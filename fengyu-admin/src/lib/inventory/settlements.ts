import { db } from '@/db'
import 'server-only'
import { ApiError } from '@/lib/api-error'
import { shanghaiToday } from '@/lib/datetime'
import { withPermission } from '@/lib/with-permission'
import { inventoryDocs, inventoryLocations } from '@db/inventory'
import { and, asc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import type {
  InventorySettlementReport,
  InventorySettlementRow,
} from './types'
import { inventoryPriceVisibility, inventoryScopedOrgNodeIds } from './access'

const settlementSourceLocation = alias(inventoryLocations, 'settlement_source_loc')
const settlementTargetLocation = alias(inventoryLocations, 'settlement_target_loc')

/**
 * 市场货款结算 = 市场报货单应付货款汇总（市场应付供应链，实际单价含福利优惠）。
 * 市场报货创建即「已完成」，白名单口径排除任何取消/驳回态。
 */
const MARKET_SETTLEMENT_STATUSES = ['已完成'] as const

/**
 * 分院货款结算 = 分院配货单应付货款汇总（门店应付市场，按门店真实单价）。
 * 配货单创建即「待收货」、门店收货后转「已完成」；两态货款均已产生。
 */
const STORE_SETTLEMENT_STATUSES = ['待收货', '已完成'] as const

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function normalizeSettlementPeriod(filters: { startDate?: string | null; endDate?: string | null }) {
  const today = shanghaiToday()
  const startDate = filters.startDate?.trim() || `${today.slice(0, 8)}01`
  const endDate = filters.endDate?.trim() || today
  if (!DATE_PATTERN.test(startDate) || !DATE_PATTERN.test(endDate)) {
    throw new ApiError('INVALID_PARAMS', '结算期间日期格式必须为 YYYY-MM-DD')
  }
  if (startDate > endDate) {
    throw new ApiError('INVALID_PARAMS', '结算开始日期不能晚于结束日期')
  }
  return { startDate, endDate }
}

async function summarizeSettlementDocs(params: {
  docType: '市场报货' | '分院配货'
  statuses: readonly string[]
  startDate: string
  endDate: string
  scopedOrgNodeIds: string[] | null
}): Promise<InventorySettlementRow[]> {
  const conditions: SQL[] = [
    eq(inventoryDocs.docType, params.docType),
    inArray(inventoryDocs.status, [...params.statuses]),
    gte(inventoryDocs.docDate, params.startDate),
    lte(inventoryDocs.docDate, params.endDate),
  ]
  if (params.scopedOrgNodeIds !== null) {
    if (params.scopedOrgNodeIds.length === 0) return []
    conditions.push(or(
      inArray(inventoryDocs.sourceOrgNodeId, params.scopedOrgNodeIds),
      inArray(inventoryDocs.targetOrgNodeId, params.scopedOrgNodeIds),
    )!)
  }
  const rows = await db
    .select({
      sourceOrgNodeId: inventoryDocs.sourceOrgNodeId,
      sourceOrgNodeName: settlementSourceLocation.name,
      targetOrgNodeId: inventoryDocs.targetOrgNodeId,
      targetOrgNodeName: settlementTargetLocation.name,
      docCount: sql<number>`cast(count(*) as int)`,
      totalQuantity: sql<string | number | null>`COALESCE(SUM(${inventoryDocs.totalQuantity}), 0)`,
      payableAmount: sql<string | number | null>`COALESCE(SUM(${inventoryDocs.totalAmount}), 0)`,
    })
    .from(inventoryDocs)
    .leftJoin(settlementSourceLocation, eq(settlementSourceLocation.orgNodeId, inventoryDocs.sourceOrgNodeId))
    .leftJoin(settlementTargetLocation, eq(settlementTargetLocation.orgNodeId, inventoryDocs.targetOrgNodeId))
    .where(and(...conditions))
    .groupBy(
      inventoryDocs.sourceOrgNodeId,
      settlementSourceLocation.name,
      inventoryDocs.targetOrgNodeId,
      settlementTargetLocation.name,
    )
    .orderBy(asc(settlementSourceLocation.name), asc(settlementTargetLocation.name))
  return rows.map((row) => ({
    sourceOrgNodeId: row.sourceOrgNodeId,
    sourceOrgNodeName: row.sourceOrgNodeName,
    targetOrgNodeId: row.targetOrgNodeId,
    targetOrgNodeName: row.targetOrgNodeName,
    docCount: Number(row.docCount ?? 0),
    totalQuantity: Number(row.totalQuantity ?? 0),
    payableAmount: Number(row.payableAmount ?? 0),
  }))
}

/**
 * 货款结算只读报表：
 * - 市场结算（市场应付供应链）随供应链/市场价格档可见（§9.5 供应链可见市场结算价、市场可见本市场进货价）；
 * - 分院结算（门店应付市场）仅市场价格档可见（供应链档不得见门店结算价）；
 * - none 档（门店库存员）两段均不可见，服务端不返回任何金额字段；
 * - scope 复用 inventoryScopedOrgNodeIds：库存总部不展开后代，市场含本市场及门店。
 */
export const listInventorySettlements = withPermission(
  'inventory:list',
  async (
    session,
    filters: { startDate?: string; endDate?: string } = {},
  ): Promise<InventorySettlementReport> => {
    const { startDate, endDate } = normalizeSettlementPeriod(filters)
    const priceVisibility = inventoryPriceVisibility(session)
    const canViewMarketSettlement = priceVisibility !== 'none'
    const canViewStoreSettlement = priceVisibility === 'all' || priceVisibility === 'market'
    if (!canViewMarketSettlement && !canViewStoreSettlement) {
      // 门店价格档：金额一律不出服务端，直接返回空报表。
      return {
        startDate,
        endDate,
        priceVisibility,
        canViewMarketSettlement: false,
        canViewStoreSettlement: false,
        marketRows: [],
        storeRows: [],
      }
    }
    const scopedOrgNodeIds = inventoryScopedOrgNodeIds(session)
    const [marketRows, storeRows] = await Promise.all([
      canViewMarketSettlement
        ? summarizeSettlementDocs({
            docType: '市场报货',
            statuses: MARKET_SETTLEMENT_STATUSES,
            startDate,
            endDate,
            scopedOrgNodeIds,
          })
        : Promise.resolve([]),
      canViewStoreSettlement
        ? summarizeSettlementDocs({
            docType: '分院配货',
            statuses: STORE_SETTLEMENT_STATUSES,
            startDate,
            endDate,
            scopedOrgNodeIds,
          })
        : Promise.resolve([]),
    ])
    return {
      startDate,
      endDate,
      priceVisibility,
      canViewMarketSettlement,
      canViewStoreSettlement,
      marketRows,
      storeRows,
    }
  },
)
