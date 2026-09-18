/**
 * Worker-only export pagination contract.
 *
 * Browser requests never provide these values: export jobs persist only their
 * filters, while the worker supplies a bounded page size during generation.
 */

export const EXPORT_WORKER_BATCH_SIZE = 500
const MAX_EXPORT_BATCH_SIZE = 1_000

export interface ExportBatchOptions<Cursor = number> {
  limit?: number
  cursor?: Cursor
}

export interface ExportBatchResult<Row, Cursor = number> {
  rows: Row[]
  /** Kept for compatibility with the former synchronous export actions. */
  truncated: boolean
  hasMore: boolean
  nextCursor?: Cursor
}

export interface ExportOffsetPage {
  limit: number
  offset: number
}

export function resolveExportBatchLimit(limit: unknown): number | null {
  if (limit == null) return null
  return Math.min(
    MAX_EXPORT_BATCH_SIZE,
    Math.max(1, Math.floor(Number(limit) || EXPORT_WORKER_BATCH_SIZE)),
  )
}

/** Returns null for legacy callers, which intentionally still receive all rows. */
export function resolveExportOffsetPage(
  options?: ExportBatchOptions<number>,
): ExportOffsetPage | null {
  const limit = resolveExportBatchLimit(options?.limit)
  if (limit == null) return null
  const offset = Math.max(0, Math.floor(Number(options?.cursor) || 0))
  return { limit, offset }
}

export function offsetPageResult<Row>(
  rows: Row[],
  page: ExportOffsetPage | null,
): ExportBatchResult<Row> {
  if (!page) return { rows, truncated: false, hasMore: false }

  const hasMore = rows.length > page.limit
  const visibleRows = hasMore ? rows.slice(0, page.limit) : rows
  return {
    rows: visibleRows,
    truncated: false,
    hasMore,
    ...(hasMore ? { nextCursor: page.offset + visibleRows.length } : {}),
  }
}

export interface ExportKeysetPage<Row, Cursor> {
  /** 切掉探测行后的本页数据 */
  pageRows: Row[]
  hasMore: boolean
  nextCursor?: Cursor
}

/**
 * Keyset（seek）分页切片。与 resolveExportOffsetPage + offsetPageResult 的区别：
 * 游标是「上一页最后一行的排序键」而不是行序号。
 *
 * **它保证的**：扫描开始时已存在、且排序键未被改写的行，不会因为别的行在导出期间被
 * INSERT / UPDATE 而在页间移位，从而重复输出或整行漏掉。offset 翻页没有这个保证 ——
 * 排序键是 updated_at / name 这类可变列时，任何一次改动都会让行移位
 * （详见 exportEmployees 上方的注释）。
 *
 * **它不保证的**：导出中途新插入、且排序键落在当前游标之前的行不会出现在本次导出里。
 * 这不是缺陷 —— 导出本就是「开始那一刻的集合」的近似，而不是某个事务快照。
 * 前提是排序键不可变；键本身被改写的那一行仍可能重复或漏掉，所以排序键要选主键。
 *
 * 用法：查询多取一行（`limit + 1`）作探测行，把原始行喂进来，游标从**源行**取，
 * 这样导出行类型不必为了翻页而多带主键字段。
 * 调用方负责保证排序键唯一（末位加主键即可），否则同键行会在页边界被吞掉。
 */
export function resolveExportKeysetPage<Row, Cursor>(
  fetchedRows: Row[],
  limit: number | null,
  toCursor: (lastRow: Row) => Cursor,
): ExportKeysetPage<Row, Cursor> {
  if (limit == null) return { pageRows: fetchedRows, hasMore: false }
  // 自守卫而不是信任 resolveExportBatchLimit 的下界：limit<1 时下面取末行会拿到
  // undefined，toCursor 里读属性就是一句语义不明的 TypeError，比这里抛难排查得多
  if (limit < 1) throw new Error('INVALID_STATE: 导出分页 limit 必须 ≥ 1')

  const hasMore = fetchedRows.length > limit
  const pageRows = hasMore ? fetchedRows.slice(0, limit) : fetchedRows
  // limit >= 1（resolveExportBatchLimit 保证）且 hasMore ⇒ pageRows 非空，游标必定给得出来。
  // iterateExportPages 在 hasMore 而 nextCursor 缺失时会抛 INVALID_STATE，不会静默截断。
  return {
    pageRows,
    hasMore,
    ...(hasMore ? { nextCursor: toCursor(pageRows[pageRows.length - 1]) } : {}),
  }
}

/**
 * Repeatedly fetches a bounded export page. A malformed page is treated as a
 * job failure instead of allowing the worker to loop forever.
 */
export async function* iterateExportPages<Row, Cursor>(
  fetch: (options: ExportBatchOptions<Cursor>) => Promise<ExportBatchResult<Row, Cursor>>,
  firstPage?: ExportBatchResult<Row, Cursor>,
): AsyncGenerator<Row> {
  let page = firstPage
  let cursor: Cursor | undefined
  const seenCursorKeys = new Set<string>()
  while (true) {
    const currentCursorKey = cursor === undefined
      ? 'initial'
      : `cursor:${JSON.stringify(cursor)}`
    if (seenCursorKeys.has(currentCursorKey)) {
      throw new Error('INVALID_STATE: 导出分页游标循环')
    }
    seenCursorKeys.add(currentCursorKey)

    const current = page ?? await fetch({
      limit: EXPORT_WORKER_BATCH_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    })
    page = undefined
    for (const row of current.rows) yield row
    if (!current.hasMore) return
    if (current.nextCursor === undefined) {
      throw new Error('INVALID_STATE: 导出分页游标缺失')
    }
    if (current.rows.length === 0) {
      throw new Error('INVALID_STATE: 导出分页未返回数据')
    }
    const nextCursorKey = `cursor:${JSON.stringify(current.nextCursor)}`
    if (seenCursorKeys.has(nextCursorKey)) {
      throw new Error('INVALID_STATE: 导出分页游标未推进')
    }
    cursor = current.nextCursor
  }
}
