import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir } from './util.js'
import { formatRelevantBlock, rankMemories } from './relevance.js'
import { EmbeddingClient } from './embeddings.js'
import { appLabel, suggestSkillAction } from './apps.js'

const SEEDS = [
  {
    id: 'seed:wechat-text',
    kind: 'recipe',
    app: 'com.tencent.mm',
    title: '微信：给指定联系人或群发文字',
    keywords: '微信 wechat 发消息 聊天 联系人 群 发文字 输入 发送',
    body: '1) 用 wechat action=open 打开目标聊天（内部会搜索联系人并点第一条）。2) 点底部输入框：1080x2340 下约 (400,2270)。3) 输入法必须是 ADBKeyboard，通过 ADB_INPUT_B64 写入中文。4) 广播 ADB_EDITOR_CODE --ei code 4 触发发送。5) 发送后恢复原输入法。坐标比例：输入框 (0.37,0.97)。',
  },
  {
    id: 'seed:wechat-media',
    kind: 'recipe',
    app: 'com.tencent.mm',
    title: '微信：从相册发送视频/图片',
    keywords: '微信 发视频 发图片 相册 附件 媒体 发送',
    body: '1) 打开目标聊天。2) 点右下角 +：1080x2340 下约 (990,2270)。3) 点“相册”：约 (160,1685)。4) 相册网格是图片/视频缩略图；点目标缩略图进入预览。5) 点右下角绿色“发送”：约 (979,2306)。6) 截图确认绿色气泡/视频缩略图。',
  },
  {
    id: 'seed:wechat-a11y',
    kind: 'fact',
    app: 'com.tencent.mm',
    title: '微信界面屏蔽无障碍节点',
    keywords: '微信 无障碍 节点 uiautomator 读屏 截图 读图',
    body: '实测微信聊天界面 dump 只有根节点；不要依赖 phone action=ui 读取微信内容。读消息用通知，判断画面用截图 + read_image，点击用坐标。',
  },
  {
    id: 'seed:camera-video',
    kind: 'recipe',
    app: 'com.huawei.camera',
    title: '相机：前置摄像头录 5 秒视频',
    keywords: '相机 摄像头 前置 录像 录视频 5秒 拍摄',
    body: '1) 启动：am start -a android.media.action.VIDEO_CAPTURE --ei android.intent.extras.CAMERA_FACING 1 --ei android.intent.extra.durationLimit 5。2) 相机页可无障碍读取，点 id=com.huawei.camera:id/shutter_button。3) 等待约 7 秒会自动停止并进入回看页。4) 点 id=com.huawei.camera:id/done_button 保存。5) 视频在 /sdcard/DCIM/Camera/VID_*.mp4，用 ls -t 找最新。',
  },
  {
    id: 'seed:camera-a11y',
    kind: 'fact',
    app: 'com.huawei.camera',
    title: '华为相机可以用无障碍节点操作',
    keywords: '相机 无障碍 节点 按钮 录像 快门',
    body: '华为相机 VideoCamera 暴露节点：shutter_button、done_button、btn_review_cancel、feature_system_back_entrance 等，可用 phone action=ui 和按 id 点击。',
  },
  {
    id: 'seed:music-netease',
    kind: 'recipe',
    app: 'com.netease.cloudmusic',
    title: '网易云音乐：搜索并播放歌曲',
    keywords: '网易云音乐 音乐 播放 搜索 歌曲 三Z工作室 网易云',
    body: '1) 启动 com.netease.cloudmusic。2) 点搜索入口（放大镜）。3) ADBKeyboard 输入歌名/歌手。4) 点第一条歌曲结果。5) 播放后可用 adb shell media dispatch play/pause/next 控制。若界面被遮挡，截图 + read_image 后按坐标点击。',
  },
  {
    id: 'seed:a11y-general',
    kind: 'fact',
    app: '',
    title: '普通应用优先用无障碍节点操作',
    keywords: '无障碍 节点 应用 app 点击 文字 控件',
    body: '普通应用用 phone action=ui 读取节点，优先按 text/desc/id 找到 center 再 tap；找不到或界面被屏蔽时再用 screenshot + read_image 判断坐标。',
  },
  {
    id: 'seed:scrcpy-screenoff',
    kind: 'fact',
    app: '',
    title: 'scrcpy 熄屏镜像',
    keywords: 'scrcpy 熄屏 黑屏 镜像 投屏 屏幕 关闭',
    body: '启动 scrcpy 时加 --turn-screen-off --stay-awake：手机物理屏幕熄灭，但 scrcpy 镜像画面继续，触摸/ADB 仍可控。控制台“熄屏镜像”按钮会重启 scrcpy 并应用该参数。',
  },
  {
    id: 'seed:pin-unlock',
    kind: 'fact',
    app: '',
    title: '锁屏自动解锁',
    keywords: '锁屏 密码 PIN 解锁 自动 开机',
    body: '在设置中配置锁屏密码后，phone wake 会唤醒、上滑、输入 PIN 并回车；如果解锁失败会明确报错。密码只保存在本机 phone-bridge-data/settings.json，不进入提示词。',
  },
  {
    id: 'seed:ime',
    kind: 'fact',
    app: '',
    title: '中文输入依赖 ADBKeyboard',
    keywords: '中文 输入 输入法 ADBKeyboard 发送 微信',
    body: 'ADBKeyboard 通过广播 ADB_INPUT_B64 写入中文，ADB_EDITOR_CODE code=4 触发 IME 发送。发送完成后恢复用户原输入法。',
  },
]

function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s\r\n\t]+/g, ' ')
    .trim()
}

function buildTerms(query) {
  const text = normalize(query)
  if (!text) return []
  const words = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const terms = new Set()
  for (const word of words) {
    const chineseRuns = word.match(/[\u3400-\u9fff]+/gu) ?? []
    for (const run of chineseRuns) {
      if (run.length <= 10) terms.add(run)
      for (let i = 0; i < run.length - 1; i++) terms.add(run.slice(i, i + 2))
      if (run.length > 2) {
        terms.add(run.slice(0, 2))
        terms.add(run.slice(-2))
      }
    }
    for (const latin of word.match(/[a-z0-9][a-z0-9.+#_-]*/gu) ?? []) {
      if (latin.length >= 3) terms.add(latin)
    }
  }
  return [...terms].filter((term) => term.length >= 2 || /[\u3400-\u9fff]/u.test(term)).slice(0, 12)
}

export class MemoryStore {
  constructor(dataDir, bus, options = {}) {
    this.bus = bus
    this.maxBytes = Number(options.maxBytes) || 5 * 1024 * 1024 * 1024
    this.embedding = new EmbeddingClient(options.embedding, bus)
    ensureDir(dataDir)
    this.file = join(dataDir, 'memory.sqlite')
    this.db = new DatabaseSync(this.file)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        app TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        keywords TEXT NOT NULL DEFAULT '',
        search_text TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        uses INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS memories_app ON memories(app);
      CREATE INDEX IF NOT EXISTS memories_kind ON memories(kind);
      CREATE TABLE IF NOT EXISTS conversation (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS phone_skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        app TEXT NOT NULL DEFAULT '',
        keywords TEXT NOT NULL DEFAULT '',
        steps TEXT NOT NULL,
        params TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS phone_skills_app ON phone_skills(app);
    `)
    const columns = new Set(this.db.prepare('PRAGMA table_info(memories)').all().map((column) => column.name))
    const migrations = [
      ['tier', "ALTER TABLE memories ADD COLUMN tier TEXT NOT NULL DEFAULT 'long'"],
      ['hits', 'ALTER TABLE memories ADD COLUMN hits INTEGER NOT NULL DEFAULT 0'],
      ['last_hit', 'ALTER TABLE memories ADD COLUMN last_hit INTEGER NOT NULL DEFAULT 0'],
      ['next_review', 'ALTER TABLE memories ADD COLUMN next_review INTEGER NOT NULL DEFAULT 0'],
      ['review_count', 'ALTER TABLE memories ADD COLUMN review_count INTEGER NOT NULL DEFAULT 0'],
      ['strength', 'ALTER TABLE memories ADD COLUMN strength REAL NOT NULL DEFAULT 1'],
    ]
    for (const [name, sql] of migrations) if (!columns.has(name)) this.db.exec(sql)
    this.applyMaxBytes(this.maxBytes)
    this.seed()
    this.pruneLegacyEpisodes()
    this.normalizeSkillNames()
  }

  normalizeSkillNames() {
    try {
      const rows = this.db.prepare('SELECT id, name, app, steps FROM phone_skills').all()
      let renamed = 0
      for (const row of rows) {
        const name = String(row.name || '')
        if (!/[·]/u.test(name) && !/^com\./u.test(name) && !/-操作$/u.test(name)) continue
        const steps = this.parseJson(row.steps, [])
        const suggested = `${appLabel(row.app)}-${suggestSkillAction(row.app, steps, '')}`
        if (!suggested || suggested === name) continue
        const existing = this.db.prepare('SELECT id FROM phone_skills WHERE name = ? LIMIT 1').get(suggested)
        if (existing && existing.id !== row.id) {
          this.db.prepare('DELETE FROM phone_skills WHERE id = ?').run(row.id)
        } else {
          this.db.prepare('UPDATE phone_skills SET name = ?, updated_at = ? WHERE id = ?').run(suggested, Date.now(), row.id)
        }
        renamed += 1
      }
      if (renamed > 0) this.bus?.log?.('info', `已重命名 ${renamed} 个旧技能`)
    } catch {}
    try {
      const rows = this.db.prepare('SELECT id, app, keywords, steps FROM phone_skills').all()
      for (const row of rows) {
        const keywords = String(row.keywords || '')
        const parts = keywords.split(/\s+/u).filter(Boolean)
        const duplicateApp = row.app && parts.filter((part) => part === row.app).length > 1
        if (!duplicateApp && !/操作\s+技能$/u.test(keywords)) continue
        const steps = this.parseJson(row.steps, [])
        const clean = [appLabel(row.app), row.app, suggestSkillAction(row.app, steps, ''), '技能'].filter(Boolean).join(' ')
        this.db.prepare('UPDATE phone_skills SET keywords = ?, updated_at = ? WHERE id = ?').run(clean, Date.now(), row.id)
      }
    } catch {}
  }

  pruneLegacyEpisodes() {
    try {
      const result = this.db.prepare(`
        DELETE FROM memories
        WHERE kind = 'episode'
          AND (title LIKE '操作记录：%' OR body LIKE '%目标:%步骤:%')
      `).run()
      if (Number(result.changes) > 0) this.bus?.log?.('info', `已清理 ${result.changes} 条旧的长操作记录`)
    } catch {}
    try {
      const result = this.db.prepare(`
        DELETE FROM memories
        WHERE kind = 'recipe'
          AND (title LIKE '技能：%' OR title LIKE '技能:%')
      `).run()
      if (Number(result.changes) > 0) this.bus?.log?.('info', `已从记忆库移出 ${result.changes} 条旧技能摘要`)
    } catch {}
  }

  applyMaxBytes(maxBytes) {
    this.maxBytes = Math.max(1024 * 1024, Number(maxBytes) || 5 * 1024 * 1024 * 1024)
    try {
      const pageSize = Number(this.db.prepare('PRAGMA page_size').get()?.page_size) || 4096
      const pages = Math.max(256, Math.floor(this.maxBytes / pageSize))
      this.db.exec(`PRAGMA max_page_count = ${pages}`)
    } catch (error) {
      this.bus?.log?.('warn', `记忆容量限制设置失败: ${error.message}`)
    }
  }

  fileSize() {
    try { return statSync(this.file).size } catch { return 0 }
  }

  seed() {
    const now = Date.now()
    for (const seed of SEEDS) {
      const exists = this.db.prepare('SELECT id FROM memories WHERE id = ?').get(seed.id)
      if (exists) continue
      this.insert({ ...seed, id: seed.id, createdAt: now, updatedAt: now })
    }
  }

  insert(entry) {
    const now = Date.now()
    const id = entry.id || `mem-${randomUUID()}`
    const app = String(entry.app ?? '').trim()
    const title = String(entry.title ?? '').trim()
    const body = String(entry.body ?? '').trim()
    const keywords = String(entry.keywords ?? '').trim()
    const kind = entry.kind || 'recipe'
    const tier = entry.tier || (kind === 'episode' || kind === 'conversation' ? 'short' : 'long')
    const nextReview = Number(entry.nextReview) || (tier === 'short' ? Date.now() + 60 * 60 * 1000 : 0)
    const searchText = normalize(`${app} ${title} ${keywords} ${body}`)
    this.db.prepare(`
      INSERT INTO memories (id, kind, app, title, body, keywords, search_text, created_at, updated_at, uses, tier, next_review)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind=excluded.kind, app=excluded.app, title=excluded.title, body=excluded.body,
        keywords=excluded.keywords, search_text=excluded.search_text, updated_at=excluded.updated_at,
        tier=excluded.tier
    `).run(id, kind, app, title, body, keywords, searchText, entry.createdAt || now, entry.updatedAt || now, tier, nextReview)
    return id
  }

  remember(entry) {
    const app = String(entry.app ?? '').trim()
    const title = String(entry.title ?? '').trim()
    if (!title || !String(entry.body ?? '').trim()) throw new Error('记忆需要 title 和 body')
    const existing = this.db.prepare('SELECT id FROM memories WHERE title = ? AND app = ? LIMIT 1').get(title, app)
    const id = existing?.id || `mem-${randomUUID()}`
    this.insert({ ...entry, id, app, title, kind: entry.kind || 'recipe' })
    this.bus?.emit('memory', { action: existing ? 'updated' : 'added', id, title })
    this.enforceLimit()
    return { id, updated: Boolean(existing) }
  }

  saveSkill(entry) {
    const name = String(entry.name ?? '').trim().slice(0, 80)
    if (!name) throw new Error('技能需要 name')
    const steps = Array.isArray(entry.steps) ? entry.steps : []
    if (steps.length === 0) throw new Error('技能需要至少一个步骤')
    if (steps.length > 40) throw new Error('技能步骤不能超过 40 个')
    const app = String(entry.app ?? '').trim().slice(0, 80)
    const keywords = String(entry.keywords ?? '').trim().slice(0, 240)
    const params = Array.isArray(entry.params) ? entry.params.map(String).slice(0, 12) : []
    const now = Date.now()
    const existing = this.db.prepare('SELECT id FROM phone_skills WHERE name = ? LIMIT 1').get(name)
    const id = existing?.id || `skill-${randomUUID()}`
    this.db.prepare(`
      INSERT INTO phone_skills (id, name, app, keywords, steps, params, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, app=excluded.app, keywords=excluded.keywords,
        steps=excluded.steps, params=excluded.params, updated_at=excluded.updated_at
    `).run(id, name, app, keywords, JSON.stringify(steps), JSON.stringify(params), now, now)
    this.bus?.emit('skill', { action: existing ? 'updated' : 'saved', name })
    return { id, name, updated: Boolean(existing), steps: steps.length }
  }

  listSkills(limit = 30) {
    const rows = this.db.prepare('SELECT id, name, app, keywords, params, steps, updated_at FROM phone_skills ORDER BY updated_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(Number(limit) || 30, 100)))
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      app: row.app,
      keywords: row.keywords,
      params: this.parseJson(row.params, []),
      steps: this.parseJson(row.steps, []).length,
      updatedAt: row.updated_at,
    }))
  }

  getSkill(nameOrId) {
    const key = String(nameOrId ?? '').trim()
    if (!key) return null
    const row = this.db.prepare('SELECT * FROM phone_skills WHERE name = ? OR id = ? LIMIT 1').get(key, key)
    if (!row) return null
    return {
      id: row.id,
      name: row.name,
      app: row.app,
      keywords: row.keywords,
      steps: this.parseJson(row.steps, []),
      params: this.parseJson(row.params, []),
      updatedAt: row.updated_at,
    }
  }

  deleteSkill(nameOrId) {
    const key = String(nameOrId ?? '').trim()
    if (!key) return { deleted: 0 }
    const result = this.db.prepare('DELETE FROM phone_skills WHERE name = ? OR id = ?').run(key, key)
    return { deleted: Number(result.changes) || 0 }
  }

  parseJson(value, fallback) {
    try { return JSON.parse(value) } catch { return fallback }
  }

  search(query, options = {}) {
    const terms = buildTerms(query)
    if (terms.length === 0) return []
    const appFilter = String(options.app ?? '').trim()
    const limit = Math.max(1, Math.min(Number(options.limit) || 5, 20))
    const clauses = terms.map(() => 'search_text LIKE ?').join(' OR ')
    const params = terms.map((term) => `%${term}%`)
    const rows = this.db.prepare(`SELECT * FROM memories WHERE ${clauses} ORDER BY updated_at DESC LIMIT 250`).all(...params)
    const q = normalize(query)
    const scored = []
    for (const row of rows) {
      const title = normalize(row.title)
      const app = normalize(row.app)
      const keywords = normalize(row.keywords)
      const body = normalize(row.body)
      let score = 0
      for (const term of terms) {
        if (title.includes(term)) score += 7
        if (app.includes(term)) score += 5
        if (keywords.includes(term)) score += 4
        if (body.includes(term)) score += 1
      }
      if (q.length >= 2 && title.includes(q)) score += 14
      if (appFilter && app === normalize(appFilter)) score += 10
      if (appFilter && app.includes(normalize(appFilter))) score += 6
      if (row.kind === 'recipe') score += 2
      score += Math.min(3, Number(row.uses || 0) * 0.25)
      if (score > 0) scored.push({ row, score })
    }
    scored.sort((a, b) => b.score - a.score || Number(b.row.updated_at) - Number(a.row.updated_at))
    const chosen = scored.slice(0, limit)
    for (const item of chosen) {
      try {
        const nextHits = Number(item.row.hits || 0) + 1
        const promote = item.row.tier === 'short' && nextHits >= 3
        const nextReview = promote
          ? Date.now() + 24 * 60 * 60 * 1000
          : Number(item.row.next_review || 0)
        this.db.prepare('UPDATE memories SET uses = uses + 1, hits = hits + 1, last_hit = ?, tier = ?, next_review = ? WHERE id = ?')
          .run(Date.now(), promote ? 'long' : item.row.tier, nextReview, item.row.id)
        if (promote) this.bus?.emit('memory', { action: 'promoted', id: item.row.id, title: item.row.title })
      } catch {}
    }
    return chosen.map(({ row, score }) => ({
      id: row.id,
      kind: row.kind,
      tier: row.tier,
      app: row.app,
      title: row.title,
      body: row.body,
      keywords: row.keywords,
      score,
      hits: Number(row.hits || 0) + 1,
      updatedAt: row.updated_at,
    }))
  }

  async recallRelevant(query, options = {}) {
    const text = String(query ?? '').trim()
    if (text.length < 2) return ''
    const rows = this.db.prepare(`
      SELECT id, kind, app, title, body, keywords, updated_at, uses
      FROM memories
      WHERE kind IN ('recipe', 'fact')
      ORDER BY updated_at DESC
      LIMIT 500
    `).all()
    let semanticScores = null
    try {
      semanticScores = await this.embedding.scores(text, rows)
    } catch (error) {
      this.bus?.log?.('warn', `外部向量检索失败，回退本地向量: ${error.message}`)
    }
    const hits = rankMemories(rows, text, {
      app: options.app,
      limit: options.limit || 1,
      minScore: options.minScore ?? 0.3,
      semanticScores,
    })
    if (hits.length === 0) return ''
    try {
      const now = Date.now()
      for (const hit of hits) {
        this.db.prepare('UPDATE memories SET hits = hits + 1, last_hit = ?, updated_at = updated_at WHERE id = ?').run(now, hit.id)
      }
    } catch {}
    return formatRelevantBlock(hits, options.maxChars || 760)
  }

  recall(query, options = {}) {
    const hits = this.search(query, { ...options, limit: Number(options.limit) || 2 })
    if (hits.length === 0) return ''
    let output = '[长期记忆命中]\n'
    for (const hit of hits) {
      const body = String(hit.body).replace(/\s+/g, ' ').trim()
      const line = `- ${hit.title}${hit.app ? ` (${hit.app})` : ''}: ${body.slice(0, 260)}`
      if (output.length + line.length > 800) break
      output += `${line}\n`
    }
    return output.trim() === '[长期记忆命中]' ? '' : `${output}[/长期记忆命中]`
  }

  appendConversation(role, text, source = '', sessionId = '') {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000)
    if (!clean) return
    this.db.prepare('INSERT INTO conversation (role, text, source, session_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(role, clean, String(source), String(sessionId), Date.now())
    const count = Number(this.db.prepare('SELECT COUNT(*) AS n FROM conversation').get().n) || 0
    if (count > 500) {
      this.db.prepare('DELETE FROM conversation WHERE id IN (SELECT id FROM conversation ORDER BY id ASC LIMIT ?)').run(count - 500)
    }
  }

  conversationCount() {
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM conversation').get().n) || 0
  }

  compactConversation(window = 20) {
    const rows = this.db.prepare('SELECT * FROM conversation ORDER BY id DESC LIMIT ?').all(Math.max(4, Math.min(Number(window) || 20, 80))).reverse()
    if (rows.length < 6) return null
    const users = rows.filter((row) => row.role === 'user')
    const assistants = rows.filter((row) => row.role === 'assistant')
    const firstUser = users[0]?.text ?? '最近对话'
    const title = `对话摘要：${firstUser.slice(0, 40)}`
    const lines = []
    for (const row of rows.slice(-8)) {
      lines.push(`${row.role === 'user' ? '用户' : '鱼鱼'}: ${row.text.slice(0, 180)}`)
    }
    const keywords = buildTerms(rows.map((row) => row.text).join(' ')).slice(0, 10).join(' ')
    const body = `${lines.join('\n')}\n关键词: ${keywords}`
    const id = this.remember({ kind: 'conversation', tier: 'short', app: '', title, body, keywords })
    const keep = 4
    this.db.prepare('DELETE FROM conversation WHERE id NOT IN (SELECT id FROM conversation ORDER BY id DESC LIMIT ?)').run(keep)
    this.bus?.emit('memory', { action: 'compacted', id, title })
    return id
  }

  runReview(now = Date.now()) {
    const intervals = [60 * 60 * 1000, 24 * 60 * 60 * 1000, 2 * 24 * 60 * 60 * 1000, 4 * 24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000, 15 * 24 * 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000, 60 * 24 * 60 * 60 * 1000]
    const due = this.db.prepare(`
      SELECT * FROM memories
      WHERE kind IN ('episode', 'conversation') AND next_review > 0 AND next_review <= ?
      ORDER BY next_review ASC LIMIT 50
    `).all(now)
    let forgotten = 0
    let reviewed = 0
    for (const row of due) {
      const strength = Number(row.strength || 1)
      if (strength < 0.25 && Math.random() < 0.35) {
        this.db.prepare('DELETE FROM memories WHERE id = ?').run(row.id)
        forgotten++
        this.bus?.emit('memory', { action: 'forgotten', id: row.id, title: row.title })
        continue
      }
      const nextCount = Number(row.review_count || 0) + 1
      const base = intervals[Math.min(nextCount, intervals.length - 1)]
      const jitter = 0.8 + Math.random() * 0.4
      const nextReview = now + Math.round(base * jitter)
      const nextStrength = Math.min(2, strength + 0.15)
      this.db.prepare('UPDATE memories SET review_count = ?, strength = ?, next_review = ?, updated_at = ? WHERE id = ?')
        .run(nextCount, nextStrength, nextReview, now, row.id)
      reviewed++
    }
    const cutoff = now - 7 * 24 * 60 * 60 * 1000
    this.db.prepare('DELETE FROM conversation WHERE created_at < ?').run(cutoff)
    this.enforceLimit()
    return { due: due.length, reviewed, forgotten, fileSize: this.fileSize(), maxBytes: this.maxBytes }
  }

  enforceLimit(maxBytes = this.maxBytes) {
    const limit = Math.max(1024 * 1024, Number(maxBytes) || 5 * 1024 * 1024 * 1024)
    if (this.fileSize() <= limit) return { pruned: 0, fileSize: this.fileSize(), maxBytes: limit }
    let pruned = 0
    while (this.fileSize() > limit * 0.9) {
      const rows = this.db.prepare(`
        SELECT id FROM memories WHERE kind IN ('episode', 'conversation')
        ORDER BY hits ASC, updated_at ASC LIMIT 50
      `).all()
      if (rows.length === 0) break
      const statement = this.db.prepare('DELETE FROM memories WHERE id = ?')
      for (const row of rows) {
        statement.run(row.id)
        pruned++
      }
    }
    this.bus?.emit('memory', { action: 'pruned', pruned, fileSize: this.fileSize(), maxBytes: limit })
    return { pruned, fileSize: this.fileSize(), maxBytes: limit }
  }

  list(limit = 50) {
    return this.db.prepare('SELECT id, kind, tier, app, title, body, keywords, hits, next_review, created_at, updated_at, uses FROM memories ORDER BY updated_at DESC LIMIT ?').all(Math.max(1, Math.min(Number(limit) || 50, 200)))
  }

  get(id) {
    return this.db.prepare('SELECT * FROM memories WHERE id = ?').get(String(id))
  }

  remove(id) {
    const result = this.db.prepare('DELETE FROM memories WHERE id = ?').run(String(id))
    this.bus?.emit('memory', { action: 'removed', id })
    return result.changes > 0
  }

  stats() {
    const row = this.db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN kind = 'recipe' THEN 1 ELSE 0 END) AS recipes,
      SUM(CASE WHEN kind = 'episode' THEN 1 ELSE 0 END) AS episodes,
      SUM(CASE WHEN tier = 'short' THEN 1 ELSE 0 END) AS short_term,
      SUM(CASE WHEN tier = 'long' THEN 1 ELSE 0 END) AS long_term
      FROM memories`).get()
    return {
      total: Number(row.total) || 0,
      recipes: Number(row.recipes) || 0,
      episodes: Number(row.episodes) || 0,
      shortTerm: Number(row.short_term) || 0,
      longTerm: Number(row.long_term) || 0,
      fileSize: this.fileSize(),
      maxBytes: this.maxBytes,
      conversation: this.conversationCount(),
      file: this.file,
    }
  }

  pruneEpisodes(max = 250) {
    const count = Number(this.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE kind = 'episode'").get().n) || 0
    if (count <= max) return
    this.db.prepare("DELETE FROM memories WHERE id IN (SELECT id FROM memories WHERE kind = 'episode' ORDER BY updated_at ASC LIMIT ?)").run(count - max)
  }

  close() {
    try { this.db.close() } catch {}
  }
}

export function memoryHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
}
