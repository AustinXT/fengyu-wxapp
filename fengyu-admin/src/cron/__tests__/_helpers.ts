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
  // 嵌套 SQL 对象不算参数（它们是 SQL 片段），递归提取其内部参数
  const out: unknown[] = []
  for (const c of chunks) {
    if (c && typeof c === 'object' && 'value' in (c as Record<string, unknown>)) {
      continue // 字面量片段
    }
    if (c && typeof c === 'object' && 'queryChunks' in (c as Record<string, unknown>)) {
      out.push(...paramsOf(c))
      continue
    }
    out.push(c)
  }
  return out
}

/**
 * 把 sql 模板对象的字符串片段拼成完整 SQL（不含参数值，用于 SQL 形态断言）。
 *
 * 嵌套 SQL chunk（如 `sql\`a${someSqlFragment}b\`` 中的 someSqlFragment 是另一个 SQL 对象）
 * 会被递归展开为其内部字面量，保留 SQL 形态可见性。
 * 参数值（非 SQL 对象的标量）渲染为 `?` 占位符。
 */
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
      // 嵌套 SQL 对象（如 sql.raw('NOW()') 或 sql`...`）递归展开
      if (c && typeof c === 'object' && 'queryChunks' in (c as Record<string, unknown>)) {
        return sqlTextOf(c)
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
