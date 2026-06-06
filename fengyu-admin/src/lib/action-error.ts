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
export function actionErrorMessage(err: unknown, fallback: string): string {
  const digest = (err as { digest?: unknown } | null)?.digest
  const raw =
    (typeof digest === "string" && digest) ||
    (err instanceof Error ? err.message : "")
  if (
    !raw ||
    raw.includes("Server Components render") ||
    raw.includes("omitted in production")
  ) {
    return fallback
  }
  return raw.replace(/^[A-Z_]+:\s*/, "")
}
