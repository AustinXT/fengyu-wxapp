/**
 * 从 Server Action 抛出的错误中取可读文案（客户端组件用）。
 *
 * Next.js 生产构建会把 Server Action 抛出的 `error.message` 脱敏成通用的
 * 「An error occurred in the Server Components render…」文案，但**原样转发自定义
 * `digest`**。因此业务 action 把可读 message 同时写入 digest（见
 * legacy-orders.ts 的 LegacyOrderError），前端优先读 digest、剥业务前缀
 * （`CONFLICT:` / `INVALID_PARAMS:` 等）后展示；若取到的仍是脱敏文案或为空，
 * 则退回调用方给的业务兜底文案。
 */
/**
 * Next.js / 网络层"不可读"文案片段（大小写不敏感匹配）。
 * 命中任一即视为脱敏/框架级异常，前端回退到调用方业务 fallback，
 * 不把英文技术文案或通用脱敏话术直接展示给用户。
 */
const UNREADABLE_FRAGMENTS = [
  // Next.js 生产构建对 Server Action error.message 的脱敏
  'server components render',
  'omitted in production',
  // Next.js 客户端：Server Action 的 POST 响应不是合法 RSC 响应时自抛的框架级错误
  // （社区讨论 vercel/next.js#87651）。WorkFine 远程 MSSQL 偶发慢/抖动触发的正是这类。
  'unexpected response',
  // fetch / 网络层错误
  'failed to fetch',
  'network request failed',
  'networkerror',
  // 底层网络错（通常在服务端日志，偶现于脱敏 message 时兜底）
  'econnreset',
  'esocket',
  'etimedout',
] as const

export function actionErrorMessage(err: unknown, fallback: string): string {
  const digest = (err as { digest?: unknown } | null)?.digest
  const raw =
    (typeof digest === "string" && digest) ||
    (err instanceof Error ? err.message : "")
  if (!raw) return fallback
  const lower = raw.toLowerCase()
  if (UNREADABLE_FRAGMENTS.some((f) => lower.includes(f))) return fallback
  return raw.replace(/^[A-Z_]+:\s*/, "")
}
