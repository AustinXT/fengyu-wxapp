import { getSession } from '@/lib/auth'
import { requirePermission, requireAnyPermission } from '@/lib/permissions'
import type { AuthSession } from '@/lib/types'

/**
 * 包装 Server Action 的统一鉴权 HOF：先 getSession + requirePermission，再调业务函数。
 *
 * 业务函数收到非空 AuthSession 作为第一参数。
 *
 * 用法：
 *   export const createPosition = withPermission(
 *     'employee:update',
 *     async (session, data: { name: string }) => { ... },
 *   )
 *
 * 等价于：
 *   export async function createPosition(data: { name: string }) {
 *     const session = await getSession()
 *     requirePermission(session, 'employee:update')
 *     // ... 业务
 *   }
 */
export function withPermission<Args extends unknown[], R>(
  action: string,
  fn: (session: AuthSession, ...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  return async (...args: Args) => {
    const session = await getSession()
    requirePermission(session, action)
    return fn(session, ...args)
  }
}

/**
 * OR 关系版本：拥有 actions 中任一即可通过。
 *
 * 用于退款详情、订单详情等"业务 + 审批"两类角色都能进的入口。
 */
export function withAnyPermission<Args extends unknown[], R>(
  actions: string[],
  fn: (session: AuthSession, ...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  return async (...args: Args) => {
    const session = await getSession()
    requireAnyPermission(session, actions)
    return fn(session, ...args)
  }
}
