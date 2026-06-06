/**
 * 取 UPDATE / INSERT / DELETE / RETURNING 语句的受影响（或返回）行数，
 * 兼容两套 driver / 测试 mock 的字段差异：
 *   - postgres.js（生产 `@/db`，drizzle-orm/postgres-js）：`RowList.count`
 *   - node-postgres（部分 vitest mock 仍按此形状返回）：`QueryResult.rowCount`
 * 两者取其一，缺失视为 0。
 *
 * 背景：admin 生产用 postgres.js，其 `db.execute()` 返回的 RowList **只有 `.count`，
 * 没有 `.rowCount`**。历史上多处误用 `.rowCount` → 在生产恒为 `undefined`
 * （乐观锁守卫静默失效 / INSERT 计数恒 0），却因测试 mock 返回 `.rowCount`
 * 而长期未暴露。统一走本函数即可同时满足生产正确性与测试兼容。
 */
export function rowsAffected(res: unknown): number {
  const r = res as { count?: number | null; rowCount?: number | null } | null
  return r?.count ?? r?.rowCount ?? 0
}
