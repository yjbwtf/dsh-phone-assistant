export class EventBus {
  constructor() {
    this.listeners = new Set()
    this.logs = []
    this.seq = 0
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(type, payload = {}) {
    const event = {
      type,
      time: Date.now(),
      seq: ++this.seq,
      ...payload,
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // A broken SSE client must not break the bridge.
      }
    }
    return event
  }

  log(level, message, data) {
    const entry = {
      level,
      message: String(message ?? ''),
      data: data === undefined ? undefined : data,
      time: Date.now(),
    }
    this.logs.push(entry)
    if (this.logs.length > 400) this.logs.splice(0, this.logs.length - 400)
    this.emit('log', entry)
  }
}
