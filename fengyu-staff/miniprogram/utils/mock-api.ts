// utils/mock-api.ts — Mock 调度器
import { MOCK_ENABLED } from './dev-config'

type MockHandler = (payload: Record<string, any>) => any

let handlers: Record<string, MockHandler> | null = null

function getHandlers(): Record<string, MockHandler> {
  if (!handlers) {
    handlers = require('../mock/index').mockHandlers
  }
  return handlers!
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Mock 拦截入口
 * @returns mock 数据，或 null 表示不拦截（走真实 API）
 */
export async function mockCallApi(
  action: string,
  payload: Record<string, any>
): Promise<any | null> {
  if (!MOCK_ENABLED) return null

  const allHandlers = getHandlers()
  const handler = allHandlers[action]
  if (!handler) return null

  await delay(300 + Math.random() * 400)

  const result = handler(payload)
  console.log(`[Mock] ${action}`, payload, '→', result)
  return result
}
