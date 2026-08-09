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
