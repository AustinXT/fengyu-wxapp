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
import { homeDeductible } from '@/lib/home-product'
import {
  offsetPageResult,
  resolveExportOffsetPage,
  type ExportBatchOptions,
  type ExportBatchResult,
} from '@/lib/export-pagination'
import { paidUnusedSessionsExpr } from '@/lib/paid-sessions'
import {
  CARD_ENTITLEMENT_ORDER_STATUSES,
  cardBaseConditions,
  cardEntitlementDirectionCondition,
  cardNotFullyRefundedCondition,
} from '@/lib/card-entitlement'
import { computeItemOverpayRemainders, type RefundSourceItem } from '@/lib/refund'
import { storeInMarketCondition } from '@/lib/market-store-sql'
import { getPointsToYuanRate, getPointsDeductionMaxRate } from '@/lib/system-config'
import { classifySaleOrderDocumentType } from '@/lib/document-type'
import { resolvePaging } from '@/lib/paging'

// ============================================================================
// 管理端卡包列表（/cards 页面）
// ============================================================================

/** 卡类型（UI segmented） */
export type CardTypeFilter = 'all' | '疗程卡' | '单次卡'

/** 状态（UI 下拉） */
export type CardStatusFilter = 'active' | 'exhausted' | 'expired'

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
  /** 可用次数（已付未用）；paid_sessions 为 NULL 时退回物理剩余，否则 max(paid − used, 0)；可用 0 的欠款卡也在列表内（issue #122） */
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
  /**
   * #182：已被转换单折走的金额。折抵会带走 overpay 余数且不动 remaining_sessions，
   * 不传这一项，卡包/顾客持卡/导出的「剩余零头」列会继续展示已经被折走的钱。
   * 调用方未提供时按 0（旧行为），但列表类查询都应带上转出行聚合。
   */
  convertedAmount?: string | number | null
  /** #182：已折走的**次数**。必须先按次数扣减再加金额，否则与 (sc − rem) 双计。 */
  convertedQuantity?: number | null
}): number {
  const source: RefundSourceItem = {
    sale_item_id: item.saleItemId,
    sku_id: null,
    product_name: null,
    product_type: '疗程卡',
    // 疗程卡不走家居数量链路，已退款件数恒 0（#154 起 RefundSourceItem 要求显式给出）；
    // converted_quantity 不在这里给 0 —— 下方用转出行聚合值，疗程卡的已转走次数必须算进去。
    refunded_quantity: 0,
    session_count: item.sessionCount,
    remaining_sessions: item.remainingSessions,
    paid_sessions: item.paidSessions,
    unit_price: 0,
    quantity: 1,
    unit_real_price: item.unitRealPrice ?? 0,
    received: item.received,
    picked_up_quantity: 0,
    picked_quantity: null,
    converted_amount: item.convertedAmount ?? null,
    converted_quantity: item.convertedQuantity ?? 0,
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

function buildCardBaseConditions(
  session: Parameters<typeof scopeCondition>[0],
): (SQL | undefined)[] {
  return [
    // 权益方向 + 有效订单状态 + 疗程卡 + 余次不为空（lib/card-entitlement.ts，与数据中心剩余卡项清单共用）
    ...cardBaseConditions(),
    // issue #122：移除原本的 `paid_sessions > 0` —— 它会把部分支付的欠款卡整行隐藏，
    // 顾客买了卡却在卡包里查无此卡。基础集不再按次数过滤（"是否已用完"交给 status 分支，
    // exhausted 要的正是 remaining_sessions = 0，基础集若先排掉它会让该筛选恒空、卡详情 404）。
    // 可用次数仍由 paidUnusedSessionsExpr 算出并展示为 0，核销限额走 service 侧独立校验。
    // 已退款的卡由 paid_sessions 口径在 service 侧挡住，不在本列表口径内。
    // scope 过滤（admin 返回 undefined；非 admin 按 scopeStoreIds）
    scopeCondition(session, saleItems.storeId),
  ]
}

/**
 * 构建卡包 WHERE 条件（列表分页与导出共用，单一真源防漂移）。
 * 基础过滤：权益方向 + 有效订单状态 + 疗程卡 + 余次不为空 + scope（不按次数过滤，见 issue #122）。
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
  const { page, pageSize, offset } = resolvePaging({
    page: filters.page,
    pageSize: filters.pageSize,
    defaultPageSize: 20,
    allowedPageSizes: [10, 20, 50],
  })

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
      // #182：折抵会带走 overpay 余数，「剩余零头」列必须扣掉已转走金额与次数，
      // 否则展示的是已被折走的钱（次数不先扣会与 (sc − rem) 双计）
      convertedQuantity: sql<number>`COALESCE((SELECT SUM(out_item.quantity) FROM sale_items out_item JOIN sale_orders conv_order ON conv_order.sale_order_id = out_item.sale_order_id WHERE out_item.ref_sale_item_id = ${saleItems.saleItemId} AND out_item.item_direction = '转出' AND conv_order.status <> '已关闭'), 0)::int`,
      convertedAmount: sql<string>`COALESCE((SELECT SUM(GREATEST(0, -out_item.received::numeric)) FROM sale_items out_item JOIN sale_orders conv_order ON conv_order.sale_order_id = out_item.sale_order_id WHERE out_item.ref_sale_item_id = ${saleItems.saleItemId} AND out_item.item_direction = '转出' AND conv_order.status <> '已关闭'), 0)`,
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
    // ⚠️ 末位 tie-break 用 **asc** 而非 desc —— 必须与导出侧（本文件 `exportCards`）
    // 的 `asc(saleItems.saleItemId)` 同向，否则 paid_at + created_at 都并列的那几行，
    // 页面上的顺序与导出 CSV 相反，对账逐行比对会在每个并列组上错位。
    // 这也是本仓既有约定（employees.ts / coupons.ts 的 `desc, desc, asc(pk)`）。
    .orderBy(desc(saleOrders.paidAt), desc(saleItems.createdAt), asc(saleItems.saleItemId))
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
      remainingRemainder: computeCardRemainingRemainder({ ...r, convertedQuantity: Number(r.convertedQuantity ?? 0) }),
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
        // #182：折抵会带走 overpay 余数，「剩余零头」列必须扣掉已转走金额，否则展示的是已被折走的钱
        // #182：次数也要，先按次数扣减再加金额，否则与 (sc − rem) 双计
        convertedQuantity: sql<number>`COALESCE((SELECT SUM(out_item.quantity) FROM sale_items out_item JOIN sale_orders conv_order ON conv_order.sale_order_id = out_item.sale_order_id WHERE out_item.ref_sale_item_id = ${saleItems.saleItemId} AND out_item.item_direction = '转出' AND conv_order.status <> '已关闭'), 0)::int`,
        convertedAmount: sql<string>`COALESCE((SELECT SUM(GREATEST(0, -out_item.received::numeric)) FROM sale_items out_item JOIN sale_orders conv_order ON conv_order.sale_order_id = out_item.sale_order_id WHERE out_item.ref_sale_item_id = ${saleItems.saleItemId} AND out_item.item_direction = '转出' AND conv_order.status <> '已关闭'), 0)`,
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
        remainingRemainder: computeCardRemainingRemainder({ ...r, convertedQuantity: Number(r.convertedQuantity ?? 0) }),
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
 *   家居产品 (product_type='家居产品')：可折抵件数 > 0（#145/#153 收紧）
 *   —— 以「剩余已付金额 = 行实收 − 已提货金额 − 已转走金额」为基准，件数 = floor(剩余已付 / 单价)、
 *      受物理未结算件数封顶；金额 = 剩余已付（含不足一整件的余数）。
 *      寄存单与 0 元赠品行无「实收」可言，维持 单价 × 未结算件数。口径见 lib/home-product.ts::homeDeductible。
 *
 * 不包含：充值卡（走 prepaid_cards 账户，不在 sale_items 行）
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
  /** 折抵金额：疗程卡 = unitRealPrice × remainingSessions；家居产品 = unitRealPrice × remainingQty（未提货数量，#125） */
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
      refundedQuantity: saleItems.refundedQuantity,
      convertedQuantity: saleItems.convertedQuantity,
      // #145/#153 家居折抵额度的**金额**项（件数自 #154 起直读上面三列，不再聚合 pickup_records）。
      // 金额仍须从转出行 received 聚合：折 4 件可能带走 ¥450 而非 ¥400（与 staff LATERAL 同源）。
      // #182 **不限 out_item.product_type**：疗程卡的已转走金额同样要扣，
      // 纯余数转出行（quantity=0）也必须计入，限类型会让同一笔已付被折两遍。
      homeConvertedAmount: sql`COALESCE((SELECT SUM(GREATEST(0, -out_item.received::numeric)) FROM sale_items out_item JOIN sale_orders conv_order ON conv_order.sale_order_id = out_item.sale_order_id WHERE out_item.ref_sale_item_id = ${saleItems.saleItemId} AND out_item.item_direction = '转出' AND conv_order.status <> '已关闭'), 0)`,
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
        // 2026-09-14 #125 甲方拍板：订单级「部分支付」也可折抵；与卡包列表共用同一组状态，
        // 疗程卡与家居同时放开，欠款按方案 A 留原单
        inArray(saleOrders.status, [...CARD_ENTITLEMENT_ORDER_STATUSES]),
        // 2026-05-21 单品合并：折抵对象统一为疗程卡（含原"体验卡单品"=1 次卡）；#125 引入家居折抵。
        // #182 改**金额口径**：疗程卡与家居统一按「剩余已付」放行，只要还有已付的钱就能折，
        // 不再要求凑满一整次/一整件——件数门槛曾把「1 件 ¥680 只付 ¥594」整行剔除
        // （prod 3 行 ¥814），顾客的钱既折不掉也提不出。与 staff customerHeldCards 的 hp LATERAL 同源。
        inArray(saleItems.productType, ['疗程卡', '家居产品']),
        // 寄存单 / 0 元赠品行没有「实收」：它们的折抵额 = 单价 × 权益，而赠品单价为 0 → 恒 0，
        // 用金额门会把整行**静默剔除**（旧闸门 remaining_sessions > 0 是放行的）。故这两类按
        // **权益**放行、其余按**金额**放行；createConversionOrder 的锁内闸门必须逐字同口径。
        // #154：家居的「未结算件数」必须减三列之和。只减 picked_up 会让整行退款/整行折抵过的
        // 寄存单与 0 元赠品家居行重新通过本闸门、在候选列表里复活；「已提货金额」的件数因子
        // 同理直读 picked_up_quantity 列（#154 保证它恒等于 SUM(pickup_records)）。
        sql`(
          CASE WHEN ${saleOrders.saleOrderType} = '寄存单' OR ${saleItems.saleAmount} <= 0
               THEN (
                 CASE WHEN ${saleItems.productType} = '疗程卡'
                      THEN COALESCE(${saleItems.remainingSessions}, 0)
                      ELSE GREATEST(0, ${saleItems.quantity} - (COALESCE(${saleItems.pickedUpQuantity}, 0) + COALESCE(${saleItems.refundedQuantity}, 0) + COALESCE(${saleItems.convertedQuantity}, 0)))
                 END
               )
               ELSE GREATEST(0, ${saleItems.received}::numeric
                 - CASE WHEN ${saleItems.productType} = '疗程卡'
                        THEN GREATEST(0, COALESCE(${saleItems.sessionCount}, 0) - COALESCE(${saleItems.remainingSessions}, 0))::numeric * ${saleItems.unitRealPrice}::numeric
                        ELSE COALESCE(${saleItems.pickedUpQuantity}, 0) * ${saleItems.unitRealPrice}::numeric
                   END
                 - COALESCE((SELECT SUM(GREATEST(0, -out_item.received::numeric)) FROM sale_items out_item JOIN sale_orders conv_order ON conv_order.sale_order_id = out_item.sale_order_id WHERE out_item.ref_sale_item_id = ${saleItems.saleItemId} AND out_item.item_direction = '转出' AND conv_order.status <> '已关闭'), 0)
               )
          END
        ) > 0`,
        // 在途退款冻结：原订单存在 '待审批' 退款时排除整单的卡（与 staff customerHeldCards 对齐）
        sql`NOT EXISTS (SELECT 1 FROM sale_order_payments sop WHERE sop.sale_order_id = ${saleItems.saleOrderId} AND sop.change_type = '退款' AND sop.status = '待审批')`,
        // 审批后隐藏已退完的卡：仅当订单存在已审批退款时按 paid_sessions 有效余量判定（不影响无退款的分期卡）
        // 家居产品不适用：已退数量落 refunded_quantity（#154 拆列前并入 picked_up_quantity），
        // 而未结算件数 = quantity − 已提货 − 已退款 − 已转换，天然已扣除
        cardNotFullyRefundedCondition(),
      ),
    )

  // #182：折抵 = 整行退出。数量带走该行全部剩余权益（疗程卡剩余次数 / 家居未结算件数），
  // 金额只折「剩余已付」。注意**件数与提货口径就此分家**：提货仍要按 floor(剩余已付/单价)
  // 一件件付满才放行，而折抵把物理件与已付金额一并清空，守恒仍成立
  // （折后可提 = min(0, …) = 0）。homeDeductible 的 quantity 是提货口径，这里只取它的 amount。
  return rows.map((r) => {
    const isHomeProduct = r.productType === '家居产品'
    const remSess = r.remainingSessions ?? 0
    const home = homeDeductible({
      saleOrderType: r.saleOrderType,
      quantity: r.quantity ?? 0,
      pickedUpQuantity: r.pickedUpQuantity ?? 0,
      refundedQuantity: r.refundedQuantity ?? 0,
      convertedQuantity: r.convertedQuantity ?? 0,
      convertedAmount: r.homeConvertedAmount as string | number | null,
      saleAmount: r.saleAmount,
      received: r.received,
      unitRealPrice: r.unitRealPrice,
    })
    // 全程按「分」整除，与 staff 侧 numeric 运算对齐（浮点直除会与 PG 分叉）
    const toCents = (v: unknown) => Math.round((Number(v ?? 0) || 0) * 100)
    const isDepositOrGift = r.saleOrderType === '寄存单' || Number(r.saleAmount ?? 0) <= 0
    const cardDeliveredCents = Math.max(0, (r.sessionCount ?? 0) - remSess) * toCents(r.unitRealPrice)
    const cardRemainingPaidCents = Math.max(
      0,
      toCents(r.received) - cardDeliveredCents - toCents(r.homeConvertedAmount),
    )
    const cardAmount = isDepositOrGift
      ? (toCents(r.unitRealPrice) * remSess) / 100
      : cardRemainingPaidCents / 100
    // #154：家居「未结算件数」= quantity − (已提货 + 已退款 + 已转换)。只减 picked_up 会把
    // 已退款/已转换过的件数当成还能折走，折抵会撞 chk_sale_item_settled_le_quantity 或超卖。
    const remainingQty = isHomeProduct
      ? Math.max(0, (r.quantity ?? 0)
          - ((r.pickedUpQuantity ?? 0) + (r.refundedQuantity ?? 0) + (r.convertedQuantity ?? 0)))
      : remSess
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
      productType: isHomeProduct ? ('家居产品' as const) : ('疗程卡' as const),
      unit: r.unit ?? (isHomeProduct ? '盒' : '次'),
      quantity: r.quantity ?? 1,
      sessionCount: r.sessionCount ?? null,
      remainingSessions: isHomeProduct ? null : remSess,
      paidSessions: r.paidSessions ?? null,
      // #182：疗程卡也给出「可折抵数量」（= 注销的次数），与 staff remaining_quantity 对齐
      remainingQty,
      unitPrice: r.unitPrice,
      unitRealPrice: r.unitRealPrice,
      saleAmount: r.saleAmount,
      received: r.received,
      pendingReceived: r.pendingReceived,
      deductibleAmount: (isHomeProduct ? home.amount : cardAmount).toFixed(2),
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
import { businessErrorMessage } from '@/lib/action-error'
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

export interface CustomerPointsBalance {
  pointsBalance: number
  pointsToYuanRate: number
  pointsDeductionMaxRate: number
}

/**
 * 查询顾客积分余额与抵扣配置（admin 开单页使用）。
 *
 * 权限：sale_order:create（开单上下文）
 */
export const getCustomerPointsBalance = withPermission(
  'sale_order:create',
  async (_session, clientUserId: string): Promise<CustomerPointsBalance> => {
    const [pointsToYuanRate, pointsDeductionMaxRate] = await Promise.all([
      getPointsToYuanRate(),
      getPointsDeductionMaxRate(),
    ])
    if (!clientUserId) {
      return { pointsBalance: 0, pointsToYuanRate, pointsDeductionMaxRate }
    }
    const rows = await db
      .select({ pointsBalance: clientWechatUsers.pointsBalance })
      .from(clientWechatUsers)
      .where(eq(clientWechatUsers.userId, clientUserId))
      .limit(1)
    const n = Number(rows[0]?.pointsBalance ?? 0)
    return {
      pointsBalance: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0,
      pointsToYuanRate,
      pointsDeductionMaxRate,
    }
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
      return { success: false, message: businessErrorMessage(err, '档位匹配失败') }
    }

    // 顾客 + market_name 快照；documentType 在创建事务内按历史达标次数计算。
    const [client] = await db
      .select({
        userId: clientWechatUsers.userId,
        name: clientWechatUsers.name,
        phone: clientWechatUsers.phone,
      })
      .from(clientWechatUsers)
      .where(eq(clientWechatUsers.userId, data.clientUserId))
      .limit(1)
    if (!client) return { success: false, message: '顾客不存在' }
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
        const documentType = await classifySaleOrderDocumentType(tx, data.clientUserId, id)

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
      // fail-closed：非白名单前缀的原始 PG 报错（SQL 片段 / 约束名）绝不回传给前端 toast（issue #133）
      return { success: false, message: businessErrorMessage(err, '充值订单创建失败') }
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
