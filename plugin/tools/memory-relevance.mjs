#!/usr/bin/env node
// 相关性检索调试脚本：只读，不会写记忆。
// 用法: node tools/memory-relevance.mjs "帮我放首歌" [--limit 3] [--min 0.3] [--app com.netease.cloudmusic]
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rankMemories } from '../lib/relevance.js'
import { EmbeddingClient } from '../lib/embeddings.js'

const argv = process.argv.slice(2)
const query = argv.find((arg) => !arg.startsWith('--')) || ''
const flag = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}
const limit = Number(flag('--limit', '3'))
const minScore = Number(flag('--min', '0.3'))
const app = flag('--app', '')
const dbPath = process.env.DSH_MEMORY_DB || 'F:/DeepSeek_harness_ws/others/phone-bridge-data/memory.sqlite'
if (!query) {
  console.error('用法: node tools/memory-relevance.mjs "查询" [--limit 3] [--min 0.3] [--app 包名]')
  process.exit(1)
}
const db = new DatabaseSync(dbPath)
const rows = db.prepare(`
  SELECT id, kind, app, title, body, keywords, updated_at, uses
  FROM memories
  WHERE kind IN ('recipe', 'fact')
  ORDER BY updated_at DESC
  LIMIT 500
`).all()
let settings = {}
try { settings = JSON.parse(readFileSync('F:/DeepSeek_harness_ws/others/phone-bridge-data/settings.json', 'utf8')) } catch {}
const embedding = new EmbeddingClient({
  baseUrl: settings.embeddingBaseUrl || process.env.EMBEDDING_BASE_URL || '',
  apiKey: settings.embeddingApiKey || process.env.EMBEDDING_API_KEY || '',
  model: settings.embeddingModel || process.env.EMBEDDING_MODEL || '',
})
const semanticScores = await embedding.scores(query, rows)
const hits = rankMemories(rows, query, { limit, minScore, app, semanticScores })
console.log(JSON.stringify({ query, db: join(dbPath), externalEmbedding: embedding.isConfigured(), hits }, null, 2))
db.close()
