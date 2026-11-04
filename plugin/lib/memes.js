import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureDir, run } from './util.js'

function normalize(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

export class MemesStore {
  constructor(dataDir, bus, options = {}) {
    this.bus = bus
    this.vision = options.vision ?? {}
    ensureDir(dataDir)
    this.file = join(dataDir, 'memes.sqlite')
    this.db = new DatabaseSync(this.file)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS memes (
        id TEXT PRIMARY KEY,
        phone_path TEXT NOT NULL,
        local_path TEXT NOT NULL DEFAULT '',
        caption TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '',
        emotion TEXT NOT NULL DEFAULT '',
        sha256 TEXT NOT NULL DEFAULT '',
        sends INTEGER NOT NULL DEFAULT 0,
        last_sent INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memes_emotion ON memes(emotion);
    `)
  }

  async visionTag(localPath, vision = this.vision) {
    if (!vision?.baseUrl || !vision?.apiKey) return null
    const ext = localPath.slice(localPath.lastIndexOf('.')).toLowerCase()
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg'
    const base64 = readFileSync(localPath).toString('base64')
    const response = await fetch(`${String(vision.baseUrl).replace(/\/+$/u, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${vision.apiKey}`,
      },
      body: JSON.stringify({
        model: vision.model || 'gpt-4o-mini',
        temperature: 0.2,
        max_tokens: 300,
        messages: [
          {
            role: 'system',
            content: '你是表情包标注器。只输出 JSON，不要 Markdown。字段：caption（短句）、tags（3-8 个中文标签）、emotion（开心/悲伤/惊讶/无语/可爱/生气/平静 之一）。',
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: '给这个表情包打标签。' },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
            ],
          },
        ],
      }),
    })
    if (!response.ok) throw new Error(`视觉模型 HTTP ${response.status}`)
    const data = await response.json()
    const text = data?.choices?.[0]?.message?.content ?? ''
    const match = String(text).match(/\{[\s\S]*\}/u)
    if (!match) throw new Error('视觉模型没有返回 JSON')
    const parsed = JSON.parse(match[0])
    return {
      caption: String(parsed.caption ?? '').slice(0, 120),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).slice(0, 12) : [],
      emotion: String(parsed.emotion ?? '').slice(0, 20),
    }
  }

  async prepareImage(localPath) {
    const lower = String(localPath).toLowerCase()
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return localPath
    const cacheDir = ensureDir(join(this.dataDir, 'meme-cache'))
    const output = join(cacheDir, `meme-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`)
    const script = fileURLToPath(new URL('../assets/tools/prepare_image.py', import.meta.url))
    const python = process.env.PYTHON || 'python'
    await run(python, [script, localPath, output], { timeout: 30000 })
    return output
  }

  add(entry) {    const id = entry.id || `meme-${randomUUID()}`
    const now = Date.now()
    const sha = entry.sha256 || (entry.localPath && statSync(entry.localPath).isFile()
      ? createHash('sha256').update(readFileSync(entry.localPath)).digest('hex')
      : '')
    this.db.prepare(`
      INSERT INTO memes (id, phone_path, local_path, caption, tags, emotion, sha256, sends, last_sent, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
    `).run(id, entry.phonePath, entry.localPath || '', entry.caption || '', entry.tags || '', entry.emotion || '', sha, now, now)
    this.bus?.emit('meme', { action: 'added', id })
    return this.get(id)
  }

  get(id) {
    return this.db.prepare('SELECT * FROM memes WHERE id = ?').get(String(id))
  }

  search(query, options = {}) {
    const text = normalize(query)
    const emotion = normalize(options.emotion)
    const terms = text.split(/[^\p{L}\p{N}]+/u).filter((term) => term.length >= 1).slice(0, 10)
    let rows = this.db.prepare('SELECT * FROM memes ORDER BY updated_at DESC LIMIT 300').all()
    if (emotion) rows = rows.filter((row) => normalize(row.emotion) === emotion)
    if (terms.length > 0) {
      rows = rows.filter((row) => {
        const haystack = normalize(`${row.caption} ${row.tags} ${row.emotion}`)
        return terms.some((term) => haystack.includes(term))
      })
    }
    const limit = Math.max(1, Math.min(Number(options.limit) || 6, 20))
    return rows.slice(0, limit).map((row) => ({
      id: row.id,
      caption: row.caption,
      tags: row.tags,
      emotion: row.emotion,
      sends: row.sends,
      phonePath: row.phone_path,
    }))
  }

  list(limit = 50) {
    return this.db.prepare('SELECT id, phone_path, caption, tags, emotion, sends, last_sent, created_at FROM memes ORDER BY updated_at DESC LIMIT ?').all(Math.max(1, Math.min(Number(limit) || 50, 200)))
  }

  markSent(id) {
    this.db.prepare('UPDATE memes SET sends = sends + 1, last_sent = ?, updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), String(id))
  }

  remove(id) {
    return this.db.prepare('DELETE FROM memes WHERE id = ?').run(String(id)).changes > 0
  }

  stats() {
    const row = this.db.prepare('SELECT COUNT(*) AS total, SUM(sends) AS sends FROM memes').get()
    return { total: Number(row.total) || 0, sends: Number(row.sends) || 0, file: this.file }
  }

  close() {
    try { this.db.close() } catch {}
  }
}
