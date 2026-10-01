import 'server-only'
import { db } from '@/db'
import { sql, type SQL } from 'drizzle-orm'
import { ApiError } from '@/lib/api-error'
import type { AuthSession } from '@/lib/types'
import {
  resolveExportBatchLimit,
  resolveExportKeysetPage,
  type ExportBatchOptions,
  type ExportBatchResult,
} from '@/lib/export-pagination'
import {
  inventoryPriceScopeByTier,
  inventoryPriceVisibility,
  inventoryScopedOrgNodeIds,
  inventoryTierRestrictedOrgNodeIds,
} from './access'
import type {
  MarketReportSummarySourceFilters,
  MarketReportSummarySourceRow,
} from './market-report-summary-detail-types'

/**
 * 页面一次取全部来源行（不含分页控件）：小计与合计必须对"全部行"有意义，
 * 分页后「合计」是当页还是全量会让口径含糊。上限只是防御性兜底 ——
 * 汇总单来源行 = Σ 各来源报货单的明细行数，正常量级在数百行内。
 */
const MAX_PAGE_ROWS = 2000

function optionalText(value: unknown, label: string): string | undefined {
  if (value == null) return undefined
  if (typeof value !== 'string') throw new ApiError('INVALID_PARAMS', `${label}格式不正确`)
  const text = value.trim()
  if (text.length > 64) throw new ApiError('INVALID_PARAMS', `${label}过长`)
  return text || undefined
}

function requireDocId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiError('INVALID_PARAMS', '汇总单号不正确')
  }
  return value.trim()
}

/** 汇总单号必填（由调用方从路由取）；市场筛选可选，作用在来源行而非单头。 */
export function normalizeMarketReportSummarySourceFilters(
  input: MarketReportSummarySourceFilters,
): MarketReportSummarySourceFilters {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ApiError('INVALID_PARAMS', '查询条件格式不正确')
  }
  return { market: optionalText(input.market, '市场') }
}

/**
 * 价格可见的**市场集合**（行级，§9.3 / §9.5）。
 *
 * 汇总单是跨市场的（单头 `market_id` 为 NULL），来源行天然含多个市场 —— 只按会话级
 * `inventoryPriceVisibility !== 'none'` 放行，会让某市场财务在端点命中的汇总单上
 * 看到**其它市场**的进货价。所以按档位绑定逐行判定，与结算侧
 * （`settlement-details.ts` 的 `settlementDetailScope`）同一套收窄函数、同一口径。
 *
 * - `null` = 不受限（admin 全量）；
 * - `[]` = 档位不覆盖任何市场（视为不可见，不是"全可见"）；
 * - 非空数组 = 仅这些市场节点参与的价格可见。
 */
export function marketReportSummaryPriceScope(session: AuthSession): string[] | null {
  const visibility = inventoryPriceVisibility(session)
  if (visibility === 'none') return []
  /*
   * 供应链档（含全档）**不受市场节点限制**：§9.5 的「供应链可见市场结算价」本来就是全市场的，
   * 而它的档位绑定落在**总部节点**上 —— 拿去和来源行的 `market_id`（市场节点）做交集会全部落空，
   * 结果是供应链用户看来源明细一片「—」、而建单表单（会话级 supply_chain||all）却有价，两边打架。
   */
  if (visibility === 'supply_chain' || visibility === 'all') return null
  const tiers = inventoryPriceScopeByTier(session)
  return inventoryTierRestrictedOrgNodeIds(null, [tiers.market])
}

/**
 * 页面、明细与 worker 导出共用条件 —— 三者同源，"导出行集 = 页面看到的行"才成立。
 *
 * scope 校验作用在**汇总单本身**（`l.to_doc_id` 指向的单）：来源明细不引入新的数据面，
 * 调用方拿不到某张汇总单时，也就取不到它的来源行。`scoped === null` 表示无限制（总部）。
 */
export function marketReportSummarySourceWhereSql(
  docId: string,
  filters: MarketReportSummarySourceFilters,
  scoped: string[] | null,
): SQL {
  const conditions: SQL[] = [
    sql`l.to_doc_id = ${docId}`,
    sql`l.relation_type = '市场报货汇总'`,
  ]
  if (scoped !== null) {
    conditions.push(scoped.length === 0
      ? sql`FALSE`
      : sql`EXISTS (
          SELECT 1 FROM inventory_docs head
           WHERE head.id = l.to_doc_id
             AND (head.source_org_node_id IN (${sql.join(scoped.map((id) => sql`${id}`), sql`, `)})
               OR head.target_org_node_id IN (${sql.join(scoped.map((id) => sql`${id}`), sql`, `)}))
        )`)
  }
  if (filters.market) conditions.push(sql`i.market_id = ${filters.market}`)
  return sql.join(conditions, sql` AND `)
}

interface RawRow {
  id: string
  market_id: string | null
  market_name: string | null
  source_doc_id: string
  source_doc_date: string
  sku_id: string
  sku_name: string
  spec_name: string | null
  batch_no: string
  quantity: string
  market_standard_unit_price: string | null
  market_unit_discount: string | null
  market_actual_unit_price: string | null
  promotion_plan_no_snapshot: string | null
}

// 例外：按 link 的不可变主键正序，页面与导出排序统一，bigint 游标全程 string 避免精度损失。
export function marketReportSummarySourceSelectSql(where: SQL, limit: number, cursor?: string): SQL {
  return sql`
    SELECT l.id::text AS id, i.market_id, COALESCE(market.name, i.market_id) AS market_name,
           l.from_doc_id AS source_doc_id, to_char(source.doc_date, 'YYYY-MM-DD') AS source_doc_date,
           i.sku_id, i.sku_name, i.spec_name, i.batch_no, l.quantity,
           i.market_standard_unit_price, i.market_unit_discount, i.market_actual_unit_price,
           i.promotion_plan_no_snapshot
      FROM inventory_doc_links l
      JOIN inventory_doc_items i ON i.id = l.from_item_id
      JOIN inventory_docs source ON source.id = l.from_doc_id
      -- org_node_id 唯一；LEFT JOIN 不漏掉缺主体档案的历史行，也不放大行数
      LEFT JOIN inventory_locations market ON market.org_node_id = i.market_id
     WHERE ${where} ${cursor === undefined ? sql`` : sql`AND l.id > ${cursor}::bigint`}
     ORDER BY l.id ASC LIMIT ${limit}
  `
}

function numericOrNull(value: string | null): number | null {
  if (value === null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const round2 = (value: number) => Number(value.toFixed(2))

/**
 * 价格档不可见（或该行所属市场不在档位绑定内）时，三个单价一律映射成 null（服务端剥离，
 * 前端据此裁列）—— 与 engine.ts 单据明细"用 undefined/null 表达不可见"的既有约定一致，
 * 拦在服务端而非只靠前端不渲染。**判定按行**：同一张汇总单的不同市场来源行可以一个可见一个不可见。
 */
function mapRow(row: RawRow, priceScopedMarketIds: string[] | null): MarketReportSummarySourceRow {
  const quantity = Number(row.quantity)
  const canViewPrice = row.market_id !== null
    && (priceScopedMarketIds === null || priceScopedMarketIds.includes(row.market_id))
  const actualUnitPrice = canViewPrice ? numericOrNull(row.market_actual_unit_price) : null
  return {
    id: row.id,
    marketId: row.market_id,
    marketName: row.market_name,
    sourceDocId: row.source_doc_id,
    sourceDocDate: row.source_doc_date,
    skuId: row.sku_id,
    skuName: row.sku_name,
    specName: row.spec_name,
    batchNo: row.batch_no,
    quantity,
    marketStandardUnitPrice: canViewPrice ? numericOrNull(row.market_standard_unit_price) : null,
    marketUnitDiscount: canViewPrice ? numericOrNull(row.market_unit_discount) : null,
    marketActualUnitPrice: actualUnitPrice,
    amount: actualUnitPrice === null ? null : round2(quantity * actualUnitPrice),
    promotionPlanNo: row.promotion_plan_no_snapshot,
  }
}

async function queryRows(query: SQL, priceScopedMarketIds: string[] | null): Promise<MarketReportSummarySourceRow[]> {
  return (await db.execute(query) as unknown as RawRow[]).map((row) => mapRow(row, priceScopedMarketIds))
}

function requireObject(input: unknown): void {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ApiError('INVALID_PARAMS', '查询条件格式不正确')
  }
}

/** 详情页用：一次取全部来源行，超出上限时由调用方按 truncated 提示导出查看。 */
export async function listMarketReportSummarySourcesForSession(
  session: AuthSession,
  input: MarketReportSummarySourceFilters & { docId?: unknown },
): Promise<{ rows: MarketReportSummarySourceRow[]; truncated: boolean; priceVisible: boolean; limit: number }> {
  requireObject(input)
  const docId = requireDocId(input.docId)
  const filters = normalizeMarketReportSummarySourceFilters(input)
  const where = marketReportSummarySourceWhereSql(docId, filters, inventoryScopedOrgNodeIds(session))
  const priceScope = marketReportSummaryPriceScope(session)
  const rows = await queryRows(
    marketReportSummarySourceSelectSql(where, MAX_PAGE_ROWS + 1),
    priceScope,
  )
  return {
    rows: rows.slice(0, MAX_PAGE_ROWS),
    truncated: rows.length > MAX_PAGE_ROWS,
    // 上限由服务端回传：前端写死会在后端调整时漂掉（结算下钻那边已经踩过一次）
    limit: MAX_PAGE_ROWS,
    /*
     * 页面裁列用的判据（**档位集合非空**，不是逐行、也不是会话级 `visibility !== 'none'`）：
     * 市场档但档位绑定集合为空时，行级剥离会把每一行的价格都置 null ——
     * 此时若页面按会话级渲染表头，就会出现「有表头、整列 —」，且与同会话导出的列不一致。
     * 取"集合非空"是因为页面只能按列级决策；具体某一行是否带价仍由 mapRow 逐行判定。
     */
    priceVisible: priceScope === null || priceScope.length > 0,
  }
}

/**
 * 来源明细的**市场筛选选项**：该汇总单 scope 内的全部来源市场（DISTINCT）。
 *
 * 不走"从已取的行里派生"：行集会被 `MAX_PAGE_ROWS` 截断，从截断后的行派生既会漏市场，
 * 也会让"筛一次就回不到其它市场"。与取数共用同一 where，口径不会分叉。
 */
export async function listMarketReportSummarySourceMarkets(
  session: AuthSession,
  input: { docId?: unknown },
): Promise<Array<{ id: string; name: string }>> {
  requireObject(input)
  const docId = requireDocId(input.docId)
  const where = marketReportSummarySourceWhereSql(docId, {}, inventoryScopedOrgNodeIds(session))
  const rows = await db.execute(sql`
    SELECT DISTINCT i.market_id AS id, COALESCE(market.name, i.market_id) AS name
      FROM inventory_doc_links l
      JOIN inventory_doc_items i ON i.id = l.from_item_id
      LEFT JOIN inventory_locations market ON market.org_node_id = i.market_id
     WHERE ${where} AND i.market_id IS NOT NULL
     ORDER BY name
  `) as unknown as Array<{ id: string; name: string }>
  return rows.map((row) => ({ id: row.id, name: row.name }))
}

/**
 * 导出用：keyset 分批，游标是 link 的不可变主键。
 * `canViewPrice` 随批次回传（与 exportInventoryLots 同构）：worker 需要它在**建列时**决定
 * 是否带价格列，而不是从首页行数据反推 —— 首页恰无价时会误判成"档位不可见"。
 */
export async function exportMarketReportSummarySourcesForSession(
  session: AuthSession,
  input: MarketReportSummarySourceFilters & { docId?: unknown },
  options?: ExportBatchOptions<string>,
): Promise<ExportBatchResult<MarketReportSummarySourceRow, string> & { canViewPrice: boolean }> {
  requireObject(input)
  const docId = requireDocId(input.docId)
  const filters = normalizeMarketReportSummarySourceFilters(input)
  const cursor = options?.cursor
  if (cursor !== undefined
    && (typeof cursor !== 'string' || !/^[1-9]\d{0,18}$/.test(cursor) || BigInt(cursor) > BigInt('9223372036854775807'))) {
    throw new ApiError('INVALID_STATE', '导出分页游标不合法')
  }
  const limit = resolveExportBatchLimit(options?.limit)
  if (limit == null) throw new ApiError('INVALID_STATE', '汇总单来源明细导出只支持分批取数')
  const canViewPrice = marketReportSummaryPriceScope(session)
  const where = marketReportSummarySourceWhereSql(docId, filters, inventoryScopedOrgNodeIds(session))
  const fetched = await queryRows(marketReportSummarySourceSelectSql(where, limit + 1, cursor), canViewPrice)
  const page = resolveExportKeysetPage(fetched, limit, (row) => row.id)
  return {
    rows: page.pageRows,
    truncated: false,
    hasMore: page.hasMore,
    // 导出列按段固定，这里只回传"是否存在任何可见价格市场"（空集时列也不含价格）
    canViewPrice: canViewPrice === null || canViewPrice.length > 0,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  }
}
