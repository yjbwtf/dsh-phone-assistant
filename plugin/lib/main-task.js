import { truncate } from './util.js'

function messageText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim()
}

/**
 * Reports long-running turns of the user's ordinary DSH sessions to WeChat.
 * The dedicated WeChat assistant session is excluded to avoid double reports.
 */
export class MainTaskReporter {
  constructor(ctx, store, wechat, bus, excludedSession) {
    this.store = store
    this.wechat = wechat
    this.bus = bus
    this.excludedSession = excludedSession
    this.tasks = new Map()
    this.disposeEvent = ctx.on('session/event', (session, event) => {
      this.handle(session, event).catch((error) => {
        this.bus.log('warn', `主任务进度处理失败: ${error.message}`)
      })
    })
    this.resumeActiveTasks(ctx)
  }

  resumeActiveTasks(ctx) {
    try {
      const agents = ctx.get('agents')?.list?.() ?? []
      for (const agent of agents) {
        const id = agent?.id ?? agent?.session?.id
        if (!id || id === this.excludedSession?.()) continue
        const session = agent?.session ?? ctx.get('sessions')?.get(id)
        if (!session || typeof session.snapshotEvents !== 'function') continue
        const events = session.snapshotEvents()
        if (!Array.isArray(events) || events.length === 0) continue
        const last = events[events.length - 1]
        if (last?.type === 'turn/end') continue
        let start = null
        for (let i = events.length - 1; i >= 0; i--) {
          if (events[i]?.type === 'turn/start') {
            start = events[i]
            break
          }
          if (events[i]?.type === 'turn/end') break
        }
        if (!start) continue
        const task = this.beginTask(id, Number(start.time) || Date.now())
        this.bus.log('info', '已接管进行中的主任务进度', { sessionId: id, startedAt: task.startedAt })
        for (let i = events.length - 1; i >= 0; i--) {
          if (events[i]?.type === 'turn/start') break
          if (events[i]?.type === 'assistant/message') {
            const text = messageText(events[i].data?.message)
            if (text) {
              task.lastText = text
              break
            }
          }
        }
      }
    } catch (error) {
      this.bus.log('warn', `恢复进行中的主任务失败: ${error.message}`)
    }
  }

  beginTask(id, startedAt = Date.now()) {
    const old = this.tasks.get(id)
    if (old?.timer) clearInterval(old.timer)
    const task = {
      startedAt,
      lastText: '',
      timer: null,
    }
    const minutes = Math.max(1, Number(this.store.get('progressIntervalMinutes')) || 30)
    task.timer = setInterval(() => {
      this.sendProgress(id).catch(() => {})
    }, minutes * 60 * 1000)
    task.timer.unref?.()
    this.tasks.set(id, task)
    return task
  }

  target() {
    return String(this.store.get('wechatTarget') || this.store.targets?.()[0] || '').trim()
  }

  async handle(session, event) {
    const id = session?.id
    if (!id) return
    if (id === this.excludedSession?.()) return
    if (this.store.get('notifyMainTaskProgress') === false) return
    const target = this.target()
    if (!target) return

    if (event.type === 'turn/start') {
      this.beginTask(id)
      return
    }

    const task = this.tasks.get(id)
    if (!task) return
    if (event.type === 'assistant/message') {
      const text = messageText(event.data?.message)
      if (text) task.lastText = text
      return
    }
    if (event.type === 'turn/end') {
      if (task.timer) clearInterval(task.timer)
      this.tasks.delete(id)
      const durationMinutes = Math.max(1, Math.round((Date.now() - task.startedAt) / 60000))
      const minMinutes = Math.max(1, Number(this.store.get('mainTaskMinMinutes')) || 3)
      if (durationMinutes < minMinutes) return
      const reason = event.data?.reason?.kind ?? 'completed'
      const text = truncate(task.lastText || (reason === 'completed' ? '' : '这次没弄成'), 1000)
      if (!text) return
      try {
        await this.wechat.send(target, text, { background: true, split: true })
        this.bus.log('info', '已发送主任务结果到微信', { durationMinutes, sessionId: id })
      } catch (error) {
        this.bus.log('warn', `主任务结果发送失败: ${error.message}`)
      }
    }
  }

  async sendProgress(sessionId) {
    const task = this.tasks.get(sessionId)
    if (!task) return
    const target = this.target()
    if (!target) return
    const minutes = Math.max(1, Math.round((Date.now() - task.startedAt) / 60000))
    const text = `还在弄，差不多 ${minutes} 分钟了\n${truncate(task.lastText || '别急，弄完我跟你说', 260)}`
    try {
      await this.wechat.send(target, text, { background: true })
      this.bus.log('info', '已发送主任务进度到微信', { minutes, sessionId })
    } catch (error) {
      this.bus.log('warn', `主任务进度发送失败: ${error.message}`)
    }
  }

  dispose() {
    for (const task of this.tasks.values()) if (task.timer) clearInterval(task.timer)
    this.tasks.clear()
    try { this.disposeEvent?.() } catch {}
  }
}
