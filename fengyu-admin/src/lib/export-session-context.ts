import 'server-only'

import { AsyncLocalStorage } from 'node:async_hooks'
import type { AuthSession } from '@/lib/types'

const exportSessionStorage = new AsyncLocalStorage<AuthSession>()

/** 仅 export-worker 使用，给既有 withPermission action 注入已持久化的权限范围快照。 */
export function getExportSession(): AuthSession | null {
  return exportSessionStorage.getStore() ?? null
}

export function runWithExportSession<T>(
  session: AuthSession,
  callback: () => Promise<T>,
): Promise<T> {
  return exportSessionStorage.run(session, callback)
}
