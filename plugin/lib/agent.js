import { randomUUID } from 'node:crypto'
import { sleep, truncate } from './util.js'
import { appLabel, suggestSkillAction } from './apps.js'

function textFromMessage(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim()
}

function isSmallTalk(text) {
  const value = String(text ?? '').trim().toLowerCase()
  if (!value) return true
  if (value.length <= 2 && !/播放|放歌|听歌|搜索|搜|发送|打开|启动|录|截图|点击|滑动|音乐/.test(value)) return true
  return /^(oi|hi|hello|嗨|你好|在吗|嗯|哦|啊|ok|okay|好|收到|哈哈|草|？|\?|。|\.|!|！)+$/u.test(value)
}

function cleanGoal(text) {
  return String(text ?? '')
    .replace(/^\[[^\]]+\]\s*/u, '')
    .replace(/不要发(?:微信)?消息[。.]?/gu, '')
    .replace(/完成后.*$/u, '')
    .replace(/在手机上|帮我|请|麻烦|一下/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

function operationVerb(text) {
  if (/播放|听歌|音乐/iu.test(text)) return '播放'
  if (/搜索|搜/iu.test(text)) return '搜索'
  if (/发送|发消息|回复/iu.test(text)) return '发消息'
  if (/录制|录像|视频/iu.test(text)) return '录像'
  if (/打开|启动/iu.test(text)) return '打开'
  return '操作'
}

function ratio(value, total) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return Math.round((number / total) * 1000) / 1000
}

function buildSkillStep(tool) {
  if (!tool || !tool.action) return null
  if (tool.action === 'launch' && tool.target) return { action: 'launch', target: tool.target }
  if (tool.action === 'tap') {
    const x = ratio(tool.x, 1080)
    const y = ratio(tool.y, 2340)
    if (x === null || y === null) return null
    return { action: 'tap', x, y }
  }
  if (tool.action === 'swipe') {
    const x1 = ratio(tool.x1, 1080)
    const y1 = ratio(tool.y1, 2340)
    const x2 = ratio(tool.x2, 1080)
    const y2 = ratio(tool.y2, 2340)
    if ([x1, y1, x2, y2].some((value) => value === null)) return null
    return { action: 'swipe', x1, y1, x2, y2, duration: Number(tool.duration) || 300 }
  }
  if (tool.action === 'text') return { action: 'text', text: '{{text}}' }
  if (tool.action === 'key' && tool.key) return { action: 'key', key: tool.key }
  if (tool.action === 'wake') return { action: 'wake' }
  if (tool.action === 'open' && tool.target) return { action: 'open', target: tool.target }
  return null
}

function describeStep(step) {
  if (step.action === 'launch') return `启动 ${appLabel(step.target)}`
  if (step.action === 'tap') return `点击 ${step.x},${step.y}`
  if (step.action === 'swipe') return `滑动 ${step.x1},${step.y1} → ${step.x2},${step.y2}`
  if (step.action === 'text') return '输入 {{text}}'
  if (step.action === 'key') return `按键 ${step.key}`
  if (step.action === 'wake') return '唤醒'
  if (step.action === 'open') return `打开 ${step.target}`
  return step.action
}

export class AgentBridge {
  constructor(ctx, store, bus, options = {}) {
    this.ctx = ctx
    this.store = store
    this.bus = bus
    this.phone = options.phone
    this.memory = options.memory
    this.sessionId = store.get('pendingSessionId') || ''
    this.agent = null
    this.promptDisposer = null
    this.startSeq = 0
    this.ready = false
    this.initPromise = null
    this.lastSource = 'wechat'
    this.turnActive = false
    this.wechatTargetQueue = []
    this.turnWechatTarget = null
    this.pendingGoals = []
    this.queuedMessages = []
    this.quickAck = null
    this.currentGoal = ''
    this.currentTurnTools = []
    this.history = []
    this.eventDisposer = ctx.on('session/event', (session, event) => {
      this.handleEvent(session, event).catch((error) => {
        this.bus.log('warn', `会话事件处理失败: ${error.message}`)
      })
    })
  }

  personaText() {
    const targets = this.store.targets()
    const targetText = targets.length > 0 ? targets.join('、') : '（尚未配置）'
    const admins = (this.store.get('adminContacts') || []).join('、') || '（未配置）'
    return `${this.store.get('persona')}

## 当前通道
你通过微信与用户对话，当前监听的微信聊天是：${targetText}。管理员：${admins}。桥接只接受管理员消息；非管理员消息不会交给你。
主聊天会优先从微信首页第一行直接进入（设置中可关闭），失败才用搜索。
桥接会把你发给用户的回复自动转成微信消息；除非用户明确要求，不要用 wechat 工具另发消息。
当微信有新消息时，桥接会以「[微信消息]」开头把内容交给你。你可以直接回复，回复会自动发回微信。

## 工具与手机
- 重复的 App 操作优先用 phone_skill：先 action=list 看已有技能，匹配就 action=run 并只传参数（如 {"text":"歌名"}）；没有再用 action=save 保存逻辑步骤。技能名用“应用-动作”，例如“天气-查看当前天气”“微信-打开聊天”“相机-拍摄”，不要只写“操作”；不要把当时的歌名、歌手、工作室或“不要发微信消息”这类一次性条件写进去。
- 开始一个 App 前可以用 memory 工具搜索；系统自动附带的「长期记忆命中」只是提示，和当前消息无关就直接忽略，不要复述、不要为了它多做操作。
- 只保存可复用的动作链（启动、点击、输入参数、按键），不保存整段用户原话；点击坐标用 0-1 比例。
- 手机操作使用 phone 工具：status、screenshot、ui、tap、swipe、text、key、launch、shell、notifications、a11y。
- 微信聊天界面会阻止无障碍读取节点；需要看微信时，优先用「wechat action=vision」让视觉模型识别聊天里的文字、图片和表情；也可以「phone action=screenshot」后用 read_image 查看，再按坐标点击。不要声称读到了截图里没有的信息。
- 识别普通 App/手机屏幕时可用「phone action=vision」，它会截图后调用已配置的视觉模型。
- 发微信优先用「wechat action=send」（会自动处理中文输入和发送），也可以「wechat action=open」只打开聊天。
- 表情包库只用于本地保存、搜索和打标；微信没有稳定可用的表情发送接口，不要用 meme 发送，也不要用相册猜着发。
- 想用网络热梗、接梗或玩梗时，先用 memekb action=search 查含义、用法和风险；不确定或高风险就别用，别硬凹、别连续堆梗。
- 操作电脑使用 pwsh、文件等工具；电脑和手机都可以操作。
- 看电脑桌面、实时画面、一起看视频时用 see_now；它的 say 只显示在电脑悬浮窗，微信回复仍由桥接发送。看手机画面用 phone 的 screenshot/vision/see（see 会连续截图并按变化拼图），不要用 see_now 代替手机截图。
- 遇到没把握的新梗/黑话先查 search_meme_wiki（本地词库）；需要判断用法或冒犯风险时再用 memekb。查到梗先接梗，别念百科。
- 不要向非目标联系人发消息，不要泄露密码、验证码或隐私内容。

## 风格
像微信里的真人聊天，不要客服腔和 AI 总结腔。闲聊短句、有反应；办事时准确简洁，先给结果，必要时再解释。不要每轮都列清单或反问。`
  }

  async ensure() {
    if (this.ready && this.agent) return this.agent
    if (this.initPromise) return await this.initPromise
    this.initPromise = this.initialize().finally(() => {
      this.initPromise = null
    })
    return await this.initPromise
  }

  async initialize() {
    if (this.sessionId) {
      try {
        const resolved = await this.ctx.sessionController.resolveAgent(this.sessionId)
        if (resolved?.agent) {
          await this.setupAgent(resolved.agent, false)
          this.bus.log('info', `已恢复微信助手会话 ${this.sessionId}`)
          return resolved.agent
        }
      } catch (error) {
        this.bus.log('warn', `恢复会话失败，将新建: ${error.message}`)
      }
      this.sessionId = ''
      this.agent = null
      this.ready = false
    }

    let workspaceId
    let workspaceTitle = '手机助手'
    const cwd = this.store.get('cwd')
    const registry = this.ctx.get('workspaceRegistry')
    if (registry && cwd) {
      try {
        let workspace = await registry.resolveByPath(cwd)
        if (!workspace) workspace = await registry.create(cwd, workspaceTitle)
        workspaceId = workspace.id
      } catch (error) {
        this.bus.log('warn', `无法准备工作区，将使用独立会话: ${error.message}`)
      }
    }

    const request = workspaceId ? { workspaceId } : { cwd }
    const created = await this.ctx.sessionController.create(request)
    this.sessionId = created.sessionId
    this.store.update({ pendingSessionId: this.sessionId })
    this.bus.log('info', `已创建微信助手会话 ${this.sessionId}`)

    const resolved = await this.ctx.sessionController.resolveAgent(this.sessionId)
    if (!resolved?.agent) throw new Error(resolved?.error?.message || '无法启动微信助手 Agent')
    await this.setupAgent(resolved.agent, true)
    return resolved.agent
  }

  async setupAgent(agent, isNew) {
    this.agent = agent
    this.ready = true
    try {
      const liveSession = this.ctx.get('sessions')?.get(this.sessionId)
      this.startSeq = Number(agent.session?.seq ?? liveSession?.seq ?? 0) || 0
      this.history = this.loadHistory(agent.session ?? liveSession)
    } catch {
      this.startSeq = 0
    }
    if (this.promptDisposer) {
      try { this.promptDisposer() } catch {}
      this.promptDisposer = null
    }
    this.promptDisposer = agent.ctx.systemPrompt.section({
      name: 'phone-bridge:persona',
      order: 4200,
      text: this.personaText(),
    })
    if (isNew) {
      try {
        await this.ctx.sessionController.rename({
          sessionId: this.sessionId,
          title: '微信手机助手',
        })
      } catch (error) {
        this.bus.log('warn', `会话重命名失败: ${error.message}`)
      }
    }
    this.bus.emit('agent', {
      sessionId: this.sessionId,
      status: 'ready',
      cwd: this.store.get('cwd'),
    })
  }

  async submitWechat(sender, text, target) {
    return await this.submit(`[微信消息 · ${sender}]\n${text}`, 'wechat', target || sender)
  }

  async submitUi(text) {
    return await this.submit(`[桌面控制台]\n${text}`, 'ui')
  }

  async submit(text, source = 'ui', replyTarget = '') {
    const content = String(text ?? '').trim()
    if (!content) throw new Error('消息内容为空')
    await this.ensure()
    if (this.turnActive && source === 'wechat') {
      this.queuedMessages.push({ text: content, source, target: replyTarget || this.store.get('wechatTarget') || '', at: Date.now() })
      this.bus.log('info', '收到新的微信消息，已排入当前流程之后合并处理')
      return { queued: true }
    }
    this.lastSource = source
    const target = source === 'wechat' ? String(replyTarget || this.store.get('wechatTarget') || '').trim() : ''
    if (target) this.wechatTargetQueue.push(target)
    const goal = content.replace(/^\[[^\]]+\]\s*/u, '').trim()
    let app = ''
    try {
      app = String((await this.phone?.status())?.package ?? '')
    } catch {}
    let memoryBlock = ''
    if (this.memory && this.store.get('memoryRecall') !== false && !isSmallTalk(goal)) {
      try {
        memoryBlock = this.memory.recallRelevant
          ? await this.memory.recallRelevant(goal, { app, limit: 1 })
          : this.memory.recall(goal, { app, limit: 1 })
      } catch (error) {
        this.bus.log('warn', `长期记忆检索失败: ${error.message}`)
      }
    }
    const promptText = memoryBlock ? `${content}\n\n${memoryBlock}` : content
    this.pendingGoals.push({ goal, source })
    try {
      this.memory?.appendConversation('user', goal, source, this.sessionId)
      if (this.memory && this.memory.conversationCount() >= 20) this.memory.compactConversation(20)
    } catch (error) {
      this.bus.log('warn', `对话缓冲写入失败: ${error.message}`)
    }
    const request = {
      requestId: randomUUID(),
      sessionId: this.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: promptText }],
      clientTimeZone: 'Asia/Shanghai',
    }
    const controller = new AbortController()
    try {
      await this.ctx.sessionController.prompt(request, controller.signal)
    } catch (error) {
      if (target) {
        const index = this.wechatTargetQueue.lastIndexOf(target)
        if (index >= 0) this.wechatTargetQueue.splice(index, 1)
      }
      this.pendingGoals.pop()
      if (/not-found|disposed|resume/i.test(String(error?.message ?? error))) {
        this.ready = false
        this.agent = null
        await this.ensure()
        request.sessionId = this.sessionId
        if (target) this.wechatTargetQueue.push(target)
        this.pendingGoals.push({ goal: content.replace(/^\[[^\]]+\]\s*/u, '').trim(), source })
        await this.ctx.sessionController.prompt(request, new AbortController().signal)
      } else {
        throw error
      }
    }
    this.pushHistory({ role: 'user', text: content, source, time: Date.now() })
    this.bus.emit('agent-user', { text: content, source, sessionId: this.sessionId })
    return { accepted: true, sessionId: this.sessionId }
  }

  async decideQuickAck(text, target = '') {
    const content = String(text ?? '').trim()
    if (!content) return ''
    await this.ensure()
    if (this.turnActive || this.quickAck) return ''
    const prompt = [
      '[内部快速判断：只输出一行，不要执行任务，不要调用任何工具]',
      `用户刚发来：${content.slice(0, 600)}`,
      '判断这条消息是否需要先回一句“我马上去看/稍等”的确认。',
      '如果需要：只输出一句自然的确认，10-25字，符合你的人格；不要回答具体问题，不要解释。',
      '如果只是闲聊、纠正、否定、反馈、情绪表达，或直接回答即可：只输出 [NO_ACK]。',
    ].join('\n')
    const request = {
      requestId: randomUUID(),
      sessionId: this.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: prompt }],
      clientTimeZone: 'Asia/Shanghai',
    }
    return await new Promise((resolve) => {
      const finish = (value) => {
        if (!this.quickAck) return
        const pending = this.quickAck
        this.quickAck = null
        if (pending.timer) clearTimeout(pending.timer)
        resolve(value)
      }
      const timer = setTimeout(() => finish(''), 15000)
      this.quickAck = { resolve, timer, target, text: '' }
      this.ctx.sessionController.prompt(request, new AbortController().signal).catch((error) => {
        this.bus.log('warn', `快速确认判断失败: ${error.message}`)
        finish('')
      })
    })
  }

  loadHistory(session) {
    if (!session || typeof session.snapshotEvents !== 'function') return []
    try {
      const events = session.snapshotEvents()
      const items = []
      for (const event of events) {
        if (event.type === 'user/message') {
          const text = textFromMessage(event.data?.message ?? event.data)
          if (!text) continue
          if (!text.startsWith('[桌面控制台]') && !text.startsWith('[微信消息')) continue
          items.push({
            role: 'user',
            text,
            source: text.startsWith('[微信消息') ? 'wechat' : 'ui',
            time: event.time,
          })
        } else if (event.type === 'assistant/message') {
          const text = textFromMessage(event.data?.message ?? event.data)
          if (!text) continue
          items.push({ role: 'assistant', text, time: event.time })
        }
      }
      return items.slice(-40)
    } catch {
      return []
    }
  }

  async handleEvent(session, event) {
    if (!this.sessionId || session?.id !== this.sessionId) return
    if (Number(event.seq) < this.startSeq) return
    if (event.type === 'assistant/message') {
      const text = textFromMessage(event.data?.message)
      if (!text) return
      if (this.quickAck) {
        this.quickAck.text = text
        return
      }
      this.pushHistory({ role: 'assistant', text, time: Date.now() })
      try {
        this.memory?.appendConversation('assistant', text, this.lastSource, this.sessionId)
        if (this.memory && this.memory.conversationCount() >= 20) this.memory.compactConversation(20)
      } catch (error) {
        this.bus.log('warn', `对话缓冲写入失败: ${error.message}`)
      }
      this.bus.emit('assistant', {
        text,
        sessionId: this.sessionId,
        source: this.lastSource,
        target: this.turnWechatTarget,
        seq: event.seq,
      })
      return
    }
    if (event.type === 'tool/call') {
      const name = event.data?.name ?? 'tool'
      let args = {}
      try { args = JSON.parse(event.data?.arguments ?? '{}') } catch {}
      if (name === 'phone' || name === 'wechat') {
        const action = String(args.action ?? '')
        const operation = {
          name,
          action,
          target: args.target ? String(args.target).slice(0, 80) : undefined,
          chars: args.text ? String(args.text).length : undefined,
          x: args.x,
          y: args.y,
          x1: args.x1,
          y1: args.y1,
          x2: args.x2,
          y2: args.y2,
          duration: args.duration,
          key: args.key,
          app: args.target && name === 'phone' && action === 'launch' ? String(args.target).slice(0, 80) : undefined,
        }
        if (['tap', 'swipe', 'text', 'key', 'launch', 'shell', 'wake', 'scrcpy', 'a11y'].includes(action) || (name === 'wechat' && ['send', 'open'].includes(action))) {
          this.currentTurnTools.push(operation)
        }
      }
      const item = {
        role: 'tool',
        name,
        args: truncate(event.data?.arguments ?? '', 500),
        time: Date.now(),
      }
      this.pushHistory(item)
      this.bus.emit('tool-call', item)
      return
    }
    if (event.type === 'tool/result') {
      const content = textFromMessage(event.data?.message)
      const item = {
        role: 'tool-result',
        name: event.data?.message?.source?.callId ?? '',
        text: truncate(content, 1200),
        isError: Boolean(event.data?.error),
        time: Date.now(),
      }
      this.bus.emit('tool-result', item)
      return
    }
    if (event.type === 'turn/start') {
      if (this.quickAck) {
        this.turnActive = true
        this.turnWechatTarget = this.quickAck.target || null
        this.currentGoal = ''
        this.currentTurnTools = []
        return
      }
      this.turnActive = true
      this.turnWechatTarget = this.wechatTargetQueue.shift() ?? null
      this.currentGoal = this.pendingGoals.shift()?.goal ?? ''
      this.currentTurnTools = []
      this.bus.emit('turn', { phase: 'start', sessionId: this.sessionId, target: this.turnWechatTarget })
      return
    }
    if (event.type === 'turn/end') {
      if (this.quickAck) {
        const pending = this.quickAck
        this.quickAck = null
        if (pending.timer) clearTimeout(pending.timer)
        this.turnActive = false
        this.turnWechatTarget = null
        let reply = String(pending.text || '').trim()
        if (/NO_ACK/iu.test(reply)) reply = ''
        reply = reply.split(/\r?\n/u)[0].replace(/^["“”'‘’]+|["“”'‘’]+$/gu, '').replace(/[。.!！]+$/u, '').trim().slice(0, 80)
        pending.resolve(reply)
        return
      }
      this.turnActive = false
      const reason = event.data?.reason?.kind ?? 'completed'
      if (reason === 'completed') this.learnEpisode()
      this.bus.emit('turn', { phase: 'end', reason, sessionId: this.sessionId, target: this.turnWechatTarget })
      this.turnWechatTarget = null
      this.currentGoal = ''
      this.currentTurnTools = []
      const pending = this.queuedMessages.splice(0, 6)
      if (pending.length > 0) {
        const target = pending[pending.length - 1].target || this.store.get('wechatTarget') || ''
        const combined = pending.map((item) => item.text.replace(/^\[[^\]]+\]\s*/u, '').trim()).filter(Boolean).join('\n---\n')
        if (combined) {
          this.bus.log('info', `工作期间收到 ${pending.length} 条新消息，合并成下一轮回复`)
          setTimeout(() => {
            this.submit(`[微信消息]\n${combined}\n\n（以上是用户在等待期间补充的消息，请合并回复；不要重复前面已经说过的内容）`, 'wechat', target)
              .catch((error) => this.bus.log('warn', `合并消息处理失败: ${error.message}`))
          }, 80)
        }
      }
    }
  }

  learnEpisode() {
    if (!this.memory || this.store.get('autoLearn') === false) return
    const tools = Array.isArray(this.currentTurnTools) ? this.currentTurnTools : []
    if (tools.length < 1 || !this.currentGoal) return
    const meaningful = tools.filter((item) => ['tap', 'swipe', 'text', 'key', 'launch', 'open', 'wake'].includes(item.action))
    if (meaningful.length === 0) return
    try {
      const launch = meaningful.find((item) => item.action === 'launch' && item.target)
      const app = String(launch?.target || this.phone?.statusCache?.package || '')
      const goal = cleanGoal(this.currentGoal)
      const steps = []
      for (const tool of meaningful) {
        const step = buildSkillStep(tool)
        if (!step) continue
        const previous = steps[steps.length - 1]
        if (previous && JSON.stringify(previous) === JSON.stringify(step)) continue
        steps.push(step)
        if (steps.length >= 20) break
      }
      if (steps.length === 0) return
      const action = suggestSkillAction(app, steps, goal)
      const name = `${appLabel(app)}-${action}`
      const hasText = steps.some((step) => step.action === 'text')
      const params = hasText ? ['text'] : []
      this.memory.saveSkill({
        name,
        app,
        keywords: [appLabel(app), app, action, '技能'].filter(Boolean).join(' '),
        steps,
        params,
      })
      this.memory.pruneEpisodes(250)
      this.bus.emit('skill', { action: 'saved', title: name })
    } catch (error) {
      this.bus.log('warn', `技能保存失败: ${error.message}`)
    }
  }

  pushHistory(item) {
    this.history.push(item)
    if (this.history.length > 120) this.history.splice(0, this.history.length - 120)
  }

  status() {
    return {
      sessionId: this.sessionId,
      ready: this.ready,
      turnActive: this.turnActive,
      source: this.lastSource,
      history: this.history.slice(-40),
    }
  }

  async refreshPrompt() {
    if (!this.agent) return { refreshed: false }
    if (this.promptDisposer) {
      try { this.promptDisposer() } catch {}
      this.promptDisposer = null
    }
    this.promptDisposer = this.agent.ctx.systemPrompt.section({
      name: 'phone-bridge:persona',
      order: 4200,
      text: this.personaText(),
    })
    return { refreshed: true }
  }

  async reset() {
    if (this.promptDisposer) {
      try { this.promptDisposer() } catch {}
      this.promptDisposer = null
    }
    this.sessionId = ''
    this.agent = null
    this.ready = false
    this.startSeq = 0
    this.history = []
    this.store.update({ pendingSessionId: '' })
    await this.ensure()
    return this.status()
  }

  dispose() {
    try { this.eventDisposer?.() } catch {}
    try { this.promptDisposer?.() } catch {}
  }
}
