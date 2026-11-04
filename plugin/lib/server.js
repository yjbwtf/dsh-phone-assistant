import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { clamp, jsonText, sleep, truncate, run } from './util.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '..')
const UI_ROOT = join(PACKAGE_ROOT, 'ui')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
}

export class ControlServer {
  constructor({ ctx, store, phone, a11y, wechat, agent, bridge, memory, memes, memekb, bus, version }) {
    this.ctx = ctx
    this.store = store
    this.phone = phone
    this.a11y = a11y
    this.wechat = wechat
    this.agent = agent
    this.bridge = bridge
    this.memory = memory
    this.memes = memes
    this.memekb = memekb
    this.bus = bus
    this.version = version
    this.server = null
    this.port = 0
    this.clients = new Set()
    this.startedAt = Date.now()
    this.unsubscribe = bus.subscribe((event) => this.broadcast(event))
  }

  async start() {
    if (this.server) return this.port
    const base = Number(this.store.get('httpPort')) || 18642
    const server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        this.bus.log('error', `HTTP 处理失败: ${error.message}`)
        if (!res.headersSent) this.sendJson(res, 500, { ok: false, error: error.message })
        else try { res.end() } catch {}
      })
    })
    this.server = server
    for (let attempt = 0; attempt < 12; attempt++) {
      const port = base + attempt
      try {
        await new Promise((resolvePromise, reject) => {
          const onError = (error) => {
            server.off('listening', onListening)
            reject(error)
          }
          const onListening = () => {
            server.off('error', onError)
            resolvePromise()
          }
          server.once('error', onError)
          server.once('listening', onListening)
          server.listen(port, '127.0.0.1')
        })
        this.port = port
        this.store.update({ httpPort: port })
        this.bus.log('info', `控制台已启动: http://127.0.0.1:${port}`)
        if (this.store.get('openOnStart')) this.openDesktopWindow().catch(() => {})
        return port
      } catch (error) {
        if (error.code !== 'EADDRINUSE') throw error
      }
    }
    throw new Error('找不到可用的本地端口')
  }

  async stop() {
    try { this.unsubscribe?.() } catch {}
    for (const res of this.clients) {
      try { res.end() } catch {}
    }
    this.clients.clear()
    if (this.server) {
      await new Promise((resolvePromise) => this.server.close(() => resolvePromise()))
      this.server = null
    }
  }

  broadcast(event) {
    if (this.clients.size === 0) return
    const payload = `data: ${JSON.stringify(event)}\n\n`
    for (const res of [...this.clients]) {
      try {
        res.write(payload)
      } catch {
        this.clients.delete(res)
      }
    }
  }

  sendJson(res, status, value) {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  sendText(res, status, text, type = 'text/plain; charset=utf-8') {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(text)
  }

  async readBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 2 * 1024 * 1024) throw new Error('请求体过大')
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new Error('JSON 请求体无效')
    }
  }

  async state() {
    const device = await this.phone.status()
    let a11y = null
    try {
      a11y = this.a11y.lastPing ?? await this.a11y.ping()
    } catch (error) {
      a11y = { available: false, error: error.message }
    }
    return {
      ok: true,
      version: this.version,
      port: this.port,
      startedAt: this.startedAt,
      now: Date.now(),
      device,
      a11y: {
        available: Boolean(a11y?.service),
        screen: a11y?.screen,
        latestSeq: a11y?.latestNotificationSeq,
        lastPackage: a11y?.lastPackage,
        error: a11y?.error,
      },
      bridge: this.bridge.status(),
      agent: this.agent.status(),
      memory: this.memory.stats(),
      memes: this.memes?.stats?.(),
      memekb: this.memekb?.stats?.(),
      settings: this.store.view(),
      logs: this.bus.logs.slice(-80),
      screenUrl: `/api/screen?t=${Date.now()}`,
    }
  }

  async handle(req, res) {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port || 18642}`)
    const path = url.pathname
    if (path === '/api/events') return this.handleEvents(req, res)
    if (path === '/api/phone.mjpeg') return this.handlePhoneMjpeg(req, res)
    if (path === '/api/state') return this.sendJson(res, 200, await this.state())
    if (path === '/api/screen') {
      const fresh = url.searchParams.get('fresh') === '1'
      const shot = await this.phone.screenshot(fresh)
      const body = readFileSync(shot.latestPath)
      res.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'no-store',
        'content-length': body.length,
      })
      res.end(body)
      return
    }
    if (path === '/api/health') {
      return this.sendJson(res, 200, { ok: true, version: this.version, port: this.port })
    }
    if (path.startsWith('/api/')) return await this.handleApi(req, res, path, url)
    if (req.method !== 'GET' && req.method !== 'HEAD') return this.sendText(res, 405, 'method not allowed')
    return this.serveStatic(res, path)
  }

  async handlePhoneMjpeg(req, res) {
    const boundary = 'phoneframe'
    res.writeHead(200, {
      'content-type': `multipart/x-mixed-replace; boundary=${boundary}`,
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const directory = this.phone.store?.screenshotsDir || resolve(String(this.store.get('dataDir') || '.'), 'screenshots')
    const output = join(directory, 'phone-mjpeg.jpg')
    const script = join(PACKAGE_ROOT, 'assets', 'tools', 'phone_frame.py')
    const python = process.env.PYTHON || 'python'
    let active = true
    req.on('close', () => { active = false })
    const writeChunk = (chunk) => new Promise((resolvePromise) => {
      if (!active) return resolvePromise(false)
      try {
        if (res.write(chunk)) return resolvePromise(true)
        res.once('drain', () => resolvePromise(active))
      } catch {
        resolvePromise(false)
      }
    })
    while (active) {
      try {
        const shot = await this.phone.screenshot(true)
        await run(python, [script, shot.path, output], { timeout: 12000 })
        const jpeg = readFileSync(output)
        if (!await writeChunk(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`)) break
        if (!await writeChunk(jpeg)) break
        if (!await writeChunk('\r\n')) break
      } catch (error) {
        this.bus.log('warn', `手机 MJPEG 帧失败: ${error.message}`)
        if (!await writeChunk(`--${boundary}\r\nContent-Type: text/plain\r\n\r\n${error.message}\r\n`)) break
      }
      await sleep(180)
    }
    try { res.end() } catch {}
  }

  serveStatic(res, path) {
    const file = path === '/' ? 'index.html' : path.replace(/^\/+/, '')
    const target = resolve(UI_ROOT, file)
    if (!target.startsWith(resolve(UI_ROOT) + '\\') && target !== resolve(UI_ROOT, 'index.html')) {
      return this.sendText(res, 403, 'forbidden')
    }
    if (!existsSync(target)) return this.sendText(res, 404, 'not found')
    const ext = target.slice(target.lastIndexOf('.'))
    const body = readFileSync(target)
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'content-length': body.length,
    })
    res.end(body)
  }

  handleEvents(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(`retry: 2000\n\n`)
    res.write(`data: ${JSON.stringify({ type: 'hello', time: Date.now() })}\n\n`)
    this.clients.add(res)
    const heartbeat = setInterval(() => {
      try { res.write(`: ping\n\n`) } catch {}
    }, 20000)
    req.on('close', () => {
      clearInterval(heartbeat)
      this.clients.delete(res)
    })
  }

  async handleApi(req, res, path, url) {
    const body = req.method === 'POST' ? await this.readBody(req) : {}
    const action = path.slice('/api/'.length)
    if (action === 'action' && req.method === 'POST') {
      const result = await this.doAction(body)
      return this.sendJson(res, 200, { ok: true, result })
    }
    if (action === 'chat' && req.method === 'POST') {
      const text = String(body.text ?? '').trim()
      if (!text) return this.sendJson(res, 400, { ok: false, error: '消息为空' })
      const result = await this.agent.submitUi(text)
      return this.sendJson(res, 200, { ok: true, result })
    }
    if (action === 'quick-ack' && req.method === 'POST') {
      const text = String(body.text ?? '').trim()
      if (!text) return this.sendJson(res, 400, { ok: false, error: '消息为空' })
      const ack = await this.agent.decideQuickAck(text, String(body.target ?? '').trim())
      return this.sendJson(res, 200, { ok: true, ack })
    }
    if (action === 'wechat/send' && req.method === 'POST') {
      const text = String(body.text ?? '').trim()
      const target = String(body.target ?? this.store.get('wechatTarget') ?? '').trim()
      if (!text) return this.sendJson(res, 400, { ok: false, error: '消息为空' })
      const result = await this.wechat.send(target, text)
      return this.sendJson(res, 200, { ok: true, result })
    }
    if (action === 'wechat/open' && req.method === 'POST') {
      const target = String(body.target ?? this.store.get('wechatTarget') ?? '').trim()
      const result = await this.wechat.openTarget(target)
      return this.sendJson(res, 200, { ok: true, result })
    }
    if (action === 'wechat/notifications' && req.method === 'GET') {
      const items = await this.wechat.latestNotifications()
      return this.sendJson(res, 200, { ok: true, items: items.slice(-80) })
    }
    if (action === 'bridge' && req.method === 'POST') {
      const enabled = Boolean(body.enabled)
      const result = await this.bridge.setEnabled(enabled)
      return this.sendJson(res, 200, { ok: true, result })
    }
    if (action === 'settings' && req.method === 'GET') {
      return this.sendJson(res, 200, { ok: true, settings: this.store.view() })
    }
    if (action === 'settings' && req.method === 'POST') {
      const patch = body.settings && typeof body.settings === 'object' ? body.settings : body
      const updated = this.store.update(patch)
      this.bus.emit('settings', updated)
      await this.agent.refreshPrompt().catch(() => {})
      if (patch.memoryMaxBytes !== undefined) this.memory.applyMaxBytes(this.store.get('memoryMaxBytes'))
      if (patch.screenshotCacheMaxBytes !== undefined) this.phone.enforceScreenshotCache().catch((error) => this.bus.log('warn', `截图缓存清理失败: ${error.message}`))
      if (patch.phoneCacheMaxBytes !== undefined || patch.phoneCacheDir !== undefined) this.phone.enforcePhoneCache().catch((error) => this.bus.log('warn', `手机缓存清理失败: ${error.message}`))
      if (this.memes && (patch.visionBaseUrl !== undefined || patch.visionApiKey !== undefined || patch.visionModel !== undefined)) {
        this.memes.vision = {
          baseUrl: this.store.get('visionBaseUrl'),
          apiKey: this.store.get('visionApiKey'),
          model: this.store.get('visionModel'),
        }
      }
      return this.sendJson(res, 200, { ok: true, settings: this.store.view() })
    }
    if (action === 'repair' && req.method === 'POST') {
      const result = await this.repair()
      return this.sendJson(res, 200, { ok: true, result })
    }
    if (action === 'session/reset' && req.method === 'POST') {
      const result = await this.agent.reset()
      return this.sendJson(res, 200, { ok: true, result })
    }
    if (action === 'a11y/dump' && req.method === 'GET') {
      const dump = await this.a11y.dump()
      return this.sendJson(res, 200, { ok: true, dump })
    }
    if (action === 'memory/stats' && req.method === 'GET') {
      return this.sendJson(res, 200, { ok: true, stats: this.memory.stats() })
    }
    if (action === 'memory/list' && req.method === 'GET') {
      const limit = Number(url.searchParams.get('limit')) || 40
      return this.sendJson(res, 200, { ok: true, items: this.memory.list(limit) })
    }
    if (action === 'memory/search' && req.method === 'GET') {
      const query = url.searchParams.get('q') || ''
      const app = url.searchParams.get('app') || ''
      const limit = Number(url.searchParams.get('limit')) || 8
      return this.sendJson(res, 200, { ok: true, items: this.memory.search(query, { app, limit }) })
    }
    if (action === 'memory/remember' && req.method === 'POST') {
      const result = this.memory.remember(body)
      return this.sendJson(res, 200, { ok: true, result })
    }
    if (action === 'memory/forget' && req.method === 'POST') {
      const removed = this.memory.remove(body.id)
      return this.sendJson(res, 200, { ok: true, removed })
    }
    if (action === 'skills' && req.method === 'GET') {
      return this.sendJson(res, 200, { ok: true, skills: this.memory.listSkills(Number(url.searchParams.get('limit')) || 50) })
    }
    if (action === 'skills/get' && req.method === 'GET') {
      const skill = this.memory.getSkill(url.searchParams.get('name') || '')
      if (!skill) return this.sendJson(res, 404, { ok: false, error: 'skill not found' })
      return this.sendJson(res, 200, { ok: true, skill })
    }
    if (action === 'skills/save' && req.method === 'POST') {
      const result = this.memory.saveSkill({
        name: body.name,
        app: body.app || '',
        keywords: body.keywords || '',
        params: Array.isArray(body.params) ? body.params : String(body.params || '').split(/[,，\s]+/u).filter(Boolean),
        steps: body.steps,
      })
      return this.sendJson(res, 200, { ok: true, result, skills: this.memory.listSkills() })
    }
    if (action === 'skills/delete' && req.method === 'POST') {
      const result = this.memory.deleteSkill(body.name)
      return this.sendJson(res, 200, { ok: true, result, skills: this.memory.listSkills() })
    }
    if (action === 'logs' && req.method === 'GET') {
      return this.sendJson(res, 200, { ok: true, logs: this.bus.logs.slice(-200) })
    }
    if (action === 'open-app' && req.method === 'POST') {
      await this.openDesktopWindow()
      return this.sendJson(res, 200, { ok: true, port: this.port })
    }
    return this.sendJson(res, 404, { ok: false, error: `unknown api: ${path}` })
  }

  async doAction(body) {
    const action = String(body.action ?? '')
    if (action === 'wake') return await this.phone.wake()
    if (action === 'home') return await this.phone.key('home')
    if (action === 'back') return await this.phone.key('back')
    if (action === 'recents') return await this.phone.key('recents')
    if (action === 'screenshot') return await this.phone.screenshot(true)
    if (action === 'scrcpy') return await this.phone.openScrcpy()
    if (action === 'scrcpy-restart') return await this.phone.openScrcpy(true)
    if (action === 'launch') return await this.phone.launch(body.target)
    if (action === 'tap') {
      const x = clamp(Number(body.x), 0, 10000)
      const y = clamp(Number(body.y), 0, 10000)
      try {
        return await this.a11y.tap(x, y)
      } catch {
        return await this.phone.tap(x, y)
      }
    }
    if (action === 'swipe') {
      return await this.phone.swipe(body.x1, body.y1, body.x2, body.y2, body.duration)
    }
    if (action === 'key') return await this.phone.key(body.key)
    if (action === 'shell') return { output: await this.phone.runShell(body.command) }
    if (action === 'a11y-ensure') return await this.a11y.ensure(true)
    if (action === 'ui') return await this.a11y.dump()
    throw new Error(`未知操作: ${action}`)
  }

  async repair() {
    const steps = []
    try {
      const status = await this.phone.status(true)
      steps.push({ step: 'device', ok: status.online, detail: status })
    } catch (error) {
      steps.push({ step: 'device', ok: false, error: error.message })
    }
    try {
      const result = await this.a11y.ensure(true)
      steps.push({ step: 'a11y', ok: true, detail: result })
    } catch (error) {
      steps.push({ step: 'a11y', ok: false, error: error.message })
    }
    try {
      await this.wechat.ensureTools()
      steps.push({ step: 'wechat-tools', ok: true })
    } catch (error) {
      steps.push({ step: 'wechat-tools', ok: false, error: error.message })
    }
    try {
      const scrcpy = await this.phone.openScrcpy()
      steps.push({ step: 'scrcpy', ok: true, detail: scrcpy })
    } catch (error) {
      steps.push({ step: 'scrcpy', ok: false, error: error.message })
    }
    return steps
  }

  async openDesktopWindow() {
    const candidates = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ]
    const browser = candidates.find((item) => existsSync(item))
    if (!browser) throw new Error('未找到 Edge/Chrome')
    const child = spawn(browser, [
      `--app=http://127.0.0.1:${this.port}`,
      '--window-size=900,1000',
      '--window-position=-1920,40',
    ], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    await sleep(300)
    return { browser, port: this.port }
  }
}
