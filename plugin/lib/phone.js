import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { clamp, ensureDir, run, runText, sleep, truncate } from './util.js'

const KEYCODES = {
  home: 'KEYCODE_HOME',
  back: 'KEYCODE_BACK',
  recents: 'KEYCODE_APP_SWITCH',
  menu: 'KEYCODE_MENU',
  enter: 'KEYCODE_ENTER',
  delete: 'KEYCODE_DEL',
  power: 'KEYCODE_POWER',
  wakeup: 'KEYCODE_WAKEUP',
  sleep: 'KEYCODE_SLEEP',
  volume_up: 'KEYCODE_VOLUME_UP',
  volume_down: 'KEYCODE_VOLUME_DOWN',
  escape: 'KEYCODE_ESCAPE',
  tab: 'KEYCODE_TAB',
  space: 'KEYCODE_SPACE',
}

function pngSize(buffer) {
  if (!buffer || buffer.length < 24) return null
  if (buffer[0] !== 0x89 || buffer.toString('ascii', 1, 4) !== 'PNG') return null
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  }
}

export class PhoneController {
  constructor(store, bus) {
    this.store = store
    this.bus = bus
    this.statusCache = null
    this.statusAt = 0
    this.lastScreenshot = null
    this.screenshotAt = 0
    this.capturePromise = null
    this.scrcpyChild = null
  }

  get adbPath() {
    return this.store.get('adbPath')
  }

  get serial() {
    return this.store.get('serial') || ''
  }

  adbEnv(extra = {}) {
    const tmp = ensureDir(join(this.store.dataDir, 'tmp'))
    return { TEMP: tmp, TMP: tmp, ...extra }
  }

  adbArgs(args) {
    return this.serial ? ['-s', this.serial, ...args] : args
  }

  async adb(args, opts = {}) {
    if (!this.adbPath || !existsSync(this.adbPath)) {
      throw new Error(`ADB 不存在: ${this.adbPath}`)
    }
    return run(this.adbPath, this.adbArgs(args), {
      timeout: 30000,
      ...opts,
      env: this.adbEnv(opts.env),
    })
  }

  async shell(command, opts = {}) {
    const result = await this.adb(['shell', command], opts)
    return result.stdout.toString('utf8').replace(/\r\n/g, '\n')
  }

  async devices() {
    const result = await this.adb(['devices', '-l'], { allowFail: true, timeout: 10000 })
    const lines = result.stdout.toString('utf8').split(/\r?\n/).slice(1)
    const devices = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const match = trimmed.match(/^(\S+)\s+(\S+)(?:\s+(.*))?$/)
      if (!match) continue
      const extra = match[3] ?? ''
      const model = extra.match(/model:(\S+)/)?.[1]
      const product = extra.match(/product:(\S+)/)?.[1]
      devices.push({ serial: match[1], state: match[2], model, product })
    }
    return devices
  }

  async ensureDevice() {
    const devices = await this.devices()
    const usable = devices.filter((item) => item.state === 'device')
    if (usable.length === 0) {
      const states = devices.map((item) => `${item.serial}:${item.state}`).join(', ') || '无设备'
      throw new Error(`手机未连接或未授权（${states}）`)
    }
    if (!this.serial) {
      this.store.update({ serial: usable[0].serial })
    }
    return usable.find((item) => item.serial === this.store.get('serial')) ?? usable[0]
  }

  async status(force = false) {
    if (!force && this.statusCache && Date.now() - this.statusAt < 2500) return this.statusCache
    const base = {
      online: false,
      serial: this.serial,
      checkedAt: Date.now(),
    }
    try {
      const device = await this.ensureDevice()
      const [props, wm, power, window, battery] = await Promise.all([
        this.shell('getprop ro.product.model; getprop ro.build.version.release; getprop ro.build.version.sdk; getprop ro.product.brand'),
        this.shell('wm size'),
        this.shell('dumpsys power | grep -E "mWakefulness="'),
        this.shell('dumpsys window | grep -E "mCurrentFocus=|mFocusedApp="'),
        this.shell('dumpsys battery | grep -E "level:|status:"'),
      ])
      const propLines = props.split('\n').map((line) => line.trim())
      const sizeMatch = wm.match(/Override size:\s*(\d+)x(\d+)/) ?? wm.match(/Physical size:\s*(\d+)x(\d+)/)
      const focusMatch = window.match(/mCurrentFocus=Window\{[^ ]+ [^ ]+ ([^/]+)\/([^}]+)\}/)
      const focusedAppMatch = window.match(/mFocusedApp=.*? ([^/ ]+)\/([^ }]+)/)
      const pkg = focusMatch?.[1] ?? focusedAppMatch?.[1] ?? ''
      const activity = focusMatch?.[2] ?? focusedAppMatch?.[2] ?? ''
      const level = Number(battery.match(/level:\s*(\d+)/)?.[1] ?? NaN)
      const status = {
        ...base,
        online: true,
        serial: device.serial,
        model: propLines[0] || device.model || 'Android',
        brand: propLines[3] || '',
        android: propLines[1] || '',
        sdk: Number(propLines[2] || 0),
        width: sizeMatch ? Number(sizeMatch[1]) : 1080,
        height: sizeMatch ? Number(sizeMatch[2]) : 2340,
        screenOn: /mWakefulness=Awake/.test(power),
        package: pkg,
        activity,
        battery: Number.isFinite(level) ? level : null,
      }
      this.statusCache = status
      this.statusAt = Date.now()
      return status
    } catch (error) {
      const status = { ...base, error: error.message }
      this.statusCache = status
      this.statusAt = Date.now()
      return status
    }
  }

  async foreground() {
    try {
      const window = await this.shell('dumpsys window | grep -E "mCurrentFocus=|mFocusedApp="')
      const focusMatch = window.match(/mCurrentFocus=Window\{[^ ]+ [^ ]+ ([^/]+)\/([^}]+)\}/)
      const focusedAppMatch = window.match(/mFocusedApp=.*? ([^/ ]+)\/([^ }]+)/)
      return {
        package: focusMatch?.[1] ?? focusedAppMatch?.[1] ?? '',
        activity: focusMatch?.[2] ?? focusedAppMatch?.[2] ?? '',
      }
    } catch {
      return { package: '', activity: '' }
    }
  }

  async wake() {
    try {
      await this.shell('input keyevent KEYCODE_WAKEUP')
      await sleep(250)
      await this.shell('wm dismiss-keyguard')
      await sleep(350)
      if (await this.isLocked()) await this.unlockWithPin()
      return await this.status(true)
    } catch (error) {
      throw new Error(`唤醒手机失败: ${error.message}`)
    }
  }

  async isLocked() {
    try {
      const info = await this.shell('dumpsys window | grep -E "mCurrentFocus=|mDreamingLockscreen=|mShowingLockscreen=|mKeyguardShowing="', { allowFail: true })
      if (/mDreamingLockscreen=true|mShowingLockscreen=true|mKeyguardShowing=true/.test(info)) return true
      if (/mCurrentFocus=.*(StatusBar|NotificationShade|Keyguard)/.test(info)) return true
      return false
    } catch {
      return false
    }
  }

  async unlockWithPin() {
    const pin = String(this.store.get('unlockPin') ?? '').trim()
    if (!pin) throw new Error('手机处于锁屏状态，但未配置锁屏密码（设置 → 锁屏密码）')
    await this.shell('input swipe 540 2000 540 500 250')
    await sleep(550)
    await this.shell(`input text ${pin.replace(/[^\d]/g, '')}`)
    await sleep(250)
    await this.shell('input keyevent 66')
    await sleep(900)
    const locked = await this.isLocked()
    if (locked) throw new Error('自动解锁失败，请检查锁屏密码或手动解锁')
    return true
  }

  async ensureUnlocked() {
    const status = await this.status(true)
    if (!status.screenOn) await this.wake()
    if (await this.isLocked()) {
      await this.unlockWithPin()
    }
    return await this.status(true)
  }

  async screenshot(fresh = false) {
    if (!fresh && this.lastScreenshot && Date.now() - this.screenshotAt < 900 && existsSync(this.lastScreenshot.latestPath)) {
      return this.lastScreenshot
    }
    if (this.capturePromise) return this.capturePromise
    this.capturePromise = (async () => {
      await this.ensureDevice()
      let buffer
      try {
        const result = await this.adb(['exec-out', 'screencap', '-p'], { timeout: 25000 })
        buffer = result.stdout
      } catch (error) {
        const remote = `${await this.ensurePhoneCache()}/screen.png`
        await this.shell(`screencap -p ${remote}`)
        const localTemp = join(this.store.screenshotsDir, 'pull.png')
        await this.adb(['pull', remote, localTemp], { timeout: 25000 })
        buffer = readFileSync(localTemp)
        await this.shell(`rm -f "${remote}"`, { allowFail: true })
      }
      const size = pngSize(buffer)
      if (!size) throw new Error('截图返回的不是有效 PNG')
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const path = join(this.store.screenshotsDir, `shot-${stamp}.png`)
      const latestPath = this.store.screenshotFile('latest.png')
      ensureDir(dirname(path))
      writeFileSync(path, buffer)
      writeFileSync(latestPath, buffer)
      const screenshot = {
        ...size,
        path,
        latestPath,
        bytes: buffer.length,
        at: Date.now(),
      }
      this.lastScreenshot = screenshot
      this.screenshotAt = Date.now()
      this.bus.emit('phone', { screenshot })
      this.enforceScreenshotCache().catch((error) => this.bus.log('warn', `截图缓存清理失败: ${error.message}`))
      return screenshot
    })().finally(() => {
      this.capturePromise = null
    })
    return this.capturePromise
  }

  async enforceScreenshotCache() {
    if (this.cacheCleanupPromise) return this.cacheCleanupPromise
    this.cacheCleanupPromise = (async () => {
      const dir = this.store.screenshotsDir
      if (!existsSync(dir)) return
      const maxBytes = Math.max(0, Number(this.store.get('screenshotCacheMaxBytes')) || 0)
      const currentPath = this.lastScreenshot?.path || ''
      const files = readdirSync(dir)
        .filter((name) => /^shot-.*\.png$/i.test(name))
        .map((name) => {
          const path = join(dir, name)
          try {
            const stat = statSync(path)
            return { path, size: stat.size, mtimeMs: stat.mtimeMs }
          } catch {
            return null
          }
        })
        .filter(Boolean)
        .sort((a, b) => a.mtimeMs - b.mtimeMs)
      let total = files.reduce((sum, file) => sum + file.size, 0)
      let removed = 0
      let removedBytes = 0
      for (const file of files) {
        if (total <= maxBytes) break
        if (!file.path || file.path === currentPath) continue
        try {
          unlinkSync(file.path)
          total -= file.size
          removed += 1
          removedBytes += file.size
        } catch {}
      }
      if (removed > 0) {
        this.bus.log('info', `截图缓存超限，已删除 ${removed} 个早期文件（${(removedBytes / 1024 / 1024).toFixed(1)} MB）`, {
          maxBytes,
          remainingBytes: total,
        })
      }
    })().finally(() => {
      this.cacheCleanupPromise = null
    })
    return this.cacheCleanupPromise
  }

  async ensurePhoneCache() {
    const dir = String(this.store.get('phoneCacheDir') || '/sdcard/Android/data/com.dsh.phoneaccess/files/cache').replace(/\/+$/u, '')
    await this.shell(`mkdir -p "${dir}" && touch "${dir}/.nomedia"`, { allowFail: true })
    return dir
  }

  async moveToPhoneCache(remotePath, prefix = '') {
    if (!remotePath) return ''
    const dir = await this.ensurePhoneCache()
    const base = String(remotePath).split('/').pop()
    const dest = `${dir}/${prefix}${base}`
    if (remotePath !== dest) {
      await this.shell(`mv "${remotePath}" "${dest}"`, { allowFail: false })
      await this.shell(`am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://${remotePath}`, { allowFail: true })
    }
    this.enforcePhoneCache().catch((error) => this.bus.log('warn', `手机缓存清理失败: ${error.message}`))
    return dest
  }

  async enforcePhoneCache() {
    if (this.phoneCacheCleanupPromise) return this.phoneCacheCleanupPromise
    this.phoneCacheCleanupPromise = (async () => {
      const dir = await this.ensurePhoneCache()
      const maxBytes = Math.max(0, Number(this.store.get('phoneCacheMaxBytes')) || 0)
      const listing = await this.shell(`find "${dir}" -type f 2>/dev/null`, { allowFail: true })
      const files = []
      for (const line of String(listing).split(/\r?\n/u)) {
        const path = line.trim()
        if (!path || path.endsWith('/.nomedia')) continue
        const stat = await this.shell(`stat -c '%Y|%s|%n' "${path}" 2>/dev/null`, { allowFail: true })
        const match = String(stat).trim().match(/^(\d+)\|(\d+)\|(.+)$/u)
        if (match) files.push({ path: match[3], mtime: Number(match[1]) * 1000, size: Number(match[2]) })
      }
      files.sort((a, b) => a.mtime - b.mtime)
      let total = files.reduce((sum, file) => sum + file.size, 0)
      let removed = 0
      let removedBytes = 0
      for (const file of files) {
        if (total <= maxBytes) break
        await this.shell(`rm -f "${file.path}"`, { allowFail: true })
        total -= file.size
        removed += 1
        removedBytes += file.size
      }
      if (removed > 0) {
        this.bus.log('info', `手机缓存超限，已删除 ${removed} 个早期文件（${(removedBytes / 1024 / 1024).toFixed(1)} MB）`, { maxBytes, remainingBytes: total })
      }
      return { removed, removedBytes, remainingBytes: total }
    })().finally(() => {
      this.phoneCacheCleanupPromise = null
    })
    return this.phoneCacheCleanupPromise
  }

  async tap(x, y) {    const nx = clamp(Math.round(Number(x)), 0, 100000)
    const ny = clamp(Math.round(Number(y)), 0, 100000)
    await this.shell(`input tap ${nx} ${ny}`)
    return { x: nx, y: ny }
  }

  async swipe(x1, y1, x2, y2, duration = 300) {
    const values = [x1, y1, x2, y2, duration].map((value) => clamp(Math.round(Number(value)), 0, 100000))
    await this.shell(`input swipe ${values[0]} ${values[1]} ${values[2]} ${values[3]} ${values[4]}`)
    return { x1: values[0], y1: values[1], x2: values[2], y2: values[3], duration: values[4] }
  }

  async key(name) {
    const code = KEYCODES[String(name ?? '').toLowerCase()] ?? (/^\d+$/.test(String(name)) ? String(name) : `KEYCODE_${String(name).toUpperCase()}`)
    await this.shell(`input keyevent ${code}`)
    return { key: code }
  }

  async launch(target) {
    const value = String(target ?? '').trim()
    if (!value) throw new Error('缺少应用包名')
    const aliases = {
      wechat: 'com.tencent.mm/.ui.LauncherUI',
      wx: 'com.tencent.mm/.ui.LauncherUI',
      settings: 'com.android.settings/.Settings',
      camera: 'com.huawei.camera/.Camera',
      browser: 'com.huawei.browser/.BrowserActivity',
    }
    const component = aliases[value.toLowerCase()] ?? value
    if (component.includes('/')) {
      await this.shell(`am start -n ${component}`)
    } else {
      await this.shell(`monkey -p ${component} -c android.intent.category.LAUNCHER 1`)
    }
    await sleep(600)
    return { launched: component }
  }

  async runShell(command) {
    const output = await this.shell(String(command ?? ''), { timeout: 60000 })
    return truncate(output, 16000)
  }

  async notificationsDump() {
    const raw = await this.shell('dumpsys notification --noredact', { timeout: 30000 })
    const items = []
    const blocks = raw.split(/NotificationRecord\(/).slice(1)
    for (const block of blocks) {
      const pkg = block.match(/pkg=([^\s]+)/)?.[1] ?? ''
      const title = block.match(/android\.title=String \((.*?)\)\n/s)?.[1] ?? ''
      const text = block.match(/android\.text=String \((.*?)\)\n/s)?.[1] ?? ''
      const ticker = block.match(/tickerText=(.*)/)?.[1]?.trim() ?? ''
      if (!pkg) continue
      items.push({
        package: pkg,
        title,
        text,
        ticker: ticker === 'null' ? '' : ticker,
        source: 'dumpsys',
      })
    }
    return items
  }

  async installApk(path) {
    if (!existsSync(path)) throw new Error(`APK 不存在: ${path}`)
    const result = await this.adb(['install', '-r', path], { timeout: 120000 })
    return result.stdout.toString('utf8').trim()
  }

  async pushFile(localPath, remoteDir = '/sdcard/DCIM/Camera') {
    if (!existsSync(localPath)) throw new Error(`文件不存在: ${localPath}`)
    const ext = localPath.slice(localPath.lastIndexOf('.'))
    const remote = `${remoteDir}/dsh-meme-${Date.now()}${ext}`
    await this.adb(['push', localPath, remote], { timeout: 120000 })
    await this.shell(`am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://${remote}`, { allowFail: true })
    await sleep(500)
    return remote
  }

  async enableAccessibility(component) {
    const current = (await this.shell('settings get secure enabled_accessibility_services')).trim()
    const values = current.split(':').filter(Boolean)
    if (!values.includes(component)) values.push(component)
    await this.shell(`settings put secure enabled_accessibility_services "${values.join(':')}"`)
    await this.shell('settings put secure accessibility_enabled 1')
    return values
  }

  async forward(localPort, remotePort = localPort) {
    await this.adb(['forward', `tcp:${localPort}`, `tcp:${remotePort}`])
    return { localPort, remotePort }
  }

  async isScrcpyRunning() {
    const result = await run('tasklist', ['/FI', 'IMAGENAME eq scrcpy.exe'], { allowFail: true, timeout: 8000 })
    return /scrcpy\.exe/i.test(result.stdout.toString('utf8'))
  }

  async openScrcpy(restart = false) {
    if (this.store.get('scrcpyWindow') !== true) {
      return { running: false, mode: 'panel', screenOff: false, message: 'scrcpy 外部窗口已关闭，画面在面板内刷新' }
    }
    const running = await this.isScrcpyRunning()
    if (running && !restart) {
      return { running: true, alreadyRunning: true }
    }
    if (running && restart) {
      await run('taskkill', ['/IM', 'scrcpy.exe', '/F'], { allowFail: true, timeout: 10000 })
      await sleep(700)
    }
    const path = this.store.get('scrcpyPath')
    if (!path || !existsSync(path)) throw new Error(`scrcpy 不存在: ${path}`)
    const child = spawn(path, [
      '--no-audio',
      '--turn-screen-off',
      '--window-title=DSH 手机镜像',
      '--window-x=-640',
      '--window-y=0',
      '--window-width=640',
      '--window-height=1080',
    ], {
      cwd: dirname(path),
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: this.adbEnv({ ADB: this.adbPath }),
    })
    child.unref()
    this.scrcpyChild = child
    await sleep(2200)
    return { running: true, alreadyRunning: false, pid: child.pid, screenOff: true }
  }
}
