const STOP_WORDS = new Set([
  '的', '了', '是', '我', '你', '他', '她', '它', '在', '有', '和', '就', '不', '也', '这', '那',
  '吗', '呢', '吧', '啊', '呀', '哦', '嗯', '把', '被', '给', '让', '对', '从', '到', '会', '能',
  '什么', '怎么', '一下', '一个', '这个', '那个', '可以', '需要', '帮我', '请', '然后', '现在',
])

const KIND_IMPORTANCE = {
  skill: 0.85,
  recipe: 0.72,
  fact: 0.62,
  episode: 0.42,
  conversation: 0.32,
}

function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim()
}

export function tokenize(query) {
  const text = normalize(query)
  if (!text) return []
  const terms = new Set()
  for (const word of text.split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue
    const chinese = word.match(/[\u3400-\u9fff]+/gu) ?? []
    for (const run of chinese) {
      if (run.includes('放歌') || run.includes('听歌')) terms.add('播放')
      if (run.includes('搜歌') || run.includes('找歌')) terms.add('搜索')
      if (run.length <= 4) terms.add(run)
      for (let i = 0; i < run.length - 1; i++) {
        const bigram = run.slice(i, i + 2)
        if (!STOP_WORDS.has(bigram)) terms.add(bigram)
      }
    }
    for (const latin of word.match(/[a-z0-9][a-z0-9._+#-]*/gu) ?? []) {
      if (latin.length >= 3 && !STOP_WORDS.has(latin)) terms.add(latin)
    }
  }
  return [...terms].filter((term) => term.length >= 2).slice(0, 24)
}

function charGrams(text, size = 2) {
  const clean = normalize(text).replace(/[^\p{L}\p{N}]+/gu, '')
  const grams = new Set()
  for (let i = 0; i + size <= clean.length; i++) grams.add(clean.slice(i, i + size))
  return grams
}

function cosine(a, b) {
  if (!a.size || !b.size) return 0
  let hit = 0
  for (const gram of a) if (b.has(gram)) hit += 1
  return hit / Math.sqrt(a.size * b.size)
}

function ageDays(timestamp, now) {
  const value = Number(timestamp) || 0
  if (!value) return 365
  return Math.max(0, (now - value) / 86400000)
}

function fieldTokens(row) {
  return {
    title: tokenize(row.title),
    keywords: tokenize(row.keywords),
    app: tokenize(row.app),
    body: tokenize(row.body),
  }
}

function scoreBM25(queryTerms, docs, options = {}) {
  const k1 = Number(options.k1) || 1.2
  const b = Number(options.b) || 0.75
  const fieldWeights = { title: 3, keywords: 2, app: 1.2, body: 1 }
  const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length)
  const df = new Map()
  for (const doc of docs) for (const term of doc.all) df.set(term, (df.get(term) || 0) + 1)
  const scores = docs.map((doc) => {
    let value = 0
    for (const term of queryTerms) {
      const termDf = df.get(term) || 0
      if (!termDf) continue
      const idf = Math.log(1 + (docs.length - termDf + 0.5) / (termDf + 0.5))
      let tf = 0
      for (const [field, weight] of Object.entries(fieldWeights)) {
        tf += (doc.fields[field]?.filter((item) => item === term).length || 0) * weight
      }
      if (!tf) continue
      const norm = k1 * (1 - b + b * (doc.length / Math.max(1, avgLength)))
      value += idf * ((tf * (k1 + 1)) / (tf + norm))
    }
    return value
  })
  const max = Math.max(...scores, 1)
  return scores.map((value) => value / max)
}

function titleCoverage(queryTerms, row) {
  if (queryTerms.length === 0) return 0
  const title = normalize(`${row.title} ${row.keywords}`)
  let hit = 0
  for (const term of queryTerms) if (title.includes(term)) hit += 1
  return hit / queryTerms.length
}

function kindImportance(row) {
  if (row.kind === 'skill') return KIND_IMPORTANCE.skill
  const base = KIND_IMPORTANCE[row.kind] ?? 0.5
  const uses = Math.min(1, Number(row.uses || 0) / 10)
  return Math.min(1, base + uses * 0.08)
}

/**
 * Hybrid relevance ranking, adapted from AstrBot memory-brain's
 * keyword + semantic + importance + recency + graph weighting:
 * keyword 0.46, semantic 0.18, importance 0.14, recency 0.11, title/entity 0.11.
 */
export function rankMemories(rows, query, options = {}) {
  const terms = tokenize(query)
  if (terms.length === 0) return []
  const now = Number(options.now) || Date.now()
  const minScore = Number(options.minScore) || 0.3
  const limit = Math.max(1, Math.min(Number(options.limit) || 2, 10))
  const docs = rows.map((row) => {
    const fields = fieldTokens(row)
    const all = new Set([...fields.title, ...fields.keywords, ...fields.app, ...fields.body])
    const searchable = normalize(`${row.title} ${row.keywords} ${row.app} ${row.body}`)
    return { row, fields, all, length: all.size, searchable, grams: charGrams(`${row.title} ${row.keywords} ${row.body}`) }
  })
  const bm25 = scoreBM25(terms, docs, options)
  const queryGrams = charGrams(query)
  const scored = docs.map((doc, index) => {
    const row = doc.row
    const sKw = bm25[index]
    const sSem = options.semanticScores instanceof Map && options.semanticScores.has(row.id)
      ? Number(options.semanticScores.get(row.id)) || 0
      : cosine(queryGrams, doc.grams)
    const sImportance = kindImportance(row)
    const sRecency = 0.5 ** (ageDays(row.updated_at, now) / Number(options.halfLifeDays || 14))
    const sTitle = titleCoverage(terms, row)
    let score = 0.46 * sKw + 0.18 * sSem + 0.14 * sImportance + 0.11 * sRecency + 0.11 * sTitle
    if (options.app && normalize(row.app).includes(normalize(options.app))) score += 0.03
    if (row.kind === 'skill') score += 0.02
    return {
      id: row.id,
      kind: row.kind,
      app: row.app,
      title: row.title,
      body: row.body,
      score: Math.round(Math.min(1, score) * 1000) / 1000,
      why: {
        keyword: Math.round(sKw * 1000) / 1000,
        semantic: Math.round(sSem * 1000) / 1000,
        importance: sImportance,
        recency: Math.round(sRecency * 1000) / 1000,
        title: Math.round(sTitle * 1000) / 1000,
      },
    }
  })
  scored.sort((a, b) => b.score - a.score)
  const picked = []
  for (const hit of scored) {
    if (hit.score < minScore) continue
    if (hit.why.keyword < 0.06 && hit.why.semantic < 0.2) continue
    if (picked.some((item) => cosine(charGrams(item.body), charGrams(hit.body)) > 0.82)) continue
    picked.push(hit)
    if (picked.length >= limit) break
  }
  return picked
}

export function formatRelevantBlock(hits, maxChars = 760) {
  if (!hits.length) return ''
  let output = '[相关记忆]\n'
  for (const hit of hits) {
    const body = String(hit.body).replace(/\s+/gu, ' ').trim()
    const line = `- ${hit.title}${hit.app ? ` (${hit.app})` : ''}: ${body.slice(0, 260)}`
    if (output.length + line.length > maxChars) break
    output += `${line}\n`
  }
  return output.trim() === '[相关记忆]' ? '' : `${output}[/相关记忆]`
}
