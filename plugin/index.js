import { EventBus } from './lib/events.js'
import { SettingsStore } from './lib/settings.js'
import { PhoneController } from './lib/phone.js'
import { A11yBridge } from './lib/a11y.js'
import { WeChatAutomation } from './lib/wechat.js'
import { AgentBridge } from './lib/agent.js'
import { WeChatBridge } from './lib/bridge.js'
import { ControlServer } from './lib/server.js'
import { registerTools } from './lib/tools.js'
import { MemoryStore } from './lib/memory.js'
import { MainTaskReporter } from './lib/main-task.js'
import { MemesStore } from './lib/memes.js'
import { MemeKnowledge } from './lib/memekb.js'
import { VisionClient } from './lib/vision.js'

export const name = 'dsh-phone-bridge'
export const inject = ['tools', 'sessionController', 'systemPrompt']
export const VERSION = '0.1.0'

export function apply(ctx, config = {}) {
  const bus = new EventBus()
  const store = new SettingsStore(config)
  const phone = new PhoneController(store, bus)
  const a11y = new A11yBridge(phone, store, bus)
  const wechat = new WeChatAutomation(phone, a11y, store, bus)
  const memory = new MemoryStore(store.dataDir, bus, {
    maxBytes: store.get('memoryMaxBytes'),
    embedding: () => ({
      baseUrl: store.get('embeddingBaseUrl'),
      apiKey: store.get('embeddingApiKey'),
      model: store.get('embeddingModel'),
    }),
  })
  const memes = new MemesStore(store.dataDir, bus, {
    vision: {
      baseUrl: store.get('visionBaseUrl'),
      apiKey: store.get('visionApiKey'),
      model: store.get('visionModel'),
    },
  })
  const memekb = new MemeKnowledge(store.dataDir, bus)
  const vision = new VisionClient(() => ({
    baseUrl: store.get('visionBaseUrl'),
    apiKey: store.get('visionApiKey'),
    model: store.get('visionModel'),
  }), bus)
  const agent = new AgentBridge(ctx, store, bus, { phone, memory })
  const bridge = new WeChatBridge(a11y, wechat, agent, store, bus)
  const mainTask = new MainTaskReporter(ctx, store, wechat, bus, () => agent.sessionId)
  const server = new ControlServer({ ctx, store, phone, a11y, wechat, agent, bridge, memory, memes, memekb, bus, version: VERSION })

  const disposeTools = registerTools(ctx, { phone, a11y, wechat, bridge, store, agent, memory, memes, memekb, vision })
  let disposed = false
  const reviewTimer = setInterval(() => {
    try {
      const result = memory.runReview()
      if (result.forgotten > 0) bus.log('info', `记忆复习：遗忘 ${result.forgotten} 条，复习 ${result.reviewed} 条`)
    } catch (error) {
      bus.log('warn', `记忆复习失败: ${error.message}`)
    }
  }, 30 * 60 * 1000)
  reviewTimer.unref?.()
  const a11yTimer = setInterval(() => {
    a11y.ensure(true).catch(() => {})
  }, 60 * 1000)
  a11yTimer.unref?.()

  ctx.effect(() => {
    const initialize = async () => {
      try {
        const port = await server.start()
        bus.log('info', `DSH 手机助手已加载 (v${VERSION})`, { port, dataDir: store.get('dataDir') })
        ctx.logger?.info?.(`phone-bridge: control panel at http://127.0.0.1:${port}`)
        phone.enforceScreenshotCache().catch((error) => bus.log('warn', `截图缓存清理失败: ${error.message}`))
        phone.enforcePhoneCache().catch((error) => bus.log('warn', `手机缓存清理失败: ${error.message}`))
      } catch (error) {
        bus.log('error', `控制台启动失败: ${error.message}`)
        ctx.logger?.error?.(`phone-bridge: ${error.message}`)
      }
      try {
        await a11y.ensure()
      } catch (error) {
        bus.log('warn', `无障碍助手尚未就绪: ${error.message}`)
      }
      if (store.get('bridgeEnabled')) {
        bridge.start().catch((error) => bus.log('error', `微信桥启动失败: ${error.message}`))
      }
      if (store.get('pendingSessionId')) {
        agent.ensure().catch((error) => bus.log('warn', `恢复微信助手会话失败: ${error.message}`))
      }
    }
    initialize()
    return () => {
      if (disposed) return
      disposed = true
      bridge.dispose()
      mainTask.dispose()
      agent.dispose()
      server.stop().catch(() => {})
      clearInterval(reviewTimer)
      clearInterval(a11yTimer)
      try { memory.close() } catch {}
      try { memes.close() } catch {}
      try { memekb.close() } catch {}
      try { disposeTools() } catch {}
    }
  }, 'phone-bridge')

  return {
    store,
    phone,
    a11y,
    wechat,
    agent,
    bridge,
    server,
  }
}
