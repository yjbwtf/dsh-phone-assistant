import net from 'node:net'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sleep } from './util.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '..')
const A11Y_COMPONENT = 'com.dsh.phoneaccess/com.dsh.phoneaccess.A11yService'
const A11Y_PACKAGE = 'com.dsh.phoneaccess'
const A11Y_PORT = 27183

export class A11yBridge {
  constructor(phone, store, bus) {
    this.phone = phone
    this.store = store
    this.bus = bus
    this.ready = false
    this.lastPing = null
    this.latestSeq = 0
    this.recoveryLogged = false
  }

  get apkPath() {
    return resolve(PACKAGE_ROOT, 'assets', 'dsh-a11y.apk')
  }

  async call(cmd, params = {}, timeout = 12000) {
    const request = { id: Date.now() % 1000000, cmd, ...params }
    return await new Promise((resolvePromise, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: A11Y_PORT })
      let buffer = ''
      let settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        if (error) reject(error)
        else resolvePromise(value)
      }
      const timer = setTimeout(() => finish(new Error(`无障碍服务响应超时 (${cmd})`)), timeout)
      socket.setEncoding('utf8')
      socket.on('connect', () => {
        socket.write(JSON.stringify(request) + '\n')
      })
      socket.on('data', (chunk) => {
        buffer += chunk
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const line = buffer.slice(0, newline)
        try {
          const response = JSON.parse(line)
          if (!response.ok) finish(new Error(response.error || '无障碍命令失败'))
          else finish(null, response.data ?? {})
        } catch (error) {
          finish(new Error(`无障碍响应解析失败: ${error.message}`))
        }
      })
      socket.on('error', (error) => finish(error))
      socket.on('close', () => {
        if (!settled) finish(new Error('无障碍服务连接已关闭'))
      })
    })
  }

  async ensure(force = false) {
    if (this.ready && !force) return this.lastPing ?? { service: true }
    if (this.ready && force) {
      try {
        return await this.ping()
      } catch (error) {
        this.ready = false
        this.bus.log('warn', `无障碍服务已断开: ${error.message}`)
      }
    }
    if (!this.phone.store.get('adbPath')) throw new Error('未配置 ADB')
    const pkg = await this.phone.shell(`pm path ${A11Y_PACKAGE}`, { allowFail: true })
    if (!pkg.includes('package:')) {
      if (!existsSync(this.apkPath)) throw new Error(`无障碍 APK 缺失: ${this.apkPath}`)
      this.bus.log('info', '正在安装无障碍助手 APK')
      await this.phone.installApk(this.apkPath)
      await sleep(600)
    }
    await this.phone.forward(A11Y_PORT)
    await this.phone.enableAccessibility(A11Y_COMPONENT)
    let lastError
    for (let i = 0; i < 8; i++) {
      try {
        const ping = await this.call('ping', {}, 3000)
        const wasReady = this.ready
        this.ready = true
        this.lastPing = ping
        this.latestSeq = Number(ping.latestNotificationSeq ?? 0)
        this.recoveryLogged = false
        if (!wasReady) this.bus.log('info', '无障碍服务已连接', { package: A11Y_PACKAGE })
        return ping
      } catch (error) {
        lastError = error
        await sleep(500)
      }
    }
    try {
      if (!this.recoveryLogged) {
        this.recoveryLogged = true
        this.bus.log('warn', '无障碍 socket 无响应，尝试重启无障碍服务')
      }
      await this.phone.shell(`am force-stop ${A11Y_PACKAGE}`, { allowFail: true })
      await this.phone.shell('settings put secure accessibility_enabled 0', { allowFail: true })
      await sleep(900)
      await this.phone.shell('settings put secure accessibility_enabled 1', { allowFail: true })
      await this.phone.enableAccessibility(A11Y_COMPONENT)
      await this.phone.forward(A11Y_PORT)
      for (let i = 0; i < 8; i++) {
        try {
          const ping = await this.call('ping', {}, 3000)
          this.ready = true
          this.lastPing = ping
          this.latestSeq = Number(ping.latestNotificationSeq ?? 0)
          this.recoveryLogged = false
          this.bus.log('info', '无障碍服务已恢复', { package: A11Y_PACKAGE })
          return ping
        } catch (error) {
          lastError = error
          await sleep(600)
        }
      }
    } catch (error) {
      lastError = error
    }
    const wasReady = this.ready
    this.ready = false
    if (wasReady) this.bus.log('warn', `无障碍服务已断开: ${lastError?.message ?? '未知错误'}`)
    throw new Error(`无障碍服务未就绪: ${lastError?.message ?? '未知错误'}`)
  }

  async ping() {
    const ping = await this.call('ping', {}, 4000)
    this.ready = true
    this.lastPing = ping
    return ping
  }

  async dump() {
    return await this.call('dump', {}, 12000)
  }

  async windows() {
    return await this.call('windows', {}, 8000)
  }

  async foreground() {
    return await this.call('foreground', {}, 5000)
  }

  async tap(x, y) {
    return await this.call('click_xy', { x: Math.round(Number(x)), y: Math.round(Number(y)) }, 5000)
  }

  async swipe(x1, y1, x2, y2, duration = 300) {
    return await this.call('swipe', {
      x1: Math.round(Number(x1)),
      y1: Math.round(Number(y1)),
      x2: Math.round(Number(x2)),
      y2: Math.round(Number(y2)),
      durationMs: Math.round(Number(duration)),
    }, 5000)
  }

  async find(query, all = false) {
    return await this.call('find', { query, all }, 8000)
  }

  async click(query) {
    return await this.call('click', { query }, 5000)
  }

  async setText(text, query) {
    return await this.call('set_text', { text, ...(query ? { query } : {}) }, 6000)
  }

  async global(action) {
    return await this.call('global', { action }, 5000)
  }

  async notifications() {
    return await this.call('notifications', {}, 8000)
  }

  async waitNotification(afterSeq, timeoutMs = 15000) {
    return await this.call('wait_notification', { afterSeq, timeoutMs }, timeoutMs + 5000)
  }

  async clearNotifications() {
    return await this.call('clear_notifications', {}, 5000)
  }
}
