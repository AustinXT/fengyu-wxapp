'use server'

import { db } from '@/db'
import { saleItems, saleOrders } from '@db/order'
import { productSkus, productCategories } from '@db/product'
import { stores, orgNodes } from '@db/org'
import { serviceItems, serviceOrders } from '@db/service'
import { clientWechatUsers, staffWechatUsers } from '@db/user'
import { prepaidCards } from '@db/prepaid-card'
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { scopeCondition, isInScope } from '@/lib/permissions'
import { withPermission } from '@/lib/with-permission'
import { parseCardFilters } from '@/lib/list-filters'
import { nowTs } from '@/lib/db-time'
import {
  offsetPageResult,
  resolveExportOffsetPage,
  type ExportBatchOptions,
  type ExportBatchResult,
} from '@/lib/export-pagination'
import { paidUnusedSessionsExpr } from '@/lib/paid-sessions'
import { computeItemOverpayRemainders, type RefundSourceItem } from '@/lib/refund'
import { storeInMarketCondition } from '@/lib/market-store-sql'

// ============================================================================
// 管理端卡包列表（/cards 页面）
// ============================================================================

/** 卡类型（UI segmented） */
export type CardTypeFilter = 'all' | '疗程卡' | '单次卡'

/** 状态（UI 下拉） */
export type CardStatusFilter = 'active' | 'exhausted' | 'expired'

const CARD_ENTITLEMENT_ORDER_STATUSES = ['已支付', '部分支付', '已完成'] as const

/** 卡包列表筛选参数 */
export interface CardFilters {
  marketId?: string
  storeId?: string
  type?: CardTypeFilter
  status?: CardStatusFilter
  /** 一级品项（product_categories.product_kind） */
  productKind?: string
  /** 二级品项 ID（product_skus.category_id） */
  categoryId?: string
  search?: string
  page?: number
  pageSize?: number
}

/** 管理端卡包行模型 */
export interface AdminCard {
  saleItemId: string
  saleOrderId: string
  /** 商品名快照 */
  productName: string | null
  /** 当前 SKU 的展示单位；历史 SKU 缺失时回退「次」。 */
  unit: string
  /** 总次数 */
  sessionCount: number | null
  /** 剩余次数（物理剩余，含未付款次数） */
  remainingSessions: number | null
  /** 已付次数（按付款比例 floor） */
  paidSessions: number | null
  /** 可用次数（已付未用）；paid_sessions 为 NULL 时退回物理剩余，否则 max(paid − used, 0)；列表仅含 paid_sessions>0 的卡 */
  paidUnusedSessions: number | null
  /** 可退的行级多收余数金额。 */
  remainingRemainder: number
  /**
   * 购买数量（B2 兜底字段）：
   * 修写入侧（疗程卡 quantity>1 拆 N 行）后，正常情况下 quantity 应恒 = 1。
   * 列表渲染层用此字段做"老卡 ×N"兜底显示（D8=B 决策不动历史）。
   */
  quantity: number
  /** 有效期（YYYY-MM-DD 或 null） */
  expireDate: string | null
  /** 购买时间（paid_at，ISO） */
  paidAt: string | null
  storeId: string
  storeName: string | null
  marketName: string | null
  clientUserId: string | null
  clientName: string | null
  clientPhone: string | null
}

/**
 * 疗程卡的「剩余零头」与退款页使用完全相同的行级多收余数口径。
 * 卡包列表已限定 product_type='疗程卡'，因此仅需补齐退款计算所需的行快照字段。
 */
function computeCardRemainingRemainder(item: {
  saleItemId: string
  sessionCount: number | null
  remainingSessions: number | null
  paidSessions: number | null
  unitRealPrice: string | number | null
  received: string | number | null
}): number {
  const source: RefundSourceItem = {
    sale_item_id: item.saleItemId,
    sku_id: null,
    product_name: null,
    product_type: '疗程卡',
    session_count: item.sessionCount,
    remaining_sessions: item.remainingSessions,
    paid_sessions: item.paidSessions,
    unit_price: 0,
    quantity: 1,
    unit_real_price: item.unitRealPrice ?? 0,
    received: item.received,
    picked_up_quantity: 0,
    sales_category: null,
    service_fee: null,
  }
  return computeItemOverpayRemainders([source]).get(item.saleItemId) ?? 0
}

/** 分页结果 */
export interface PaginatedCards {
  data: AdminCard[]
  total: number
}

/** 疗程卡筛选器可选的二级品项。 */
export interface CardFilterCategory {
  categoryId: string
  categoryName: string
  productKind: string
}

/** 疗程卡筛选器可选项（与 sale_item:list 权限保持一致，不依赖商品管理权限）。 */
export interface CardFilterOptions {
  productKinds: string[]
  categories: CardFilterCategory[]
}

export const getCardFilterOptions = withPermission(
  'sale_item:list',
  async (_session): Promise<CardFilterOptions> => {
    const [kindRows, categoryRows] = await Promise.all([
      db
        .select({ categoryName: productCategories.categoryName })
        .from(productCategories)
        .where(isNull(productCategories.productKind))
        // 例外：sortOrder 是品项字典的人工排序权重
        .orderBy(asc(productCategories.sortOrder), asc(productCategories.categoryName)),
      db
        .select({
          categoryId: productCategories.categoryId,
          categoryName: productCategories.categoryName,
          productKind: productCategories.productKind,
        })
        .from(productCategories)
        .where(isNotNull(productCategories.productKind))
        // 例外：sortOrder 是品项字典的人工排序权重
        .orderBy(asc(productCategories.sortOrder), asc(productCategories.categoryName)),
    ])

    return {
      productKinds: kindRows.map((row) => row.categoryName),
      categories: categoryRows.map((row) => ({
        categoryId: row.categoryId,
        categoryName: row.categoryName,
        productKind: row.productKind!,
      })),
    }
  },
)

/**
 * 服务端分页卡包列表
 *
 * "卡包" = sale_items WHERE product_type='疗程卡'
 *   AND (item_direction='购买' OR sale_order_type='转换单' AND item_direction='转入')
 *   AND remaining_sessions IS NOT NULL
 *   - session_count = 1  → UI 标记为"单次卡"
 *   - session_count >= 2 → UI 标记为"疗程卡"
 *
 * scope 基于 sale_items.store_id（权益归属门店），与 PR-A 新增的 store_id 列绑定。
 *
 * 状态判定：
 *   - active:    remaining_sessions > 0 AND (expire_date IS NULL OR expire_date >= CURRENT_DATE)
 *   - exhausted: remaining_sessions = 0
 *   - expired:   expire_date IS NOT NULL AND expire_date < CURRENT_DATE
 */

// paidUnusedSessionsExpr（已付未用 = 可用次数 派生）已提升为 admin 共享单源（@/lib/paid-sessions），
// 卡包列表/详情 + 订单/营业额分配导出复用同一表达式；NULL 退回物理剩余、clamp 等口径细节见该文件注释。

function cardEntitlementDirectionCondition() {
  return or(
    eq(saleItems.itemDirection, '购买'),
    and(
      eq(saleOrders.saleOrderType, '转换单'),
      eq(saleItems.itemDirection, '转入'),
    ),
  )
}

function buildCardBaseConditions(
  session: Parameters<typeof scopeCondition>[0],
): (SQL | undefined)[] {
  return [
    cardEntitlementDirectionCondition(),
    inArray(saleOrders.status, [...CARD_ENTITLEMENT_ORDER_STATUSES]),
    eq(saleItems.productType, '疗程卡'),
    isNotNull(saleItems.remainingSessions),
    // #4：过滤完全未付款的欠款卡（paid_sessions=0/NULL）——可用卡列表只展示有已付次数的卡，
    // 避免欠款卡误显「剩余 0 / 已用完」红色进度条（历史 NULL 行同样视作未付款排除）
    sql`${saleItems.paidSessions} > 0`,
    // scope 过滤（admin 返回 undefined；非 admin 按 scopeStoreIds）
    scopeCondition(session, saleItems.storeId),
  ]
}

/**
 * 构建卡包 WHERE 条件（列表分页与导出共用，单一真源防漂移）。
 * 基础过滤：权益方向 + 有效订单状态 + 疗程卡 + 余次不为空 + 已付次数>0 + scope。
 * market 分支用子查询（不预查节点类型），故为同步函数。
 */
function buildCardConditions(
  session: Parameters<typeof scopeCondition>[0],
  filters: CardFilters,
): (SQL | undefined)[] {
  const conditions = buildCardBaseConditions(session)

  // 市场筛选：市场节点自身及任意层级下属节点关联的所有门店。
  if (filters.marketId) {
    conditions.push(storeInMarketCondition(saleItems.storeId, filters.marketId))
  }
  // 门店筛选
  if (filters.storeId) {
    conditions.push(eq(saleItems.storeId, filters.storeId))
  }
  // 卡类型筛选
  if (filters.type === '疗程卡') {
    conditions.push(gte(saleItems.sessionCount, 2))
  } else if (filters.type === '单次卡') {
    conditions.push(eq(saleItems.sessionCount, 1))
  }
  // 状态筛选
  if (filters.status === 'active') {
    conditions.push(sql`${saleItems.remainingSessions} > 0`)
    conditions.push(
      or(
        isNull(saleItems.expireDate),
        sql`${saleItems.expireDate} >= CURRENT_DATE`,
      ),
    )
  } else if (filters.status === 'exhausted') {
    conditions.push(eq(saleItems.remainingSessions, 0))
  } else if (filters.status === 'expired') {
    conditions.push(isNotNull(saleItems.expireDate))
    conditions.push(sql`${saleItems.expireDate} < CURRENT_DATE`)
  }
  // 品项筛选：历史无分类卡在「全部」下保留，筛具体一级/二级时不匹配。
  if (filters.productKind) {
    conditions.push(eq(productCategories.productKind, filters.productKind))
  }
  if (filters.categoryId) {
    conditions.push(eq(productSkus.categoryId, filters.categoryId))
  }
  // 搜索：订单号精准匹配 OR 顾客姓名/手机号/疗程卡名称模糊匹配。
  if (filters.search) {
    const escaped = filters.search.replace(/[%_]/g, '\\$&')
    const pattern = `%${escaped}%`
    conditions.push(
      or(
        // 订单号精准匹配（sale_order_id 主键唯一，输入完整单号即定位唯一卡）
        eq(saleOrders.saleOrderId, filters.search),
        // 顾客姓名/手机号模糊匹配
        ilike(clientWechatUsers.name, pattern),
        ilike(clientWechatUsers.phone, pattern),
        // 疗程卡商品名快照模糊匹配（历史 SKU 删除后仍可检索）
        ilike(saleItems.productName, pattern),
      ),
    )
  }
  return conditions
}

export const getCardsPaginated = withPermission(
  'sale_item:list',
  async (session, filters: CardFilters = {}): Promise<PaginatedCards> => {
  const page = Math.max(1, filters.page || 1)
  const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
  const offset = (page - 1) * pageSize

  const whereClause = and(...buildCardConditions(session, filters))

  // 市场名称标量子查询（参考 customers.ts 范式）
  const marketNameExpr = sql<string | null>`(
    SELECT n.name FROM stores s
    JOIN org_nodes sn ON sn.id = s.org_node_id
    JOIN org_nodes n ON n.id = sn.parent_id
    WHERE s.store_id = ${saleItems.storeId}
  )`.as('market_name')

  // COUNT 查询（同样需要 JOIN 顾客、SKU、分类表，因为 search / 品项筛选会命中这些列）
  const countQuery = db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(saleItems)
    .leftJoin(saleOrders, eq(saleItems.saleOrderId, saleOrders.saleOrderId))
    .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
    .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
    .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
    .where(whereClause)

  // DATA 查询
  const dataQuery = db
    .select({
      saleItemId: saleItems.saleItemId,
      saleOrderId: saleItems.saleOrderId,
      productName: saleItems.productName,
      unit: productSkus.unit,
      sessionCount: saleItems.sessionCount,
      remainingSessions: saleItems.remainingSessions,
      paidSessions: saleItems.paidSessions,
      paidUnusedSessions: paidUnusedSessionsExpr,
      unitRealPrice: saleItems.unitRealPrice,
      received: saleItems.received,
      quantity: saleItems.quantity,
      expireDate: saleItems.expireDate,
      paidAt: saleOrders.paidAt,
      storeId: saleItems.storeId,
      storeName: stores.storeName,
      marketName: marketNameExpr,
      clientUserId: saleOrders.clientUserId,
      clientName: clientWechatUsers.name,
      clientPhone: clientWechatUsers.phone,
    })
    .from(saleItems)
    .leftJoin(saleOrders, eq(saleItems.saleOrderId, saleOrders.saleOrderId))
    .leftJoin(stores, eq(saleItems.storeId, stores.storeId))
    .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
    .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
    .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
    .where(whereClause)
    // 例外：业务时间优先（支付时间优于"最近编辑"）
    .orderBy(desc(saleOrders.paidAt), desc(saleItems.createdAt))
    .limit(pageSize)
    .offset(offset)

  const [[countRow], rows] = await Promise.all([countQuery, dataQuery])

  return {
    data: rows.map((r) => ({
      saleItemId: r.saleItemId,
      saleOrderId: r.saleOrderId,
      productName: r.productName ?? null,
      unit: r.unit ?? '次',
      sessionCount: r.sessionCount ?? null,
      remainingSessions: r.remainingSessions ?? null,
      paidSessions: r.paidSessions ?? null,
      paidUnusedSessions: r.paidUnusedSessions ?? null,
      remainingRemainder: computeCardRemainingRemainder(r),
      quantity: r.quantity ?? 1,
      expireDate: r.expireDate ?? null,
      paidAt: r.paidAt?.toISOString() ?? null,
      storeId: r.storeId,
      storeName: r.storeName ?? null,
      marketName: r.marketName ?? null,
      clientUserId: r.clientUserId ?? null,
      clientName: r.clientName ?? null,
      clientPhone: r.clientPhone ?? null,
    })),
    total: countRow?.count ?? 0,
  }
  },
)

// ============================================================================
// 疗程卡导出（/cards 页面「导出」按钮）
//
// 权限：sale_item:list（与列表同）；scope 由 saleItems.storeId 约束。
// 复用 buildCardConditions + paidUnusedSessionsExpr，保证筛选条件 / 剩余次数口径与列表一致。
// 金额 5 列 Number 化便于 Excel 求和；时间列交前端 fmtDateTime（Asia/Shanghai）。
// ============================================================================

/** 疗程卡导出行（19 列，与表头一致） */
export interface ExportCardRow {
  /** 顾客（主档优先，回退订单快照） */
  clientName: string
  /** 手机号 */
  clientPhone: string
  /** 一级品项（product_kind，父级 L1 名） */
  categoryL1: string | null
  /** 二级品项（category_name，L2 行名） */
  categoryL2: string | null
  /** 商品/规格（productName 快照优先，脏数据 fallback specName） */
  productSpec: string | null
  /** 当前 SKU 的展示单位；历史 SKU 缺失时回退「次」。 */
  unit: string
  /** 类型（单次卡 / N次卡，sessionCount 派生，与列表 typeBadge 一致） */
  cardType: string
  /** 剩余次数（已付未用口径） */
  remaining: number
  /** 已付次数（按付款比例 floor） */
  paidSessions: number
  /** 总次数 */
  totalSessions: number
  /** 可退的行级多收余数金额。 */
  remainingRemainder: number
  /** 单次标价 */
  unitPrice: number | null
  /** 单次优惠后价 */
  unitRealPrice: number | null
  /** 行应付总额 */
  saleAmount: number | null
  /** 行实收（行级净实收，退款/转出可为负） */
  received: number | null
  /** 购买门店（门店名 / 市场名） */
  storeDisplay: string | null
  /** 开单时间（sale_order_datetime，ISO） */
  saleOrderDatetime: string | null
  /** 订单号 */
  saleOrderId: string
  /** 订单状态 */
  orderStatus: string | null
  /** 付款时间（paid_at，ISO；待支付为 null） */
  paidAt: string | null
}

/** numeric 列（postgres.js 返回 string）转 number；null/空/非数字 → null */
const numOrNull = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 导出疗程卡（当前筛选命中，跨分页）。 */
export const exportCards = withPermission(
  'sale_item:list',
  async (
    session,
    params: Record<string, string | undefined>,
    options?: ExportBatchOptions,
  ): Promise<ExportBatchResult<ExportCardRow>> => {
    const filters = parseCardFilters(params)
    const whereClause = and(...buildCardConditions(session, filters))
    const page = resolveExportOffsetPage(options)

    // 市场名 scalar subquery（与列表/详情同范式）
    const marketNameExpr = sql<string | null>`(
      SELECT n.name FROM stores s
      JOIN org_nodes sn ON sn.id = s.org_node_id
      JOIN org_nodes n ON n.id = sn.parent_id
      WHERE s.store_id = ${saleItems.storeId}
    )`.as('market_name')

    const query = db
      .select({
        saleItemId: saleItems.saleItemId,
        productName: saleItems.productName,
        specName: productSkus.specName,
        unit: productSkus.unit,
        sessionCount: saleItems.sessionCount,
        remainingSessions: saleItems.remainingSessions,
        paidSessions: saleItems.paidSessions,
        paidUnusedSessions: paidUnusedSessionsExpr,
        unitPrice: saleItems.unitPrice,
        unitRealPrice: saleItems.unitRealPrice,
        saleAmount: saleItems.saleAmount,
        received: saleItems.received,
        productKind: productCategories.productKind,
        categoryName: productCategories.categoryName,
        storeName: stores.storeName,
        marketName: marketNameExpr,
        clientName: clientWechatUsers.name,
        clientPhone: clientWechatUsers.phone,
        fallbackName: saleOrders.customerName,
        fallbackPhone: saleOrders.clientPhone,
        saleOrderId: saleItems.saleOrderId,
        saleOrderDatetime: saleOrders.saleOrderDatetime,
        orderStatus: saleOrders.status,
        paidAt: saleOrders.paidAt,
      })
      .from(saleItems)
      .leftJoin(saleOrders, eq(saleItems.saleOrderId, saleOrders.saleOrderId))
      .leftJoin(stores, eq(saleItems.storeId, stores.storeId))
      .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
      .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
      .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
      .where(whereClause)
      // 例外：业务时间优先（支付时间优于"最近编辑"），与列表排序一致
      .orderBy(desc(saleOrders.paidAt), desc(saleItems.createdAt), asc(saleItems.saleItemId))
    const raw = page
      ? await query.limit(page.limit + 1).offset(page.offset)
      : await query

    const rows: ExportCardRow[] = raw.map((r) => {
      const sessionCount = r.sessionCount ?? 0
      const unit = r.unit ?? '次'
      return {
        clientName: r.clientName || r.fallbackName || '',
        clientPhone: r.clientPhone || r.fallbackPhone || '',
        categoryL1: r.productKind ?? null,
        categoryL2: r.categoryName ?? null,
        productSpec: r.productName ?? r.specName ?? null,
        unit,
        cardType: sessionCount === 1 ? `单${unit}卡` : `${sessionCount}${unit}卡`,
        remaining: r.paidUnusedSessions ?? 0,
        paidSessions: r.paidSessions ?? 0,
        totalSessions: sessionCount,
        remainingRemainder: computeCardRemainingRemainder(r),
        unitPrice: numOrNull(r.unitPrice),
        unitRealPrice: numOrNull(r.unitRealPrice),
        saleAmount: numOrNull(r.saleAmount),
        received: numOrNull(r.received),
        storeDisplay: [r.storeName, r.marketName].filter(Boolean).join(' / ') || null,
        saleOrderDatetime: r.saleOrderDatetime?.toISOString() ?? null,
        saleOrderId: r.saleOrderId,
        orderStatus: r.orderStatus ?? null,
        paidAt: r.paidAt?.toISOString() ?? null,
      }
    })

    return offsetPageResult(rows, page)
  },
)

// ============================================================================
// 卡详情（/cards/[id] 页面）
//
// 权限：sale_item:list（admin/manager/finance/customer_mgr 均默认持有）。
//   - scope 由 saleItems.storeId 约束，非 admin 角色跨门店 saleItemId 直接返回 null。
//   - 强制权益方向：购买行，或转换单转入行；转换出/退款出的 sale_item 是流水副本不是卡，详情入口不展示。
// ============================================================================

export interface CardDetail {
  // sale_items 快照
  saleItemId: string
  saleOrderId: string
  productName: string | null
  /** 当前 SKU 的展示单位；历史 SKU 缺失时按商品类型回退。 */
  unit: string
  sessionCount: number | null
  remainingSessions: number | null
  paidSessions: number | null
  /** 可用次数（已付未用）；paid_sessions 为 NULL 时退回物理剩余，否则 max(paid − used, 0) */
  paidUnusedSessions: number | null
  unitPrice: string
  unitRealPrice: string
  saleAmount: string
  received: string
  quantity: number
  expireDate: string | null
  itemDirection: string
  productType: '疗程卡' | '家居产品' | null
  // 顾客 / 门店
  storeId: string
  storeName: string | null
  marketName: string | null
  clientUserId: string | null
  clientName: string | null
  clientPhone: string | null
  // 关联订单
  paidAt: string | null
  orderCreatedAt: string | null
  orderStatus: string | null
}

export const getCardById = withPermission(
  'sale_item:list',
  async (session, saleItemId: string): Promise<CardDetail | null> => {
    if (!saleItemId) return null

    // 复用 cards 列表的市场名 scalar subquery 范式（cards.ts:148-153）
    const marketNameExpr = sql<string | null>`(
      SELECT n.name FROM stores s
      JOIN org_nodes sn ON sn.id = s.org_node_id
      JOIN org_nodes n ON n.id = sn.parent_id
      WHERE s.store_id = ${saleItems.storeId}
    )`.as('market_name')

    const rows = await db
      .select({
        saleItemId: saleItems.saleItemId,
        saleOrderId: saleItems.saleOrderId,
        productName: saleItems.productName,
        unit: productSkus.unit,
        sessionCount: saleItems.sessionCount,
        remainingSessions: saleItems.remainingSessions,
        paidSessions: saleItems.paidSessions,
        paidUnusedSessions: paidUnusedSessionsExpr,
        unitPrice: saleItems.unitPrice,
        unitRealPrice: saleItems.unitRealPrice,
        saleAmount: saleItems.saleAmount,
        received: saleItems.received,
        quantity: saleItems.quantity,
        expireDate: saleItems.expireDate,
        itemDirection: saleItems.itemDirection,
        productType: saleItems.productType,
        storeId: saleItems.storeId,
        storeName: stores.storeName,
        marketName: marketNameExpr,
        clientUserId: saleOrders.clientUserId,
        clientName: clientWechatUsers.name,
        clientPhone: clientWechatUsers.phone,
        paidAt: saleOrders.paidAt,
        orderCreatedAt: saleOrders.createdAt,
        orderStatus: saleOrders.status,
      })
      .from(saleItems)
      .leftJoin(saleOrders, eq(saleItems.saleOrderId, saleOrders.saleOrderId))
      .leftJoin(stores, eq(saleItems.storeId, stores.storeId))
      .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
      .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
      .where(
        and(
          eq(saleItems.saleItemId, saleItemId),
          ...buildCardBaseConditions(session),
        ),
      )
      .limit(1)

    if (rows.length === 0) return null
    const r = rows[0]

    return {
      saleItemId: r.saleItemId,
      saleOrderId: r.saleOrderId,
      productName: r.productName ?? null,
      unit: r.unit ?? (r.productType === '家居产品' ? '盒' : '次'),
      sessionCount: r.sessionCount ?? null,
      remainingSessions: r.remainingSessions ?? null,
      paidSessions: r.paidSessions ?? null,
      paidUnusedSessions: r.paidUnusedSessions ?? null,
      unitPrice: r.unitPrice,
      unitRealPrice: r.unitRealPrice,
      saleAmount: r.saleAmount,
      received: r.received,
      quantity: r.quantity ?? 1,
      expireDate: r.expireDate ?? null,
      itemDirection: r.itemDirection,
      productType: (r.productType as '疗程卡' | '家居产品' | null) ?? null,
      storeId: r.storeId,
      storeName: r.storeName ?? null,
      marketName: r.marketName ?? null,
      clientUserId: r.clientUserId ?? null,
      clientName: r.clientName ?? null,
      clientPhone: r.clientPhone ?? null,
      paidAt: r.paidAt?.toISOString() ?? null,
      orderCreatedAt: r.orderCreatedAt?.toISOString() ?? null,
      orderStatus: r.orderStatus ?? null,
    }
  },
)

export interface CardTransaction {
  serviceItemId: string
  serviceOrderId: string
  serviceDate: string
  serviceOrderStatus: string
  sessionUsed: number
  unitRealPriceSnapshot: string | null
  employeeId: string | null
  employeeName: string | null
}

export const getCardTransactions = withPermission(
  'sale_item:list',
  async (_session, saleItemId: string): Promise<CardTransaction[]> => {
    if (!saleItemId) return []

    const rows = await db
      .select({
        serviceItemId: serviceItems.serviceItemId,
        serviceOrderId: serviceItems.serviceOrderId,
        serviceDate: serviceOrders.serviceDate,
        serviceOrderStatus: serviceOrders.status,
        sessionUsed: serviceItems.sessionUsed,
        unitRealPriceSnapshot: serviceItems.unitRealPrice,
        employeeId: serviceItems.employeeId,
        employeeName: staffWechatUsers.name,
      })
      .from(serviceItems)
      .innerJoin(serviceOrders, eq(serviceItems.serviceOrderId, serviceOrders.serviceOrderId))
      .leftJoin(staffWechatUsers, eq(serviceItems.employeeId, staffWechatUsers.employeeId))
      .where(eq(serviceItems.saleItemId, saleItemId))
      .orderBy(desc(serviceOrders.serviceDate), desc(serviceItems.createdAt))

    return rows.map((r) => ({
      serviceItemId: r.serviceItemId,
      serviceOrderId: r.serviceOrderId,
      serviceDate: r.serviceDate,
      serviceOrderStatus: r.serviceOrderStatus,
      sessionUsed: r.sessionUsed,
      unitRealPriceSnapshot: r.unitRealPriceSnapshot ?? null,
      employeeId: r.employeeId ?? null,
      employeeName: r.employeeName ?? null,
    }))
  },
)

// ============================================================================
// 转换单候选卡（PR-A 新增）
// ============================================================================

/**
 * 转换单候选卡 — 顾客在指定门店可折抵的购买行。
 *
 * 来源口径：sale_items 上 item_direction='购买'，且归属该顾客（通过 sale_orders
 * 反向 JOIN client_user_id）、归属指定 store_id；状态为"已支付/已完成"的订单。
 *
 * 折抵对象（2026-05-21 单品合并后放开）：
 *   疗程卡 (product_type='疗程卡') AND remaining_sessions > 0
 *   —— 原"体验卡单品"已并入疗程卡（session_count=1），不再要求 is_experience。
 *
 * 不包含：充值卡（走 prepaid_cards 账户，不在 sale_items 行）、家居产品（不在业务口径内）
 */
export interface HeldCardCandidate {
  saleItemId: string
  saleItemGroupId: string | null
  saleOrderId: string
  saleOrderDatetime: string | null
  paidAt: string | null
  orderStatus: string
  saleOrderType: string
  documentType: string | null
  marketName: string
  legacySource: string | null
  storeId: string
  skuId: string | null
  itemDirection: string
  refSaleItemId: string | null
  productName: string | null
  productType: '疗程卡' | '家居产品'
  /** 当前 SKU 的展示单位；历史 SKU 缺失时按商品类型回退。 */
  unit: string
  quantity: number
  sessionCount: number | null
  /** 剩余次数（疗程卡） */
  remainingSessions: number | null
  paidSessions: number | null
  /** 剩余可提货数量；疗程卡返回 null */
  remainingQty: number | null
  unitPrice: string
  unitRealPrice: string
  saleAmount: string
  received: string
  pendingReceived: string
  /** 折抵金额 = unitRealPrice × remainingSessions */
  deductibleAmount: string
  expireDate: string | null
  remark: string | null
  salesCategory: string | null
  pickedUpQuantity: number | null
  /** 一级品项（历史无分类卡为 null） */
  productKind: string | null
  /** 二级品项 ID（历史无分类卡为 null） */
  categoryId: string | null
  /** 二级品项名称（历史无分类卡为 null） */
  categoryName: string | null
}

export const getCustomerHeldCards = withPermission(
  'sale_order:list',
  async (
    session,
    clientUserId: string,
    storeId: string,
  ): Promise<HeldCardCandidate[]> => {
  if (!clientUserId || !storeId) return []
  // scope 校验：admin 可全量，其余角色需 storeId 在 scope 内
  if (!isInScope(session, storeId)) return []

  const rows = await db
    .select({
      saleItemId: saleItems.saleItemId,
      saleItemGroupId: saleItems.saleItemGroupId,
      saleOrderId: saleItems.saleOrderId,
      saleOrderDatetime: saleOrders.saleOrderDatetime,
      paidAt: saleOrders.paidAt,
      orderStatus: saleOrders.status,
      saleOrderType: saleOrders.saleOrderType,
      documentType: saleOrders.documentType,
      marketName: saleOrders.marketName,
      legacySource: saleOrders.legacySource,
      storeId: saleItems.storeId,
      skuId: saleItems.skuId,
      itemDirection: saleItems.itemDirection,
      refSaleItemId: saleItems.refSaleItemId,
      productName: saleItems.productName,
      productType: saleItems.productType,
      unit: productSkus.unit,
      sessionCount: saleItems.sessionCount,
      remainingSessions: saleItems.remainingSessions,
      paidSessions: saleItems.paidSessions,
      quantity: saleItems.quantity,
      pickedUpQuantity: saleItems.pickedUpQuantity,
      unitPrice: saleItems.unitPrice,
      unitRealPrice: saleItems.unitRealPrice,
      saleAmount: saleItems.saleAmount,
      received: saleItems.received,
      pendingReceived: saleItems.pendingReceived,
      expireDate: saleItems.expireDate,
      remark: saleItems.remark,
      salesCategory: saleItems.salesCategory,
      productKind: productCategories.productKind,
      categoryId: productSkus.categoryId,
      categoryName: productCategories.categoryName,
    })
    .from(saleItems)
    .innerJoin(saleOrders, eq(saleItems.saleOrderId, saleOrders.saleOrderId))
    .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
    .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
    .where(
      and(
        eq(saleItems.storeId, storeId),
        eq(saleOrders.clientUserId, clientUserId),
        cardEntitlementDirectionCondition(),
        or(eq(saleOrders.status, '已支付'), eq(saleOrders.status, '已完成')),
        // 2026-05-21 单品合并：折抵对象统一为 疗程卡 + 剩余次数>0（含原"体验卡单品"=1 次卡）
        eq(saleItems.productType, '疗程卡'),
        sql`COALESCE(${saleItems.remainingSessions}, 0) > 0`,
        // 在途退款冻结：原订单存在 '待审批' 退款时排除整单的卡（与 staff customerHeldCards 对齐）
        sql`NOT EXISTS (SELECT 1 FROM sale_order_payments sop WHERE sop.sale_order_id = ${saleItems.saleOrderId} AND sop.change_type = '退款' AND sop.status = '待审批')`,
        // 审批后隐藏已退完的卡：仅当订单存在已审批退款时按 paid_sessions 有效余量判定（不影响无退款的分期卡）
        sql`(NOT EXISTS (SELECT 1 FROM sale_order_payments sop WHERE sop.sale_order_id = ${saleItems.saleOrderId} AND sop.change_type = '退款' AND sop.status = '已支付') OR ${saleItems.paidSessions} IS NULL OR ${saleItems.paidSessions} > (${saleItems.sessionCount} - ${saleItems.remainingSessions}))`,
      ),
    )

  // 单品合并后 WHERE 仅返回疗程卡行，统一按 remaining_sessions 折抵
  return rows.map((r) => {
    const unit = Number(r.unitRealPrice)
    const remSess = r.remainingSessions ?? 0
    return {
      saleItemId: r.saleItemId,
      saleItemGroupId: r.saleItemGroupId ?? null,
      saleOrderId: r.saleOrderId,
      saleOrderDatetime: r.saleOrderDatetime?.toISOString() ?? null,
      paidAt: r.paidAt?.toISOString() ?? null,
      orderStatus: r.orderStatus,
      saleOrderType: r.saleOrderType,
      documentType: r.documentType,
      marketName: r.marketName,
      legacySource: r.legacySource,
      storeId: r.storeId,
      skuId: r.skuId ?? null,
      itemDirection: r.itemDirection,
      refSaleItemId: r.refSaleItemId ?? null,
      productName: r.productName,
      productType: '疗程卡' as const,
      unit: r.unit ?? '次',
      quantity: r.quantity ?? 1,
      sessionCount: r.sessionCount ?? null,
      remainingSessions: remSess,
      paidSessions: r.paidSessions ?? null,
      remainingQty: null,
      unitPrice: r.unitPrice,
      unitRealPrice: r.unitRealPrice,
      saleAmount: r.saleAmount,
      received: r.received,
      pendingReceived: r.pendingReceived,
      deductibleAmount: (unit * remSess).toFixed(2),
      expireDate: r.expireDate ?? null,
      remark: r.remark ?? null,
      salesCategory: r.salesCategory ?? null,
      pickedUpQuantity: r.pickedUpQuantity ?? null,
      productKind: r.productKind ?? null,
      categoryId: r.categoryId ?? null,
      categoryName: r.categoryName ?? null,
    }
  })
  },
)

// ============================================================================
// 充值档位配置（admin 开单页 PrepaidCardPicker 数据源）
//
// 2026-05-20 充值卡剥离 SKU 化：档位/边界来源从 product_skus 迁到 system_configs。
// admin / staff / client 三端均通过同步读取相同的 system_configs 行保持一致。
// ============================================================================

import { loadRechargeConfig, matchTier, type RechargeTier, type RechargeConfig } from '@/lib/recharge'
import { logOperation } from '@/lib/operation-log'
import { ApiError } from '@/lib/api-error'
import { revalidatePath } from 'next/cache'

/**
 * 充值档位（system_configs 驱动；admin 开单页可选档位）
 */
export interface RechargeCardTier {
  /** 面值 */
  faceValue: number
  /** 实付 */
  payAmount: number
  /** 赠送金额 = faceValue - payAmount */
  bonus: number
  /** 折扣 = payAmount / faceValue */
  discount: number
}

/**
 * 拉 admin 开单页可选的充值档位（system_configs.recharge.tiers 驱动）
 *
 * 权限：复用 sale_order:create —— 开单页 SSR 时一同 fetch。
 */
export const getRechargeCardTiers = withPermission(
  'sale_order:create',
  async (_session): Promise<RechargeCardTier[]> => {
    const cfg = await loadRechargeConfig()
    return cfg.tiers.map((t: RechargeTier) => {
      const discount = t.faceValue > 0 ? Math.round((t.payAmount / t.faceValue) * 100) / 100 : 1
      return {
        faceValue: t.faceValue,
        payAmount: t.payAmount,
        bonus: Math.round((t.faceValue - t.payAmount) * 100) / 100,
        discount,
      }
    })
  },
)

/**
 * 查询顾客充值卡余额（跨店统一；admin 新增开单页"充值卡抵扣"使用）
 *
 * 与 staff customer.customerBalance 同 SQL，使用 prepaid_cards.balance（聚合维护的余额列）。
 * 没有 prepaid_cards 行 / 余额 ≤ 0 → 返回 0。
 *
 * 权限：sale_order:create（开单上下文）
 */
export const getCustomerCardBalance = withPermission(
  'sale_order:create',
  async (_session, clientUserId: string): Promise<number> => {
    if (!clientUserId) return 0
    const rows = await db
      .select({ balance: prepaidCards.balance })
      .from(prepaidCards)
      .where(eq(prepaidCards.userId, clientUserId))
      .limit(1)
    if (!rows.length) return 0
    const n = Number(rows[0].balance)
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0
  },
)

/**
 * 拉充值档位配置（含 minAmount/maxAmount）—— 自建充值页表单实时校验用
 *
 * 与 staff card.rechargeConfig + client card.rechargeConfig 同 shape。
 */
export const getRechargeConfig = withPermission(
  'sale_order:create',
  async (_session): Promise<RechargeConfig> => {
    const cfg = await loadRechargeConfig()
    return {
      tiers: cfg.tiers.map((t: RechargeTier) => ({
        faceValue: t.faceValue,
        payAmount: t.payAmount,
      })),
      minAmount: cfg.minAmount,
      maxAmount: cfg.maxAmount,
    }
  },
)

/**
 * admin 自建充值订单
 *
 * 与 staff card.recharge 同义：
 *   - 校验顾客 + 门店 scope
 *   - 拒绝并发待支付订单
 *   - 事务内 advisory lock → 生成 saleOrderId → INSERT sale_orders type='充值单'，0 sale_items
 *   - total_amount = faceValue，payable_amount = matchTier(faceValue).payAmount
 *
 * paymentMethod 支持 线下 / 微信 / 支付宝：
 *   - 线下：创建后由 admin 在完成页「确认收款」(confirmOfflinePayment) 触发入账
 *   - 微信/支付宝：创建后展示小程序码，顾客扫码支付 → payNotify 回调触发入账
 * 三条路径统一走 applyRechargeOnOrderPaid（UPSERT prepaid_cards.balance += faceValue +
 * INSERT card_transactions(type='充值')，幂等键 card-topup-{saleOrderId}）。
 */
export const createRechargeOrder = withPermission(
  'sale_order:create',
  async (
    session,
    data: {
      clientUserId: string
      storeId: string
      faceValue: number
      paymentMethod: '微信' | '支付宝' | '线下'
      remark?: string | null
    },
  ): Promise<{ success: boolean; message: string; saleOrderId?: string; payAmount?: number }> => {
    if (!data.clientUserId) return { success: false, message: '请选择顾客' }
    if (!data.storeId) return { success: false, message: '请选择入账门店' }
    if (!Number.isFinite(data.faceValue) || data.faceValue <= 0) {
      return { success: false, message: '充值金额无效' }
    }
    if (!['微信', '支付宝', '线下'].includes(data.paymentMethod)) {
      return { success: false, message: '支付方式无效' }
    }
    if (!isInScope(session, data.storeId)) {
      return { success: false, message: '无权在该门店创建充值订单' }
    }

    let payAmount: number
    try {
      const cfg = await loadRechargeConfig()
      const matched = matchTier(data.faceValue, cfg)
      payAmount = matched.payAmount
    } catch (err: any) {
      return { success: false, message: (err?.message || '档位匹配失败').replace(/^[A-Z_]+:\s*/, '') }
    }

    // 顾客 + market_name + documentType 快照
    const [client] = await db
      .select({
        userId: clientWechatUsers.userId,
        name: clientWechatUsers.name,
        phone: clientWechatUsers.phone,
        customerType: clientWechatUsers.customerType,
      })
      .from(clientWechatUsers)
      .where(eq(clientWechatUsers.userId, data.clientUserId))
      .limit(1)
    if (!client) return { success: false, message: '顾客不存在' }
    const documentType: '售前' | '售后' = client.customerType === '会员客' ? '售后' : '售前'

    // 门店 + marketName 快照（与 staff card.recharge 同口径：跨两级 org_nodes 取上级 market）
    const storeRows = (await db.execute(sql`
      SELECT s.store_id, pm.name AS market_name
      FROM stores s
      LEFT JOIN org_nodes sn ON s.org_node_id = sn.id
      LEFT JOIN org_nodes pm ON sn.parent_id = pm.id
      WHERE s.store_id = ${data.storeId}
      LIMIT 1
    `)) as unknown as Array<{ store_id: string; market_name: string | null }>
    if (storeRows.length === 0) return { success: false, message: '入账门店不存在' }
    const marketName = storeRows[0].market_name || ''

    // 拒绝并发待支付订单（uq_sale_orders_client_pending 兜底）
    const existing = await db
      .select({ saleOrderId: saleOrders.saleOrderId })
      .from(saleOrders)
      .where(and(eq(saleOrders.clientUserId, data.clientUserId), eq(saleOrders.status, '待支付')))
      .limit(1)
    if (existing.length > 0) {
      return {
        success: false,
        message: `该顾客已有待支付订单 ${existing[0].saleOrderId}，请先完成或关闭后再充值`,
      }
    }

    // 事务：advisory lock → 生成 saleOrderId → INSERT sale_orders（type='充值单'，0 items）
    let saleOrderId: string
    try {
      saleOrderId = await db.transaction(async (tx) => {
        const idRows = await tx.execute(sql`
          WITH lock AS (
            SELECT pg_advisory_xact_lock(hashtext('sale_order_id_gen')::bigint)
          )
          SELECT 'FY-XSD-WX-' || to_char(NOW(), 'YYMMDD') ||
            LPAD(
              (SELECT COALESCE(MAX(
                CAST(NULLIF(SUBSTRING(sale_order_id FROM '.{4}$'), '') AS INTEGER)
              ), 0) + 1
              FROM sale_orders
              WHERE sale_order_id LIKE 'FY-XSD-WX-' || to_char(NOW(), 'YYMMDD') || '%'
              )::TEXT, 4, '0'
            ) AS id
          FROM lock
        `)
        const id = (idRows as unknown as Array<{ id: string }>)[0]?.id
        if (!id) throw new ApiError('INVALID_STATE', '订单号生成失败')

        await tx.insert(saleOrders).values({
          saleOrderId: id,
          status: '待支付',
          saleOrderType: '充值单',
          documentType,
          marketName,
          storeId: data.storeId,
          storeName: sql<string>`(SELECT store_name FROM stores WHERE store_id = ${data.storeId})`,
          saleOrderDatetime: nowTs(),
          clientUserId: data.clientUserId,
          clientPhone: client.phone || '',
          customerName: client.name || '',
          totalAmount: data.faceValue.toFixed(2),
          prepaidCardAmount: '0',
          payableAmount: payAmount.toFixed(2),
          received: '0',
          firstPaymentAmount: null,
          couponId: null,
          couponDiscount: '0',
          paymentMethod: data.paymentMethod,
          openedBy: session.employeeId,
          preferredEmployeeId: null,
          allocationStatus: '待分配',
          remark: data.remark || null,
          paidAt: null,
        })

        return id
      })
    } catch (err: any) {
      const msg = err?.message || '充值订单创建失败'
      return { success: false, message: msg.replace(/^[A-Z_]+:\s*/, '') }
    }

    await logOperation(session, 'sale_order.create_recharge', 'sale_order', saleOrderId, {
      clientUserId: data.clientUserId,
      storeId: data.storeId,
      faceValue: data.faceValue,
      payAmount,
      paymentMethod: data.paymentMethod,
    })

    revalidatePath('/orders')
    revalidatePath(`/customers/${data.clientUserId}`)

    return { success: true, message: '充值订单已创建', saleOrderId, payAmount }
  },
)
