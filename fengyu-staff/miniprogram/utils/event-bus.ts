// utils/event-bus.ts — 简单事件总线
// 用于跨页广播（e.g. workbench 切换门店 → 其他 tab 刷新数据）
type Handler = (...args: any[]) => void

const handlers = new Map<string, Set<Handler>>()

export function on(event: string, handler: Handler): () => void {
  let set = handlers.get(event)
  if (!set) {
    set = new Set()
    handlers.set(event, set)
  }
  set.add(handler)
  return () => off(event, handler)
}

export function off(event: string, handler: Handler): void {
  const set = handlers.get(event)
  if (!set) return
  set.delete(handler)
}

export function emit(event: string, ...args: any[]): void {
  const set = handlers.get(event)
  if (!set) return
  for (const h of set) {
    try {
      h(...args)
    } catch (err) {
      console.error(`[event-bus] handler error for "${event}":`, err)
    }
  }
}

export const EVENT_STORE_CHANGED = 'store-changed'
