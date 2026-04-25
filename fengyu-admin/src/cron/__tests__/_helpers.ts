/**
 * 测试辅助：从 drizzle 的 sql 模板对象中提取参数值
 *
 * sql 模板对象的 queryChunks 形如：
 *   [{ value: ['INSERT...'] }, paramA, { value: [', '] }, paramB, ...]
 *
 * 字符串/字面量片段是 `{ value: [...] }`，参数值是直接元素（string/number/Date/...）。
 * 此 helper 过滤出参数值数组，方便断言。
 */
export function paramsOf(sqlObj: unknown): unknown[] {
  if (!sqlObj || typeof sqlObj !== 'object') return []
  const chunks = (sqlObj as { queryChunks?: unknown[] }).queryChunks
  if (!Array.isArray(chunks)) return []
  return chunks.filter(
    (c) => !(c && typeof c === 'object' && 'value' in (c as Record<string, unknown>)),
  )
}

/** 把 sql 模板对象的字符串片段拼成完整 SQL（不含参数值，用于 SQL 形态断言） */
export function sqlTextOf(sqlObj: unknown): string {
  if (!sqlObj || typeof sqlObj !== 'object') return ''
  const chunks = (sqlObj as { queryChunks?: unknown[] }).queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((c) => {
      if (c && typeof c === 'object' && 'value' in (c as Record<string, unknown>)) {
        const v = (c as { value: unknown }).value
        return Array.isArray(v) ? v.join('') : String(v)
      }
      return '?'
    })
    .join('')
}

/** 拍平所有 mock.calls 的 params，用于"任意一次调用是否传过 X 参数"型断言 */
export function flatParamsOfCalls(
  calls: Array<readonly unknown[]>,
): unknown[] {
  return calls.flatMap((c) => paramsOf(c[0]))
}
