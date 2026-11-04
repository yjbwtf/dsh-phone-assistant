import { truncate, jsonText, sleep } from './util.js'
import { isAbsolute, resolve } from 'node:path'
import { ocrImage } from './ocr.js'

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    text: { type: 'string' },
  },
  required: ['ok', 'text'],
}

function makeTool(name, description, parameters, handler) {
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(parameters?.properties ?? {})) {
    const { required: isRequired, ...schema } = value
    properties[key] = schema
    if (isRequired === true) required.push(key)
  }
  return {
    name,
    description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args, exec) {
      try {
        const text = await handler(args ?? {}, exec)
        return { ok: true, text: String(text ?? '') }
      } catch (error) {
        return { ok: false, text: `错误: ${error?.message ?? String(error)}` }
      }
    },
  }
}

function summaryNode(node, depth = 0) {
  if (!node || depth > 30) return null
  const item = {
    path: node.path,
    text: node.text,
    desc: node.desc,
    id: node.id,
    cls: node.cls,
    bounds: node.bounds,
    center: node.center,
    clickable: node.clickable,
    editable: node.editable,
    scrollable: node.scrollable,
  }
  if (Array.isArray(node.children) && node.children.length > 0) {
    item.children = node.children.map((child) => summaryNode(child, depth + 1)).filter(Boolean)
  }
  return item
}

function extractUiText(dump) {
  const nodes = []
  let count = 0
  const walk = (node) => {
    if (!node || count > 400) return
    count++
    if (node.text || node.desc || node.clickable || node.editable) {
      nodes.push({
        text: node.text,
        desc: node.desc,
        id: node.id,
        cls: node.cls,
        bounds: node.bounds,
        center: node.center,
        clickable: node.clickable,
        editable: node.editable,
        scrollable: node.scrollable,
      })
    }
    if (Array.isArray(node.children)) for (const child of node.children) walk(child)
  }
  walk(dump?.root)
  return nodes
}

async function clickFound(a11y, phone, items, preferBottom = false) {
  let candidates = (items || []).filter((item) => item.clickable && Array.isArray(item.center))
  if (candidates.length === 0) candidates = (items || []).filter((item) => Array.isArray(item.center))
  if (candidates.length === 0) throw new Error('没有找到可点击的控件')
  if (preferBottom) candidates.sort((a, b) => Number(b.center[1]) - Number(a.center[1]))
  const item = candidates[0]
  try {
    await a11y.tap(item.center[0], item.center[1])
  } catch {
    await phone.tap(item.center[0], item.center[1])
  }
  return item
}

export function registerTools(ctx, deps) {
  const { phone, a11y, wechat, bridge, store, memory, memes, memekb, vision } = deps
  const disposers = []

  disposers.push(ctx.tools.register(makeTool(
    'phone',
    '操作已连接的 Android 手机。微信界面会阻止无障碍节点读取；需要看微信时先用 action=screenshot 获取截图，再用 read_image 查看，然后用 action=tap 按坐标点击；也可以直接用 action=vision 让已配置的视觉模型识别当前屏幕/聊天里的图片、表情和文字。普通界面的 action=screenshot 优先返回无障碍节点的文字和精确 center，有节点时不走硅基流动；无节点才走本地 OCR + 硅基流动。所有坐标基于手机原生分辨率（1080x2340）。',
    {
      properties: {
        action: {
          type: 'string',
          required: true,
          enum: ['status', 'screenshot', 'vision', 'ui', 'tap', 'swipe', 'text', 'key', 'launch', 'shell', 'notifications', 'wake', 'scrcpy', 'a11y', 'record_video', 'record_audio', 'media'],
          description: '要执行的操作。',
        },
        prompt: { type: 'string', description: 'vision 的可选问题，例如“识别聊天里最新发来的表情/图片”。' },
        x: { type: 'number', description: 'tap 的 x 坐标（像素）。' },
        y: { type: 'number', description: 'tap 的 y 坐标（像素）。' },
        x1: { type: 'number', description: 'swipe 起点 x。' },
        y1: { type: 'number', description: 'swipe 起点 y。' },
        x2: { type: 'number', description: 'swipe 终点 x。' },
        y2: { type: 'number', description: 'swipe 终点 y。' },
        duration: { type: 'number', description: '滑动时长（毫秒）。' },
        text: { type: 'string', description: 'text 操作要输入的文字。' },
        key: { type: 'string', description: 'key 操作：home/back/recents/enter/delete/power 或 keycode。' },
        target: { type: 'string', description: 'launch 的包名或 wechat/settings。' },
        command: { type: 'string', description: 'shell 操作要执行的 adb shell 命令。' },
        seconds: { type: 'number', description: 'record_video / record_audio 的时长，默认 5 秒。' },
        camera: { type: 'string', enum: ['front', 'back'], description: 'record_video 使用的摄像头，默认 front。' },
        media_action: { type: 'string', enum: ['play', 'pause', 'next', 'previous', 'stop'], description: 'media 操作。' },
      },
    },
    async (args) => {
      const action = String(args.action ?? '')
      if (['tap', 'swipe', 'text', 'launch', 'shell', 'record_video', 'record_audio', 'media'].includes(action)) {
        await phone.ensureUnlocked()
      }
      if (action === 'status') {
        const status = await phone.status(true)
        let accessibility = null
        try { accessibility = await a11y.ping() } catch {}
        return jsonText({ phone: status, accessibility })
      }
      if (action === 'screenshot') {
        const shot = await phone.screenshot(true)
        let uiBlock = ''
        try {
          const dump = await a11y.dump()
          const useful = extractUiText(dump)
            .filter((node) => node.text || node.desc || node.clickable || node.editable)
            .slice(0, 40)
          if (useful.length > 0) {
            uiBlock = useful.map((node) => {
              const label = node.text || node.desc || node.id || node.cls || ''
              const center = Array.isArray(node.center) ? `[${node.center[0]}, ${node.center[1]}]` : '[?]'
              return `${center} ${label}${node.clickable ? ' (可点击)' : ''}`
            }).join('\n')
            return `截图已保存到: ${shot.path}\n尺寸: ${shot.width}x${shot.height}\n无障碍节点（精确坐标，优先用 center；已跳过硅基流动）:\npackage: ${dump.package || '未知'} / nodes: ${dump.nodeCount ?? useful.length}\n${uiBlock}\n\n直接 tap center 即可；只有需要看图片像素、表情或视觉细节时才 read_image。`
          }
        } catch {}
        let ocrBlock = ''
        try {
          const ocr = await ocrImage(shot.path)
          const lines = (ocr?.lines ?? [])
            .filter((line) => line.text && Number(line.y) >= 0)
            .slice(0, 40)
            .map((line) => `[x=${Math.round(Number(line.x) || 0)}, y=${Math.round(Number(line.y) || 0)}] ${line.text}`)
          if (lines.length > 0) ocrBlock = `\n本地 OCR 文字坐标（左上角像素）:\n${lines.join('\n').slice(0, 6000)}`
        } catch {}
        let status = {}
        try { status = await phone.status() } catch {}
        const packageName = String(status.package || '')
        const sensitive = /com\.tencent\.mm|alipay|bank|wallet|password|authenticator/i.test(packageName)
        if (!sensitive) {
          try {
            const text = await vision.analyze(shot.latestPath, '简要识别当前手机界面：页面名称、可见文字/按钮、当前状态。只输出要点，不要猜测。')
            if (text) {
              return `截图已保存到: ${shot.path}\n尺寸: ${shot.width}x${shot.height}\n界面识别（SiliconFlow，已转成文字，不需要 read_image）:\n${text}${ocrBlock}\n\n文字坐标来自本地 OCR；图标/按钮精确位置优先用 phone action=ui 的 center。只有需要看原图像素、表情或视觉细节时才调用 read_image。`
            }
          } catch (error) {
            return `截图已保存到: ${shot.path}\n尺寸: ${shot.width}x${shot.height}\n硅基流动识图失败: ${error.message}${ocrBlock}\n请调用 read_image 查看。`
          }
        }
        return `截图已保存到: ${shot.path}\n尺寸: ${shot.width}x${shot.height}\n当前是敏感界面（${packageName || '未知'}），未自动上传识图。${ocrBlock}\n请调用 read_image 查看，或明确使用 vision。`
      }
      if (action === 'vision') {
        const shot = await phone.screenshot(true)
        const text = await vision.analyze(shot.latestPath, args.prompt)
        return `画面识别:\n${text}\n截图: ${shot.path}`
      }
      if (action === 'ui') {
        try {
          const dump = await a11y.dump()
          const nodes = extractUiText(dump)
          if (nodes.length === 0) {
            return `当前界面（${dump.package || '未知'}）没有可读节点。微信等应用会屏蔽无障碍；请改用 action=screenshot + read_image 读图。`
          }
          return jsonText({
            package: dump.package,
            nodeCount: dump.nodeCount,
            nodes,
            hint: '坐标使用手机原生像素；tap 可以直接点 center。',
          })
        } catch (error) {
          return `无障碍读取失败: ${error.message}\n请改用 action=screenshot + read_image。`
        }
      }
      if (action === 'tap') {
        const x = Math.round(Number(args.x))
        const y = Math.round(Number(args.y))
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('tap 需要 x/y')
        try {
          const result = await a11y.tap(x, y)
          return `已通过无障碍服务点击 (${x}, ${y}): ${jsonText(result)}`
        } catch {
          const result = await phone.tap(x, y)
          return `已通过 ADB 点击 (${result.x}, ${result.y})`
        }
      }
      if (action === 'swipe') {
        const result = await phone.swipe(args.x1, args.y1, args.x2, args.y2, args.duration)
        return `已滑动: ${jsonText(result)}`
      }
      if (action === 'text') {
        const text = String(args.text ?? '')
        if (!text) throw new Error('缺少 text')
        await wechat.ensureTools()
        try {
          await wechat.ensureIme()
          await wechat.clearText()
          await wechat.typeText(text)
        } finally {
          await wechat.restoreIme().catch(() => {})
        }
        return `已输入 ${text.length} 个字符。`
      }
      if (action === 'key') {
        return `已按键: ${jsonText(await phone.key(args.key))}`
      }
      if (action === 'launch') {
        return `已启动: ${jsonText(await phone.launch(args.target))}`
      }
      if (action === 'shell') {
        const output = await phone.runShell(args.command)
        return `adb shell 输出:\n${output}`
      }
      if (action === 'notifications') {
        const items = await wechat.latestNotifications()
        return jsonText(items.slice(-30))
      }
      if (action === 'wake') {
        return `已尝试唤醒: ${jsonText(await phone.wake())}`
      }
      if (action === 'scrcpy') {
        return `镜像窗口: ${jsonText(await phone.openScrcpy())}`
      }
      if (action === 'a11y') {
        return `无障碍服务: ${jsonText(await a11y.ensure(true))}`
      }
      if (action === 'record_video') {
        const seconds = Math.max(1, Math.min(30, Number(args.seconds) || 5))
        const facing = String(args.camera ?? 'front') === 'back' ? 0 : 1
        await a11y.ensure()
        await phone.shell(`am start -a android.media.action.VIDEO_CAPTURE --ei android.intent.extras.CAMERA_FACING ${facing} --ei android.intent.extra.durationLimit ${seconds}`)
        await sleep(2500)
        const shutter = await a11y.find({ id: 'com.huawei.camera:id/shutter_button' })
        if (!shutter.items?.length) {
          const byDesc = await a11y.find({ desc: '录像' })
          await clickFound(a11y, phone, byDesc.items, true)
        } else {
          await clickFound(a11y, phone, shutter.items)
        }
        await sleep(seconds * 1000 + 2800)
        let done = await a11y.find({ id: 'com.huawei.camera:id/done_button' })
        if (!done.items?.length) {
          // Duration limit may not be honored by every camera; stop explicitly.
          const again = await a11y.find({ id: 'com.huawei.camera:id/shutter_button' })
          if (again.items?.length) {
            await clickFound(a11y, phone, again.items)
            await sleep(1200)
            done = await a11y.find({ id: 'com.huawei.camera:id/done_button' })
          }
        }
        if (done.items?.length) {
          await clickFound(a11y, phone, done.items)
          await sleep(900)
        }
        const path = (await phone.shell('ls -t /sdcard/DCIM/Camera/*.mp4 2>/dev/null | head -1')).trim()
        if (!path) throw new Error('没有找到新录制的视频文件')
        const info = (await phone.shell(`ls -l "${path}"`)).trim()
        return `视频已录制: ${path}\n${info}\n可用 wechat action=send_video 发送到微信。`
      }
      if (action === 'record_audio') {
        const seconds = Math.max(1, Math.min(30, Number(args.seconds) || 5))
        await phone.shell(`am start -n com.dsh.phoneaccess/.RecordActivity --ei seconds ${seconds}`)
        await sleep(seconds * 1000 + 2600)
        const path = (await phone.shell('ls -t /sdcard/Music/DSH_REC_*.m4a 2>/dev/null | head -1')).trim()
        if (!path) throw new Error('没有找到新录制的音频文件')
        const cached = await phone.moveToPhoneCache(path, 'rec-')
        const info = (await phone.shell(`ls -l "${cached}"`)).trim()
        return `音频已录制并放入手机隐藏缓存: ${cached}\n${info}`
      }
      if (action === 'media') {
        const mediaAction = String(args.media_action ?? 'play')
        const output = await phone.shell(`media dispatch ${mediaAction}`, { allowFail: true })
        const fallback = await phone.shell(`cmd media_session dispatch ${mediaAction}`, { allowFail: true })
        return `媒体控制 ${mediaAction}: ${(output || fallback).trim() || '已发送'}`
      }
      throw new Error(`未知 action: ${action}`)
    },
  )))

  disposers.push(ctx.tools.register(makeTool(
    'wechat',
    '操作手机微信。微信界面屏蔽无障碍读取，新消息优先从通知获取；发送消息会自动打开目标聊天、输入中文并点击发送。目标聊天默认为设置中的微信通道。',
    {
      properties: {
        action: {
          type: 'string',
          required: true,
          enum: ['status', 'send', 'open', 'read', 'vision', 'notifications', 'target', 'send_video'],
          description: '要执行的操作。read 会打开聊天并截图；vision 会让已配置的视觉模型识别聊天里的图片/表情/文字。',
        },
        target: { type: 'string', description: '微信联系人/群名；省略时使用设置中的目标。' },
        text: { type: 'string', description: 'send 要发送的文字。' },
        prompt: { type: 'string', description: 'vision 的可选问题，例如“识别对方最新发来的表情或图片”。' },
        path: { type: 'string', description: 'send_video 可选的手机端视频路径；省略时发送最新视频。' },
      },
    },
    async (args) => {
      const action = String(args.action ?? '')
      if (action === 'status') {
        return jsonText({
          bridge: bridge.status(),
          settingsTarget: store.get('wechatTarget'),
          notifications: (await wechat.latestNotifications()).slice(-10),
        })
      }
      if (action === 'send') {
        const target = String(args.target ?? store.get('wechatTarget') ?? '').trim()
        const text = String(args.text ?? '').trim()
        if (!text) throw new Error('缺少 text')
        const result = await wechat.send(target, text)
        return `已发送给 ${result.target}：${result.text}\n截图: ${result.screenshot ?? '无'}`
      }
      if (action === 'open') {
        const target = String(args.target ?? store.get('wechatTarget') ?? '').trim()
        return `已打开聊天: ${jsonText(await wechat.openTarget(target))}`
      }
      if (action === 'read') {
        const target = String(args.target ?? store.get('wechatTarget') ?? '').trim()
        const result = await wechat.readChat(target)
        const text = (result.ocr?.lines ?? []).map((line) => line.text).join('\n')
        return `已打开 ${result.target} 并截图。\n截图: ${result.screenshot}\n\n--- OCR ---\n${text || '未识别到文字（可改用 read_image 读截图）'}`
      }
      if (action === 'vision') {
        const target = String(args.target ?? store.get('wechatTarget') ?? '').trim()
        const result = await wechat.readChat(target)
        const text = await vision.analyze(result.screenshot, args.prompt || [
          '这是微信聊天截图。请识别聊天界面里最新出现的图片、表情、贴纸和文字，',
          '说明对方发了什么、表情表达的情绪；只描述看得见的内容，不要编造。',
        ].join(''))
        return `微信画面识别（${result.target}）:\n${text}\n截图: ${result.screenshot}`
      }
      if (action === 'notifications') {
        const items = await wechat.latestNotifications()
        const filtered = items.filter((item) => item.package === 'com.tencent.mm')
        return jsonText(filtered.slice(-30))
      }
      if (action === 'target') {
        return `当前微信目标: ${store.get('wechatTarget')}`
      }
      if (action === 'send_video') {
        const target = String(args.target ?? store.get('wechatTarget') ?? '').trim()
        const result = await wechat.sendLatestVideo(target, args.path || '')
        let cached = ''
        if (result.filePath) {
          try { cached = await phone.moveToPhoneCache(result.filePath, 'video-') } catch {}
        }
        return `视频已发送到 ${result.target}\n媒体: ${result.media}\n相册索引: ${result.galleryIndex}\n${cached ? `已归档到手机隐藏缓存: ${cached}\n` : ''}预览截图: ${result.preview ?? '无'}\n发送后截图: ${result.screenshot ?? '无'}`
      }
      throw new Error(`未知 action: ${action}`)
    },
  )))

  disposers.push(ctx.tools.register(makeTool(
    'memekb',
    '中文网络热梗知识库。想用热梗、玩梗或接梗前先 search 查含义、用法和风险；检索只做关键词匹配，不调用大模型。高风险/冒犯性梗不要用。',
    {
      properties: {
        action: {
          type: 'string',
          required: true,
          enum: ['search', 'list', 'add', 'remove', 'stats'],
          description: '操作。',
        },
        query: { type: 'string', description: 'search 的关键词或梗名。' },
        term: { type: 'string', description: 'add 的梗名。' },
        aliases: { type: 'string', description: '别名，逗号/空格分隔。' },
        meaning: { type: 'string', description: '含义。' },
        usage: { type: 'string', description: '怎么用、适用语境。' },
        tags: { type: 'string', description: '标签，空格分隔。' },
        risk: { type: 'string', description: '风险：低/中/高。' },
        id: { type: 'string', description: 'remove 的 id。' },
        limit: { type: 'number', description: '返回条数。' },
      },
    },
    async (args) => {
      const action = String(args.action ?? '')
      if (action === 'search') {
        return jsonText(memekb.search(args.query || '', { limit: args.limit }))
      }
      if (action === 'list') {
        return jsonText(memekb.list(Number(args.limit) || 30))
      }
      if (action === 'add') {
        const entry = memekb.add({
          term: args.term,
          aliases: args.aliases || '',
          meaning: args.meaning || '',
          usage: args.usage || '',
          tags: args.tags || '',
          risk: args.risk || '低',
        })
        return `已保存网络梗 ${entry.term}（${entry.id}）`
      }
      if (action === 'remove') {
        return memekb.remove(args.id) ? `已删除 ${args.id}` : `没有找到 ${args.id}`
      }
      if (action === 'stats') {
        return jsonText(memekb.stats())
      }
      throw new Error(`未知 action: ${action}`)
    },
  )))

  disposers.push(ctx.tools.register(makeTool(
    'memory',
    '长期记忆与 App 操作知识库。搜索使用关键词/字符串匹配，不调用大模型；只在需要时取回少量步骤，节省 token。可保存可复用操作步骤、应用事实或用户偏好。',
    {
      properties: {
        action: {
          type: 'string',
          required: true,
          enum: ['search', 'list', 'remember', 'forget', 'stats'],
          description: '操作。',
        },
        query: { type: 'string', description: 'search 的关键词/自然语言查询。' },
        app: { type: 'string', description: '应用包名，可选，用于加权。' },
        title: { type: 'string', description: 'remember 的标题。' },
        body: { type: 'string', description: 'remember 的步骤/事实正文。' },
        keywords: { type: 'string', description: 'remember 的额外关键词，空格分隔。' },
        kind: { type: 'string', enum: ['recipe', 'fact', 'episode'], description: '记忆类型。' },
        id: { type: 'string', description: 'forget 的记忆 id。' },
        limit: { type: 'number', description: '返回条数。' },
      },
    },
    async (args) => {
      const action = String(args.action ?? '')
      if (action === 'search') {
        const hits = memory.search(String(args.query ?? ''), { app: args.app, limit: Number(args.limit) || 5 })
        return jsonText(hits.map((hit) => ({
          id: hit.id,
          kind: hit.kind,
          app: hit.app,
          title: hit.title,
          body: hit.body,
          score: hit.score,
        })))
      }
      if (action === 'list') {
        return jsonText(memory.list(Number(args.limit) || 30))
      }
      if (action === 'remember') {
        const result = memory.remember({
          kind: args.kind || 'recipe',
          app: args.app || '',
          title: args.title,
          body: args.body,
          keywords: args.keywords || '',
        })
        return `已保存记忆 ${result.id}${result.updated ? '（更新了同标题条目）' : ''}。`
      }
      if (action === 'forget') {
        const removed = memory.remove(args.id)
        return removed ? `已删除记忆 ${args.id}` : `没有找到记忆 ${args.id}`
      }
      if (action === 'stats') {
        return jsonText(memory.stats())
      }
      throw new Error(`未知 action: ${action}`)
    },
  )))

  disposers.push(ctx.tools.register(makeTool(
    'phone_skill',
    '手机操作技能（Skill）。把重复操作保存成逻辑步骤：list 查看，run 执行，save 新增/修改，delete 删除。步骤坐标可用 0-1 比例；text 里的 {{参数}} 会从 params 替换。比每次记整串坐标更省 token。',
    {
      properties: {
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'get', 'run', 'save', 'delete'],
          description: '操作。',
        },
        name: { type: 'string', description: '技能名，如“网易云音乐·播放”。' },
        app: { type: 'string', description: '应用包名。' },
        keywords: { type: 'string', description: '检索关键词，空格分隔。' },
        steps: {
          type: 'array',
          description: '步骤数组。支持 launch/tap/swipe/text/key/wake/open/sleep；tap/swipe 坐标可用 0-1 比例。',
          items: { type: 'object', additionalProperties: true },
        },
        params: { type: 'array', description: '参数名列表，如 ["text"]。', items: { type: 'string' } },
        params_values: {
          type: 'object',
          description: 'run 时的参数值，如 {"text":"晴天"}。',
          additionalProperties: true,
        },
        limit: { type: 'number', description: 'list 返回条数。' },
      },
    },
    async (args) => {
      const action = String(args.action ?? '')
      if (action === 'list') return jsonText(memory.listSkills(Number(args.limit) || 30))
      if (action === 'get') {
        const skill = memory.getSkill(args.name)
        return skill ? jsonText(skill) : `没有找到技能 ${args.name}`
      }
      if (action === 'save') {
        const result = memory.saveSkill({
          name: args.name,
          app: args.app || '',
          keywords: args.keywords || '',
          steps: args.steps,
          params: args.params,
        })
        return `技能已保存: ${result.name}（${result.steps} 步${result.updated ? '，更新' : '，新增'}）`
      }
      if (action === 'delete') {
        const result = memory.deleteSkill(args.name)
        return result.deleted ? `已删除技能 ${args.name}` : `没有找到技能 ${args.name}`
      }
      if (action === 'run') {
        const skill = memory.getSkill(args.name)
        if (!skill) throw new Error(`没有找到技能 ${args.name}`)
        const params = args.params_values && typeof args.params_values === 'object' ? args.params_values : {}
        const replace = (value) => {
          if (typeof value === 'string') return value.replace(/\{\{(\w+)\}\}/gu, (_, key) => String(params[key] ?? ''))
          if (Array.isArray(value)) return value.map(replace)
          if (value && typeof value === 'object') {
            const next = {}
            for (const [key, item] of Object.entries(value)) next[key] = replace(item)
            return next
          }
          return value
        }
        const size = await wechat.size()
        const lines = []
        for (const rawStep of skill.steps) {
          const step = replace(rawStep)
          if (step.action === 'launch') {
            await phone.launch(step.target)
            lines.push(`启动 ${step.target}`)
          } else if (step.action === 'open') {
            await wechat.openChat(step.target || store.get('wechatTarget'))
            lines.push(`打开 ${step.target || store.get('wechatTarget')}`)
          } else if (step.action === 'tap') {
            const x = Number(step.x) <= 1 ? Math.round(Number(step.x) * size.width) : Math.round(Number(step.x))
            const y = Number(step.y) <= 1 ? Math.round(Number(step.y) * size.height) : Math.round(Number(step.y))
            await phone.tap(x, y)
            lines.push(`点击 ${x},${y}`)
          } else if (step.action === 'swipe') {
            const scale = (value, total) => Number(value) <= 1 ? Math.round(Number(value) * total) : Math.round(Number(value))
            await phone.swipe(scale(step.x1, size.width), scale(step.y1, size.height), scale(step.x2, size.width), scale(step.y2, size.height), Number(step.duration) || 300)
            lines.push('滑动')
          } else if (step.action === 'text') {
            const text = String(step.text ?? '')
            await wechat.ensureTools()
            try {
              await wechat.ensureIme()
              await wechat.clearText()
              await wechat.typeText(text)
            } finally {
              await wechat.restoreIme().catch(() => {})
            }
            lines.push(`输入 ${text.length} 字`)
          } else if (step.action === 'key') {
            await phone.key(step.key)
            lines.push(`按键 ${step.key}`)
          } else if (step.action === 'wake') {
            await phone.wake()
            lines.push('唤醒')
          } else if (step.action === 'sleep') {
            await sleep(Math.max(100, Math.min(Number(step.ms) || 800, 15000)))
            lines.push('等待')
          }
        }
        return `技能 ${skill.name} 执行完成：\n${lines.join('\n')}`
      }
      throw new Error(`未知 action: ${action}`)
    },
  )))

  disposers.push(ctx.tools.register(makeTool(
    'meme',
    '本地表情包/图片库，只做保存、搜索和打标；不再通过微信相册发送（微信没有稳定可用的发送接口）。图片保存在电脑并推到手机隐藏缓存。标注可用已配置的视觉模型自动打标。',
    {
      properties: {
        action: {
          type: 'string',
          required: true,
          enum: ['add', 'search', 'list', 'remove', 'stats'],
          description: '操作。',
        },
        localPath: { type: 'string', description: 'add 的电脑端图片路径（绝对路径或相对工作目录）。' },
        caption: { type: 'string', description: '图片描述。' },
        tags: { type: 'string', description: '空格分隔的标签，例如“开心 猫 摸鱼”。' },
        emotion: { type: 'string', description: '情绪标签：开心/悲伤/惊讶/无语/可爱/生气/平静。' },
        autoTag: { type: 'boolean', description: 'add 时是否调用已配置的视觉模型自动打标，默认 true。' },
        query: { type: 'string', description: 'search 关键词。' },
        id: { type: 'string', description: 'remove 的表情 id。' },
        limit: { type: 'number', description: '返回条数。' },
      },
    },
    async (args) => {
      const action = String(args.action ?? '')
      if (action === 'add') {
        const raw = String(args.localPath ?? '').trim()
        if (!raw) throw new Error('缺少 localPath')
        const file = isAbsolute(raw) ? raw : resolve(store.get('cwd'), raw)
        let caption = String(args.caption ?? '').trim()
        let tags = Array.isArray(args.tags) ? args.tags.join(' ') : String(args.tags ?? '').trim()
        let emotion = String(args.emotion ?? '').trim()
        let note = ''
        if (args.autoTag !== false) {
          try {
            const vision = await memes.visionTag(file)
            if (vision) {
              caption = vision.caption || caption
              tags = [tags, ...(vision.tags || [])].filter(Boolean).join(' ')
              emotion = vision.emotion || emotion
            }
          } catch (error) {
            note = `（自动打标失败: ${error.message}）`
          }
        }
        const phonePath = ''
        const meme = memes.add({
          localPath: file,
          phonePath,
          caption: caption || file.split(/[\\/]/u).pop(),
          tags,
          emotion,
        })
        return `已加入本地表情库 ${meme.id}\n${meme.caption}\n标签: ${meme.tags}\n情绪: ${meme.emotion}${note}`
      }
      if (action === 'search') {
        const items = memes.search(args.query || '', { emotion: args.emotion, limit: args.limit })
        return jsonText(items)
      }
      if (action === 'list') {
        return jsonText(memes.list(Number(args.limit) || 30))
      }
      if (action === 'remove') {
        return memes.remove(args.id) ? `已删除 ${args.id}` : `没有找到 ${args.id}`
      }
      if (action === 'stats') {
        return jsonText(memes.stats())
      }
      throw new Error(`未知 action: ${action}`)
    },
  )))

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch {}
    }
  }
}
