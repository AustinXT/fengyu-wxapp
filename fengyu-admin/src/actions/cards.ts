'use server'

import { db } from '@/db'
import { saleItems, saleOrders } from '@db/order'
import { productSkus, productCategories } from '@db/product'
import { stores, orgNodes } from '@db/org'
import { clientWechatUsers } from '@db/user'
import { and, desc, eq, gte, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { getSession } from '@/lib/auth'
import { requirePermission, scopeCondition, isInScope } from '@/lib/permissions'

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
  /** 规格名快照 */
  skuSpecName: string | null
  /** 总次数 */
  sessionCount: number | null
  /** 剩余次数 */
  remainingSessions: number | null
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

/** 分页结果 */
export interface PaginatedCards {
  data: AdminCard[]
  total: number
}

/**
 * 服务端分页卡包列表
 *
 * "卡包" = sale_items WHERE product_type='疗程卡' AND item_direction='购买' AND remaining_sessions IS NOT NULL
 *   - session_count = 1  → UI 标记为"单次卡"
 *   - session_count >= 2 → UI 标记为"疗程卡"
 *
 * scope 基于 sale_items.store_id（购买门店），与 PR-A 新增的 store_id 列绑定。
 *
 * 状态判定：
 *   - active:    remaining_sessions > 0 AND (expire_date IS NULL OR expire_date >= CURRENT_DATE)
 *   - exhausted: remaining_sessions = 0
 *   - expired:   expire_date IS NOT NULL AND expire_date < CURRENT_DATE
 */
export async function getCardsPaginated(filters: CardFilters = {}): Promise<PaginatedCards> {
  const session = await getSession()
  requirePermission(session, 'sale_item:list')

  const page = Math.max(1, filters.page || 1)
  const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
  const offset = (page - 1) * pageSize

  const conditions: (SQL | undefined)[] = [
    // 基础过滤：仅购买方向的疗程卡（含余次追踪）
    eq(saleItems.itemDirection, '购买'),
    eq(saleItems.productType, '疗程卡'),
    isNotNull(saleItems.remainingSessions),
    // scope 过滤（admin 返回 undefined；非 admin 按 scopeStoreIds）
    scopeCondition(session, saleItems.storeId),
  ]

  // 市场筛选（subquery：orgNodes.parentId = marketId 下的所有门店节点 → stores）
  if (filters.marketId) {
    const sub = db.select({ storeId: stores.storeId }).from(stores)
      .innerJoin(orgNodes, eq(stores.orgNodeId, orgNodes.id))
      .where(eq(orgNodes.parentId, filters.marketId))
    conditions.push(inArray(saleItems.storeId, sub))
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
  // 顾客姓名/手机号搜索（ILIKE 命中被 JOIN 的 clientWechatUsers 列）
  if (filters.search) {
    const escaped = filters.search.replace(/[%_]/g, '\\$&')
    const pattern = `%${escaped}%`
    conditions.push(
      or(
        ilike(clientWechatUsers.name, pattern),
        ilike(clientWechatUsers.phone, pattern),
      ),
    )
  }

  const whereClause = and(...conditions)

  // 市场名称标量子查询（参考 customers.ts 范式）
  const marketNameExpr = sql<string | null>`(
    SELECT n.name FROM stores s
    JOIN org_nodes sn ON sn.id = s.org_node_id
    JOIN org_nodes n ON n.id = sn.parent_id
    WHERE s.store_id = ${saleItems.storeId}
  )`.as('market_name')

  // COUNT 查询（同样需要 JOIN clientWechatUsers 因为 search 命中该表列）
  const countQuery = db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(saleItems)
    .leftJoin(saleOrders, eq(saleItems.saleOrderId, saleOrders.saleOrderId))
    .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
    .where(whereClause)

  // DATA 查询
  const dataQuery = db
    .select({
      saleItemId: saleItems.saleItemId,
      saleOrderId: saleItems.saleOrderId,
      productName: saleItems.productName,
      skuSpecName: saleItems.skuSpecName,
      sessionCount: saleItems.sessionCount,
      remainingSessions: saleItems.remainingSessions,
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
      skuSpecName: r.skuSpecName ?? null,
      sessionCount: r.sessionCount ?? null,
      remainingSessions: r.remainingSessions ?? null,
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
}

// ============================================================================
// 转换单候选卡（PR-A 新增）
// ============================================================================

/**
 * 转换单候选卡 — 顾客在指定门店可折抵的购买行。
 *
 * 来源口径：sale_items 上 item_direction='购买'，且归属该顾客（通过 sale_orders
 * 反向 JOIN client_user_id）、归属指定 store_id；状态为"已支付/已完成"的订单。
 *
 * 两类折抵对象：
 *   1. 疗程卡 (product_type='疗程卡') AND remaining_sessions > 0
 *   2. 单品 (product_type='单品') AND product_category.product_kind='体验卡'
 *      AND quantity - COALESCE(picked_up_quantity,0) > 0
 *
 * 不包含：充值卡（走 prepaid_cards 账户，不在 sale_items 行）、家居产品（不在业务口径内）
 */
export interface HeldCardCandidate {
  saleItemId: string
  productName: string | null
  skuSpecName: string | null
  productType: '疗程卡' | '单品' | '家居产品'
  /** 剩余次数（疗程卡）；单品返回 null */
  remainingSessions: number | null
  /** 剩余可提货数量（单品）；疗程卡返回 null */
  remainingQty: number | null
  unitRealPrice: string
  /** 折抵金额 = unitRealPrice × (疗程卡:remainingSessions | 单品:remainingQty) */
  deductibleAmount: string
}

export async function getCustomerHeldCards(
  clientUserId: string,
  storeId: string,
): Promise<HeldCardCandidate[]> {
  const session = await getSession()
  requirePermission(session, 'sale_order:list')

  if (!clientUserId || !storeId) return []
  // scope 校验：admin 可全量，其余角色需 storeId 在 scope 内
  if (!isInScope(session, storeId)) return []

  const rows = await db
    .select({
      saleItemId: saleItems.saleItemId,
      productName: saleItems.productName,
      skuSpecName: saleItems.skuSpecName,
      productType: saleItems.productType,
      remainingSessions: saleItems.remainingSessions,
      quantity: saleItems.quantity,
      pickedUpQuantity: saleItems.pickedUpQuantity,
      unitRealPrice: saleItems.unitRealPrice,
      productKind: productCategories.productKind,
    })
    .from(saleItems)
    .innerJoin(saleOrders, eq(saleItems.saleOrderId, saleOrders.saleOrderId))
    .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
    .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
    .where(
      and(
        eq(saleItems.storeId, storeId),
        eq(saleOrders.clientUserId, clientUserId),
        eq(saleItems.itemDirection, '购买'),
        or(eq(saleOrders.status, '已支付'), eq(saleOrders.status, '已完成')),
        or(
          and(
            eq(saleItems.productType, '疗程卡'),
            sql`COALESCE(${saleItems.remainingSessions}, 0) > 0`,
          ),
          and(
            eq(saleItems.productType, '单品'),
            eq(productCategories.productKind, '体验卡'),
            sql`${saleItems.quantity} - COALESCE(${saleItems.pickedUpQuantity}, 0) > 0`,
          ),
        ),
      ),
    )

  return rows.map((r) => {
    const unit = Number(r.unitRealPrice)
    if (r.productType === '疗程卡') {
      const remSess = r.remainingSessions ?? 0
      return {
        saleItemId: r.saleItemId,
        productName: r.productName,
        skuSpecName: r.skuSpecName,
        productType: '疗程卡' as const,
        remainingSessions: remSess,
        remainingQty: null,
        unitRealPrice: r.unitRealPrice,
        deductibleAmount: (unit * remSess).toFixed(2),
      }
    }
    const remQty = r.quantity - (r.pickedUpQuantity ?? 0)
    return {
      saleItemId: r.saleItemId,
      productName: r.productName,
      skuSpecName: r.skuSpecName,
      productType: r.productType as HeldCardCandidate['productType'],
      remainingSessions: null,
      remainingQty: remQty,
      unitRealPrice: r.unitRealPrice,
      deductibleAmount: (unit * remQty).toFixed(2),
    }
  })
}
