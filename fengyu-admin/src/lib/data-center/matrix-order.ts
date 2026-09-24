/**
 * 矩阵表服务端排序（#368）：URL 参数白名单解析 + 带唯一键兜底的 ORDER BY。
 *
 * 排序键相同的行在 LIMIT/OFFSET 翻页时顺序不确定，会出现「第 2 页重复第 1 页的行、另一行永远看不到」
 * （#282）。所以 ORDER BY 末尾必须追加唯一键；这里把它做成必填参数，调用方忘不掉。
 */
import { sql, type SQL } from 'drizzle-orm'
import type { MatrixSort, MatrixSortDirection } from './matrix'

function isSortable(sortable: Readonly<Record<string, SQL>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(sortable, key)
}

/**
 * 解析 `?sort=<key>&dir=asc|desc`。白名单就是传给 matrixOrderBySql 的同一张 `sortable` 表，
 * 两边不会漂移。key 不在白名单 → 回退默认排序（不抛错：URL 可被手改，排序参数不合法不值得让整页 400）。
 * 方向缺省或非法 → desc。
 */
export function parseMatrixSort(
  raw: { sort?: string | null; dir?: string | null },
  sortable: Readonly<Record<string, SQL>>,
  fallback: MatrixSort,
): MatrixSort {
  const key = raw.sort?.trim()
  if (!key || !isSortable(sortable, key)) return fallback
  const direction: MatrixSortDirection = raw.dir === 'asc' ? 'asc' : 'desc'
  return { key, direction }
}

/**
 * 生成 `ORDER BY` 的表达式列表（不含 ORDER BY 关键字）：
 *   <排序列> ASC|DESC NULLS LAST, <唯一键 1> ASC, <唯一键 2> ASC ...
 *
 * - `sortable` 是「排序 key → SQL 表达式」白名单，key 只拿来查表，绝不拼进 SQL；
 * - `tiebreak` 必须能唯一确定一行（通常是主键，如 customer_id / employee_id），至少一个。
 */
export function matrixOrderBySql(
  sort: MatrixSort,
  sortable: Readonly<Record<string, SQL>>,
  tiebreak: readonly SQL[],
): SQL {
  if (tiebreak.length === 0) {
    throw new Error('INVALID_STATE: 矩阵表排序必须提供唯一键兜底（#282）')
  }
  const expression = isSortable(sortable, sort.key) ? sortable[sort.key] : undefined
  if (!expression) {
    throw new Error(`INVALID_PARAMS: 不支持按「${sort.key}」排序`)
  }
  const direction = sort.direction === 'asc' ? sql.raw('ASC') : sql.raw('DESC')
  return sql.join(
    [sql`${expression} ${direction} NULLS LAST`, ...tiebreak.map((key) => sql`${key} ASC`)],
    sql`, `,
  )
}
