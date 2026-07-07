import { getSession } from '@/lib/auth'
import { requirePermission, requireAnyPermission } from '@/lib/permissions'
import { parseErrorPrefix } from '@/lib/api-error'
import type { AuthSession } from '@/lib/types'


function rethrowWithDigest(err: unknown): never {
  if (
    err instanceof Error &&
    !(err as { digest?: unknown }).digest &&
    parseErrorPrefix(err.message)
  ) {
    ;(err as { digest?: string }).digest = err.message
  }
  throw err
}


export function withPermission<Args extends unknown[], R>(
  action: string,
  fn: (session: AuthSession, ...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  return async (...args: Args) => {
    const session = await getSession()
    requirePermission(session, action)
    try {
      return await fn(session, ...args)
    } catch (err) {
      rethrowWithDigest(err)
    }
  }
}


export function withAnyPermission<Args extends unknown[], R>(
  actions: string[],
  fn: (session: AuthSession, ...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  return async (...args: Args) => {
    const session = await getSession()
    requireAnyPermission(session, actions)
    try {
      return await fn(session, ...args)
    } catch (err) {
      rethrowWithDigest(err)
    }
  }
}
