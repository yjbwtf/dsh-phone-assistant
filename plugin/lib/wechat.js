import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeText, run, sleep } from './util.js'
import { ocrImage } from './ocr.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '..')
const ADB_KEYBOARD = 'com.android.adbkeyboard/.AdbIME'
const ADB_KEYBOARD_PACKAGE = 'com.android.adbkeyboard'

export function stripTaskLabel(value) {
  let text = String(value ?? '').trim()
  text = text.replace(/^[ \t]*[✅⚠️⏳][^\n]*(?:任务结束|任务进行中|你的任务)[^\n]*\n?/u, '')
  text = text.replace(/^[ \t]*(?:任务结束|任务进行中|你的任务)[^\n]*\n?/u, '')
  return text.trim()
}

function stripEndPeriod(value) {
  return String(value ?? '')
    .replace(/[。]+$/u, '')
    .replace(/(?<![.\/])\.$/u, '')
    .trim()
}

export function splitChatText(value) {
  const text = stripTaskLabel(value)
  if (!text) return []
  if (text.includes('```')) return [stripEndPeriod(text.slice(0, 1800))]
  const rawBlocks = text.split(/\n{2,}/u).map((block) => block.trim()).filter(Boolean)
  const blocks = []
  for (const block of rawBlocks) {
    if (block.length <= 160) {
      blocks.push(block)
      continue
    }
    const sentences = block.split(/(?<=[。！？!?…])/u).filter(Boolean)
    let current = ''
    for (const sentence of sentences) {
      if (current && current.length + sentence.length > 140) {
        blocks.push(current.trim())
        current = sentence
      } else {
        current += sentence
      }
    }
    if (current.trim()) blocks.push(current.trim())
  }
  if (blocks.length > 4) {
    blocks.splice(3, blocks.length - 3, blocks.slice(3).join('\n'))
  }
  return blocks.map(stripEndPeriod).filter(Boolean)
}

export class WeChatAutomation {
  constructor(phone, a11y, store, bus) {
    this.phone = phone
    this.a11y = a11y
    this.store = store
    this.bus = bus
    this.queue = Promise.resolve()
    this.currentChat = ''
    this.openedAt = 0
    this.originalIme = ''
    this.imePrepared = false
  }

  get adbKeyboardApk() {
    return resolve(PACKAGE_ROOT, 'assets', 'ADBKeyboard.apk')
  }

  async ensureTools() {
    try {
      const ime = await this.phone.shell(`pm path ${ADB_KEYBOARD_PACKAGE}`, { allowFail: true })
      if (!ime.includes('package:')) {
        if (!existsSync(this.adbKeyboardApk)) throw new Error(`ADBKeyboard APK 缺失: ${this.adbKeyboardApk}`)
        this.bus.log('info', '正在安装 ADBKeyboard')
        await this.phone.installApk(this.adbKeyboardApk)
      }
      await this.a11y.ensure().catch((error) => {
        this.bus.log('warn', `无障碍服务不可用，改用 ADB 手势: ${error.message}`)
      })
      return true
    } catch (error) {
      this.bus.log('error', `微信工具初始化失败: ${error.message}`)
      throw error
    }
  }

  async ensureIme() {
    if (this.imePrepared) return
    const current = (await this.phone.shell('settings get secure default_input_method', { allowFail: true })).trim()
    if (current && current !== 'null') this.originalIme = current
    await this.phone.shell(`ime enable ${ADB_KEYBOARD}`, { allowFail: true })
    await this.phone.shell(`ime set ${ADB_KEYBOARD}`, { allowFail: true })
    this.imePrepared = true
    await sleep(280)
  }

  async restoreIme() {
    if (!this.imePrepared) return
    this.imePrepared = false
    if (!this.store.get('restoreIme')) return
    if (!this.originalIme || this.originalIme === ADB_KEYBOARD) {
      try {
        const list = await this.phone.shell('ime list -s', { allowFail: true })
        const values = String(list).split(/\r?\n/).map((value) => value.trim()).filter((value) => value && value !== ADB_KEYBOARD)
        this.originalIme = values.find((value) => /qqpinyin|sogou|baidu|inputmethod/i.test(value)) || values[0] || ''
      } catch {}
    }
    if (this.originalIme && this.originalIme !== ADB_KEYBOARD) {
      await this.phone.shell(`ime set ${this.originalIme}`, { allowFail: true })
      await sleep(180)
    }
  }

  async broadcast(action, extra = '') {
    const suffix = extra ? ` ${extra}` : ''
    return await this.phone.shell(`am broadcast -a ${action}${suffix}`, { allowFail: true })
  }

  async clearText() {
    await this.broadcast('ADB_CLEAR_TEXT')
    await sleep(120)
  }

  async typeText(text) {
    const base64 = Buffer.from(String(text), 'utf8').toString('base64')
    await this.broadcast('ADB_INPUT_B64', `--es msg ${base64}`)
    await sleep(220)
  }

  async editorAction(code = 4) {
    await this.broadcast('ADB_EDITOR_CODE', `--ei code ${Number(code) || 4}`)
    await sleep(700)
  }

  async size() {
    const status = await this.phone.status()
    return {
      width: Number(status.width) || 1080,
      height: Number(status.height) || 2340,
    }
  }

  async tapRatio(rx, ry) {
    const { width, height } = await this.size()
    const x = Math.round(width * rx)
    const y = Math.round(height * ry)
    try {
      await this.a11y.tap(x, y)
    } catch {
      await this.phone.tap(x, y)
    }
    return { x, y }
  }

  async pressBack() {
    try {
      await this.a11y.global('back')
    } catch {
      await this.phone.key('back')
    }
    await sleep(450)
  }

  async hideKeyboard() {
    const state = await this.phone.shell('dumpsys input_method | grep -E "mInputShown=|mShowRequested="', { allowFail: true })
    if (/mInputShown=true|mShowRequested=true/.test(state)) {
      await this.phone.key('back')
      await sleep(300)
    }
  }

  async ensureChatList() {
    await this.phone.ensureUnlocked()
    await this.phone.launch('wechat')
    await sleep(700)
    for (let i = 0; i < 5; i++) {
      const fg = await this.phone.foreground()
      if (fg.package !== 'com.tencent.mm') {
        await this.phone.launch('wechat')
        await sleep(600)
        continue
      }
      const activity = fg.activity || ''
      if (activity.includes('LauncherUI')) return fg
      if (activity.includes('ChattingUI') || activity.includes('FTSMainUI')) {
        await this.pressBack()
        continue
      }
      await this.pressBack()
    }
    return await this.phone.foreground()
  }

  async waitForActivity(pattern, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const fg = await this.phone.foreground()
      if (fg.package === 'com.tencent.mm' && pattern.test(String(fg.activity))) return fg
      await sleep(400)
    }
    return null
  }

  async verifyChat(name, screenshotPath = '') {
    const target = String(name ?? '').replace(/[^\p{L}\p{N}]/gu, '')
    if (!target) return false
    let shotPath = screenshotPath
    if (!shotPath) {
      const shot = await this.phone.screenshot(true).catch(() => null)
      shotPath = shot?.path ?? ''
    }
    if (!shotPath) return false
    let ocr
    try {
      ocr = await ocrImage(shotPath)
    } catch (error) {
      this.bus.log('warn', `聊天标题校验 OCR 失败: ${error.message}`)
      return false
    }
    const lines = (ocr?.lines ?? []).filter((line) => Number(line.y) >= 60 && Number(line.y) <= 240)
    const title = lines.map((line) => line.compact || line.text || '').join('').replace(/[^\p{L}\p{N}]/gu, '')
    if (!title) return false
    const matched = title.includes(target) || target.includes(title)
    if (!matched) this.bus.log('warn', `聊天标题不匹配，拒绝发送`, { expected: target, actual: title.slice(0, 40), screenshot: shotPath })
    return matched
  }

  async openChat(target) {
    const name = String(target ?? this.store.get('wechatTarget') ?? '').trim()
    if (!name) throw new Error('未配置微信目标聊天')
    const fg = await this.phone.foreground()
    if (
      this.currentChat === name &&
      Date.now() - this.openedAt < 120000 &&
      fg.package === 'com.tencent.mm' &&
      await this.verifyChat(name)
    ) {
      return { target: name, reused: true }
    }
    if (this.currentChat === name) {
      this.currentChat = ''
      this.openedAt = 0
    }
    await this.ensureChatList()
    await sleep(700)
    if (name !== this.store.get('wechatTarget') && this.store.targets().includes(name)) {
      const groupHit = await this.tapTemplate('wechat-group-row', [0, 200, 1080, 1500])
      if (groupHit) {
        await sleep(1200)
        if (await this.verifyChat(name)) {
          this.currentChat = name
          this.openedAt = Date.now()
          return { target: name, group: true, opened: true }
        }
        this.currentChat = ''
        this.openedAt = 0
        throw new Error(`打开群「${name}」后标题校验失败，已拒绝发送`)
      }
    }
    if (name === this.store.get('wechatTarget') && this.store.get('directPrimaryChat') !== false) {
      await this.tapRatio(0.37, 0.100)
      await sleep(1600)
      const direct = await this.phone.foreground()
      if (direct.package === 'com.tencent.mm' && await this.verifyChat(name)) {
        this.currentChat = name
        this.openedAt = Date.now()
        return { target: name, direct: true, foreground: direct, opened: true }
      }
      this.currentChat = ''
      this.openedAt = 0
      await this.ensureChatList()
    }
    const fgNow = await this.phone.foreground()
    if (!String(fgNow.activity).includes('FTSMainUI')) {
      await this.tapRatio(0.861, 0.047)
      await sleep(650)
    }
    await this.clearText()
    await this.ensureIme()
    await this.typeText(name)
    await sleep(950)
    await this.tapRatio(0.36, 0.196)
    await sleep(1800)
    const after = await this.phone.foreground()
    if (after.package !== 'com.tencent.mm') {
      const shot = await this.phone.screenshot(true).catch(() => null)
      throw new Error(`没有打开目标聊天「${name}」，${shot?.path ? `截图: ${shot.path}` : '请检查前台'}`)
    }
    if (!await this.verifyChat(name)) {
      this.currentChat = ''
      this.openedAt = 0
      const shot = await this.phone.screenshot(true).catch(() => null)
      throw new Error(`目标聊天「${name}」标题校验失败，已拒绝发送，${shot?.path ? `截图: ${shot.path}` : '请检查当前聊天'}`)
    }
    this.currentChat = name
    this.openedAt = Date.now()
    return {
      target: name,
      foreground: after,
      opened: true,
    }
  }

  async focusInput() {
    for (const y of [2270, 2260, 2245]) {
      await this.tapAt(400, y)
      await sleep(450)
      const state = await this.phone.shell('dumpsys input_method | grep -E "mInputShown=|mServedInputConnection"', { allowFail: true })
      if (/mInputShown=true/.test(state) && /mServedInputConnectionWrapper=(?!null)/.test(state)) return true
    }
    return false
  }

  async send(target, text, options = {}) {
    const run = () => this._send(target, text, options)
    const result = this.queue.then(run, run)
    this.queue = result.catch(() => {})
    return await result
  }

  async _send(target, text, options = {}) {
    const name = String(target ?? this.store.get('wechatTarget') ?? '').trim()
    const content = String(text ?? '').slice(0, 1800)
    if (!name) throw new Error('未配置微信目标聊天')
    if (!content.trim()) throw new Error('消息内容为空')
    const segments = options.split ? splitChatText(content) : [content]
    if (segments.length === 0) throw new Error('消息内容为空')
    await this.ensureTools()
    await this.phone.ensureDevice()
    const status = await this.phone.status()
    if (!status.screenOn) await this.phone.wake()
    const opened = await this.openChat(name)
    const focused = await this.focusInput()
    if (!focused) throw new Error('没有聚焦到微信输入框，请截图确认当前是否在聊天页')
    try {
      await this.ensureIme()
      for (const segment of segments) {
        await this.clearText()
        await this.typeText(segment)
        await sleep(180)
        await this.editorAction(4)
        await sleep(450)
      }
    } finally {
      await this.restoreIme().catch(() => {})
    }
    await this.hideKeyboard().catch(() => {})
    const screenshot = await this.phone.screenshot(true).catch(() => null)
    if (options.background && this.store.get('homeAfterReply')) {
      await this.phone.key('home').catch(() => {})
      await sleep(300)
    }
    const result = {
      target: name,
      text: segments.join('\n\n'),
      segments,
      opened,
      screenshot: screenshot?.path ?? null,
      at: Date.now(),
    }
    this.bus.emit('wechat-out', result)
    this.bus.log('info', `已发送微信消息给 ${name}`, { chars: result.text.length, segments: segments.length })
    return result
  }

  async latestNotifications() {
    const items = []
    try {
      const a11yResult = await this.a11y.notifications()
      if (Array.isArray(a11yResult.items)) items.push(...a11yResult.items.map((item) => ({ ...item, source: 'a11y' })))
    } catch {
      // Accessibility may be unavailable; dumpsys is the fallback.
    }
    try {
      const dump = await this.phone.notificationsDump()
      items.push(...dump)
    } catch {
      // Notifications may be restricted; the caller still gets a11y data.
    }
    return items
  }

  extractMessages(item, target) {
    const wantedList = (Array.isArray(target) ? target : [target])
      .map((value) => normalizeText(value))
      .filter(Boolean)
    if (wantedList.length === 0) return []
    const title = normalizeText(item.title || item.sender || '')
    const raw = normalizeText(item.bigText || item.text || item.ticker || (Array.isArray(item.eventText) ? item.eventText.join(' ') : ''))
    const matchedTarget = wantedList.find((wanted) => {
      const matches = (value) => {
        const text = normalizeText(value)
        return text === wanted || text.includes(wanted)
      }
      return matches(title) || matches(raw)
    })
    if (!matchedTarget) return []
    const messages = []
    if (Array.isArray(item.messages) && item.messages.length > 0) {
      for (const entry of item.messages) {
        const sender = normalizeText(entry.sender || title)
        const text = normalizeText(entry.text)
        if (!text) continue
        if (text === matchedTarget) continue
        messages.push({ sender, text, target: matchedTarget, time: Number(entry.time) || Number(item.time) || Date.now() })
      }
    }
    if (messages.length === 0 && raw) {
      let text = raw
      text = text.replace(/^\[\d+条\]\s*/, '')
      if (title && text.startsWith(`${title}:`)) text = text.slice(title.length + 1).trim()
      if (title && text.startsWith(`${title}：`)) text = text.slice(title.length + 1).trim()
      if (matchedTarget && text.startsWith(`${matchedTarget}:`)) text = text.slice(matchedTarget.length + 1).trim()
      if (matchedTarget && text.startsWith(`${matchedTarget}：`)) text = text.slice(matchedTarget.length + 1).trim()
      text = normalizeText(text)
      if (text && text !== matchedTarget && !/^你(?:收到)?(?:了)?一条新消息$/.test(text)) {
        messages.push({ sender: title || matchedTarget, text, target: matchedTarget, time: Number(item.time) || Date.now() })
      }
    }
    return messages
  }

  async openTarget(target) {
    await this.ensureTools()
    try {
      return await this.openChat(target ?? this.store.get('wechatTarget'))
    } finally {
      await this.restoreIme().catch(() => {})
    }
  }

  async readChat(target) {
    await this.ensureTools()
    await this.phone.ensureUnlocked()
    const name = String(target ?? this.store.get('wechatTarget') ?? '').trim()
    if (!name) throw new Error('未配置微信目标聊天')
    const opened = await this.openChat(name)
    await this.hideKeyboard().catch(() => {})
    await sleep(500)
    const shot = await this.phone.screenshot(true)
    let ocr = null
    try {
      ocr = await ocrImage(shot.path)
    } catch (error) {
      this.bus.log('warn', `聊天 OCR 失败: ${error.message}`)
    }
    this.bus.log('info', `已打开并截图微信聊天: ${name}`, { screenshot: shot.path, ocrLines: ocr?.lines?.length ?? 0 })
    return { target: name, opened, screenshot: shot.path, ocr }
  }

  async latestMediaInfo(filePath = '', preferType = 'video') {
    try {
      const wantedName = filePath ? String(filePath).split('/').pop() : ''
      const [videoOut, imageOut] = await Promise.all([
        this.phone.shell('content query --uri content://media/external/video/media --projection _id:_display_name:date_added --sort "date_added DESC"', { allowFail: true }),
        this.phone.shell('content query --uri content://media/external/images/media --projection _id:_display_name:date_added --sort "date_added DESC"', { allowFail: true }),
      ])
      const rows = []
      for (const [type, output] of [['video', videoOut], ['image', imageOut]]) {
        for (const line of String(output).split(/\r?\n/)) {
          if (!line.includes('_display_name=')) continue
          const name = line.match(/_display_name=([^,]+)/)?.[1]?.trim()
          const date = Number(line.match(/date_added=(\d+)/)?.[1] ?? 0)
          if (name) rows.push({ type, name, date })
        }
      }
      rows.sort((a, b) => b.date - a.date)
      let index = wantedName ? rows.findIndex((row) => row.name === wantedName) : -1
      if (index < 0) index = rows.findIndex((row) => row.type === preferType)
      if (index < 0) return { index: 0, name: wantedName, rows: rows.length }
      return { index, name: rows[index].name, rows: rows.length, type: rows[index].type }
    } catch {
      return { index: 0, name: filePath ? String(filePath).split('/').pop() : '', rows: 0 }
    }
  }

  async tapAt(x, y) {
    try {
      await this.a11y.tap(x, y)
    } catch {
      await this.phone.tap(x, y)
    }
  }

  async findTemplate(name, roi) {
    try {
      const shot = await this.phone.screenshot(true)
      const script = join(PACKAGE_ROOT, 'assets', 'tools', 'find_template.py')
      const template = join(PACKAGE_ROOT, 'assets', 'templates', `${name}.png`)
      const python = process.env.PYTHON || 'python'
      const result = await run(python, [script, shot.path, template, ...roi.map(String)], { timeout: 20000 })
      const parsed = JSON.parse(result.stdout.toString('utf8').trim())
      if (!parsed.found) return null
      return parsed
    } catch (error) {
      this.bus.log('warn', `模板识别失败(${name}): ${error.message}`)
      return null
    }
  }

  async tapTemplate(name, roi) {
    const found = await this.findTemplate(name, roi)
    if (!found) return null
    await this.tapAt(found.x, found.y)
    return found
  }

  async sendLatestVideo(target, filePath = '') {
    const name = String(target ?? this.store.get('wechatTarget') ?? '').trim()
    if (name !== this.store.get('wechatTarget')) throw new Error('媒体发送目前只支持主聊天「' + this.store.get('wechatTarget') + '」')
    const path = filePath || (await this.phone.shell('ls -t /sdcard/DCIM/Camera/*.mp4 2>/dev/null | head -1')).trim()
    if (!path) throw new Error('手机相册里没有视频')
    return await this.sendVideoViaShare(name, path)
  }

  async sendLatestImage(target, filePath = '') {
    const name = String(target ?? this.store.get('wechatTarget') ?? '').trim()
    if (name !== this.store.get('wechatTarget')) throw new Error('媒体发送目前只支持主聊天「' + this.store.get('wechatTarget') + '」')
    if (!filePath) throw new Error('缺少图片路径')
    return await this.sendImageViaShare(name, filePath)
  }

  async mediaContentUri(filePath, kind = 'images') {
    const table = kind === 'video' ? 'video' : 'images'
    const name = String(filePath).split('/').pop()
    const output = await this.phone.shell(`content query --uri content://media/external/${table}/media --projection _id:_display_name`, { allowFail: true })
    for (const line of String(output).split(/\r?\n/)) {
      if (!line.includes(name)) continue
      const id = line.match(/_id=(\d+)/)?.[1]
      if (id) return `content://media/external/${table}/media/${id}`
    }
    throw new Error(`媒体库里找不到 ${name}`)
  }

  async sendMediaViaShare(target, filePath, type = 'image') {
    await this.ensureTools()
    const name = String(target ?? this.store.get('wechatTarget') ?? '').trim()
    if (!name) throw new Error('未配置微信目标聊天')
    if (name !== this.store.get('wechatTarget')) throw new Error('共享发送目前只支持主聊天')
    const isVideo = type === 'video'
    if (!isVideo && !/\.jpe?g$/iu.test(String(filePath))) throw new Error('分享发送图片需要 JPEG，请先用 prepareImage 转换')
    const uri = await this.mediaContentUri(filePath, isVideo ? 'video' : 'images')
    await this.phone.ensureUnlocked()
    const mime = isVideo ? 'video/mp4' : 'image/jpeg'
    await this.phone.shell(`am start -a android.intent.action.SEND -t ${mime} --eu android.intent.extra.STREAM ${uri} -p com.tencent.mm`)
    await sleep(1400)
    let fg = await this.phone.foreground()
    if (String(fg.activity).includes('HwResolverActivity') || String(fg.activity).includes('ResolverActivity')) {
      await this.tapAt(161, 1870)
      await sleep(800)
      fg = await this.phone.foreground()
      if (String(fg.activity).includes('ResolverActivity')) {
        await this.tapAt(370, 2260)
        await sleep(800)
      }
    }
    await sleep(500)
    const targetHit = await this.tapTemplate('wechat-share-primary', [0, 300, 1080, 1200])
    if (!targetHit) throw new Error('分享列表里没有找到主聊天')
    await sleep(1400)
    const preview = await this.phone.screenshot(true).catch(() => null)
    await this.tapAt(743, 2167)
    await sleep(2200)
    const after = await this.phone.screenshot(true).catch(() => null)
    const sentState = await this.phone.foreground()
    const confirmed = sentState.package === 'com.tencent.mm'
    if (!confirmed) throw new Error('分享发送后没有回到微信')
    this.bus.log('info', `已通过分享发送${isVideo ? '视频' : '图片'}到 ${name}`, { filePath })
    return {
      target: name,
      filePath,
      mediaType: isVideo ? 'video' : 'image',
      confirmed,
      preview: preview?.path ?? null,
      screenshot: after?.path ?? null,
    }
  }

  async sendImageViaShare(target, filePath) {
    return await this.sendMediaViaShare(target, filePath, 'image')
  }

  async sendVideoViaShare(target, filePath) {
    return await this.sendMediaViaShare(target, filePath, 'video')
  }

  async sendLatestMedia(target, filePath = '', preferType = 'video', label = '媒体') {
    await this.ensureTools()
    const info = await this.latestMediaInfo(filePath, preferType)
    const name = String(target ?? this.store.get('wechatTarget') ?? '').trim()
    if (!name) throw new Error('未配置微信目标聊天')
    const badPage = /RedPacket|LuckyMoney|Pay|Wallet|WebView|FTSMainUI/i
    await this.openChat(name)
    await this.hideKeyboard().catch(() => {})
    await sleep(300)
    let albumOpened = false
    const plus = await this.tapTemplate('wechat-plus', [850, 2050, 230, 290])
    if (!plus) await this.tapRatio(0.916, 0.970)
    await sleep(850)
    const album = await this.tapTemplate('wechat-album', [0, 1500, 1080, 800])
    if (album) {
      await sleep(1000)
      const fg = await this.phone.foreground()
      if (String(fg.activity).includes('AlbumPreviewUI') || String(fg.activity).toLowerCase().includes('gallery')) albumOpened = true
    }
    const albumCandidates = [[160, 1685], [161, 1932], [167, 2018], [167, 1783], [160, 1730]]
    let panelOpen = albumOpened
    for (const [x, y] of (albumOpened ? [] : albumCandidates)) {
      if (!panelOpen) {
        await this.tapRatio(0.916, 0.970)
        await sleep(700)
        panelOpen = true
      }
      await this.tapAt(x, y)
      await sleep(900)
      const fg = await this.phone.foreground()
      if (String(fg.activity).includes('AlbumPreviewUI') || String(fg.activity).toLowerCase().includes('gallery')) {
        albumOpened = true
        break
      }
      if (badPage.test(String(fg.activity))) {
        await this.pressBack()
        panelOpen = false
        continue
      }
      if (fg.package === 'com.tencent.mm' && /ChattingUI|LauncherUI/.test(String(fg.activity))) {
        panelOpen = false
        continue
      }
      await this.pressBack()
      panelOpen = false
    }
    if (!albumOpened) throw new Error('没有打开微信相册：+ 面板坐标可能变了，请截图后人工确认')
    const index = Math.max(0, Number(info.index) || 0)
    const col = index % 4
    const row = Math.floor(index / 4)
    const scrollRows = Math.max(0, row - 6)
    if (scrollRows > 0) {
      await this.phone.swipe(540, 1700, 540, 1700 - scrollRows * 270, 400)
      await sleep(600)
    }
    const gridX = 135 + col * 270
    const gridY = 315 + (row - scrollRows) * 270
    await this.tapAt(gridX, gridY)
    await sleep(1000)
    const preview = await this.phone.screenshot(true).catch(() => null)
    const sendCandidates = [[979, 2306], [953, 2280], [990, 2295]]
    let sent = false
    for (const [x, y] of sendCandidates) {
      await this.tapAt(x, y)
      await sleep(1300)
      const fg = await this.phone.foreground()
      if (badPage.test(String(fg.activity))) {
        await this.pressBack()
        continue
      }
      if (fg.package === 'com.tencent.mm' && /ChattingUI|LauncherUI/.test(String(fg.activity))) {
        sent = true
        break
      }
    }
    if (!sent) throw new Error('相册发送按钮没有生效，请查看截图确认')
    await sleep(1200)
    const after = await this.phone.screenshot(true).catch(() => null)
    this.bus.log('info', `已发送${label}到 ${name}`, { media: info.name, galleryIndex: index })
    return {
      target: name,
      media: info.name,
      mediaType: preferType,
      galleryIndex: index,
      confirmed: true,
      preview: preview?.path ?? null,
      screenshot: after?.path ?? null,
    }
  }
}
