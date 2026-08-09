import { requirePermission, requireAnyPermission } from '@/lib/permissions'
import { parseErrorPrefix } from '@/lib/api-error'
import type { AuthSession } from '@/lib/types'
import { getExportSession } from '@/lib/export-session-context'

/**
 * 给白名单前缀的业务错误补 `digest`，穿透 Next.js 生产构建对 Server Action `error.message`
 * 的脱敏（生产下 message 被替换为通用文案，但自定义 digest 原样转发）。客户端
 * `actionErrorMessage()` 优先读 digest 并剥前缀，故后端的精确业务文案得以到达前端。
 *
 * 与云函数 `buildErrorResponse` / 小程序 `errorType` 判断同构：
 * - 已带 digest（如 `PermissionError` 的 `'PERMISSION_DENIED'`）→ 不覆盖；
 * - 命中 9 项白名单前缀（`CONFLICT:` / `INVALID_STATE:` …）→ 把可读 message 写入 digest；
 * - 非白名单（`TypeError` / 未预期 DB 错误等系统错误）→ 不补 digest，保持脱敏 →
 *   客户端回退兜底文案，避免泄露 SQL / 堆栈等技术细节。
 */
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

async function getActionSession(): Promise<AuthSession | null> {
  const exportSession = getExportSession()
  if (exportSession) return exportSession
  // export-worker 构建时此条件会被 Bun 固化为 true，从 bundle 中裁掉 Web auth 依赖。
  if (process.env.FENGYU_EXPORT_WORKER === '1') {
    throw new Error('INVALID_STATE: 导出任务缺少权限上下文')
  }
  const { getSession } = await import('@/lib/auth')
  return getSession()
}

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
    const session = await getActionSession()
    requirePermission(session, action)
    try {
      return await fn(session, ...args)
    } catch (err) {
      rethrowWithDigest(err)
    }
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
    const session = await getActionSession()
    requireAnyPermission(session, actions)
    try {
      return await fn(session, ...args)
    } catch (err) {
      rethrowWithDigest(err)
    }
  }
}
