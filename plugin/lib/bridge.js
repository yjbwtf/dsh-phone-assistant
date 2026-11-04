import { sleep } from './util.js'

export class WeChatBridge {
  constructor(a11y, wechat, agent, store, bus) {
    this.a11y = a11y
    this.wechat = wechat
    this.agent = agent
    this.store = store
    this.bus = bus
    this.enabled = false
    this.lastSeq = 0
    this.serviceStartedAt = 0
    this.loopToken = 0
    this.inbox = []
    this.blocked = []
    this.seen = new Map()
    this.lastError = ''
    this.taskStartedAt = 0
    this.taskTarget = ''
    this.taskLastText = ''
    this.taskSource = ''
    this.taskLastRelayed = false
    this.progressTimer = null
    this.progressSending = false
    this.assistantUnsubscribe = bus.subscribe((event) => {
      if (event.type === 'assistant') this.onAssistant(event).catch(() => {})
      if (event.type === 'wechat-out') this.recordOutbound(event)
      if (event.type === 'turn' && event.phase === 'start') this.startTaskProgress(event)
      if (event.type === 'turn' && event.phase === 'end') {
        this.finishTaskProgress(event).catch(() => {})
        if (event.reason !== 'completed') this.lastError = `Agent turn ended: ${event.reason}`
      }
    })
  }

  targets() {
    const values = this.store.targets?.()
    return values && values.length > 0 ? values : (this.store.get('wechatTarget') ? [this.store.get('wechatTarget')] : [])
  }

  isAdmin(sender) {
    if (this.store.get('adminOnly') === false) return true
    const admins = this.store.get('adminContacts') || []
    const name = String(sender ?? '').trim()
    if (!name) return false
    return admins.some((admin) => {
      const value = String(admin ?? '').trim()
      return value && (name === value || name.includes(value) || value.includes(name))
    })
  }

  isAtMessage(item, message) {
    const blob = [
      message?.text,
      item?.text,
      item?.bigText,
      item?.subText,
      item?.ticker,
      item?.infoText,
      ...(Array.isArray(item?.eventText) ? item.eventText : []),
    ].filter(Boolean).join(' ')
    return /有人@我|@我|@你|@所有人|\[有人@我\]/u.test(blob)
  }

  async ensureAdbIme() {
    try {
      await this.wechat.ensureTools()
      await this.wechat.ensureIme()
      this.bus.log('info', '已切换 ADBKeyboard 输入法')
      return true
    } catch (error) {
      this.bus.log('warn', `切换 ADBKeyboard 失败: ${error.message}`)
      return false
    }
  }

  async start() {
    if (this.enabled) return this.status()
    this.enabled = true
    this.store.update({ bridgeEnabled: true })
    this.bus.emit('bridge', { enabled: true, targets: this.targets(), target: this.targets()[0] || '' })
    this.loopToken += 1
    const token = this.loopToken
    try {
      const ping = await this.a11y.ensure()
      this.serviceStartedAt = Number(ping.startedAt ?? 0)
      this.lastSeq = Number(ping.latestNotificationSeq ?? 0)
      this.bus.log('info', `微信桥已启动，正在监听新消息（${this.targets().join('、') || '未配置'}）`)
    } catch (error) {
      this.lastError = error.message
      this.bus.log('warn', `无障碍服务未就绪，仍在后台重试: ${error.message}`)
    }
    await this.ensureAdbIme()
    this.loop(token).catch((error) => {
      this.lastError = error.message
      this.bus.log('error', `微信桥循环异常: ${error.message}`)
    })
    return this.status()
  }

  async stop() {
    this.enabled = false
    this.loopToken += 1
    this.store.update({ bridgeEnabled: false })
    this.bus.emit('bridge', { enabled: false, targets: this.targets(), target: this.targets()[0] || '' })
    this.bus.log('info', '微信桥已停止')
    return this.status()
  }

  async setEnabled(enabled) {
    if (enabled) return await this.start()
    return await this.stop()
  }

  async loop(token) {
    while (this.enabled && token === this.loopToken) {
      try {
        await sleep(2000)
        const result = await this.a11y.notifications()
        if (this.lastError) {
          this.bus.log('info', '微信桥连接已恢复')
          this.lastError = ''
        }
        const items = Array.isArray(result.items) ? result.items : []
        for (const item of items) {
          const seq = Number(item.seq) || 0
          if (seq <= this.lastSeq) continue
          this.lastSeq = seq
          await this.handleItem(item)
        }
        const latest = Number(result.latestSeq ?? 0)
        if (latest > this.lastSeq) this.lastSeq = latest
      } catch (error) {
        if (!this.enabled || token !== this.loopToken) return
        if (!this.lastError) this.bus.log('warn', `微信桥连接中断，重试中: ${error.message}`)
        this.lastError = error.message
        await sleep(3000)
        try {
          const ping = await this.a11y.ensure(true)
          const startedAt = Number(ping.startedAt ?? 0)
          if (startedAt !== this.serviceStartedAt) {
            this.serviceStartedAt = startedAt
            this.lastSeq = Number(ping.latestNotificationSeq ?? 0)
          }
        } catch (retryError) {
          this.lastError = retryError.message
          await sleep(3000)
        }
      }
    }
  }

  async handleItem(item) {
    if (!item || item.package !== 'com.tencent.mm') return
    const targets = this.targets()
    if (targets.length === 0) return
    const messages = this.wechat.extractMessages(item, targets)
    for (const message of messages) {
      const admin = this.isAdmin(message.sender)
      const mention = !admin && this.store.get('groupAtOnly') !== false && this.isAtMessage(item, message)
      if (!admin && !mention) {
        const blocked = {
          direction: 'blocked',
          target: message.target,
          sender: message.sender,
          text: message.text,
          time: Number(message.time) || Date.now(),
          seq: Number(item.seq) || 0,
          blocked: true,
        }
        this.blocked.push(blocked)
        if (this.blocked.length > 100) this.blocked.splice(0, this.blocked.length - 100)
        this.inbox.push(blocked)
        if (this.inbox.length > 120) this.inbox.splice(0, this.inbox.length - 120)
        this.bus.log('warn', `非管理员消息已记录（不回复）: ${message.sender}: ${String(message.text).slice(0, 100)}`)
        this.bus.emit('wechat-blocked', blocked)
        continue
      }
      const key = `${message.target}|${message.sender}|${message.text}|${Math.floor((Number(message.time) || Date.now()) / 120000)}`
      if (this.seen.has(key)) continue
      this.seen.set(key, Date.now())
      for (const [oldKey, at] of this.seen) {
        if (Date.now() - at > 10 * 60 * 1000) this.seen.delete(oldKey)
      }
      const entry = {
        direction: 'in',
        target: message.target,
        sender: message.sender,
        text: message.text,
        time: Number(message.time) || Date.now(),
        seq: Number(item.seq) || 0,
        mention,
      }
      this.inbox.push(entry)
      if (this.inbox.length > 120) this.inbox.splice(0, this.inbox.length - 120)
      this.bus.emit('wechat-in', entry)
      if (!this.enabled) continue
      try {
        if (!this.agent.turnActive && typeof this.agent.decideQuickAck === 'function') {
          try {
            const ack = await this.agent.decideQuickAck(message.text, message.target)
            if (ack) await this.wechat.send(message.target, ack, { background: true })
          } catch (error) {
            this.bus.log('warn', `快速确认判断失败，继续执行: ${error.message}`)
          }
        }
        await this.agent.submitWechat(message.sender, message.text, message.target)
        this.bus.log('info', mention ? `群@消息已交给 Agent: ${message.target}` : `微信消息已交给 Agent: ${message.target}`)
      } catch (error) {
        this.lastError = error.message
        this.bus.log('error', `微信消息转交 Agent 失败: ${error.message}`)
      }
    }
  }

  recordOutbound(event) {
    const text = String(event.text ?? '').trim()
    if (!text) return
    const entry = {
      direction: 'out',
      target: event.target || '',
      sender: '蓝色大肥鱼',
      text,
      time: Number(event.at) || Number(event.time) || Date.now(),
    }
    this.inbox.push(entry)
    if (this.inbox.length > 120) this.inbox.splice(0, this.inbox.length - 120)
  }

  startTaskProgress(event) {
    this.clearProgressTimer()
    if (this.store.get('notifyTaskProgress') === false) return
    const target = String(event.target || this.store.get('wechatTarget') || this.targets()[0] || '').trim()
    if (!target) return
    this.taskStartedAt = Date.now()
    this.taskTarget = target
    this.taskLastText = ''
    this.taskSource = event.target ? 'wechat' : 'ui'
    this.taskLastRelayed = false
    const minutes = Math.max(1, Number(this.store.get('progressIntervalMinutes')) || 30)
    this.progressTimer = setInterval(() => this.sendProgress().catch(() => {}), minutes * 60 * 1000)
    this.progressTimer.unref?.()
  }

  clearProgressTimer() {
    if (this.progressTimer) {
      clearInterval(this.progressTimer)
      this.progressTimer = null
    }
  }

  async sendProgress() {
    if (!this.taskStartedAt || this.progressSending) return
    const minutes = Math.max(1, Math.round((Date.now() - this.taskStartedAt) / 60000))
    const snippet = String(this.taskLastText || '').replace(/\s+/g, ' ').trim().slice(0, 180)
    const text = `还在弄，差不多 ${minutes} 分钟了\n${snippet || '别急，弄完我跟你说'}`
    this.progressSending = true
    try {
      await this.wechat.send(this.taskTarget || this.store.get('wechatTarget'), text, { background: true })
      this.bus.log('info', '已发送任务进度到微信', { minutes })
    } catch (error) {
      this.bus.log('warn', `任务进度发送失败: ${error.message}`)
    } finally {
      this.progressSending = false
    }
  }

  async finishTaskProgress(event) {
    this.clearProgressTimer()
    if (!this.taskStartedAt || this.store.get('notifyTaskProgress') === false) {
      this.taskStartedAt = 0
      return
    }
    const target = String(event.target || this.taskTarget || this.store.get('wechatTarget') || this.targets()[0] || '').trim()
    const finalText = String(this.taskLastText || '').trim()
    const alreadyRelayed = this.taskLastRelayed
    this.taskStartedAt = 0
    this.taskTarget = ''
    this.taskLastText = ''
    this.taskSource = ''
    this.taskLastRelayed = false
    if (!target) return
    // 正常回复已经作为聊天发出去了，不再补一条“弄完了”。
    if (alreadyRelayed) return
    const text = finalText || (event.reason === 'completed' ? '' : '这次没弄成')
    if (!text) return
    try {
      await this.wechat.send(target, text, { background: true, split: true })
      this.bus.log('info', '已补发任务结果到微信', { target })
    } catch (error) {
      this.bus.log('warn', `任务结果补发失败: ${error.message}`)
    }
  }

  async onAssistant(event) {
    const text = String(event.text ?? '').trim()
    if (text) {
      this.taskLastText = text
      this.taskSource = event.source || this.taskSource
    }
    if (!this.enabled || !this.store.get('relayReplies')) return
    if (event.source !== 'wechat') return
    if (!text) return
    const target = String(event.target || this.targets()[0] || '').trim()
    if (!target) return
    this.taskLastRelayed = true
    try {
      await this.wechat.send(target, text, { background: true, split: true })
    } catch (error) {
      this.taskLastRelayed = false
      this.lastError = error.message
      this.bus.log('error', `Agent 回复发送微信失败: ${error.message}`)
      this.bus.emit('error', { message: `微信回复发送失败: ${error.message}` })
    }
  }

  status() {
    return {
      enabled: this.enabled,
      target: this.targets()[0] || '',
      targets: this.targets(),
      adminOnly: this.store.get('adminOnly') !== false,
      adminContacts: this.store.get('adminContacts') || [],
      lastSeq: this.lastSeq,
      lastError: this.lastError,
      inbox: this.inbox.slice(-60),
      blocked: this.blocked.slice(-30),
    }
  }

  dispose() {
    this.enabled = false
    this.loopToken += 1
    this.clearProgressTimer()
    try { this.assistantUnsubscribe?.() } catch {}
  }
}
