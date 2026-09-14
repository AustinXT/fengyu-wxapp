'use server'

import { db } from '@/db'
import { clientWechatUsers, staffWechatUsers } from '@db/user'
import { saleOrders } from '@db/order'
import { stores, orgNodes } from '@db/org'
import { eq, and, or, desc, asc, inArray, sql, ilike, isNotNull, getTableColumns } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { Customer, SaleOrder, SaleItem, Appointment, AuthSession, CustomerCoupon, CouponType, CouponStatus } from '@/lib/types'
import { scopeCondition, isAdminScope, isInScope, requireAdmin } from '@/lib/permissions'
import { hasRole } from '@/lib/auth'
import { withPermission } from '@/lib/with-permission'
import { logOperation, logUpdate } from '@/lib/operation-log'
import { pgErrorCode } from '@/lib/pg-error'
import { fmtDate } from '@/lib/datetime'
import {
  offsetPageResult,
  resolveExportOffsetPage,
  type ExportBatchOptions,
  type ExportBatchResult,
} from '@/lib/export-pagination'
import { storeInMarketCondition } from '@/lib/market-store-sql'
import { deriveHomeProductStatus, type CustomerHomeProduct } from '@/lib/home-product'

const WORKFINE_OVERRIDE_FIELD_MAP = {
  customerSource: 'customer_source',
  birthday: 'birthday',
  occupation: 'occupation',
  isMarried: 'is_married',
  skinIssue: 'skin_issue',
  wellnessPreference: 'wellness_preference',
} as const

// 标量子查询 — 替代 3 个 LEFT JOIN（stores → storeNode → marketNode）
const storeName = sql<string | null>`(
  SELECT s.store_name FROM stores s WHERE s.store_id = ${clientWechatUsers.boundStoreId}
)`.as('store_name')

const marketName = sql<string | null>`(
  SELECT n.name FROM stores s
  JOIN org_nodes sn ON sn.id = s.org_node_id
  JOIN org_nodes n ON n.id = sn.parent_id
  WHERE s.store_id = ${clientWechatUsers.boundStoreId}
)`.as('market_name')

const inviterName = sql<string | null>`(
  SELECT inviter.name FROM client_wechat_users inviter
  WHERE inviter.user_id = ${clientWechatUsers.inviterUserId}
)`.as('inviter_name')

const inviterPhone = sql<string | null>`(
  SELECT inviter.phone FROM client_wechat_users inviter
  WHERE inviter.user_id = ${clientWechatUsers.inviterUserId}
)`.as('inviter_phone')

const promoterCurrentNameSql = sql<string | null>`(
  SELECT promoter.name FROM staff_wechat_users promoter
  WHERE promoter.employee_id = ${clientWechatUsers.promoterEmployeeId}
)`
const promoterCurrentName = promoterCurrentNameSql.as('promoter_current_name')

const customerColumns = {
  ...getTableColumns(clientWechatUsers),
  storeName,
  marketName,
  inviterName,
  inviterPhone,
  promoterCurrentName,
}

type CustomerRow = typeof clientWechatUsers.$inferSelect & {
  storeName: string | null
  marketName: string | null
  inviterName: string | null
  inviterPhone: string | null
  promoterCurrentName: string | null
}

function serializeCustomer(row: CustomerRow): Customer {
  return {
    userId: row.userId,
    openid: row.openid,
    phone: row.phone,
    customerId: row.customerId,
    name: row.name,
    gender: row.gender,
    boundStoreId: row.boundStoreId,
    boundEmployeeId: row.boundEmployeeId,
    isCrossStoreTemp: row.isCrossStoreTemp,
    memberLevel: row.memberLevel,
    becameMemberAt: row.becameMemberAt ? row.becameMemberAt.toISOString() : null,
    memberLevelUpgradedAt: row.memberLevelUpgradedAt ? row.memberLevelUpgradedAt.toISOString() : null,
    memberLevelLockedUntil: row.memberLevelLockedUntil ? row.memberLevelLockedUntil.toISOString() : null,
    customerSource: row.customerSource,
    promoterEmployeeId: row.promoterEmployeeId,
    promoterEmployeeName: row.promoterCurrentName ?? row.promoterEmployeeName,
    inviterUserId: row.inviterUserId,
    inviterName: row.inviterName,
    inviterPhone: row.inviterPhone,
    invitedAt: row.invitedAt ? row.invitedAt.toISOString() : null,
    customerType: row.customerType,
    spendingTier: row.spendingTier,
    monthlyActivity: row.monthlyActivity,
    customerStatus: row.customerStatus,
    birthday: row.birthday,
    occupation: row.occupation,
    isMarried: row.isMarried,
    wechatName: row.wechatName,
    skinType: row.skinType,
    improvementFocus: row.improvementFocus,
    skinIssue: row.skinIssue,
    wellnessPreference: row.wellnessPreference,
    notes: row.notes,
    pointsBalance: row.pointsBalance,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    storeName: row.storeName ?? undefined,
    employeeName: row.boundEmployeeName ?? undefined,
    marketName: row.marketName ?? undefined,
  }
}

/** 推荐员工当前姓名优先，关联失效或旧 client 仅写快照时回退历史姓名。 */
const promoterName = sql<string | null>`COALESCE(${promoterCurrentNameSql}, ${clientWechatUsers.promoterEmployeeName})`

/** 顾客导出取数列（12 表头所需字段 + storeName + promoterName） */
const exportCustomerColumns = {
  userId: clientWechatUsers.userId,
  name: clientWechatUsers.name,
  phone: clientWechatUsers.phone,
  customerType: clientWechatUsers.customerType,
  memberLevel: clientWechatUsers.memberLevel,
  spendingTier: clientWechatUsers.spendingTier,
  customerStatus: clientWechatUsers.customerStatus,
  customerSource: clientWechatUsers.customerSource,
  birthday: clientWechatUsers.birthday,
  boundEmployeeName: clientWechatUsers.boundEmployeeName,
  storeName,
  promoterName,
}

export const searchCustomerByPhone = withPermission(
  'customer:list',
  async (_session, phone: string): Promise<Customer | null> => {
  const rows = await db
    .select(customerColumns)
    .from(clientWechatUsers)
    .where(eq(clientWechatUsers.phone, phone))
    .limit(1)

  if (rows.length === 0) return null
  return serializeCustomer(rows[0])
  },
)

/**
 * 模糊搜索顾客 — 按姓名或手机号 ILIKE 匹配，返回最多 20 条结果。
 * 用于开单页面的顾客搜索。
 */
export const searchCustomers = withPermission(
  'customer:list',
  async (session, keyword: string): Promise<Customer[]> => {
  const trimmed = keyword.trim()
  if (!trimmed) return []

  const pattern = `%${trimmed}%`
  const rows = await db
    .select(customerColumns)
    .from(clientWechatUsers)
    .where(
      and(
        // 本门店已绑定顾客 ∪ 标记临时跨店的外门店顾客（需求21：跨门店临时绑定）
        or(
          and(
            scopeCondition(session, clientWechatUsers.boundStoreId),
            isNotNull(clientWechatUsers.boundStoreId),
          ),
          eq(clientWechatUsers.isCrossStoreTemp, true),
        ),
        or(
          ilike(clientWechatUsers.name, pattern),
          ilike(clientWechatUsers.phone, pattern),
        ),
      ),
    )
    // 例外：picker 字母序
    .orderBy(asc(clientWechatUsers.name))
    .limit(20)

  return rows.map(serializeCustomer)
  },
)

export const getCustomers = withPermission(
  'customer:list',
  async (session): Promise<Customer[]> => {
  // admin 不碰顾客数据（规范约束），但 scopeCondition 会返回 undefined（无过滤）
  // 非 admin 角色按 boundStoreId scope 过滤
  const rows = await db
    .select(customerColumns)
    .from(clientWechatUsers)
    .where(scopeCondition(session, clientWechatUsers.boundStoreId))
    // 例外：picker 字母序
    .orderBy(asc(clientWechatUsers.name))

  return rows.map(serializeCustomer)
  },
)

/** 顾客列表筛选参数 */
export interface CustomerFilters {
  marketId?: string
  storeId?: string
  memberLevel?: string
  customerSource?: string
  customerType?: string
  spendingTier?: string
  monthlyActivity?: string
  customerStatus?: string
  search?: string
  page?: number
  pageSize?: number
}

/** URL searchParams → CustomerFilters（列表/导出入参解析单一来源，与 page.tsx 共用） */
// 注：实际实现已迁出到 `@/lib/list-filters.ts` 的 `parseCustomerFilters`，
// 与 `parseOrderFilters` / `parseServiceOrderFilters` / `parseCardFilters` 同处一处，
// 避免 page.tsx 与 action 间出现筛选映射漂移。
import { parseCustomerFilters } from '@/lib/list-filters'

/** 构建顾客列表/导出共用 WHERE 条件（scope + 8 筛选维度 + 姓名/手机号搜索） */
function buildCustomerConditions(
  session: AuthSession,
  filters: CustomerFilters,
): (SQL | undefined)[] {
  const conditions: (SQL | undefined)[] = [
    scopeCondition(session, clientWechatUsers.boundStoreId),
  ]

  if (filters.marketId) {
    conditions.push(storeInMarketCondition(clientWechatUsers.boundStoreId, filters.marketId))
  }
  if (filters.storeId) {
    conditions.push(eq(clientWechatUsers.boundStoreId, filters.storeId))
  }
  if (filters.memberLevel) {
    conditions.push(eq(clientWechatUsers.memberLevel, filters.memberLevel as typeof clientWechatUsers.memberLevel.enumValues[number]))
  }
  if (filters.customerSource) {
    conditions.push(eq(clientWechatUsers.customerSource, filters.customerSource as typeof clientWechatUsers.customerSource.enumValues[number]))
  }
  if (filters.customerType) {
    conditions.push(eq(clientWechatUsers.customerType, filters.customerType as typeof clientWechatUsers.customerType.enumValues[number]))
  }
  if (filters.spendingTier) {
    conditions.push(eq(clientWechatUsers.spendingTier, filters.spendingTier as typeof clientWechatUsers.spendingTier.enumValues[number]))
  }
  if (filters.monthlyActivity) {
    conditions.push(eq(clientWechatUsers.monthlyActivity, filters.monthlyActivity as typeof clientWechatUsers.monthlyActivity.enumValues[number]))
  }
  if (filters.customerStatus) {
    conditions.push(eq(clientWechatUsers.customerStatus, filters.customerStatus as typeof clientWechatUsers.customerStatus.enumValues[number]))
  }
  if (filters.search) {
    const pattern = `%${filters.search}%`
    conditions.push(
      or(
        ilike(clientWechatUsers.name, pattern),
        ilike(clientWechatUsers.phone, pattern),
      ),
    )
  }

  return conditions
}

/** 分页结果 */
export interface PaginatedCustomers {
  data: Customer[]
  total: number
}

/**
 * 服务端分页顾客列表 — DB 级过滤 + LIMIT/OFFSET
 *
 * scope 基于 boundStoreId（顾客归属门店）。
 * 搜索支持：姓名、手机号（ILIKE）。
 */
export const getCustomersPaginated = withPermission(
  'customer:list',
  async (session, filters: CustomerFilters = {}): Promise<PaginatedCustomers> => {
  const page = Math.max(1, filters.page || 1)
  const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
  const offset = (page - 1) * pageSize

  const whereClause = and(...buildCustomerConditions(session, filters))

  const [[countRow], rows] = await Promise.all([
    db.select({ count: sql<number>`cast(count(*) as int)` })
      .from(clientWechatUsers)
      .where(whereClause),
    db.select(customerColumns)
      .from(clientWechatUsers)
      .where(whereClause)
      // 例外：picker 字母序
      .orderBy(asc(clientWechatUsers.name))
      .limit(pageSize)
      .offset(offset),
  ])

  return {
    data: rows.map(serializeCustomer),
    total: countRow?.count ?? 0,
  }
  },
)

/** 顾客导出行（对应 12 列表头） */
export interface ExportCustomerRow {
  name: string | null
  phone: string | null
  storeName: string | null
  customerType: string
  memberLevel: string | null
  spendingTier: string
  customerStatus: string | null
  employeeName: string | null
  /** 累计消费（spending_tier 口径，与「消费档位」列自洽） */
  totalSpend: string
  promoterName: string | null
  customerSource: string | null
  birthday: string | null
}

/**
 * 导出顾客（全部筛选命中，跨分页）。
 *
 * 累计消费口径 = refresh-spending-tier.ts 的 spending_tier 分桶原值：
 *   SUM(GREATEST(received - refunded_amount, 0)) FILTER (WHERE sale_order_type IN ('销售单','转换单'))
 * 含 WorkFine 历史单、不限支付状态，故数值与「消费档位」列严格对应。
 * 推荐人 = 关联员工当前姓名；关联失效或旧 client 仅写姓名时回退快照。
 */
export const exportCustomers = withPermission(
  'customer:list',
  async (
    session,
    params: Record<string, string | undefined>,
    options?: ExportBatchOptions,
  ): Promise<ExportBatchResult<ExportCustomerRow>> => {
    const filters = parseCustomerFilters(params)
    const whereClause = and(...buildCustomerConditions(session, filters))
    const page = resolveExportOffsetPage(options)

    const query = db
      .select(exportCustomerColumns)
      .from(clientWechatUsers)
      .where(whereClause)
      // 例外：picker 字母序（与列表一致）；userId 让 worker 分页在同名顾客下保持稳定。
      .orderBy(asc(clientWechatUsers.name), asc(clientWechatUsers.userId))
    const dataRows = page
      ? await query.limit(page.limit + 1).offset(page.offset)
      : await query

    const userIds = dataRows.map((r) => r.userId)

    // 批量补查累计消费（spending_tier 口径，1 次聚合避免 N+1）
    const spendMap = new Map<string, string>()
    if (userIds.length > 0) {
      const spendRows = await db
        .select({
          clientUserId: saleOrders.clientUserId,
          total: sql<string>`COALESCE(SUM(GREATEST((received::numeric) - (refunded_amount::numeric), 0)) FILTER (WHERE sale_order_type IN ('销售单','转换单')), 0)::text`,
        })
        .from(saleOrders)
        .where(inArray(saleOrders.clientUserId, userIds))
        .groupBy(saleOrders.clientUserId)
      for (const sr of spendRows) {
        // clientUserId 理论可空（匿名单），但 WHERE 已限定 IN userIds（非空），守卫仅作类型收窄
        if (sr.clientUserId) spendMap.set(sr.clientUserId, sr.total)
      }
    }

    const rows: ExportCustomerRow[] = dataRows.map((r) => ({
      name: r.name,
      phone: r.phone,
      storeName: r.storeName,
      customerType: r.customerType,
      memberLevel: r.memberLevel,
      spendingTier: r.spendingTier,
      customerStatus: r.customerStatus,
      employeeName: r.boundEmployeeName,
      totalSpend: spendMap.get(r.userId) ?? '0',
      promoterName: r.promoterName,
      customerSource: r.customerSource,
      birthday: r.birthday ? fmtDate(r.birthday) : null,
    }))

    return offsetPageResult(rows, page)
  },
)

export const getCustomerById = withPermission(
  'customer:list',
  async (session, userId: string): Promise<Customer | null> => {
  // admin 纯角色不碰顾客数据（admin+manager 双角色可访问）
  const isAdminOnly = isAdminScope(session) && !hasRole(session, 'manager') && !hasRole(session, 'customer_mgr') && !hasRole(session, 'finance')
  if (isAdminOnly) return null

  const rows = await db
    .select(customerColumns)
    .from(clientWechatUsers)
    .where(and(eq(clientWechatUsers.userId, userId), scopeCondition(session, clientWechatUsers.boundStoreId)))
    .limit(1)

  if (rows.length === 0) return null
  return serializeCustomer(rows[0])
  },
)

export const getCustomerCoupons = withPermission(
  'customer:list',
  async (_session, userId: string): Promise<CustomerCoupon[]> => {
    // scope 守卫：与 getCustomerOrders 同口径，顾客不在当前 scope 返回空
    const customer = await getCustomerById(userId)
    if (!customer) return []

    const { userCoupons, couponTemplates } = await import('@db/coupon')
    const { productCategories } = await import('@db/product')

    // 懒清扫过期券（系统无 cron 批量置过期，查询前顺手扫，保证「已过期」准确）
    await db.execute(sql`UPDATE user_coupons SET status = '已过期' WHERE user_id = ${userId} AND status = '未使用' AND expire_at <= NOW()`)

    const rows = await db
      .select({
        couponId: userCoupons.couponId,
        templateId: couponTemplates.templateId,
        name: couponTemplates.name,
        couponType: couponTemplates.couponType,
        discountValue: sql<string>`COALESCE(${userCoupons.faceValueOverride}, ${couponTemplates.discountValue})`,
        minSpend: couponTemplates.minSpend,
        status: userCoupons.status,
        expireAt: userCoupons.expireAt,
        usedAt: userCoupons.usedAt,
        usedSaleOrderId: userCoupons.usedSaleOrderId,
        createdAt: userCoupons.createdAt,
        description: couponTemplates.description,
        applicableStoreIds: couponTemplates.applicableStoreIds,
        applicableCategoryIds: couponTemplates.applicableCategoryIds,
      })
      .from(userCoupons)
      .innerJoin(couponTemplates, eq(userCoupons.templateId, couponTemplates.templateId))
      .where(eq(userCoupons.userId, userId))
      // 例外：详情页子列表，按状态固定序（未使用→已使用→已过期）+ 到期升序
      .orderBy(sql`CASE ${userCoupons.status} WHEN '未使用' THEN 0 WHEN '已使用' THEN 1 ELSE 2 END`, asc(userCoupons.expireAt))

    // 批量解析适用门店 / 品类名（text[] → 名称，对齐 client coupon.list 返回 shape）
    const storeIdSet = new Set<string>()
    const categoryIdSet = new Set<string>()
    for (const r of rows) {
      for (const id of r.applicableStoreIds ?? []) storeIdSet.add(id)
      for (const id of r.applicableCategoryIds ?? []) categoryIdSet.add(id)
    }
    const [storeRows, categoryRows] = await Promise.all([
      storeIdSet.size > 0
        ? db.select({ id: stores.storeId, name: stores.storeName }).from(stores).where(inArray(stores.storeId, [...storeIdSet]))
        : Promise.resolve([]),
      categoryIdSet.size > 0
        ? db.select({ id: productCategories.categoryId, name: productCategories.categoryName }).from(productCategories).where(inArray(productCategories.categoryId, [...categoryIdSet]))
        : Promise.resolve([]),
    ])
    const storeNameMap = new Map(storeRows.map((r) => [r.id, r.name]))
    const categoryNameMap = new Map(categoryRows.map((r) => [r.id, r.name]))

    return rows.map((r) => ({
      couponId: r.couponId,
      templateId: r.templateId,
      name: r.name,
      couponType: r.couponType as CouponType,
      discountValue: r.discountValue,
      minSpend: r.minSpend,
      status: r.status as CouponStatus,
      expireAt: r.expireAt.toISOString(),
      usedAt: r.usedAt?.toISOString() ?? null,
      usedSaleOrderId: r.usedSaleOrderId,
      createdAt: r.createdAt.toISOString(),
      description: r.description,
      applicableStoreNames: r.applicableStoreIds ? r.applicableStoreIds.map((id) => storeNameMap.get(id) ?? id) : null,
      applicableCategoryNames: r.applicableCategoryIds ? r.applicableCategoryIds.map((id) => categoryNameMap.get(id) ?? id) : null,
    }))
  },
)

export const getCustomerOrders = withPermission(
  'customer:list',
  async (_session, userId: string): Promise<SaleOrder[]> => {
  // scope 守卫：与退款 / 服务记录同口径，顾客不在当前 scope 内返回空，
  // 杜绝受限角色凭 userId 越权枚举他店顾客订单 / 转换单（getCustomerById 内含 scopeCondition）。
  const customer = await getCustomerById(userId)
  if (!customer) return []

  const { saleOrders, saleItems } = await import('@db/order')
  const { stores } = await import('@db/org')
  const { staffWechatUsers, clientWechatUsers } = await import('@db/user')
  const { productSkus, productCategories } = await import('@db/product')
  const { alias } = await import('drizzle-orm/pg-core')
  const { desc } = await import('drizzle-orm')

  // drizzle 0.45 alias() 返回 PgTableWithColumns<Required<Update<any,...>>>，与 .leftJoin() 期望签名不兼容；cast 回原表类型解锁 build
  const opener = alias(staffWechatUsers, 'opener') as unknown as typeof staffWechatUsers

  // 2026-07-08 修复 T1：与 orders.ts 对齐，left join clientWechatUsers 做 name/phone 兜底。
  const rows = await db
    .select({
      order: saleOrders,
      storeName: stores.storeName,
      openedByName: opener.name,
      custName: clientWechatUsers.name,
      custPhone: clientWechatUsers.phone,
    })
    .from(saleOrders)
    .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
    .leftJoin(opener, eq(saleOrders.openedBy, opener.employeeId))
    .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
    .where(eq(saleOrders.clientUserId, userId))
    // 例外：详情页子列表，业务时间（订单日期）优先
    .orderBy(desc(saleOrders.saleOrderDatetime))

  // 批量查询所有订单的明细（避免 N+1）
  const orderIds = rows.map(r => r.order.saleOrderId)
  const allItemRows = orderIds.length > 0
    ? await db
        .select({
          item: saleItems,
          skuName: productSkus.specName,
          skuUnit: productSkus.unit,
          categoryId: productSkus.categoryId,
          categoryName: productCategories.categoryName,
          productKind: productCategories.productKind,
        })
        .from(saleItems)
        .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
        .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
        .where(inArray(saleItems.saleOrderId, orderIds))
    : []

  // 按订单 ID 分组
  const itemsByOrderId = new Map<string, typeof allItemRows>()
  for (const ir of allItemRows) {
    const oid = ir.item.saleOrderId
    if (!itemsByOrderId.has(oid)) itemsByOrderId.set(oid, [])
    itemsByOrderId.get(oid)!.push(ir)
  }

  const orders: SaleOrder[] = []
  for (const r of rows) {
    const itemRows = itemsByOrderId.get(r.order.saleOrderId) ?? []

    orders.push({
      saleOrderId: r.order.saleOrderId,
      status: r.order.status as SaleOrder['status'],
      saleOrderType: r.order.saleOrderType as SaleOrder['saleOrderType'],
      documentType: r.order.documentType as SaleOrder['documentType'],
      refSaleOrderId: r.order.refSaleOrderId,
      legacySource: r.order.legacySource ?? null,
      marketName: r.order.marketName,
      storeId: r.order.storeId,
      saleOrderDatetime: r.order.saleOrderDatetime.toISOString(),
      performanceAttributionDate: r.order.performanceAttributionDate,
      performanceAttributionAdjustedAt: r.order.performanceAttributionAdjustedAt?.toISOString() ?? null,
      performanceAttributionAdjustedBy: r.order.performanceAttributionAdjustedBy,
      clientUserId: r.order.clientUserId,
      // 顾客档案权威 > sale_orders 兜底
      clientPhone: r.custPhone || r.order.clientPhone || null,
      customerName: r.custName || r.order.customerName || null,
      totalAmount: r.order.totalAmount,
      prepaidCardAmount: r.order.prepaidCardAmount ?? '0',
      pendingPrepaidCardAmount: r.order.pendingPrepaidCardAmount ?? '0',
      payableAmount: r.order.payableAmount ?? '0',
      received: r.order.received ?? '0',
      refundedAmount: r.order.refundedAmount ?? '0',
      paymentMethod: r.order.paymentMethod as SaleOrder['paymentMethod'],
      openedBy: r.order.openedBy,
      preferredEmployeeId: r.order.preferredEmployeeId,
      paidAt: r.order.paidAt?.toISOString() ?? null,
      allocationStatus: r.order.allocationStatus as SaleOrder['allocationStatus'],
      couponId: r.order.couponId,
      couponDiscount: r.order.couponDiscount,
      remark: r.order.remark,
      createdAt: r.order.createdAt.toISOString(),
      updatedAt: r.order.updatedAt.toISOString(),
      storeName: r.storeName ?? undefined,
      openedByName: r.openedByName ?? undefined,
      items: itemRows.map((ir) => ({
        saleItemId: ir.item.saleItemId,
        saleOrderId: ir.item.saleOrderId,
        itemDirection: ir.item.itemDirection as SaleItem['itemDirection'],
        refSaleItemId: ir.item.refSaleItemId,
        skuId: ir.item.skuId,
        productType: ir.item.productType ?? undefined,
        unit: ir.skuUnit ?? (ir.item.productType === '家居产品' ? '盒' : '次'),
        sessionCount: ir.item.sessionCount,
        remainingSessions: ir.item.remainingSessions,
        paidSessions: ir.item.paidSessions,
        unitPrice: ir.item.unitPrice,
        quantity: ir.item.quantity,
        unitRealPrice: ir.item.unitRealPrice,
        saleAmount: ir.item.saleAmount,
        received: ir.item.received,
        prepaidCardReceived: ir.item.prepaidCardReceived ?? '0',
        cashReceived: ir.item.cashReceived ?? ir.item.received,
        pendingReceived: ir.item.pendingReceived,
        expireDate: ir.item.expireDate,
        remark: ir.item.remark,
        salesCategory: ir.item.salesCategory as SaleItem['salesCategory'],
        createdAt: ir.item.createdAt.toISOString(),
        updatedAt: ir.item.updatedAt.toISOString(),
        skuName: ir.skuName ?? undefined,
        productName: ir.item.productName ?? undefined,
        categoryId: ir.categoryId ?? null,
        categoryName: ir.categoryName ?? null,
        productKind: ir.productKind ?? null,
      })),
    })
  }

  return orders
  },
)

/** 顾客已购家居产品资产；pickup_records 是真实提货数量的权威来源。 */
export const getCustomerHomeProducts = withPermission(
  'customer:list',
  async (_session, userId: string): Promise<CustomerHomeProduct[]> => {
    const customer = await getCustomerById(userId)
    if (!customer) return []

    const rows = await db.execute(sql`
      WITH pickup_totals AS (
        SELECT sale_item_id, SUM(pickup_quantity)::int AS picked_quantity
          FROM pickup_records
         GROUP BY sale_item_id
      ), conversion_totals AS (
        -- 2026-09-14 #125：家居转出数量并入 picked_up_quantity（"已结算"），这里单独聚合出来，
        -- 避免把"已转换"算进"已退款"。已关闭/失败的转换单已被 rollback 退回数量，须排除。
        SELECT out_item.ref_sale_item_id AS sale_item_id,
               SUM(out_item.quantity)::int AS converted_quantity
          FROM sale_items out_item
          JOIN sale_orders conv_order ON conv_order.sale_order_id = out_item.sale_order_id
         WHERE out_item.item_direction = '转出'
           AND out_item.product_type = '家居产品'
           AND out_item.ref_sale_item_id IS NOT NULL
           -- 只排除 '已关闭'：那是 rollbackPendingConversionOnClose 的唯一触发状态（数量已退回）。
           -- 其余状态（含 '支付失败'）扣减仍然生效，必须计入已转换，否则会被读成"已退款"。
           -- 删除订单的转出行已随主单消失，天然不计入。
           AND conv_order.status <> '已关闭'
         GROUP BY out_item.ref_sale_item_id
      ), home_products AS (
        SELECT
          si.sale_item_id,
          si.sale_order_id,
          COALESCE(si.product_name, '家居产品') AS product_name,
          COALESCE(ps.unit, '盒') AS unit,
          si.quantity::int AS purchased_quantity,
          LEAST(
            si.quantity,
            GREATEST(0, COALESCE(si.picked_up_quantity, 0))
          )::int AS settled_quantity,
          LEAST(
            LEAST(si.quantity, GREATEST(0, COALESCE(si.picked_up_quantity, 0))),
            GREATEST(0, COALESCE(pt.picked_quantity, 0))
          )::int AS picked_quantity,
          LEAST(
            LEAST(si.quantity, GREATEST(0, COALESCE(si.picked_up_quantity, 0))),
            GREATEST(0, COALESCE(ct.converted_quantity, 0))
          )::int AS converted_quantity,
          CASE
            WHEN si.sale_amount <= 0 THEN si.quantity
            ELSE LEAST(
              si.quantity,
              FLOOR(GREATEST(0, si.received::numeric) * si.quantity / NULLIF(si.sale_amount::numeric, 0))::int
            )
          END AS paid_quantity,
          o.store_id,
          s.store_name,
          COALESCE(o.paid_at, o.sale_order_datetime, o.created_at) AS purchased_at,
          EXISTS (
            SELECT 1 FROM sale_order_payments sop
             WHERE sop.sale_order_id = o.sale_order_id
               AND sop.change_type = '退款'
               AND sop.status = '待审批'
          ) AS refund_pending
        FROM sale_items si
        JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
        LEFT JOIN stores s ON s.store_id = o.store_id
        LEFT JOIN product_skus ps ON ps.sku_id = si.sku_id
        LEFT JOIN pickup_totals pt ON pt.sale_item_id = si.sale_item_id
        LEFT JOIN conversion_totals ct ON ct.sale_item_id = si.sale_item_id
        WHERE o.client_user_id = ${userId}
          AND o.status IN ('已支付', '部分支付', '已完成')
          AND si.item_direction = '购买'
          AND si.product_type = '家居产品'
      ), home_product_balances AS (
        SELECT *,
               GREATEST(0, settled_quantity - picked_quantity - converted_quantity)::int AS refunded_quantity,
               (purchased_quantity - settled_quantity)::int AS remaining_quantity,
               LEAST(
                 purchased_quantity - settled_quantity,
                 GREATEST(paid_quantity - picked_quantity, 0)
               )::int AS pending_pickup_quantity
          FROM home_products
      )
      SELECT *
        FROM home_product_balances
       WHERE picked_quantity > 0 OR pending_pickup_quantity > 0 OR converted_quantity > 0
    ORDER BY (pending_pickup_quantity > 0) DESC,
             purchased_at DESC,
             sale_item_id
    `)

    return (rows as unknown as Array<Record<string, unknown>>).map((row) => {
      const pickedQuantity = Number(row.picked_quantity ?? 0)
      const refundedQuantity = Number(row.refunded_quantity ?? 0)
      const convertedQuantity = Number(row.converted_quantity ?? 0)
      const remainingQuantity = Number(row.remaining_quantity ?? 0)
      const paidQuantity = Number(row.paid_quantity ?? 0)
      const pendingPickupQuantity = Number(row.pending_pickup_quantity ?? 0)
      return {
        saleItemId: String(row.sale_item_id),
        saleOrderId: String(row.sale_order_id),
        productName: String(row.product_name || '家居产品'),
        unit: String(row.unit || '盒'),
        purchasedQuantity: Number(row.purchased_quantity),
        paidQuantity,
        pickedQuantity,
        refundedQuantity,
        convertedQuantity,
        remainingQuantity,
        pendingPickupQuantity,
        status: deriveHomeProductStatus(
          Boolean(row.refund_pending),
          pickedQuantity,
          refundedQuantity,
          pendingPickupQuantity,
          convertedQuantity,
        ),
        storeId: String(row.store_id),
        storeName: (row.store_name as string | null) ?? null,
        purchasedAt: new Date(String(row.purchased_at)).toISOString(),
      }
    })
  },
)

export const getCustomerAppointments = withPermission(
  'customer:list',
  async (_session, userId: string): Promise<Appointment[]> => {
  // scope 守卫：顾客不在当前 scope 内返回空，杜绝越权枚举他店顾客预约记录（getCustomerById 内含 scopeCondition）。
  const customer = await getCustomerById(userId)
  if (!customer) return []

  const { appointments } = await import('@db/appointment')
  const { stores } = await import('@db/org')
  const { desc } = await import('drizzle-orm')

  const rows = await db
    .select({
      appointment: appointments,
      storeName: stores.storeName,
    })
    .from(appointments)
    .leftJoin(stores, eq(appointments.storeId, stores.storeId))
    .where(eq(appointments.clientUserId, userId))
    // 例外：详情页子列表，业务时间（预约时间）优先
    .orderBy(desc(appointments.appointmentTime))

  return rows.map((r) => {
    const a = r.appointment
    return {
      appointmentId: a.appointmentId,
      status: a.status as Appointment['status'],
      storeId: a.storeId,
      clientUserId: a.clientUserId,
      clientName: a.clientName,
      employeeId: a.employeeId,
      employeeName: a.employeeName,
      saleItemId: a.saleItemId,
      appointmentTime: a.appointmentTime.toISOString(),
      checkinAt: a.checkinAt?.toISOString() ?? null,
      notes: a.notes,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
      storeName: r.storeName ?? undefined,
    }
  })
  },
)

export interface CustomerRefundItem {
  saleItemId: string
  direction: string | null
  productName: string | null
  specName: string | null
  quantity: number
  received: string
}

export interface CustomerRefundRecord {
  /** 退款指向原销售单；转换单指向转换单自身 */
  saleOrderId: string
  type: '退款' | '转换单'
  status: string
  /** 退款金额已含负号；转换单为单据总额 */
  totalAmount: string
  refundReason: string | null
  createdAt: string
  paidAt: string | null
  items: CustomerRefundItem[]
}

/**
 * 顾客退换记录（顾客档案「退换记录」Tab，与员工端 customer.refundHistory 同口径）
 * 数据源 = sale_order_payments[change_type='退款'] + sale_orders[sale_order_type='转换单']
 * scope：按 sale_orders.store_id 过滤（与列表同 scope；admin 无过滤）
 */
export const getCustomerRefundHistory = withPermission(
  'customer:list',
  async (session, userId: string): Promise<CustomerRefundRecord[]> => {
  // scope 守卫：交易数据虽「跟顾客走」不按门店过滤，但「能否查这位顾客」仍受 scope 限制。
  // 复用 getCustomerById 的 scopeCondition（与 getCustomerPhoneChangeLogs 同口径）：
  // 顾客不在当前 scope 内则返回空，杜绝受限角色凭 userId 越权枚举他店顾客退款 / 转换单历史。
  const customer = await getCustomerById(userId)
  if (!customer) return []

  const { saleOrders, saleItems, saleOrderPayments } = await import('@db/order')

  // 退款流水（来自 sale_order_payments）
  const refundRows = await db
    .select({
      saleOrderId: saleOrderPayments.saleOrderId,
      amount: saleOrderPayments.amount,
      status: saleOrderPayments.status,
      createdAt: saleOrderPayments.createdAt,
      paidAt: saleOrderPayments.paidAt,
      refundReason: saleOrderPayments.refundReason,
      note: saleOrderPayments.note,
    })
    .from(saleOrderPayments)
    .innerJoin(saleOrders, eq(saleOrders.saleOrderId, saleOrderPayments.saleOrderId))
    .where(
      // 交易数据跟顾客走：退款流水不按门店过滤（顾客可见性由 getCustomerById 守护）
      and(
        eq(saleOrderPayments.changeType, '退款'),
        eq(saleOrders.clientUserId, userId),
      ),
    )
    .orderBy(desc(saleOrderPayments.createdAt))

  // 转换单
  const convRows = await db
    .select({
      saleOrderId: saleOrders.saleOrderId,
      status: saleOrders.status,
      totalAmount: saleOrders.totalAmount,
      createdAt: saleOrders.createdAt,
      paidAt: saleOrders.paidAt,
    })
    .from(saleOrders)
    .where(
      // 交易数据跟顾客走：转换单不按门店过滤
      and(
        eq(saleOrders.clientUserId, userId),
        eq(saleOrders.saleOrderType, '转换单'),
      ),
    )
    .orderBy(desc(saleOrders.createdAt))

  // 转换单明细
  const convOrderIds = convRows.map((o) => o.saleOrderId)
  const convItemRows = convOrderIds.length > 0
    ? await db
        .select({
          saleOrderId: saleItems.saleOrderId,
          saleItemId: saleItems.saleItemId,
          itemDirection: saleItems.itemDirection,
          productName: saleItems.productName,
          quantity: saleItems.quantity,
          received: saleItems.received,
        })
        .from(saleItems)
        .where(inArray(saleItems.saleOrderId, convOrderIds))
    : []
  const convItemsByOrder = new Map<string, CustomerRefundItem[]>()
  for (const i of convItemRows) {
    if (!convItemsByOrder.has(i.saleOrderId)) convItemsByOrder.set(i.saleOrderId, [])
    convItemsByOrder.get(i.saleOrderId)!.push({
      saleItemId: i.saleItemId,
      direction: i.itemDirection,
      productName: i.productName,
      specName: i.productName,
      quantity: i.quantity,
      received: i.received,
    })
  }

  const refunds: CustomerRefundRecord[] = refundRows.map((r) => {
    let parsed: { items?: CustomerRefundItem[] } | null = null
    if (r.note) {
      try { parsed = typeof r.note === 'string' ? JSON.parse(r.note) : r.note } catch { /* ignore */ }
    }
    return {
      saleOrderId: r.saleOrderId,
      type: '退款',
      status: r.status,
      totalAmount: r.amount, // 已含负号
      refundReason: r.refundReason,
      createdAt: r.createdAt.toISOString(),
      paidAt: r.paidAt?.toISOString() ?? null,
      items: parsed?.items ?? [],
    }
  })

  const conversions: CustomerRefundRecord[] = convRows.map((o) => ({
    saleOrderId: o.saleOrderId,
    type: '转换单',
    status: o.status,
    totalAmount: o.totalAmount,
    refundReason: null,
    createdAt: o.createdAt.toISOString(),
    paidAt: o.paidAt?.toISOString() ?? null,
    items: convItemsByOrder.get(o.saleOrderId) ?? [],
  }))

  return [...refunds, ...conversions].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
  },
)

export interface CustomerServiceItem {
  productName: string | null
}

export interface CustomerServiceRecord {
  serviceOrderId: string
  status: string
  serviceDate: string
  storeName: string | null
  employeeName: string | null
  items: CustomerServiceItem[]
}

/**
 * 顾客服务记录（顾客档案「服务记录」Tab）
 * 交易数据跟顾客走：按 clientUserId 查全量服务单（含跨门店、各状态），无 store scope。
 * 与 getCustomerRefundHistory 同 scope 口径（顾客可见性由 getCustomerById 守护）。
 */
export const getCustomerServiceOrders = withPermission(
  'customer:list',
  async (session, userId: string): Promise<CustomerServiceRecord[]> => {
  // scope 守卫：与 getCustomerRefundHistory 同口径，复用 getCustomerById 的 scopeCondition；
  // 顾客不在当前 scope 内返回空，杜绝越权枚举他店顾客跨门店服务记录。
  const customer = await getCustomerById(userId)
  if (!customer) return []

  const { serviceOrders, serviceItems } = await import('@db/service')
  const { saleItems } = await import('@db/order')
  const { staffWechatUsers } = await import('@db/user')

  const rows = await db
    .select({
      serviceOrderId: serviceOrders.serviceOrderId,
      status: serviceOrders.status,
      serviceDate: serviceOrders.serviceDate,
      createdAt: serviceOrders.createdAt,
      storeName: stores.storeName,
      employeeName: staffWechatUsers.name,
    })
    .from(serviceOrders)
    .leftJoin(stores, eq(serviceOrders.storeId, stores.storeId))
    .leftJoin(staffWechatUsers, eq(serviceOrders.assignedEmployeeId, staffWechatUsers.employeeId))
    .where(eq(serviceOrders.clientUserId, userId))
    .orderBy(desc(serviceOrders.serviceDate), desc(serviceOrders.createdAt))

  if (rows.length === 0) return []

  const soIds = rows.map((r) => r.serviceOrderId)
  const itemRows = await db
    .select({
      serviceOrderId: serviceItems.serviceOrderId,
      productName: saleItems.productName,
    })
    .from(serviceItems)
    .leftJoin(saleItems, eq(serviceItems.saleItemId, saleItems.saleItemId))
    .where(inArray(serviceItems.serviceOrderId, soIds))

  const itemsByOrder = new Map<string, CustomerServiceItem[]>()
  for (const i of itemRows) {
    if (!itemsByOrder.has(i.serviceOrderId)) itemsByOrder.set(i.serviceOrderId, [])
    itemsByOrder.get(i.serviceOrderId)!.push({ productName: i.productName })
  }

  return rows.map((r) => ({
    serviceOrderId: r.serviceOrderId,
    status: r.status,
    serviceDate: r.serviceDate,
    storeName: r.storeName,
    employeeName: r.employeeName,
    items: itemsByOrder.get(r.serviceOrderId) ?? [],
  }))
  },
)

export const updateCustomer = withPermission(
  'customer:update',
  async (
    session,
    userId: string,
    data: Partial<{
    name: string | null
    gender: string | null
    phone: string | null
    memberLevel: string | null
    customerSource: string | null
    birthday: string | null
    occupation: string | null
    isMarried: boolean | null
    wechatName: string | null
    skinType: string | null
    improvementFocus: string | null
    skinIssue: string | null
    wellnessPreference: string | null
    notes: string | null
    promoterEmployeeId: string | null
    boundEmployeeId: string | null
    /** 临时跨门店标记（需求21）；每日 03:00 cron 重置为 false */
    isCrossStoreTemp: boolean
    }>,
    /** 乐观锁：提交时携带的 updated_at */
    expectedUpdatedAt?: string,
  ): Promise<{ success: boolean; message: string }> => {
  if (Object.prototype.hasOwnProperty.call(data, 'boundStoreId')) {
    return { success: false, message: '绑定门店仅允许新增顾客时设置，请通过顾客转店/解绑流程处理' }
  }

  const allowedUpdateFields = new Set([
    'name',
    'gender',
    'phone',
    'memberLevel',
    'customerSource',
    'birthday',
    'occupation',
    'isMarried',
    'wechatName',
    'skinType',
    'improvementFocus',
    'skinIssue',
    'wellnessPreference',
    'notes',
    'promoterEmployeeId',
    'boundEmployeeId',
    'isCrossStoreTemp',
  ])
  const unexpectedFields = Object.keys(data).filter((field) => !allowedUpdateFields.has(field))
  if (unexpectedFields.length > 0) {
    return { success: false, message: `包含不允许修改的字段：${unexpectedFields.join('、')}` }
  }

  // 服务端输入校验
  if (data.phone !== undefined && data.phone !== null && !/^1\d{10}$/.test(data.phone)) {
    return { success: false, message: '手机号格式不正确（需为 11 位手机号）' }
  }

  const scopeCond = scopeCondition(session, clientWechatUsers.boundStoreId)

  // 先确认顾客在当前 scope 内，避免后续员工校验形成越权枚举侧信道。
  const [before] = await db.select().from(clientWechatUsers)
    .where(and(eq(clientWechatUsers.userId, userId), scopeCond)).limit(1)
  if (!before) return { success: false, message: '顾客不存在或无权修改' }

  const updateData: Record<string, unknown> = Object.fromEntries(
    Object.entries(data).filter(([field, value]) => allowedUpdateFields.has(field) && value !== undefined),
  )

  const newlyOverriddenFields = Object.entries(WORKFINE_OVERRIDE_FIELD_MAP)
    .filter(([field]) => Object.prototype.hasOwnProperty.call(data, field)
      && JSON.stringify((before as Record<string, unknown>)[field]) !== JSON.stringify((data as Record<string, unknown>)[field]))
    .map(([, dbField]) => dbField)
  if (newlyOverriddenFields.length > 0) {
    updateData.workfineOverrideFields = Array.from(new Set([
      ...((before.workfineOverrideFields as string[] | null) ?? []),
      ...newlyOverriddenFields,
    ]))
  }

  // boundEmployeeId 变更时同步写入冗余姓名
  if ('boundEmployeeId' in data) {
    if (data.boundEmployeeId) {
      const [emp] = await db.select({ name: staffWechatUsers.name }).from(staffWechatUsers)
        .where(eq(staffWechatUsers.employeeId, data.boundEmployeeId)).limit(1)
      updateData.boundEmployeeName = emp?.name ?? null
    } else {
      updateData.boundEmployeeName = null
    }
  }

  // admin 只提交 employeeId；服务端解析当前姓名并同步写 ID + 姓名快照。
  // 推荐人可跨店（与员工端小程序口径一致），仅校验在职，不受账号 scope 限制。
  if ('promoterEmployeeId' in data) {
    if (data.promoterEmployeeId) {
      const [promoter] = await db
        .select({
          employeeId: staffWechatUsers.employeeId,
          name: staffWechatUsers.name,
        })
        .from(staffWechatUsers)
        .where(and(
          eq(staffWechatUsers.employeeId, data.promoterEmployeeId),
          eq(staffWechatUsers.isResigned, false),
        ))
        .limit(1)
      if (!promoter) {
        return { success: false, message: '推荐员工不存在或已离职' }
      }
      updateData.promoterEmployeeId = promoter.employeeId
      updateData.promoterEmployeeName = promoter.name
    } else {
      updateData.promoterEmployeeId = null
      updateData.promoterEmployeeName = null
    }
  }

  const whereConditions = expectedUpdatedAt
    ? and(
        eq(clientWechatUsers.userId, userId),
        sql`date_trunc('milliseconds', ${clientWechatUsers.updatedAt}) = ${expectedUpdatedAt}`,
        scopeCond,
      )
    : and(eq(clientWechatUsers.userId, userId), scopeCond)

  let result: any
  try {
    result = await db.update(clientWechatUsers).set(updateData as any).where(whereConditions)
  } catch (err: any) {
    if (pgErrorCode(err) === '23505') {
      return { success: false, message: '该手机号已被其他顾客使用' }
    }
    throw err
  }

  if ((result as any).count === 0) {
    return {
      success: false,
      message: expectedUpdatedAt ? '数据已被其他人修改，请刷新后重试' : '顾客不存在或无权修改',
    }
  }

  await logUpdate(session, 'customer.update', 'customer', userId, before as Record<string, unknown>, updateData)

  const { revalidatePath } = await import('next/cache')
  revalidatePath('/customers')
  return { success: true, message: '顾客信息已更新' }
  },
)

/**
 * 客户分配（将顾客绑定给指定美容师）— 对齐 staff 端 customer.assign。
 *
 * 复用 customer:update 权限（免改权限矩阵）。校验员工存在后 UPDATE
 * bound_employee_id + bound_employee_name（冗余姓名）。scope 由 scopeCondition 守护。
 */
export const assignCustomer = withPermission(
  'customer:update',
  async (session, userId: string, employeeId: string): Promise<{ success: boolean; message: string }> => {
  if (!userId) return { success: false, message: '缺少顾客 userId' }
  if (!employeeId) return { success: false, message: '请选择美容师' }

  // 校验员工存在并取冗余姓名 + 门店（与 updateCustomer 同范式）
  const { staffWechatUsers } = await import('@db/user')
  const [emp] = await db
    .select({ name: staffWechatUsers.name, storeId: staffWechatUsers.storeId })
    .from(staffWechatUsers)
    .where(eq(staffWechatUsers.employeeId, employeeId))
    .limit(1)
  if (!emp) return { success: false, message: '员工不存在' }

  // 员工 scope 校验（对齐 staff 端 assertEmployeeInScope）：
  // 防止门店店长把本店顾客分配给其他门店的美容师。
  // isInScope 对 admin 角色放行；员工无门店（storeId=null）时非 admin 拒绝。
  if (!isInScope(session, emp.storeId ?? '')) {
    return { success: false, message: '无权分配给该门店的员工' }
  }

  const scopeCond = scopeCondition(session, clientWechatUsers.boundStoreId)
  const result: any = await db
    .update(clientWechatUsers)
    .set({ boundEmployeeId: employeeId, boundEmployeeName: emp.name ?? null } as any)
    .where(and(eq(clientWechatUsers.userId, userId), scopeCond))

  if ((result as any).count === 0) {
    return { success: false, message: '顾客不存在或无权操作' }
  }

  await logOperation(session, 'customer.assign', 'customer', userId, {
    employeeId,
    employeeName: emp.name ?? null,
  })

  const { revalidatePath } = await import('next/cache')
  revalidatePath(`/customers/${userId}`)
  return { success: true, message: `已分配给 ${emp.name ?? employeeId}` }
  },
)

/**
 * 顾客储值卡余额（基本档案 Tab 展示）— 对齐 staff 端 customer.customerBalance。
 *
 * 账户级资产：prepaid_cards 一户一账户、跨店共享、无 store_id 列，故不加 scope 过滤
 * （未绑定门店的顾客余额仍可查）。无行返回 { cardId: null, balance: '0' }。
 */
export const getCustomerPrepaidBalance = withPermission(
  'customer:list',
  async (_session, userId: string): Promise<{ cardId: string | null; balance: string }> => {
  const { prepaidCards } = await import('@db/prepaid-card')
  const [row] = await db
    .select({ cardId: prepaidCards.cardId, balance: prepaidCards.balance })
    .from(prepaidCards)
    .where(eq(prepaidCards.userId, userId))
    .limit(1)

  if (!row) return { cardId: null, balance: '0' }
  return { cardId: row.cardId, balance: row.balance }
  },
)

export const createCustomer = withPermission(
  'customer:create',
  async (
    session,
    data: {
  phone: string
  name: string
  boundStoreId?: string | null
  boundEmployeeId?: string | null
    },
  ): Promise<{ success: boolean; message: string; userId?: string }> => {
  // 服务端输入校验
  if (!data.name?.trim()) {
    return { success: false, message: '姓名不能为空' }
  }
  if (!data.phone?.trim()) {
    return { success: false, message: '请输入手机号' }
  }
  if (!/^1\d{10}$/.test(data.phone)) {
    return { success: false, message: '手机号格式不正确（需为 11 位手机号）' }
  }

  // scope 隔离：非 admin 只能在自己 scope 内的门店创建顾客
  if (data.boundStoreId && !isInScope(session, data.boundStoreId)) {
    return { success: false, message: '无权在该门店创建顾客' }
  }

  // 检查手机号是否已存在
  const existing = await db
    .select({ userId: clientWechatUsers.userId })
    .from(clientWechatUsers)
    .where(eq(clientWechatUsers.phone, data.phone))
    .limit(1)

  if (existing.length > 0) {
    return { success: false, message: '该手机号已存在顾客记录' }
  }

  // 解析绑定美容师姓名
  let boundEmployeeName: string | null = null
  if (data.boundEmployeeId) {
    const { staffWechatUsers } = await import('@db/user')
    const [emp] = await db.select({ name: staffWechatUsers.name }).from(staffWechatUsers)
      .where(eq(staffWechatUsers.employeeId, data.boundEmployeeId)).limit(1)
    boundEmployeeName = emp?.name ?? null
  }

  // 服务端生成 userId
  const { randomBytes } = await import('crypto')
  const userId = `FYGK-${randomBytes(6).toString('hex')}`

  try {
    await db.insert(clientWechatUsers).values({
      userId,
      phone: data.phone,
      name: data.name,
      boundStoreId: data.boundStoreId ?? null,
      boundEmployeeId: data.boundEmployeeId ?? null,
      boundEmployeeName,
    })
  } catch (err: any) {
    if (pgErrorCode(err) === '23505') {
      return { success: false, message: '该手机号已被其他顾客使用' }
    }
    throw err
  }

  await logOperation(session, 'customer.create', 'customer', userId, { name: data.name, phone: data.phone })

  const { revalidatePath } = await import('next/cache')
  revalidatePath('/customers')
  return { success: true, message: '顾客创建成功', userId }
  },
)

/* ============================================================
 * P1 — 手机号变更日志（顾客详情 Tab，只读）
 * ============================================================ */

export interface PhoneChangeLog {
  id: number
  createdAt: string
  oldPhone: string | null
  newPhone: string | null
  mergedOrders: number
  operatorLabel: string
  /** 'client'：顾客端 P0/P1 自助换绑历史；'admin'：管理后台代客修改 */
  source: 'client' | 'admin'
  /** 仅 admin 来源时填充：操作员姓名 */
  operatorName: string | null
}

/**
 * 读取指定顾客的手机号变更记录
 *
 * 数据源（合并展示）：
 *   1. action='auth.rebindPhone' AND target_type='client_user'
 *      （P0/P1 客户端自助换绑历史，2026-04-16 已下线，仅供历史回看）
 *      detail 形如 { oldPhone, newPhone, clientUserId, mergedOrders }（P0 已脱敏）
 *   2. action='customer.update' AND target_type='customer'
 *      （admin-only 改 phone，detail 由 logUpdate 写入）
 *      detail 形如 { _v: 2, _t: 'update', changes: { phone: { from, to }, ... } }
 *      仅 changes.phone 存在的记录被纳入
 */
export const getCustomerPhoneChangeLogs = withPermission(
  'customer:list',
  async (_session, userId: string): Promise<PhoneChangeLog[]> => {
  const { operationLogs } = await import('@db/operation-log')

  // scope 保护：非 admin 需确认顾客在其 scope 内（复用 getCustomerById 的 scope 过滤）
  const customer = await getCustomerById(userId)
  if (!customer) return []

  const rows = await db
    .select({
      id: operationLogs.id,
      createdAt: operationLogs.createdAt,
      action: operationLogs.action,
      detail: operationLogs.detail,
      source: operationLogs.source,
      operatorEmployeeId: operationLogs.operatorEmployeeId,
      operatorName: operationLogs.operatorName,
    })
    .from(operationLogs)
    .where(
      or(
        and(
          eq(operationLogs.action, 'auth.rebindPhone'),
          eq(operationLogs.targetType, 'client_user'),
          eq(operationLogs.targetId, userId),
        ),
        and(
          eq(operationLogs.action, 'customer.update'),
          eq(operationLogs.targetType, 'customer'),
          eq(operationLogs.targetId, userId),
          // 仅当 detail.changes 中包含 phone 字段时才计入（admin 改了非 phone 字段的更新不应进入手机号变更 Tab）
          sql`(${operationLogs.detail} -> 'changes' ? 'phone')`,
        ),
      ),
    )
    // 例外：流水型表无 updatedAt 列（operation_logs）
    .orderBy(desc(operationLogs.createdAt))

  return rows.map((r) => {
    if (r.action === 'customer.update') {
      // logUpdate 写入的 diff 结构：{ _v: 2, _t: 'update', changes: { phone: { from, to } } }
      const detail = (r.detail ?? {}) as {
        changes?: { phone?: { from?: string | null; to?: string | null } }
      }
      const phoneDiff = detail.changes?.phone ?? {}
      return {
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        oldPhone: phoneDiff.from ?? null,
        newPhone: phoneDiff.to ?? null,
        mergedOrders: 0,
        operatorLabel: r.operatorName ?? r.operatorEmployeeId ?? '—',
        source: 'admin',
        operatorName: r.operatorName ?? null,
      }
    }

    // auth.rebindPhone 历史记录
    const detail = (r.detail ?? {}) as { oldPhone?: string; newPhone?: string; clientUserId?: string; mergedOrders?: number }
    // operator_employee_id 为 null + detail.clientUserId 存在 → 顾客自助
    const operatorLabel = r.operatorEmployeeId
      ? (r.operatorName ?? r.operatorEmployeeId)
      : (detail.clientUserId ? '顾客自助' : (r.operatorName ?? '—'))
    return {
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      oldPhone: detail.oldPhone ?? null,
      newPhone: detail.newPhone ?? null,
      mergedOrders: detail.mergedOrders ?? 0,
      operatorLabel,
      source: 'client',
      operatorName: r.operatorEmployeeId ? (r.operatorName ?? null) : null,
    }
  })
  },
)

/* ============================================================
 * P1 — 顾客合并工具（孤儿档案认领）
 * ============================================================ */

export interface OrphanProfile {
  userId: string
  customerId: string | null
  name: string | null
  gender: string | null
  memberLevel: string | null
  spendingTier: string | null
  pointsBalance: number
  skinType: string | null
  notes: string | null
  createdAt: string
}

/**
 * 查询与当前顾客同手机号的"孤儿档案"（openid IS NULL 且 user_id 不同）
 *
 * 用于顾客详情页展示"合并历史档案"入口。
 */
export const getOrphanProfilesByUserId = withPermission(
  'customer:list',
  async (_session, userId: string): Promise<OrphanProfile[]> => {
  // 先拿到当前行（受 scope 限制）
  const current = await getCustomerById(userId)
  if (!current || !current.phone) return []

  const rows = await db
    .select({
      userId: clientWechatUsers.userId,
      customerId: clientWechatUsers.customerId,
      name: clientWechatUsers.name,
      gender: clientWechatUsers.gender,
      memberLevel: clientWechatUsers.memberLevel,
      spendingTier: clientWechatUsers.spendingTier,
      pointsBalance: clientWechatUsers.pointsBalance,
      skinType: clientWechatUsers.skinType,
      notes: clientWechatUsers.notes,
      createdAt: clientWechatUsers.createdAt,
      openid: clientWechatUsers.openid,
    })
    .from(clientWechatUsers)
    .where(
      and(
        eq(clientWechatUsers.phone, current.phone),
        sql`${clientWechatUsers.openid} IS NULL`,
        sql`${clientWechatUsers.userId} <> ${userId}`,
      ),
    )
    .limit(10)

  return rows.map((r) => ({
    userId: r.userId,
    customerId: r.customerId,
    name: r.name,
    gender: r.gender,
    memberLevel: r.memberLevel,
    spendingTier: r.spendingTier,
    pointsBalance: r.pointsBalance,
    skinType: r.skinType,
    notes: r.notes,
    createdAt: r.createdAt.toISOString(),
  }))
  },
)

/**
 * 合并客户档案（孤儿行 → 活跃行）
 *
 * 条件：
 *   - 目标（source）必须是活跃行（openid NOT NULL）
 *   - 来源（orphan）必须是孤儿行（openid IS NULL）
 *   - 权限：仅店长（manager）/ admin
 *
 * 事务内：
 *   1. 把孤儿行的档案字段填入活跃行（活跃行已有非空字段**不覆盖**）
 *   2. 重挂 sale_orders / user_coupons / point_transactions / point_batches / prepaid_cards /
 *      card_transactions / appointments / messages / service_orders
 *      的 client_user_id = orphan → source
 *   3. DELETE 孤儿行
 *   4. 审计日志 admin.mergeClientProfile
 */
export const mergeClientProfile = withPermission(
  'customer:update',
  async (
    session,
    sourceUserId: string,
    orphanUserId: string,
  ): Promise<{ success: boolean; message: string; fieldsMigrated?: string[]; ordersReassigned?: number }> => {
  // 仅店长 / admin 允许合并
  if (!hasRole(session, 'manager') && !isAdminScope(session)) {
    return { success: false, message: '仅店长或管理员可执行顾客合并' }
  }

  if (!sourceUserId || !orphanUserId || sourceUserId === orphanUserId) {
    return { success: false, message: '源顾客与目标孤儿档案必须是两个不同的 userId' }
  }

  // 校验两边状态
  const [sourceRow] = await db
    .select()
    .from(clientWechatUsers)
    .where(eq(clientWechatUsers.userId, sourceUserId))
    .limit(1)
  const [orphanRow] = await db
    .select()
    .from(clientWechatUsers)
    .where(eq(clientWechatUsers.userId, orphanUserId))
    .limit(1)

  if (!sourceRow) return { success: false, message: '活跃顾客不存在' }
  if (!orphanRow) return { success: false, message: '孤儿档案不存在' }
  if (!sourceRow.openid) return { success: false, message: '源顾客缺少 openid（并非活跃账户），不能作为合并目标' }
  if (orphanRow.openid) return { success: false, message: '目标档案 openid 非空（并非孤儿档案），拒绝合并' }
  if (sourceRow.phone && orphanRow.phone && sourceRow.phone !== orphanRow.phone) {
    return { success: false, message: '两条档案手机号不一致，请先核实' }
  }

  // 非 admin 需 scope 允许访问活跃顾客所属门店
  if (!isAdminScope(session)) {
    if (sourceRow.boundStoreId && !isInScope(session, sourceRow.boundStoreId)) {
      return { success: false, message: '无权对该门店的顾客执行合并' }
    }
  }

  // 可迁移字段（源行**缺失**才从孤儿行搬）；points_balance 是 point_batches 的派生缓存，合并后统一重算。
  const migratable: Array<keyof typeof clientWechatUsers.$inferSelect> = [
    'customerId', 'memberLevel', 'spendingTier', 'skinType',
    'name', 'gender', 'notes', 'birthday', 'occupation', 'customerSource',
    'customerType', 'improvementFocus', 'skinIssue', 'wellnessPreference',
    'boundStoreId', 'boundEmployeeId', 'boundEmployeeName', 'wechatName', 'isMarried',
  ]
  const patch: Record<string, unknown> = {}
  const fieldsMigrated: string[] = []
  const orphanOverrideFields = new Set((orphanRow.workfineOverrideFields as string[] | null) ?? [])
  const transferredOverrideFields = new Set<string>()
  for (const field of migratable) {
    const currentVal = (sourceRow as Record<string, unknown>)[field as string]
    const orphanVal = (orphanRow as Record<string, unknown>)[field as string]
    const currentEmpty = currentVal === null || currentVal === undefined || currentVal === ''
    const overrideField = WORKFINE_OVERRIDE_FIELD_MAP[field as keyof typeof WORKFINE_OVERRIDE_FIELD_MAP]
    if (currentEmpty && overrideField && orphanOverrideFields.has(overrideField)) {
      transferredOverrideFields.add(overrideField)
    }
    if (currentEmpty && orphanVal !== null && orphanVal !== undefined && orphanVal !== '') {
      patch[field as string] = orphanVal
      fieldsMigrated.push(field as string)
    }
  }
  if (transferredOverrideFields.size > 0) {
    const fieldsToTransfer = Array.from(transferredOverrideFields)
    const fieldsToTransferSql = sql.join(
      fieldsToTransfer.map((field) => sql`${field}`),
      sql.raw(', '),
    )
    patch.workfineOverrideFields = sql<string[]>`ARRAY(
      SELECT DISTINCT unnest(${clientWechatUsers.workfineOverrideFields} || ARRAY[${fieldsToTransferSql}]::text[])
    )`
  }

  let ordersReassigned = 0
  try {
    await db.transaction(async (tx) => {
      const { saleOrders } = await import('@db/order')
      const { userCoupons } = await import('@db/coupon')
      const { pointBatches, pointTransactions } = await import('@db/points')
      const { prepaidCards } = await import('@db/prepaid-card')
      const { appointments } = await import('@db/appointment')
      const { messages } = await import('@db/message')
      const { serviceOrders } = await import('@db/service')
      const { pickupRecords } = await import('@db/pickup')

      // 1. 档案字段回填（仅缺失项）
      if (Object.keys(patch).length > 0) {
        await tx.update(clientWechatUsers)
          .set(patch as any)
          .where(eq(clientWechatUsers.userId, sourceUserId))
      }

      // 2. 业务引用重挂（各表列名不同：order/appointment/service 用 clientUserId，
      //    coupon/points/prepaid 用 userId，messages 用 recipientType+recipientId）
      const reassignCol = async (table: any, col: any, setObj: Record<string, unknown>) => {
        const res: any = await tx.update(table).set(setObj as any).where(eq(col, orphanUserId))
        return (res?.count ?? res?.rowCount ?? 0) as number
      }
      ordersReassigned = await reassignCol(saleOrders, saleOrders.clientUserId, { clientUserId: sourceUserId })
      await reassignCol(userCoupons, userCoupons.userId, { userId: sourceUserId })
      await reassignCol(pointTransactions, pointTransactions.userId, { userId: sourceUserId })
      await reassignCol(pointBatches, pointBatches.userId, { userId: sourceUserId })
      await tx.update(clientWechatUsers)
        .set({
          pointsBalance: sql<number>`COALESCE((
            SELECT SUM(${pointBatches.remainingAmount})
            FROM ${pointBatches}
            WHERE ${pointBatches.userId} = ${sourceUserId}
              AND ${pointBatches.expireAt} > NOW()
          ), 0)`,
          pointsUpdatedAt: sql`NOW()`,
        })
        .where(eq(clientWechatUsers.userId, sourceUserId))
      await reassignCol(prepaidCards, prepaidCards.userId, { userId: sourceUserId })
      // card_transactions 通过 card_id → prepaid_cards 间接关联，无需直接迁移
      await reassignCol(appointments, appointments.clientUserId, { clientUserId: sourceUserId })
      await reassignCol(serviceOrders, serviceOrders.clientUserId, { clientUserId: sourceUserId })
      await reassignCol(pickupRecords, pickupRecords.clientUserId, { clientUserId: sourceUserId })
      // messages: recipientType='客户' AND recipient_id = orphan
      await tx.update(messages)
        .set({ recipientId: sourceUserId })
        .where(and(eq(messages.recipientType, '客户'), eq(messages.recipientId, orphanUserId)))

      // 3. 删除孤儿行
      await tx.delete(clientWechatUsers).where(eq(clientWechatUsers.userId, orphanUserId))
    })
  } catch (err: any) {
    return { success: false, message: `合并失败：${err?.message ?? 'unknown'}` }
  }

  await logOperation(session, 'admin.mergeClientProfile', 'client_user', sourceUserId, {
    sourceUserId,
    orphanUserId,
    fieldsMigrated,
    ordersReassigned,
  })

  const { revalidatePath } = await import('next/cache')
  revalidatePath('/customers')
  revalidatePath(`/customers/${sourceUserId}`)

  return { success: true, message: `已合并 ${fieldsMigrated.length} 个字段，${ordersReassigned} 笔订单归属已更新`, fieldsMigrated, ordersReassigned }
  },
)

/**
 * 物理删除顾客（仅系统管理员；数据治理用，清理测试顾客账号）。
 *
 * 仅适用于"无任何业务关联"的测试号：顾客被订单/服务/预约/积分/储值卡/优惠券等引用即由
 * PG FK RESTRICT 拦截，pgErrorCode 23503 兜底并提示。顾客无可随删的从属表（messages 无 FK 快照），
 * 故直接删主表 + 兜底。注意：积分/储值卡/券等资产流水绝不级联删除。
 */
export const deleteCustomer = withPermission(
  'customer:delete',
  async (session, userId: string): Promise<{ success: boolean; message: string }> => {
    requireAdmin(session)
    const [cust] = await db
      .select({
        name: clientWechatUsers.name,
        phone: clientWechatUsers.phone,
        boundStoreId: clientWechatUsers.boundStoreId,
        memberLevel: clientWechatUsers.memberLevel,
      })
      .from(clientWechatUsers)
      .where(and(eq(clientWechatUsers.userId, userId), scopeCondition(session, clientWechatUsers.boundStoreId)))
      .limit(1)

    if (!cust) {
      return { success: false, message: '顾客不存在或无权操作' }
    }

    let result: any
    try {
      result = await db
        .delete(clientWechatUsers)
        .where(and(eq(clientWechatUsers.userId, userId), scopeCondition(session, clientWechatUsers.boundStoreId)))
    } catch (e) {
      if (pgErrorCode(e) === '23503') {
        return { success: false, message: '该顾客已有业务关联（订单 / 服务 / 预约 / 积分 / 储值卡 / 优惠券等），无法删除' }
      }
      throw e
    }
    if ((result as any).count === 0) {
      return { success: false, message: '顾客状态已变更，请刷新重试' }
    }

    await logOperation(session, 'customer.delete', 'customer', userId, {
      snapshot: { name: cust.name, phone: cust.phone, boundStoreId: cust.boundStoreId, memberLevel: cust.memberLevel },
    })

    const { revalidatePath } = await import('next/cache')
    revalidatePath('/customers')
    return { success: true, message: '顾客已删除' }
  },
)
