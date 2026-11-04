import { createHash } from 'node:crypto'

function normalizeEndpoint(baseUrl) {
  let base = String(baseUrl ?? '').trim().replace(/\/+$/u, '')
  if (!base) return ''
  if (/\/embeddings$/u.test(base)) return base
  if (/\/v\d+$/u.test(base)) return `${base}/embeddings`
  return `${base}/v1/embeddings`
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]) || 0
    const y = Number(b[i]) || 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (!na || !nb) return 0
  return dot / Math.sqrt(na * nb)
}

function documentText(row) {
  return [row.title, row.keywords, row.app, row.body].filter(Boolean).join('\n').slice(0, 4000)
}

/**
 * Optional OpenAI-compatible embedding backend.
 * The rest of the memory system keeps working with local character vectors if
 * no endpoint is configured, the request fails, or the model is not reachable.
 */
export class EmbeddingClient {
  constructor(getConfig, bus = null) {
    this.getConfig = typeof getConfig === 'function' ? getConfig : () => getConfig
    this.bus = bus
    this.cache = new Map()
    this.lastFailure = 0
    this.lastError = ''
    this.warned = false
  }

  config() {
    const value = this.getConfig() || {}
    return {
      baseUrl: normalizeEndpoint(value.baseUrl),
      apiKey: String(value.apiKey ?? '').trim(),
      model: String(value.model ?? '').trim(),
    }
  }

  isConfigured() {
    const { baseUrl, model } = this.config()
    return Boolean(baseUrl && model)
  }

  cacheKey(text, config) {
    return createHash('sha256').update(`${config.baseUrl}|${config.model}|${text}`).digest('hex')
  }

  async request(texts, config) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch(config.baseUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: config.model, input: texts }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const json = await response.json()
      const data = Array.isArray(json?.data) ? json.data : []
      const ordered = data
        .slice()
        .sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
        .map((item) => (Array.isArray(item.embedding) ? item.embedding : null))
      if (ordered.length !== texts.length || ordered.some((item) => !item)) {
        throw new Error('embedding 返回数量不匹配')
      }
      return ordered
    } finally {
      clearTimeout(timer)
    }
  }

  async embedMany(texts) {
    const config = this.config()
    if (!config.baseUrl || !config.model) return null
    const now = Date.now()
    if (this.lastFailure && now - this.lastFailure < 60000) return null
    const missing = []
    const keys = texts.map((text) => this.cacheKey(text, config))
    for (let i = 0; i < texts.length; i++) {
      if (!this.cache.has(keys[i])) missing.push({ text: texts[i], key: keys[i] })
    }
    try {
      for (let offset = 0; offset < missing.length; offset += 16) {
        const batch = missing.slice(offset, offset + 16)
        const vectors = await this.request(batch.map((item) => item.text), config)
        for (let i = 0; i < batch.length; i++) this.cache.set(batch[i].key, vectors[i])
      }
      this.lastFailure = 0
      this.warned = false
      return keys.map((key) => this.cache.get(key))
    } catch (error) {
      this.lastFailure = Date.now()
      this.lastError = error.message
      if (!this.warned) {
        this.warned = true
        this.bus?.log?.('warn', `外部 embedding 不可用，回退本地向量: ${error.message}`)
      }
      return null
    }
  }

  async scores(query, rows) {
    if (!this.isConfigured() || rows.length === 0) return null
    const texts = [String(query), ...rows.map(documentText)]
    const vectors = await this.embedMany(texts)
    if (!vectors) return null
    const queryVector = vectors[0]
    const scores = new Map()
    for (let i = 0; i < rows.length; i++) {
      scores.set(rows[i].id, Math.max(0, cosine(queryVector, vectors[i + 1])))
    }
    return scores
  }
}
