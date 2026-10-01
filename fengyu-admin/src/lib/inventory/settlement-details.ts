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
import {
  normalizeSettlementPeriod,
  settlementProjectionSql,
  type SettlementSegment,
} from './settlements'
import type {
  SettlementDetailFilters,
  SettlementDetailResult,
  SettlementDetailRow,
  SettlementSegmentFilters,
} from './settlement-detail-types'

/**
 * 页面一次取该行的全部明细：行内展开没有分页控件，合计必须对"全部行"有意义。
 * 上限只是防御性兜底（与来源明细的 MAX_PAGE_ROWS 取同一量级），超出时由 truncated 提示导出；
 * 超过上限时合计退化为「可见行合计」，验收口径的完整对账走导出。
 */
const DETAIL_PAGE_LIMIT = 2000

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiError('INVALID_PARAMS', `${label}不正确`)
  }
  return value.trim()
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value == null) return undefined
  if (typeof value !== 'string') throw new ApiError('INVALID_PARAMS', `${label}格式不正确`)
  const text = value.trim()
  if (text.length > 64) throw new ApiError('INVALID_PARAMS', `${label}过长`)
  return text || undefined
}

export interface NormalizedSettlementDetailFilters {
  segment: SettlementSegment
  startDate: string
  endDate: string
  marketNode: string
  partyNode: string
  market?: string
}

/** 段、期间、汇总行的两个端点都是必填：下钻必须落在**某一行的口径**上，不能是整段。 */
export function normalizeSettlementDetailFilters(input: SettlementDetailFilters): NormalizedSettlementDetailFilters {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ApiError('INVALID_PARAMS', '查询条件格式不正确')
  }
  const segment = input.segment
  if (segment !== 'market' && segment !== 'store') {
    throw new ApiError('INVALID_PARAMS', '结算段不正确')
  }
  const { startDate, endDate } = normalizeSettlementPeriod(input)
  return {
    segment,
    startDate,
    endDate,
    marketNode: requiredText(input.marketNode, '市场主体'),
    partyNode: requiredText(input.partyNode, '对方主体'),
    market: optionalText(input.market, '市场'),
  }
}

/**
 * 段的可见性 + 档位收窄，与 `listInventorySettlements` 逐条对齐：
 * 市场段随任一价格档可见（收窄到 supplyChain ∪ market），分院段仅市场/全档可见（收窄到 market）。
 * 两段用不同的收窄集合，直接拿 `inventoryScopedOrgNodeIds` 会回归 2026-09-02 修掉的跨绑定借权泄漏。
 */
export function settlementDetailScope(
  session: AuthSession,
  segment: SettlementSegment,
): { scopedOrgNodeIds: string[] | null; visible: boolean } {
  const priceVisibility = inventoryPriceVisibility(session)
  const visible = segment === 'market'
    ? priceVisibility !== 'none'
    : priceVisibility === 'all' || priceVisibility === 'market'
  if (!visible) return { scopedOrgNodeIds: null, visible: false }
  const scoped = inventoryScopedOrgNodeIds(session)
  const tiers = inventoryPriceScopeByTier(session)
  return {
    scopedOrgNodeIds: segment === 'market'
      ? inventoryTierRestrictedOrgNodeIds(scoped, [tiers.supplyChain, tiers.market])
      : inventoryTierRestrictedOrgNodeIds(scoped, [tiers.market]),
    visible: true,
  }
}

const DETAIL_COLUMNS = sql`
    p.item_id::text AS id, p.doc_id, p.doc_type, p.status,
    to_char(p.effective_date, 'YYYY-MM-DD') AS effective_date,
    p.market_node, p.market_name, p.party_node, p.party_name,
    p.market_id, p.sku_id, p.sku_name, p.spec_name, p.batch_no, p.is_gift,
    (p.sign < 0) AS is_return, p.quantity, p.signed_amount
  `

interface RawDetailRow {
  id: string
  doc_id: string
  doc_type: string
  status: string
  effective_date: string
  market_node: string | null
  market_name: string | null
  party_node: string | null
  party_name: string | null
  market_id: string | null
  sku_id: string
  sku_name: string
  spec_name: string | null
  batch_no: string
  is_gift: boolean
  is_return: boolean
  quantity: string
  signed_amount: string | number
  // 价格列按段取（见 detailPriceColumnsSql）：未选中的段在行里就是 undefined。
  market_standard_unit_price?: string | null
  market_unit_discount?: string | null
  market_actual_unit_price?: string | null
  store_standard_unit_price?: string | null
  store_unit_discount?: string | null
  store_actual_unit_price?: string | null
}

/**
 * 下钻明细与汇总行**同源**：投影由 `settlementProjectionSql` 生成（同一份单据类型表、同一 scope、
 * 同一日期口径），这里只在投影之上加「本行的两个端点」这一条过滤。
 *
 * ⚠️ 端点过滤必须作用在**投影列** `market_node` / `party_node` 上。若改成按原始列过滤，
 * 退货行（原始端点是反的）一条都查不到 —— 汇总净额 0、明细合计却非 0，且两处共用同一 where 也救不回来。
 */
/**
 * 价格列**按段取，不跨界**：市场段只出市场价三列，分院段只出门店价三列。
 *
 * 这不只是列裁剪 —— 市场退货行的 `actual_unit_price` / `store_*` 存的是**批次门店价**
 * （触发器按 `business.ts:5329-5334` 的取价写入），一旦随市场段返回，供应链价格档就能
 * 用「金额 ÷ 数量」反推出它无权可见的门店结算价（§9.5）。通用三件套同理：它们的语义
 * 随 doc_type 变（市场段=市场价、分院段=门店价），所以两段都不返回，各段只看自己那三列。
 */
function detailPriceColumnsSql(segment: SettlementSegment): SQL {
  return segment === 'market'
    ? sql`p.market_standard_unit_price, p.market_unit_discount, p.market_actual_unit_price`
    : sql`p.store_standard_unit_price, p.store_unit_discount, p.store_actual_unit_price`
}

export function settlementDetailSelectSql(
  projection: SQL,
  segment: SettlementSegment,
  marketNode: string,
  partyNode: string,
  limit: number,
  cursor?: string,
): SQL {
  return sql`
    SELECT ${DETAIL_COLUMNS}, ${detailPriceColumnsSql(segment)}
      FROM (${projection}) AS p
     WHERE p.market_node = ${marketNode} AND p.party_node = ${partyNode}
       ${cursor === undefined ? sql`` : sql`AND p.item_id > ${cursor}::bigint`}
     ORDER BY p.item_id ASC LIMIT ${limit}
  `
}

/** 整段导出：不加端点过滤（一个会计期间跨多个市场主体），供收款凭证使用。 */
export function settlementSegmentDetailSelectSql(
  projection: SQL,
  segment: SettlementSegment,
  limit: number,
  cursor?: string,
): SQL {
  return sql`
    SELECT ${DETAIL_COLUMNS}, ${detailPriceColumnsSql(segment)}
      FROM (${projection}) AS p
     WHERE ${cursor === undefined ? sql`TRUE` : sql`p.item_id > ${cursor}::bigint`}
     ORDER BY p.item_id ASC LIMIT ${limit}
  `
}

const numOrNull = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function mapRow(row: RawDetailRow): SettlementDetailRow {
  return {
    id: row.id,
    docId: row.doc_id,
    docType: row.doc_type,
    status: row.status,
    effectiveDate: row.effective_date,
    marketNode: row.market_node,
    marketName: row.market_name,
    partyNode: row.party_node,
    partyName: row.party_name,
    marketId: row.market_id,
    skuId: row.sku_id,
    skuName: row.sku_name,
    specName: row.spec_name,
    batchNo: row.batch_no,
    isGift: row.is_gift,
    quantity: Number(row.quantity ?? 0),
    signedAmount: Number(row.signed_amount ?? 0),
    isReturn: row.is_return,
    marketStandardUnitPrice: numOrNull(row.market_standard_unit_price),
    marketUnitDiscount: numOrNull(row.market_unit_discount),
    marketActualUnitPrice: numOrNull(row.market_actual_unit_price),
    storeStandardUnitPrice: numOrNull(row.store_standard_unit_price),
    storeUnitDiscount: numOrNull(row.store_unit_discount),
    storeActualUnitPrice: numOrNull(row.store_actual_unit_price),
  }
}

async function queryRows(query: SQL): Promise<SettlementDetailRow[]> {
  return (await db.execute(query) as unknown as RawDetailRow[]).map(mapRow)
}

/** 整段导出用的条件（不含端点）。 */
export type NormalizedSettlementSegmentFilters = Omit<NormalizedSettlementDetailFilters, 'marketNode' | 'partyNode'>

/** 整段导出：段与期间必填，端点不参与（凭证是"整月 × 整段"）。 */
export function normalizeSettlementSegmentFilters(input: SettlementSegmentFilters): NormalizedSettlementSegmentFilters {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ApiError('INVALID_PARAMS', '查询条件格式不正确')
  }
  const segment = input.segment
  if (segment !== 'market' && segment !== 'store') {
    throw new ApiError('INVALID_PARAMS', '结算段不正确')
  }
  const { startDate, endDate } = normalizeSettlementPeriod(input)
  return { segment, startDate, endDate, market: optionalText(input.market, '市场') }
}

function projectionFor(session: AuthSession, filters: NormalizedSettlementSegmentFilters): SQL | null {
  const scope = settlementDetailScope(session, filters.segment)
  if (!scope.visible) return null
  return settlementProjectionSql({
    segment: filters.segment,
    startDate: filters.startDate,
    endDate: filters.endDate,
    scopedOrgNodeIds: scope.scopedOrgNodeIds,
    market: filters.market,
  })
}

/** 页面用：段不可见时返回空集（与汇总报表"不返回任何金额字段"同一处置），不抛错。 */
export async function listSettlementDetailsForSession(
  session: AuthSession,
  input: SettlementDetailFilters,
): Promise<SettlementDetailResult> {
  const filters = normalizeSettlementDetailFilters(input)
  const projection = projectionFor(session, filters)
  if (projection === null) return { rows: [], truncated: false, limit: DETAIL_PAGE_LIMIT }
  const rows = await queryRows(
    settlementDetailSelectSql(projection, filters.segment, filters.marketNode, filters.partyNode, DETAIL_PAGE_LIMIT + 1),
  )
  return {
    rows: rows.slice(0, DETAIL_PAGE_LIMIT),
    truncated: rows.length > DETAIL_PAGE_LIMIT,
    limit: DETAIL_PAGE_LIMIT,
  }
}

/** 导出用：整段 keyset 分批，游标是明细行的不可变主键。 */
export async function exportSettlementSegmentDetailsForSession(
  session: AuthSession,
  input: SettlementSegmentFilters,
  options?: ExportBatchOptions<string>,
): Promise<ExportBatchResult<SettlementDetailRow, string>> {
  const filters = normalizeSettlementSegmentFilters(input)
  const cursor = options?.cursor
  if (cursor !== undefined
    && (typeof cursor !== 'string' || !/^[1-9]\d{0,18}$/.test(cursor) || BigInt(cursor) > BigInt('9223372036854775807'))) {
    throw new ApiError('INVALID_STATE', '导出分页游标不合法')
  }
  const limit = resolveExportBatchLimit(options?.limit)
  if (limit == null) throw new ApiError('INVALID_STATE', '结算明细导出只支持分批取数')
  const projection = projectionFor(session, filters)
  // 导出与页面不同：段不可见时页面返回空集是对的（页面本身走 404 收口），
  // 但任务路径没有价格档校验 —— 静默产出只有表头的 xlsx 会变成"成功但无意义"的任务与审计噪音，
  // 所以这里 fail-fast。
  if (projection === null) throw new ApiError('PERMISSION_DENIED', '当前账号无权导出该结算段')
  const fetched = await queryRows(settlementSegmentDetailSelectSql(projection, filters.segment, limit + 1, cursor))
  const page = resolveExportKeysetPage(fetched, limit, (row) => row.id)
  return {
    rows: page.pageRows,
    truncated: false,
    hasMore: page.hasMore,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  }
}
