(() => {
  const $ = (selector) => document.querySelector(selector)
  const $$ = (selector) => [...document.querySelectorAll(selector)]
  const state = { data: null, logs: [], tab: 'console', screenAt: 0, lastScreenUrl: '', activeTarget: '' }

  const titles = {
    console: ['控制台', 'ADB + 无障碍 + 读图回退，操作手机并和微信里的鱼鱼对话。'],
    wechat: ['微信桥', '监听手机微信新消息，自动交给 Agent，并把回复发回微信。'],
    agent: ['Agent', '和蓝色大肥鱼对话；她同时拥有电脑工具和手机工具。'],
    memory: ['长期记忆', '按需检索 App 操作方式与事实；不调用大模型，只取回命中的少量条目。'],
    skills: ['技能（Skills）', '查看、修改、新增或删除可复用的手机操作技能。'],
    persona: ['人格', '人格提示词与微信行为设置。'],
    settings: ['设置', '连接路径与本地依赖。'],
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;')
  }

  function formatTime(value) {
    const date = value ? new Date(value) : new Date()
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }

  function formatBytes(value) {
    const bytes = Number(value) || 0
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${bytes} B`
  }

  function toast(message, error = false) {
    const el = $('#toast')
    el.textContent = message
    el.classList.toggle('error', Boolean(error))
    el.classList.add('show')
    clearTimeout(toast.timer)
    toast.timer = setTimeout(() => el.classList.remove('show'), 3600)
  }

  async function api(path, body) {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
    if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`)
    return data
  }

  function setTab(tab) {
    if (!titles[tab]) return
    state.tab = tab
    $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.tab === tab))
    $$('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === tab))
    $('#pageTitle').textContent = titles[tab][0]
    $('#pageSub').textContent = titles[tab][1]
    if (tab === 'wechat') renderFeeds()
    if (tab === 'agent') renderFeeds()
    if (tab === 'memory') loadMemory()
    if (tab === 'console') refreshScreen()
    try { window.chrome?.webview?.postMessage({ type: 'tab', tab }) } catch {}
  }

  function setPill(el, text, kind) {
    el.textContent = text
    el.className = `pill ${kind || ''}`.trim()
  }

  function renderState(data) {
    state.data = data
    const device = data.device || {}
    const a11y = data.a11y || {}
    const bridge = data.bridge || {}
    const agent = data.agent || {}
    const settings = data.settings || {}

    if (device.online) {
      setPill($('#connPill'), '手机已连接', 'ok')
      $('#sideDevice').textContent = device.model || '已连接'
      $('#dModel').textContent = device.model || '—'
      $('#dAndroid').textContent = device.android ? `Android ${device.android}` : '—'
      $('#dBattery').textContent = device.battery == null ? '—' : `${device.battery}%`
      $('#dScreen').textContent = device.width && device.height ? `${device.width}×${device.height}` : '—'
      $('#dFocus').textContent = device.package ? `${device.package}${device.activity ? '/' + device.activity : ''}` : '—'
      $('#phoneMeta').textContent = `${device.model || ''} ${device.width || ''}×${device.height || ''}`
      $('#deviceChecked').textContent = `更新于 ${formatTime(device.checkedAt)}`
      $('#dShot').textContent = data.screenUrl ? '可刷新' : '—'
    } else {
      setPill($('#connPill'), device.error ? '手机未连接' : '连接中', 'bad')
      $('#sideDevice').textContent = '离线'
      $('#dModel').textContent = device.error || '—'
      $('#dAndroid').textContent = '—'
      $('#dBattery').textContent = '—'
      $('#dScreen').textContent = '—'
      $('#dFocus').textContent = device.error || '—'
      $('#phoneMeta').textContent = '离线'
      $('#phoneCover').classList.remove('hidden')
      $('#phoneCover').textContent = device.error || '手机未连接'
    }

    $('#dA11y').textContent = a11y.available ? '已连接' : (a11y.error ? '不可用' : '检测中')
    $('#dA11y').style.color = a11y.available ? 'var(--accent)' : 'var(--warn)'
    $('#compA11y').textContent = a11y.available ? `已启用 · 端口 27183` : (a11y.error || '未启用')
    $('#compIme').textContent = 'ADBKeyboard（自动安装）'
    $('#compScrcpy').textContent = settings.scrcpyPath || '—'
    $('#compData').textContent = settings.dataDir || '—'

    $('#sideBridge').textContent = bridge.enabled ? '监听中' : '未启动'
    $('#bridgeDot').classList.toggle('on', Boolean(bridge.enabled))
    $('#wechatQuickState').textContent = bridge.enabled ? '监听中' : '未启动'
    setPill($('#bridgeState'), bridge.enabled ? '监听中' : '未启动', bridge.enabled ? 'ok' : 'warn')
    $('#bridgeToggle').checked = Boolean(bridge.enabled)
    const targets = Array.isArray(settings.wechatTargets) && settings.wechatTargets.length > 0
      ? settings.wechatTargets
      : (settings.wechatTarget ? [settings.wechatTarget] : [])
    if (!targets.includes(state.activeTarget)) state.activeTarget = targets[0] || ''
    renderTargets(targets)
    if (document.activeElement !== $('#quickTarget')) $('#quickTarget').value = state.activeTarget || settings.wechatTarget || ''
    const hint = $('#wechatSendHint')
    if (hint) hint.textContent = `发送到：${state.activeTarget || '尚未选择聊天'}`
    $('#wechatCompose').placeholder = state.activeTarget ? `以本机身份给「${state.activeTarget}」发消息…` : '以本机身份给当前聊天发消息…'

    const sessionId = agent.sessionId || settings.pendingSessionId || ''
    $('#sideSession').textContent = sessionId ? sessionId.slice(0, 12) : '—'
    $('#sessionId').textContent = sessionId || '—'
    $('#sessionReady').textContent = agent.ready ? '运行中' : '未启动'
    $('#sessionCwd').textContent = settings.cwd || '—'
    $('#agentState').textContent = agent.ready ? (agent.turnActive ? '思考中…' : '空闲') : '未连接'
    $('#agentState2').textContent = $('#agentState').textContent
    if (data.memory) {
      $('#memoryStats').textContent = `${data.memory.total || 0} 条 · 短 ${data.memory.shortTerm || 0} · 长 ${data.memory.longTerm || 0} · ${formatBytes(data.memory.fileSize)} / ${formatBytes(data.memory.maxBytes)}`
    }
    $('#wechatFeedMeta').textContent = bridge.lastError
      ? `异常: ${bridge.lastError.slice(0, 48)}`
      : `${bridge.enabled ? '监听中' : '已停止'} · seq ${bridge.lastSeq || 0}`
    $('#deviceChecked').textContent = `更新于 ${formatTime(device.checkedAt)}`

    if (state.logs.length === 0 && Array.isArray(data.logs)) {
      state.logs = data.logs.slice(-200)
      renderLogs()
    }

    setForm(data)
    renderFeeds(data)
  }

  function renderTargets(targets) {
    const box = $('#targetChips')
    if (!box) return
    box.innerHTML = ''
    if (!targets || targets.length === 0) {
      box.innerHTML = '<div class="chip-empty">还没有监听聊天，添加一个联系人或群吧。</div>'
      return
    }
    for (const target of targets) {
      const chip = document.createElement('div')
      chip.className = `chip${target === state.activeTarget ? ' active' : ''}`
      chip.dataset.target = target
      chip.innerHTML = `<span>${escapeHtml(target)}</span><span class="x" title="移除">×</span>`
      chip.addEventListener('click', async (event) => {
        if (event.target.classList.contains('x')) {
          event.stopPropagation()
          await removeTarget(target)
          return
        }
        state.activeTarget = target
        renderTargets(targets)
        $('#quickTarget').value = target
        $('#wechatCompose').placeholder = `以本机身份给「${target}」发消息…`
        $('#wechatSendHint').textContent = `发送到：${target}`
      })
      box.appendChild(chip)
    }
  }

  async function saveTargets(targets) {
    await api('/api/settings', { settings: { wechatTargets: targets } })
    toast('监听聊天已更新')
    await loadState(true)
    if (!targets.includes(state.activeTarget)) state.activeTarget = targets[0] || ''
    const hint = $('#wechatSendHint')
    if (hint) hint.textContent = `发送到：${state.activeTarget || '尚未选择聊天'}`
  }

  async function removeTarget(target) {
    const targets = (state.data?.settings?.wechatTargets || []).filter((item) => item !== target)
    await saveTargets(targets)
  }

  async function addTarget() {
    const input = $('#newTargetInput')
    const value = input.value.trim()
    if (!value) return
    const existing = state.data?.settings?.wechatTargets || []
    if (existing.includes(value)) {
      toast('这个聊天已经在列表里了')
      return
    }
    await saveTargets([...existing, value])
    input.value = ''
    state.activeTarget = value
    renderTargets([...existing, value])
  }

  function setForm(data) {
    const settings = data.settings || {}
    const fields = [
      ['#setAdb', settings.adbPath],
      ['#setScrcpy', settings.scrcpyPath],
      ['#setSerial', settings.serial],
      ['#setPort', settings.httpPort],
      ['#setTargets', (settings.wechatTargets || [settings.wechatTarget]).filter(Boolean).join('\n')],
      ['#setAdmins', (settings.adminContacts || []).join('\n')],
      ['#setMemoryMaxGB', settings.memoryMaxBytes ? (Number(settings.memoryMaxBytes) / (1024 ** 3)).toFixed(1) : '5.0'],
      ['#setScreenshotMaxGB', settings.screenshotCacheMaxBytes ? (Number(settings.screenshotCacheMaxBytes) / (1024 ** 3)).toFixed(1) : '1.0'],
      ['#setPhoneCacheMaxGB', settings.phoneCacheMaxBytes ? (Number(settings.phoneCacheMaxBytes) / (1024 ** 3)).toFixed(1) : '2.0'],
      ['#setProgressInterval', settings.progressIntervalMinutes || 30],
      ['#setMainMin', settings.mainTaskMinMinutes || 3],
      ['#setVisionBase', settings.visionBaseUrl || ''],
      ['#setVisionModel', settings.visionModel || 'gpt-4o-mini'],
      ['#setEmbeddingBase', settings.embeddingBaseUrl || ''],
      ['#setEmbeddingModel', settings.embeddingModel || ''],
      ['#setPersona', settings.persona],
    ]
    for (const [selector, value] of fields) {
      const el = $(selector)
      if (el && document.activeElement !== el) el.value = value ?? ''
    }
    $('#setRelay').checked = Boolean(settings.relayReplies)
    $('#setRestoreIme').checked = Boolean(settings.restoreIme)
    $('#setHomeAfterReply').checked = Boolean(settings.homeAfterReply)
    $('#setAdminOnly').checked = settings.adminOnly !== false
    $('#setGroupAtOnly').checked = settings.groupAtOnly !== false
    $('#setDirectChat').checked = settings.directPrimaryChat !== false
    $('#setNotifyProgress').checked = settings.notifyTaskProgress !== false
    $('#setNotifyMain').checked = settings.notifyMainTaskProgress !== false
    $('#setMemoryRecall').checked = Boolean(settings.memoryRecall)
    $('#setAutoLearn').checked = Boolean(settings.autoLearn)
    $('#setOpenOnStart').checked = Boolean(settings.openOnStart)
    const pin = $('#setPin')
    if (pin) {
      pin.value = ''
      pin.placeholder = settings.hasPin ? '已配置，留空保持不变' : '未配置'
    }
    const visionKey = $('#setVisionKey')
    if (visionKey) {
      visionKey.value = ''
      visionKey.placeholder = settings.hasVisionKey ? '已配置，留空保持不变' : '未配置'
    }
  }

  function stripDisplayPrefix(text) {
    return String(text ?? '')
      .replace(/^\[桌面控制台\]\s*\n?/, '')
      .replace(/^\[微信消息 · [^\]]+\]\s*\n?/, '')
  }

  function renderFeeds(data = state.data) {
    if (!data) return
    const wechatFeed = $('#wechatFeed')
    if (wechatFeed) {
      const nearBottom = wechatFeed.scrollHeight - wechatFeed.scrollTop - wechatFeed.clientHeight < 100
      const oldTop = wechatFeed.scrollTop
      wechatFeed.innerHTML = ''
      for (const item of data.bridge?.inbox || []) {
        wechatFeed.appendChild(wechatElement(item))
      }
      wechatFeed.scrollTop = nearBottom ? wechatFeed.scrollHeight : oldTop
    }
    const history = data.agent?.history || []
    for (const selector of ['#agentFeed', '#agentFeed2']) {
      const feed = $(selector)
      if (!feed) continue
      const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 100
      const oldTop = feed.scrollTop
      feed.innerHTML = ''
      for (const item of history) {
        if (!item) continue
        if (item.role === 'user') feed.appendChild(agentElement('user', stripDisplayPrefix(item.text), item.time))
        else if (item.role === 'assistant') feed.appendChild(agentElement('assistant', item.text, item.time))
        else if (item.role === 'tool') feed.appendChild(toolElement(`${item.name || 'tool'} ${item.args || ''}`))
      }
      feed.scrollTop = nearBottom ? feed.scrollHeight : oldTop
    }
  }

  function wechatElement(item) {
    const direction = item.direction === 'out' ? 'out' : 'in'
    const kind = item.blocked || item.direction === 'blocked' ? 'blocked' : direction
    const div = document.createElement('div')
    div.className = `msg ${kind}`
    div.innerHTML = `<div class="meta"><span>${escapeHtml(item.sender || (direction === 'out' ? '鱼鱼' : '微信'))}</span><span>${formatTime(item.time)}</span></div><div class="body">${escapeHtml(item.text || '')}</div>`
    return div
  }

  function agentElement(role, text, time) {
    const div = document.createElement('div')
    div.className = `msg ${role}`
    div.innerHTML = `<div class="meta"><span>${role === 'user' ? '你' : '蓝色大肥鱼'}</span><span>${formatTime(time)}</span></div><div class="body">${escapeHtml(text)}</div>`
    return div
  }

  function toolElement(text) {
    const div = document.createElement('div')
    div.className = 'msg tool'
    div.innerHTML = `<div class="body">⚙ ${escapeHtml(String(text || '').slice(0, 400))}</div>`
    return div
  }

  function appendWechat(item, scroll = true) {
    const feed = $('#wechatFeed')
    if (!feed) return
    feed.appendChild(wechatElement(item))
    if (scroll) scrollFeed(feed)
  }

  function appendAgent(role, text, time) {
    for (const selector of ['#agentFeed', '#agentFeed2']) {
      const feed = $(selector)
      if (!feed) continue
      feed.appendChild(agentElement(role, stripDisplayPrefix(text), time))
      scrollFeed(feed)
    }
  }

  function appendTool(text) {
    const feed = $('#toolFeed')
    if (!feed) return
    const div = document.createElement('div')
    div.className = 'tool-line'
    div.innerHTML = `<b>⚙</b> ${escapeHtml(text).slice(0, 400)}`
    feed.appendChild(div)
    if (feed.childElementCount > 80) feed.removeChild(feed.firstElementChild)
    feed.scrollTop = feed.scrollHeight
  }

  function appendLog(entry) {
    state.logs.push(entry)
    if (state.logs.length > 250) state.logs.shift()
    renderLogs()
  }

  function renderLogs() {
    const feed = $('#logFeed')
    if (!feed) return
    feed.innerHTML = state.logs.slice(-120).map((entry) => {
      const level = entry.level || 'info'
      return `<div class="log-line ${escapeHtml(level)}"><time>${formatTime(entry.time)}</time><span class="lvl">${escapeHtml(level)}</span><span>${escapeHtml(entry.message || '')}</span></div>`
    }).join('')
    feed.scrollTop = feed.scrollHeight
  }

  function scrollFeed(feed) {
    if (!feed) return
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120
    if (nearBottom) feed.scrollTop = feed.scrollHeight
  }

  async function refreshScreen() {
    if (window.__dshScrcpyEmbedded) return
    if (state.tab !== 'console' || document.hidden || !state.data?.device?.online) return
    if (state.screenBusy) return
    state.screenBusy = true
    const url = `/api/screen?t=${Date.now()}`
    const image = new Image()
    image.onload = () => {
      const phoneImg = $('#phoneImg')
      phoneImg.src = url
      state.lastScreenUrl = url
      state.screenAt = Date.now()
      $('#phoneCover').classList.add('hidden')
      state.screenBusy = false
    }
    image.onerror = () => {
      $('#phoneCover').classList.remove('hidden')
      $('#phoneCover').textContent = '截图失败，点「修复连接」'
      state.screenBusy = false
    }
    image.src = url
  }

  async function loadState(quiet = false) {
    try {
      const data = await api('/api/state')
      renderState(data)
    } catch (error) {
      if (!quiet) toast(`无法连接本地控制台: ${error.message}`, true)
      setPill($('#connPill'), '控制台离线', 'bad')
    }
  }

  async function action(body) {
    return await api('/api/action', body)
  }

  async function sendWechat(text, target) {
    const content = String(text || '').trim()
    if (!content) return
    const destination = target || state.activeTarget || $('#quickTarget').value.trim()
    if (!destination) {
      toast('请先选择或添加一个微信聊天', true)
      return
    }
    try {
      await api('/api/wechat/send', { text: content, target: destination })
      toast(`已交给微信发送到 ${destination}`)
    } catch (error) {
      toast(`发送失败: ${error.message}`, true)
    }
  }

  async function sendAgent(text, input) {
    const content = String(text || '').trim()
    if (!content) return
    try {
      await api('/api/chat', { text: content })
      if (input) input.value = ''
      toast('已交给鱼鱼')
    } catch (error) {
      toast(`发送失败: ${error.message}`, true)
    }
  }

  async function loadMemory(query = '') {
    try {
      const data = query
        ? await api(`/api/memory/search?q=${encodeURIComponent(query)}&limit=20`)
        : await api('/api/memory/list?limit=40')
      renderMemory(data.items || [])
    } catch (error) {
      toast(`读取记忆失败: ${error.message}`, true)
    }
  }

  function renderMemory(items) {
    const box = $('#memoryList')
    if (!box) return
    if (!items || items.length === 0) {
      box.innerHTML = '<div class="chip-empty">没有匹配的记忆。Agent 操作成功后会自动生成轨迹，也可以手动添加。</div>'
      return
    }
    box.innerHTML = items.map((item) => `
      <div class="memory-item">
        <div class="memory-item-head">
          <div>
            <h4>${escapeHtml(item.title)}</h4>
            <div class="meta">${escapeHtml(item.kind || 'recipe')}${item.tier ? ` · ${escapeHtml(item.tier)}` : ''}${item.app ? ` · ${escapeHtml(item.app)}` : ''}${item.hits ? ` · 命中 ${item.hits}` : ''}</div>
          </div>
          <button class="del" data-memory-id="${escapeHtml(item.id)}" title="删除">×</button>
        </div>
        <div class="body">${escapeHtml(String(item.body || '').slice(0, 900))}</div>
      </div>
    `).join('')
  }

  async function saveMemory() {
    const title = $('#memoryTitle').value.trim()
    const body = $('#memoryBody').value.trim()
    if (!title || !body) {
      toast('标题和正文都要填', true)
      return
    }
    try {
      await api('/api/memory/remember', {
        title,
        body,
        app: $('#memoryApp').value.trim(),
        keywords: $('#memoryKeywords').value.trim(),
        kind: 'recipe',
      })
      toast('记忆已保存')
      $('#memoryTitle').value = ''
      $('#memoryBody').value = ''
      $('#memoryKeywords').value = ''
      await loadMemory()
      await loadState(true)
    } catch (error) {
      toast(`保存失败: ${error.message}`, true)
    }
  }

  function bind() {
    $$('.nav-item').forEach((item) => item.addEventListener('click', () => setTab(item.dataset.tab)))
    $$('.phone-actions .btn').forEach((button) => {
      button.addEventListener('click', async () => {
        const actionName = button.dataset.phoneAction
        try {
          if (actionName === 'scrcpy' || actionName === 'scrcpy-restart') {
            const result = await action({ action: actionName })
            toast(result.result?.alreadyRunning ? '镜像窗口已在运行' : '熄屏镜像窗口已打开')
          } else {
            await action({ action: actionName })
            toast('已执行')
          }
          if (actionName === 'screenshot') refreshScreen()
        } catch (error) {
          toast(`操作失败: ${error.message}`, true)
        }
      })
    })

    $('#phoneImg').addEventListener('click', async (event) => {
      const img = event.currentTarget
      if (!img.naturalWidth || !img.naturalHeight) return
      const rect = img.getBoundingClientRect()
      const scale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight)
      const drawWidth = img.naturalWidth * scale
      const drawHeight = img.naturalHeight * scale
      const offsetX = (rect.width - drawWidth) / 2
      const offsetY = (rect.height - drawHeight) / 2
      const localX = event.clientX - rect.left - offsetX
      const localY = event.clientY - rect.top - offsetY
      if (localX < 0 || localY < 0 || localX > drawWidth || localY > drawHeight) return
      const x = Math.round(localX / scale)
      const y = Math.round(localY / scale)
      try {
        await action({ action: 'tap', x, y })
        setTimeout(refreshScreen, 300)
      } catch (error) {
        toast(`点击失败: ${error.message}`, true)
      }
    })

    $('#btnRepair').addEventListener('click', repair)
    $('#btnRepair2').addEventListener('click', repair)
    $('#btnOpenApp').addEventListener('click', async () => {
      try { await api('/api/open-app', {}); toast('已打开新窗口') } catch (error) { toast(error.message, true) }
    })
    $('#btnOpenChat').addEventListener('click', async () => {
      const target = $('#quickTarget').value.trim() || state.activeTarget
      try {
        await api('/api/wechat/open', { target })
        toast('正在打开聊天…')
      } catch (error) { toast(`打开失败: ${error.message}`, true) }
    })
    $('#btnQuickSend').addEventListener('click', async () => {
      await sendWechat($('#quickText').value, $('#quickTarget').value.trim() || state.activeTarget)
      $('#quickText').value = ''
    })
    $('#btnWechatCompose').addEventListener('click', async () => {
      await sendWechat($('#wechatCompose').value, state.activeTarget)
      $('#wechatCompose').value = ''
    })
    $('#wechatCompose').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') $('#btnWechatCompose').click()
    })
    $('#btnAgentCompose').addEventListener('click', () => sendAgent($('#agentCompose').value, $('#agentCompose')))
    $('#btnAgentCompose2').addEventListener('click', () => sendAgent($('#agentCompose2').value, $('#agentCompose2')))
    for (const id of ['#agentCompose', '#agentCompose2']) {
      $(id).addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          const input = $(id)
          sendAgent(input.value, input)
        }
      })
    }

    $('#bridgeToggle').addEventListener('change', async (event) => {
      try {
        const enabled = event.target.checked
        await api('/api/bridge', { enabled })
        toast(enabled ? '微信桥已启动' : '微信桥已停止')
        await loadState(true)
      } catch (error) {
        event.target.checked = !event.target.checked
        toast(`切换失败: ${error.message}`, true)
      }
    })
    $('#btnAddTarget').addEventListener('click', () => addTarget().catch((error) => toast(error.message, true)))
    $('#newTargetInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') addTarget().catch((error) => toast(error.message, true))
    })

    let skillCache = []
    let activeSkill = ''
    const showSkillEditor = () => { $('#skillEditor').hidden = false }
    const hideSkillEditor = () => { $('#skillEditor').hidden = true }
    const clearSkillForm = (name = '') => {
      activeSkill = ''
      $('#skillEditorTitle').textContent = '新建技能'
      $('#skillName').value = name
      $('#skillApp').value = ''
      $('#skillKeywords').value = ''
      $('#skillParams').value = ''
      $('#skillSteps').value = '[\n  {"action": "launch", "target": ""}\n]'
      showSkillEditor()
    }
    const fillSkillForm = (skill) => {
      activeSkill = skill.name
      $('#skillEditorTitle').textContent = `编辑：${skill.name}`
      $('#skillName').value = skill.name || ''
      $('#skillApp').value = skill.app || ''
      $('#skillKeywords').value = skill.keywords || ''
      $('#skillParams').value = (skill.params || []).join(', ')
      $('#skillSteps').value = JSON.stringify(skill.steps || [], null, 2)
      showSkillEditor()
    }
    const renderSkillList = () => {
      const box = $('#skillList')
      if (!box) return
      $('#skillCount').textContent = `${skillCache.length} 个技能`
      if (skillCache.length === 0) {
        box.innerHTML = '<div class="chip-empty">暂无技能。成功操作后会自动生成，也可以点「新建技能」。</div>'
        return
      }
      box.innerHTML = skillCache.map((skill) => `
        <div class="memory-item skill-item ${skill.name === activeSkill ? 'active' : ''}" data-skill-name="${escapeHtml(skill.name)}">
          <div class="memory-item-head">
            <div>
              <h4>${escapeHtml(skill.name)}</h4>
              <div class="meta">${escapeHtml(skill.app || '未指定应用')} · ${Number(skill.steps || 0)} 步${skill.params?.length ? ` · 参数 ${escapeHtml(skill.params.join(', '))}` : ''}</div>
            </div>
            <span class="muted">编辑</span>
          </div>
          <div class="body">${escapeHtml(skill.keywords || '无关键词')}</div>
        </div>
      `).join('')
    }
    const loadSkill = async (name) => {
      const data = await api(`/api/skills/get?name=${encodeURIComponent(name)}`)
      fillSkillForm(data.skill)
      renderSkillList()
      $('#skillEditor').scrollIntoView?.({ behavior: 'smooth', block: 'nearest' })
    }
    const loadSkills = async (selected = '') => {
      const data = await api('/api/skills')
      skillCache = data.skills || []
      renderSkillList()
      if (selected && skillCache.some((item) => item.name === selected)) await loadSkill(selected)
      else if (activeSkill && !skillCache.some((item) => item.name === activeSkill)) {
        activeSkill = ''
        hideSkillEditor()
      }
    }
    $('#btnSkillRefresh').addEventListener('click', () => loadSkills().catch((error) => toast(error.message, true)))
    $('#skillList')?.addEventListener('click', (event) => {
      const item = event.target.closest('[data-skill-name]')
      if (item) loadSkill(item.dataset.skillName).catch((error) => toast(error.message, true))
    })
    $('#btnSkillNew').addEventListener('click', () => clearSkillForm())
    $('#btnSkillClose').addEventListener('click', () => hideSkillEditor())
    $('#btnSkillSave').addEventListener('click', async () => {
      try {
        const name = $('#skillName').value.trim()
        if (!name) throw new Error('技能名不能为空')
        let steps
        try { steps = JSON.parse($('#skillSteps').value) } catch { throw new Error('步骤 JSON 格式不对') }
        if (!Array.isArray(steps) || steps.length === 0) throw new Error('步骤必须是非空数组')
        const params = $('#skillParams').value.split(/[,，\s]+/u).map((item) => item.trim()).filter(Boolean)
        await api('/api/skills/save', {
          name,
          app: $('#skillApp').value.trim(),
          keywords: $('#skillKeywords').value.trim(),
          params,
          steps,
        })
        toast('技能已保存')
        activeSkill = name
        await loadSkills(name)
      } catch (error) { toast(error.message, true) }
    })
    $('#btnSkillDelete').addEventListener('click', async () => {
      const name = $('#skillName').value.trim()
      if (!name) return
      if (!confirm(`删除技能「${name}」？`)) return
      try {
        await api('/api/skills/delete', { name })
        toast('技能已删除')
        activeSkill = ''
        hideSkillEditor()
        await loadSkills()
      } catch (error) { toast(error.message, true) }
    })
    if ($('#skillsPanel') && $('#skillList')) {
      const card = $('#skillList').closest('article.card')
      if (card) $('#skillsPanel').appendChild(card)
    }
    if ($('#personaPanel') && $('#setPersona')) {
      const card = $('#setPersona').closest('article.card')
      if (card) {
        card.classList.add('span2')
        $('#personaPanel').appendChild(card)
      }
    }
    const moveField = (selector, targetSelector) => {
      const input = $(selector)
      const target = $(targetSelector)
      const row = input?.closest('.field, .switch-row')
      if (row && target) target.appendChild(row)
    }
    for (const id of ['#setTargets', '#setAdmins', '#setAdminOnly', '#setGroupAtOnly', '#setDirectChat', '#setRelay', '#setRestoreIme', '#setHomeAfterReply']) {
      moveField(id, '#wechatSettingsFields')
    }
    for (const id of ['#setNotifyProgress', '#setProgressInterval', '#setNotifyMain', '#setMainMin', '#setVisionBase', '#setVisionModel', '#setVisionKey', '#setEmbeddingBase', '#setEmbeddingModel', '#setEmbeddingKey']) {
      moveField(id, '#agentSettingsFields')
    }
    for (const id of ['#setMemoryRecall', '#setAutoLearn', '#setMemoryMaxGB']) {
      moveField(id, '#memorySettingsFields')
    }
    for (const id of ['#setScreenshotMaxGB', '#setPhoneCacheMaxGB', '#setOpenOnStart']) {
      moveField(id, '#storageSettingsFields')
    }
    for (const id of ['#btnSaveWechatSettings', '#btnSaveAgentSettings', '#btnSaveMemorySettings', '#btnSaveStorageSettings']) {
      $(id)?.addEventListener('click', () => $('#btnSavePersona').click())
    }
    loadSkills().catch(() => {})

    $('#btnSaveSettings').addEventListener('click', async () => {
      try {
        await api('/api/settings', {
          settings: {
            adbPath: $('#setAdb').value.trim(),
            scrcpyPath: $('#setScrcpy').value.trim(),
            serial: $('#setSerial').value.trim(),
            httpPort: Number($('#setPort').value) || 18642,
          },
        })
        toast('设置已保存（端口变更需重启 DSH）')
        await loadState(true)
      } catch (error) { toast(error.message, true) }
    })
    $('#btnSavePersona').addEventListener('click', async () => {
      try {
        const settingsPatch = {
          wechatTargets: $('#setTargets').value.split(/\n|,|，|;|；/).map((item) => item.trim()).filter(Boolean),
          adminContacts: $('#setAdmins').value.split(/\n|,|，|;|；/).map((item) => item.trim()).filter(Boolean),
          adminOnly: $('#setAdminOnly').checked,
          groupAtOnly: $('#setGroupAtOnly').checked,
          directPrimaryChat: $('#setDirectChat').checked,
          persona: $('#setPersona').value,
          relayReplies: $('#setRelay').checked,
          restoreIme: $('#setRestoreIme').checked,
          homeAfterReply: $('#setHomeAfterReply').checked,
          memoryRecall: $('#setMemoryRecall').checked,
          autoLearn: $('#setAutoLearn').checked,
          memoryMaxBytes: Math.max(0.01, Number($('#setMemoryMaxGB').value) || 5) * 1024 * 1024 * 1024,
          screenshotCacheMaxBytes: Math.max(0.01, Number($('#setScreenshotMaxGB').value) || 1) * 1024 * 1024 * 1024,
          phoneCacheMaxBytes: Math.max(0.01, Number($('#setPhoneCacheMaxGB').value) || 2) * 1024 * 1024 * 1024,
          notifyTaskProgress: $('#setNotifyProgress').checked,
          progressIntervalMinutes: Math.max(1, Number($('#setProgressInterval').value) || 30),
          notifyMainTaskProgress: $('#setNotifyMain').checked,
          mainTaskMinMinutes: Math.max(1, Number($('#setMainMin').value) || 3),
          visionBaseUrl: $('#setVisionBase').value.trim(),
          visionModel: $('#setVisionModel').value.trim() || 'gpt-4o-mini',
          embeddingBaseUrl: $('#setEmbeddingBase').value.trim(),
          embeddingModel: $('#setEmbeddingModel').value.trim(),
          openOnStart: $('#setOpenOnStart').checked,
        }
        const pin = $('#setPin').value.trim()
        if (pin) settingsPatch.unlockPin = pin
        const visionKey = $('#setVisionKey').value.trim()
        if (visionKey) settingsPatch.visionApiKey = visionKey
        const embeddingKey = $('#setEmbeddingKey').value.trim()
        if (embeddingKey) settingsPatch.embeddingApiKey = embeddingKey
        await api('/api/settings', { settings: settingsPatch })
        $('#setPin').value = ''
        $('#setVisionKey').value = ''
        $('#setEmbeddingKey').value = ''
        toast('设置已保存')
        await loadState(true)
      } catch (error) { toast(error.message, true) }
    })
    $('#btnResetSession').addEventListener('click', async () => {
      if (!confirm('重开会话会新建一个 DSH Session，旧会话仍保留在侧栏。继续？')) return
      try {
        await api('/api/session/reset', {})
        $('#agentFeed').innerHTML = ''
        $('#agentFeed2').innerHTML = ''
        toast('已重开会话')
        await loadState(true)
      } catch (error) { toast(error.message, true) }
    })
    $('#btnMemorySearch').addEventListener('click', () => loadMemory($('#memorySearch').value.trim()))
    $('#memorySearch').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') loadMemory($('#memorySearch').value.trim())
    })
    $('#btnMemorySave').addEventListener('click', saveMemory)
    $('#memoryList').addEventListener('click', async (event) => {
      const button = event.target.closest('[data-memory-id]')
      if (!button) return
      const id = button.dataset.memoryId
      if (!id) return
      try {
        await api('/api/memory/forget', { id })
        toast('已删除记忆')
        await loadMemory($('#memorySearch').value.trim())
        await loadState(true)
      } catch (error) {
        toast(`删除失败: ${error.message}`, true)
      }
    })
    $('#btnClearLog').addEventListener('click', () => {
      state.logs = []
      renderLogs()
    })
    $('#btnBridgeRepair').addEventListener('click', repair)
    $('#quickTarget').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') $('#btnOpenChat').click()
    })

    const events = new EventSource('/api/events')
    events.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data)
        handleEvent(event)
      } catch {}
    }
    events.onerror = () => {}
  }

  async function repair() {
    toast('正在修复连接…')
    try {
      const data = await api('/api/repair', {})
      const failed = (data.result || []).filter((item) => !item.ok)
      toast(failed.length ? `修复完成，${failed.length} 项失败` : '连接已修复', failed.length > 0)
      await loadState(true)
      refreshScreen()
    } catch (error) {
      toast(`修复失败: ${error.message}`, true)
    }
  }

  function handleEvent(event) {
    if (event.type === 'log') return appendLog(event)
    if (event.type === 'wechat-in') {
      appendWechat({ direction: 'in', sender: event.sender, text: event.text, time: event.time })
      return
    }
    if (event.type === 'wechat-out') {
      appendWechat({ direction: 'out', sender: '鱼鱼', text: event.text, time: event.time || event.at })
      return
    }
    if (event.type === 'agent-user') {
      appendAgent('user', event.text, event.time)
      return
    }
    if (event.type === 'assistant') {
      appendAgent('assistant', event.text, event.time)
      $('#agentState').textContent = '空闲'
      $('#agentState2').textContent = '空闲'
      return
    }
    if (event.type === 'tool-call') {
      appendTool(`调用 ${event.name} ${event.args || ''}`)
      $('#agentState').textContent = '操作中…'
      $('#agentState2').textContent = '操作中…'
      return
    }
    if (event.type === 'tool-result') {
      appendTool(`${event.isError ? '✗' : '✓'} ${event.name || 'tool'} ${event.text || ''}`)
      return
    }
    if (event.type === 'turn') {
      const label = event.phase === 'start' ? '思考中…' : (event.reason === 'completed' ? '空闲' : `结束: ${event.reason}`)
      $('#agentState').textContent = label
      $('#agentState2').textContent = label
      return
    }
    if (event.type === 'bridge') {
      $('#bridgeToggle').checked = Boolean(event.enabled)
      setPill($('#bridgeState'), event.enabled ? '监听中' : '未启动', event.enabled ? 'ok' : 'warn')
      $('#sideBridge').textContent = event.enabled ? '监听中' : '未启动'
      $('#bridgeDot').classList.toggle('on', Boolean(event.enabled))
      return
    }
    if (event.type === 'phone' && event.screenshot) {
      if ($('#phoneCover')) $('#phoneCover').classList.add('hidden')
      return
    }
    if (event.type === 'error') {
      appendLog({ level: 'error', message: event.message, time: event.time })
    }
  }

  function setupNativeMirror() {
    const webview = window.chrome?.webview
    const canvas = $('#nativeMirror')
    if (!webview || !canvas) return
    const ctx = canvas.getContext('2d')
    let decoder = null
    let codecData = null
    let videoWidth = 0
    let videoHeight = 0
    let ready = false
    let failed = false
    const fail = (message) => {
      if (failed) return
      failed = true
      canvas.hidden = true
      webview.postMessage({ type: 'native-failed', error: message || 'native mirror error' })
      try { decoder?.close?.() } catch {}
      decoder = null
    }
    const bytes = (base64) => {
      const raw = atob(String(base64 || ''))
      const out = new Uint8Array(raw.length)
      for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
      return out
    }
    const codecString = (data) => {
      if (data && data.length > 8) {
        for (let i = 0; i < data.length - 4; i++) {
          const start = data[i] === 0 && data[i + 1] === 0 && (data[i + 2] === 1 || (data[i + 2] === 0 && data[i + 3] === 1))
          if (!start) continue
          const offset = data[i + 2] === 1 ? i + 3 : i + 4
          if ((data[offset] & 0x1f) !== 7 || offset + 3 >= data.length) continue
          const hex = (value) => value.toString(16).padStart(2, '0')
          return `avc1.${hex(data[offset + 1])}${hex(data[offset + 2])}${hex(data[offset + 3])}`
        }
      }
      return 'avc1.42E01E'
    }
    const ensureDecoder = async () => {
      if (decoder) return true
      if (!('VideoDecoder' in window)) {
        fail('WebCodecs VideoDecoder not available')
        return false
      }
      const codec = codecString(codecData)
      const width = Math.max(2, videoWidth || 1080)
      const height = Math.max(2, videoHeight || 2340)
      const candidates = [
        { codec, codedWidth: width, codedHeight: height, avc: { format: 'annexb' }, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' },
        { codec, codedWidth: width, codedHeight: height, avc: { format: 'annexb' }, optimizeForLatency: true },
      ]
      for (const config of candidates) {
        try {
          const support = await VideoDecoder.isConfigSupported(config)
          if (!support.supported) continue
          decoder = new VideoDecoder({
            output: (frame) => {
              try {
                if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
                  canvas.width = frame.displayWidth
                  canvas.height = frame.displayHeight
                }
                ctx.drawImage(frame, 0, 0)
                canvas.hidden = false
                $('#phoneCover')?.classList.add('hidden')
                if (!ready) {
                  ready = true
                  webview.postMessage({ type: 'native-ready' })
                }
              } catch (error) {
                fail(error.message)
              } finally {
                frame.close()
              }
            },
            error: (error) => fail(error?.message || 'VideoDecoder error'),
          })
          decoder.configure(config)
          return true
        } catch (error) {
          try { decoder?.close?.() } catch {}
          decoder = null
        }
      }
      fail('H.264 WebCodecs config not supported')
      return false
    }
    webview.addEventListener('message', async (event) => {
      const message = event.data || {}
      if (message.type === 'native-stream') {
        videoWidth = Number(message.width) || 0
        videoHeight = Number(message.height) || 0
        return
      }
      if (message.type === 'native-codec') {
        codecData = bytes(message.data)
        return
      }
      if (message.type !== 'native-frame') return
      if (failed) return
      try {
        if (!(await ensureDecoder())) return
        if (decoder.decodeQueueSize > 8 && !message.key) return
        const frameData = bytes(message.data)
        let data = frameData
        if (message.key && codecData) {
          data = new Uint8Array(codecData.length + frameData.length)
          data.set(codecData, 0)
          data.set(frameData, codecData.length)
        }
        decoder.decode(new EncodedVideoChunk({
          type: message.key ? 'key' : 'delta',
          timestamp: Number(message.pts) || 0,
          data,
        }))
      } catch (error) {
        fail(error.message)
      }
    })

    const mapPoint = (clientX, clientY) => {
      const rect = canvas.getBoundingClientRect()
      const sourceWidth = Math.max(1, videoWidth || canvas.width || 1080)
      const sourceHeight = Math.max(1, videoHeight || canvas.height || 2340)
      const scale = Math.min(rect.width / sourceWidth, rect.height / sourceHeight)
      const drawWidth = sourceWidth * scale
      const drawHeight = sourceHeight * scale
      const offsetX = (rect.width - drawWidth) / 2
      const offsetY = (rect.height - drawHeight) / 2
      const localX = clientX - rect.left - offsetX
      const localY = clientY - rect.top - offsetY
      if (localX < 0 || localY < 0 || localX > drawWidth || localY > drawHeight) return null
      const phoneWidth = Number(state.data?.device?.width) || 1080
      const phoneHeight = Number(state.data?.device?.height) || 2340
      return {
        x: Math.max(0, Math.min(phoneWidth - 1, Math.round(localX / scale / sourceWidth * phoneWidth))),
        y: Math.max(0, Math.min(phoneHeight - 1, Math.round(localY / scale / sourceHeight * phoneHeight))),
      }
    }
    const postPointer = (phase, point, button = 0) => {
      if (!point || !webview) return
      const phoneWidth = Number(state.data?.device?.width) || 1080
      const phoneHeight = Number(state.data?.device?.height) || 2340
      webview.postMessage({
        type: 'native-pointer',
        phase,
        button,
        x: Math.max(0, Math.min(1, point.x / phoneWidth)),
        y: Math.max(0, Math.min(1, point.y / phoneHeight)),
      })
    }
    let activePointer = null
    let lastMoveAt = 0
    const endPointer = (event) => {
      if (!activePointer) return
      if (event && event.pointerId !== undefined && event.pointerId !== activePointer.pointerId) return
      const point = (event ? mapPoint(event.clientX, event.clientY) : null) || activePointer.lastPoint
      const { pointerId, button } = activePointer
      activePointer = null
      if (point) postPointer('up', point, button)
      try { canvas.releasePointerCapture(pointerId) } catch {}
      if (event) event.preventDefault()
    }
    canvas.addEventListener('contextmenu', (event) => event.preventDefault())
    canvas.addEventListener('pointerdown', (event) => {
      if (![0, 1, 2].includes(event.button)) return
      const point = mapPoint(event.clientX, event.clientY)
      if (!point) return
      activePointer = { pointerId: event.pointerId, button: event.button, lastPoint: point }
      postPointer('move', point, event.button)
      postPointer('down', point, event.button)
      try { canvas.setPointerCapture(event.pointerId) } catch {}
      event.preventDefault()
    })
    canvas.addEventListener('pointermove', (event) => {
      const now = Date.now()
      const point = mapPoint(event.clientX, event.clientY)
      if (!point) return
      if (activePointer?.pointerId === event.pointerId) {
        activePointer.lastPoint = point
        if (now - lastMoveAt < 12) return
        lastMoveAt = now
        postPointer('move', point, activePointer.button)
      } else if (event.pointerType === 'mouse') {
        if (now - lastMoveAt < 24) return
        lastMoveAt = now
        postPointer('move', point, 0)
      }
    })
    canvas.addEventListener('pointerup', endPointer)
    canvas.addEventListener('pointercancel', endPointer)
    window.addEventListener('pointerup', endPointer, true)
    window.addEventListener('pointercancel', endPointer, true)
    window.addEventListener('blur', () => endPointer(null))
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) endPointer(null)
    })
  }

  async function boot() {
    bind()
    await loadState()
    refreshScreen()
    setInterval(() => loadState(true), 5000)
    setInterval(refreshScreen, 700)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshScreen()
    })
  }

  setupNativeMirror()
  boot()
})();
