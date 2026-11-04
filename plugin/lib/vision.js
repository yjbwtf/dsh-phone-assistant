import { readFileSync } from 'node:fs'

function normalizeBase(baseUrl) {
  let base = String(baseUrl ?? '').trim().replace(/\/+$/u, '')
  if (!base) return ''
  if (/\/chat\/completions$/u.test(base)) return base
  if (/\/v\d+$/u.test(base)) return `${base}/chat/completions`
  return `${base}/v1/chat/completions`
}

function mimeFor(path) {
  const lower = String(path).toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return 'image/jpeg'
}

/**
 * General screen/image understanding through the same OpenAI-compatible
 * vision endpoint used by meme auto-tagging.
 */
export class VisionClient {
  constructor(getConfig, bus = null) {
    this.getConfig = typeof getConfig === 'function' ? getConfig : () => getConfig
    this.bus = bus
  }

  config() {
    const value = this.getConfig() || {}
    return {
      endpoint: normalizeBase(value.baseUrl),
      apiKey: String(value.apiKey ?? '').trim(),
      model: String(value.model ?? '').trim(),
    }
  }

  isConfigured() {
    const { endpoint, model } = this.config()
    return Boolean(endpoint && model)
  }

  async analyze(localPath, prompt = '') {
    const config = this.config()
    if (!config.endpoint || !config.model) throw new Error('未配置视觉模型（Base / 模型 / Key）')
    if (!localPath) throw new Error('缺少图片路径')
    const base64 = readFileSync(localPath).toString('base64')
    const question = String(prompt ?? '').trim() || [
      '你是手机屏幕视觉助手。',
      '识别这张手机截图里的界面、文字、图片、表情和贴纸，重点说明用户发来的图片或表情是什么。',
      '只描述看得见的内容，不要猜测或编造。',
    ].join('')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 45000)
    try {
      const response = await fetch(config.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.model,
          temperature: 0.2,
          max_tokens: 700,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: question },
                { type: 'image_url', image_url: { url: `data:${mimeFor(localPath)};base64,${base64}` } },
              ],
            },
          ],
        }),
        signal: controller.signal,
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`视觉模型 HTTP ${response.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`)
      }
      const data = await response.json()
      const text = String(data?.choices?.[0]?.message?.content ?? '').trim()
      if (!text) throw new Error('视觉模型没有返回内容')
      return text
    } finally {
      clearTimeout(timer)
    }
  }
}
