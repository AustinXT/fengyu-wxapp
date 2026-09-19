import { actionErrorMessage } from '@/lib/action-error'
import { ERROR_PREFIXES } from '@/lib/api-error'

export const STALE_STATE_MESSAGE = '单据状态或权限已变化，已为你刷新列表'

/** 状态型错误：说明单据已被别人改过，留在原地也没用，该刷新列表给出路。 */
const STALE_STATE_PREFIXES: readonly string[] = [
  'CONFLICT',
  'INVALID_STATE',
  'NOT_FOUND',
  // 权限被收回后，页面上按旧权限渲染的按钮还在，留着只会让人反复点必失败的按钮 ——
  // 与状态被改是同构的死胡同，刷新后按钮会随权限消失。
  'PERMISSION_DENIED',
]

function rawErrorSignal(err: unknown): string {
  const digest = (err as { digest?: unknown } | null | undefined)?.digest
  return (typeof digest === 'string' && digest) || (err instanceof Error ? err.message : '') || ''
}

/**
 * 这个 err 的「信号」本身就不是人话，交给 `actionErrorMessage` 会原样吐给用户：
 *
 * - 整串恰好是一个错误前缀、无可读文案 —— `PermissionError` 的 `digest = 'PERMISSION_DENIED'`
 *   （剥前缀的正则要求冒号，剥不掉就原样返回）
 * - 纯数字 —— Next 给没有自定义 digest 的异常自动生成的错误编号（未包装的 DB/驱动异常走这条）
 *
 * 注：issue #133 在 `actionErrorMessage` 里也修了同一类问题。这里仍然自己判一道，
 * 是为了让相关 PR **单独合入也正确**；#133 合入后这段就是无害的冗余。
 */
function isUnreadableSignal(err: unknown): boolean {
  const raw = rawErrorSignal(err)
  // 裸前缀按 9 项白名单判，而不是只认这里的 4 个状态型前缀 —— 今天只有 `PermissionError`
  // 会产裸前缀 digest（恰好是 `PERMISSION_DENIED`），但将来谁手工塞个 `digest='INVALID_PARAMS'`，
  // 走窄名单就会漏过去、被原样吐成英文 token。
  return (
    (ERROR_PREFIXES as readonly string[]).includes(raw) ||
    /^\d{1,10}(?:@[A-Za-z][\w-]*)?$/.test(raw)
  )
}

export function isStaleStateError(err: unknown): boolean {
  const raw = rawErrorSignal(err)
  // 要同时认「带冒号的完整 message」与「裸前缀」：HOF 层的 requireAnyPermission 抛的是
  // `PermissionError`，它的 digest 是字段常量 `'PERMISSION_DENIED'`（无冒号无文案），
  // 而 rethrowWithDigest 见 digest 已存在就跳过、不会补写 —— 只认带冒号的话，
  // 「权限被收回」这条最直接的路径恰好判不出来。
  return STALE_STATE_PREFIXES.some((prefix) => raw === prefix || raw.startsWith(`${prefix}:`))
}

export function docActionErrorMessage(err: unknown, fallback: string): string {
  if (isUnreadableSignal(err)) {
    return isStaleStateError(err) ? STALE_STATE_MESSAGE : fallback
  }
  return actionErrorMessage(err, fallback)
}
