import 'server-only'
import { db } from '@/db'
import { sql, type SQL } from 'drizzle-orm'
import { ApiError } from '@/lib/api-error'
import { shanghaiToday } from '@/lib/datetime'
import type { AuthSession } from '@/lib/types'
import { resolveExportBatchLimit, resolveExportKeysetPage, type ExportBatchOptions, type ExportBatchResult } from '@/lib/export-pagination'
import { inventoryScopedOrgNodeIds } from './access'
import { assertRealCalendarDate } from './settlements'
import type { PendingReceiptFilters, PendingReceiptKind, PendingReceiptOptions, PendingReceiptPage, PendingReceiptRow } from './pending-receipt-types'

interface NormalizedFilters extends PendingReceiptFilters { kind: PendingReceiptKind }

function optionalText(value: unknown, label: string): string | undefined {
  if (value == null) return undefined
  if (typeof value !== 'string') throw new ApiError('INVALID_PARAMS', `${label}格式不正确`)
  const text = value.trim()
  if (text.length > 64) throw new ApiError('INVALID_PARAMS', `${label}过长`)
  return text || undefined
}

/** 输入先校验；与 #453 独立分支，复用 dev 已有的库存日历断言。 */
export function normalizePendingReceiptFilters(input: PendingReceiptFilters): NormalizedFilters {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new ApiError('INVALID_PARAMS', '查询条件格式不正确')
  const kind = input.kind ?? 'store'
  if (kind !== 'store' && kind !== 'market') throw new ApiError('INVALID_PARAMS', '收货视图不正确')
  const market = optionalText(input.market, '市场')
  const store = optionalText(input.store, '门店')
  if (kind === 'market' && store) throw new ApiError('INVALID_PARAMS', '市场入库视图不支持门店筛选')
  const start = optionalText(input.start, '开始日期')
  const end = optionalText(input.end, '结束日期')
  if (start) assertRealCalendarDate(start, '开始日期')
  if (end) assertRealCalendarDate(end, '结束日期')
  if (start && end && start > end) throw new ApiError('INVALID_PARAMS', '开始日期不能晚于结束日期')
  return { kind, market, store, start, end }
}

/** 页面计数、明细和 worker 共用条件；完成单兜底排除历史未回写 fulfilled 的记录。 */
export function pendingReceiptWhereSql(filters: NormalizedFilters, scoped: string[] | null): SQL {
  const conditions = [
    sql`d.doc_type = ${filters.kind === 'store' ? '分院配货' : '品项公司发货'}`,
    sql`d.status = '待收货'`,
    sql`COALESCE(i.fulfilled_quantity, 0) < i.quantity`,
  ]
  if (scoped !== null) {
    conditions.push(scoped.length === 0 ? sql`FALSE` : sql`(
      d.source_org_node_id IN (${sql.join(scoped.map(id => sql`${id}`), sql`, `)})
      OR d.target_org_node_id IN (${sql.join(scoped.map(id => sql`${id}`), sql`, `)})
    )`)
  }
  if (filters.market) conditions.push(sql`d.market_id = ${filters.market}`)
  if (filters.store) conditions.push(sql`d.target_org_node_id = ${filters.store}`)
  if (filters.start) conditions.push(sql`d.doc_date >= ${filters.start}::date`)
  if (filters.end) conditions.push(sql`d.doc_date <= ${filters.end}::date`)
  return sql.join(conditions, sql` AND `)
}

interface RawRow {
  id: string; recipient_id: string; recipient_name: string; market_id: string | null; market_name: string | null
  doc_date: string; doc_id: string; sku_id: string; sku_name: string; batch_no: string
  sent_quantity: string; received_quantity: string; pending_quantity: string; transit_days: number
}

// 例外：按明细不可变主键正序，页面与导出排序统一，bigint 游标全程 string 避免精度损失。
export function pendingReceiptSelectSql(where: SQL, today: string, limit: number, offset = 0, cursor?: string): SQL {
  return sql`
    SELECT i.id::text AS id, d.target_org_node_id AS recipient_id,
           COALESCE(recipient.name, d.target_org_node_id) AS recipient_name,
           d.market_id, COALESCE(market.name, d.market_id) AS market_name,
           to_char(d.doc_date, 'YYYY-MM-DD') AS doc_date, d.id AS doc_id,
           i.sku_id, i.sku_name, i.batch_no, i.quantity AS sent_quantity,
           COALESCE(i.fulfilled_quantity, 0) AS received_quantity,
           i.quantity - COALESCE(i.fulfilled_quantity, 0) AS pending_quantity,
           ${today}::date - d.doc_date AS transit_days
      FROM inventory_doc_items i JOIN inventory_docs d ON d.id = i.doc_id
      -- org_node_id 唯一；LEFT JOIN 不漏掉缺主体档案的历史明细，也不放大计数
      LEFT JOIN inventory_locations recipient ON recipient.org_node_id = d.target_org_node_id
      LEFT JOIN inventory_locations market ON market.org_node_id = d.market_id
     WHERE ${where} ${cursor === undefined ? sql`` : sql`AND i.id > ${cursor}::bigint`}
     ORDER BY i.id ASC LIMIT ${limit} OFFSET ${offset}
  `
}

function mapRow(row: RawRow): PendingReceiptRow {
  return {
    id: row.id, recipientId: row.recipient_id, recipientName: row.recipient_name,
    marketId: row.market_id, marketName: row.market_name,
    docDate: row.doc_date, docId: row.doc_id, skuId: row.sku_id, skuName: row.sku_name, batchNo: row.batch_no,
    sentQuantity: Number(row.sent_quantity), receivedQuantity: Number(row.received_quantity),
    pendingQuantity: Number(row.pending_quantity), transitDays: Number(row.transit_days),
  }
}

async function queryRows(query: SQL): Promise<PendingReceiptRow[]> {
  return (await db.execute(query) as unknown as RawRow[]).map(mapRow)
}

export async function listPendingReceiptsForSession(session: AuthSession, input: PendingReceiptFilters & { page?: unknown; size?: unknown }): Promise<PendingReceiptPage> {
  const filters = normalizePendingReceiptFilters(input)
  const pageSize = [20, 50, 100].includes(Number(input.size)) ? Number(input.size) : 20
  const requestedPage = Number(input.page ?? 1)
  const safePage = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1
  const where = pendingReceiptWhereSql(filters, inventoryScopedOrgNodeIds(session))
  const count = await db.execute(sql`SELECT count(*)::int AS total FROM inventory_doc_items i JOIN inventory_docs d ON d.id = i.doc_id WHERE ${where}`)
  const total = Number((count as unknown as Array<{ total: number }>)[0]?.total ?? 0)
  const page = Math.min(safePage, Math.max(1, Math.ceil(total / pageSize)))
  const rows = await queryRows(pendingReceiptSelectSql(where, shanghaiToday(), pageSize, (page - 1) * pageSize))
  return { rows, total, page, pageSize }
}

export async function pendingReceiptOptionsForSession(session: AuthSession, kind: string = 'store'): Promise<PendingReceiptOptions> {
  const filters = normalizePendingReceiptFilters({ kind })
  const result = await db.execute(sql`
    SELECT DISTINCT d.market_id, COALESCE(market.name, d.market_id) AS market_name,
           d.target_org_node_id AS recipient_id, COALESCE(recipient.name, d.target_org_node_id) AS recipient_name
      FROM inventory_doc_items i JOIN inventory_docs d ON d.id = i.doc_id
      LEFT JOIN inventory_locations recipient ON recipient.org_node_id = d.target_org_node_id
      LEFT JOIN inventory_locations market ON market.org_node_id = d.market_id
     WHERE ${pendingReceiptWhereSql(filters, inventoryScopedOrgNodeIds(session))}
     ORDER BY market_name, recipient_name
  `)
  const markets = new Map<string, { id: string; name: string }>()
  const stores = new Map<string, { id: string; name: string; marketId: string | null }>()
  for (const row of result as unknown as RawRow[]) {
    if (row.market_id) markets.set(row.market_id, { id: row.market_id, name: row.market_name ?? row.market_id })
    if (filters.kind === 'store' && row.recipient_id) stores.set(row.recipient_id, { id: row.recipient_id, name: row.recipient_name, marketId: row.market_id })
  }
  return { markets: [...markets.values()], stores: [...stores.values()] }
}

/** 动作角色已按 inventory:export 收窄。异步执行是实时集合，收货并发发生时行数可与旧页面不同。 */
export async function exportPendingReceiptsForSession(session: AuthSession, input: PendingReceiptFilters, options?: ExportBatchOptions<string>): Promise<ExportBatchResult<PendingReceiptRow, string>> {
  const filters = normalizePendingReceiptFilters(input)
  const cursor = options?.cursor
  if (cursor !== undefined && (typeof cursor !== 'string' || !/^[1-9]\d{0,18}$/.test(cursor) || BigInt(cursor) > BigInt('9223372036854775807'))) {
    throw new ApiError('INVALID_STATE', '导出分页游标不合法')
  }
  const limit = resolveExportBatchLimit(options?.limit)
  if (limit == null) throw new ApiError('INVALID_STATE', '收货跟进导出只支持分批取数')
  const where = pendingReceiptWhereSql(filters, inventoryScopedOrgNodeIds(session))
  const fetched = await queryRows(pendingReceiptSelectSql(where, shanghaiToday(), limit + 1, 0, cursor))
  const page = resolveExportKeysetPage(fetched, limit, row => row.id)
  return { rows: page.pageRows, truncated: false, hasMore: page.hasMore, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) }
}
