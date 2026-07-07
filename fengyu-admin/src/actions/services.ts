'use server'

import { db } from '@/db'
import { serviceOrders, serviceItems, serviceReviews } from '@db/service'
import { serviceCommissions } from '@db/service-commission'
import { saleItems, saleOrders } from '@db/order'
import { productSkus, productCategories } from '@db/product'
import { stores } from '@db/org'
import { staffWechatUsers, clientWechatUsers } from '@db/user'
import { appointments } from '@db/appointment'
import { eq, desc, and, or, sql, ilike, gte, lte, isNotNull, notExists, inArray } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { ServiceOrder } from '@/lib/types'
import { scopeCondition, isInScope, isAdminScope } from '@/lib/permissions'
import { withPermission } from '@/lib/with-permission'
import { logOperation, logTransition } from '@/lib/operation-log'
import { ApiError } from '@/lib/api-error'
import { pgErrorCode } from '@/lib/pg-error'
import { hasPendingRefundByServiceOrder } from '@/lib/refund-cascade'
import { parseServiceOrderFilters, parseAllocationServiceFilters } from '@/lib/list-filters'
import { nowTs } from '@/lib/db-time'

function serializeServiceOrder(r: {
  service_order: typeof serviceOrders.$inferSelect
  storeName: string | null
  employeeName: string | null
  customerName: string | null
}): ServiceOrder {
  const so = r.service_order
  return {
    serviceOrderId: so.serviceOrderId,
    status: so.status as ServiceOrder['status'],
    serviceOrderType: so.serviceOrderType as ServiceOrder['serviceOrderType'],
    marketName: so.marketName,
    storeId: so.storeId,
    serviceDate: so.serviceDate,
    assignedEmployeeId: so.assignedEmployeeId,
    remark: so.remark,
    appointmentId: so.appointmentId,
    clientUserId: so.clientUserId,
    commissionStatus: so.commissionStatus ?? undefined,
    createdAt: so.createdAt.toISOString(),
    updatedAt: so.updatedAt.toISOString(),
    storeName: r.storeName ?? undefined,
    employeeName: r.employeeName ?? undefined,
    customerName: r.customerName ?? undefined,
  }
}

export const getServiceOrders = withPermission(
  'service:list',
  async (session): Promise<ServiceOrder[]> => {
  const rows = await db
    .select({
      service_order: serviceOrders,
      storeName: stores.storeName,
      employeeName: staffWechatUsers.name,
      customerName: clientWechatUsers.name,
    })
    .from(serviceOrders)
    .leftJoin(stores, eq(serviceOrders.storeId, stores.storeId))
    .leftJoin(staffWechatUsers, eq(serviceOrders.assignedEmployeeId, staffWechatUsers.employeeId))
    .leftJoin(clientWechatUsers, eq(serviceOrders.clientUserId, clientWechatUsers.userId))
    .where(scopeCondition(session, serviceOrders.storeId))
    
    .orderBy(desc(serviceOrders.updatedAt), desc(serviceOrders.createdAt))
    .limit(500)

  return rows.map(serializeServiceOrder)
  },
)


export interface ServiceOrderFilters {
  status?: string
  storeId?: string
  dateFrom?: string
  dateTo?: string
  search?: string
  
  commissionStatus?: string
  page?: number
  pageSize?: number
}


function buildServiceOrderConditions(
  session: Parameters<typeof scopeCondition>[0],
  filters: ServiceOrderFilters,
): (SQL | undefined)[] {
  const conditions: (SQL | undefined)[] = [
    scopeCondition(session, serviceOrders.storeId),
  ]

  if (filters.status) {
    conditions.push(eq(serviceOrders.status, filters.status as typeof serviceOrders.status.enumValues[number]))
  }
  if (filters.storeId) {
    conditions.push(eq(serviceOrders.storeId, filters.storeId))
  }
  if (filters.dateFrom) {
    conditions.push(gte(serviceOrders.serviceDate, filters.dateFrom))
  }
  if (filters.dateTo) {
    conditions.push(lte(serviceOrders.serviceDate, filters.dateTo))
  }
  if (filters.search) {
    const pattern = `%${filters.search}%`
    conditions.push(
      or(
        ilike(serviceOrders.serviceOrderId, pattern),
        
        sql`EXISTS (SELECT 1 FROM staff_wechat_users sw WHERE sw.employee_id = ${serviceOrders.assignedEmployeeId} AND sw.name ILIKE ${pattern})`,
        sql`EXISTS (SELECT 1 FROM client_wechat_users cw WHERE cw.user_id = ${serviceOrders.clientUserId} AND cw.name ILIKE ${pattern})`,
      ),
    )
  }
  if (filters.commissionStatus === '待分配' || filters.commissionStatus === '已分配') {
    conditions.push(eq(serviceOrders.commissionStatus, filters.commissionStatus))
  }

  return conditions
}


export interface PaginatedServiceOrders {
  data: ServiceOrder[]
  total: number
}


export const getServiceOrdersPaginated = withPermission(
  'service:list',
  async (session, filters: ServiceOrderFilters = {}): Promise<PaginatedServiceOrders> => {
  const page = Math.max(1, filters.page || 1)
  const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
  const offset = (page - 1) * pageSize

  
  const whereClause = and(...buildServiceOrderConditions(session, filters))

  
  const [countRow] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(serviceOrders)
    .where(whereClause)

  const total = countRow?.count ?? 0

  
  const rows = await db
    .select({
      service_order: serviceOrders,
      storeName: stores.storeName,
      employeeName: staffWechatUsers.name,
      customerName: clientWechatUsers.name,
    })
    .from(serviceOrders)
    .leftJoin(stores, eq(serviceOrders.storeId, stores.storeId))
    .leftJoin(staffWechatUsers, eq(serviceOrders.assignedEmployeeId, staffWechatUsers.employeeId))
    .leftJoin(clientWechatUsers, eq(serviceOrders.clientUserId, clientWechatUsers.userId))
    .where(whereClause)
    
    .orderBy(desc(serviceOrders.updatedAt), desc(serviceOrders.createdAt))
    .limit(pageSize)
    .offset(offset)

  return { data: rows.map(serializeServiceOrder), total }
  },
)


export interface ExportServiceOrderRow {
  serviceOrderId: string
  status: string
  serviceOrderType: string
  customerName: string | null
  clientPhone: string | null
  storeName: string | null
  employeeName: string | null
  serviceDate: string | null
  createdAt: string
  itemsSummary: string
}


export const exportServiceOrders = withPermission(
  'service:list',
  async (
    session,
    params: Record<string, string | undefined>,
  ): Promise<{ rows: ExportServiceOrderRow[]; truncated: boolean }> => {
    const LIMIT = 10000
    const filters = parseServiceOrderFilters(params)
    const whereClause = and(...buildServiceOrderConditions(session, filters))

    const orderRows = await db
      .select({
        service_order: serviceOrders,
        storeName: stores.storeName,
        employeeName: staffWechatUsers.name,
        customerName: clientWechatUsers.name,
        clientPhone: clientWechatUsers.phone,
      })
      .from(serviceOrders)
      .leftJoin(stores, eq(serviceOrders.storeId, stores.storeId))
      .leftJoin(staffWechatUsers, eq(serviceOrders.assignedEmployeeId, staffWechatUsers.employeeId))
      .leftJoin(clientWechatUsers, eq(serviceOrders.clientUserId, clientWechatUsers.userId))
      .where(whereClause)
      .orderBy(desc(serviceOrders.updatedAt), desc(serviceOrders.createdAt))
      .limit(LIMIT + 1)

    const truncated = orderRows.length > LIMIT
    const page = truncated ? orderRows.slice(0, LIMIT) : orderRows
    const ids = page.map((r) => r.service_order.serviceOrderId)

    
    const itemsMap = new Map<string, string[]>()
    if (ids.length > 0) {
      const itemRows = await db
        .select({
          serviceOrderId: serviceItems.serviceOrderId,
          sessionUsed: serviceItems.sessionUsed,
          productName: saleItems.productName,
          skuName: productSkus.specName,
        })
        .from(serviceItems)
        .leftJoin(saleItems, eq(serviceItems.saleItemId, saleItems.saleItemId))
        .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
        .where(inArray(serviceItems.serviceOrderId, ids))
      for (const it of itemRows) {
        const name = it.productName ?? it.skuName ?? '—'
        const arr = itemsMap.get(it.serviceOrderId) ?? []
        arr.push(`${name}x${it.sessionUsed}`)
        itemsMap.set(it.serviceOrderId, arr)
      }
    }

    const rows: ExportServiceOrderRow[] = page.map((r) => ({
      serviceOrderId: r.service_order.serviceOrderId,
      status: r.service_order.status,
      serviceOrderType: r.service_order.serviceOrderType,
      customerName: r.customerName,
      clientPhone: r.clientPhone,
      storeName: r.storeName,
      employeeName: r.employeeName,
      serviceDate: r.service_order.serviceDate,
      createdAt: r.service_order.createdAt.toISOString(),
      itemsSummary: (itemsMap.get(r.service_order.serviceOrderId) ?? []).join('、'),
    }))

    return { rows, truncated }
  },
)


export interface ExportAllocationServiceRow {
  market: string | null
  storeName: string | null
  serviceOrderId: string
  saleOrderType: string | null
  serviceOrderType: string | null
  customerName: string | null
  customerPhone: string | null
  productType: string | null
  categoryL1: string | null
  categoryL2: string | null
  productName: string | null
  sessionUsed: number | null
  consumeMoney: number | null
  unitRealPrice: number | null
  status: string | null
  employeeName: string | null
  positionName: string | null
  allocationRatio: string | null
  allocationAmount: number | null
  commissionRate: string | null
  commissionAmount: number | null
  rating: number | null
  reviewComment: string | null
  salesCategory: string | null
  customerType: string | null
  openedByName: string | null
  sourceSaleOrderId: string | null
  serviceDate: string | null
  createdAt: string | null
  remark: string | null
}


export const exportAllocationServiceOrders = withPermission(
  'service:list',
  async (
    session,
    params: Record<string, string | undefined>,
  ): Promise<{ rows: ExportAllocationServiceRow[]; truncated: boolean }> => {
    const LIMIT = 10000
    const filters = parseAllocationServiceFilters(params)
    
    const whereClause = and(
      eq(serviceCommissions.isVoid, false),
      ...buildServiceOrderConditions(session, filters),
    )

    
    
    const openedByStaff = alias(staffWechatUsers, 'staff_opened_by') as unknown as typeof staffWechatUsers

    const raw = await db
      .select({
        market: serviceOrders.marketName,
        storeName: stores.storeName,
        serviceOrderId: serviceOrders.serviceOrderId,
        saleOrderType: saleOrders.saleOrderType,
        serviceOrderType: serviceOrders.serviceOrderType,
        customerName: clientWechatUsers.name,
        customerPhone: clientWechatUsers.phone,
        fallbackPhone: saleOrders.clientPhone,
        productType: saleItems.productType,
        categoryL1: productCategories.categoryName,
        categoryL2: productCategories.productKind,
        productName: saleItems.productName,
        sessionUsed: serviceItems.sessionUsed,
        unitRealPrice: serviceItems.unitRealPrice,
        status: serviceOrders.status,
        employeeName: staffWechatUsers.name,
        positionName: staffWechatUsers.positionName,
        allocationRatio: serviceCommissions.allocationRatio,
        commissionRate: serviceCommissions.commissionRate,
        commissionAmount: serviceCommissions.commissionAmount,
        rating: serviceReviews.rating,
        reviewComment: serviceReviews.comment,
        salesCategory: serviceItems.salesCategory,
        customerType: clientWechatUsers.customerType,
        openedByName: openedByStaff.name,
        sourceSaleOrderId: saleItems.saleOrderId,
        serviceDate: serviceOrders.serviceDate,
        createdAt: serviceOrders.createdAt,
        remark: serviceOrders.remark,
        scId: serviceCommissions.id,
      })
      .from(serviceCommissions)
      .innerJoin(serviceItems, eq(serviceCommissions.serviceItemId, serviceItems.serviceItemId))
      .innerJoin(serviceOrders, eq(serviceItems.serviceOrderId, serviceOrders.serviceOrderId))
      .leftJoin(saleItems, eq(serviceItems.saleItemId, saleItems.saleItemId))
      .leftJoin(saleOrders, eq(saleItems.saleOrderId, saleOrders.saleOrderId))
      .leftJoin(stores, eq(serviceOrders.storeId, stores.storeId))
      .leftJoin(clientWechatUsers, eq(serviceOrders.clientUserId, clientWechatUsers.userId))
      .leftJoin(staffWechatUsers, eq(serviceCommissions.employeeId, staffWechatUsers.employeeId))
      .leftJoin(openedByStaff, eq(saleOrders.openedBy, openedByStaff.employeeId))
      .leftJoin(serviceReviews, eq(serviceOrders.serviceOrderId, serviceReviews.serviceOrderId))
      .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
      .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
      .where(whereClause)
      .orderBy(desc(serviceOrders.updatedAt), desc(serviceOrders.createdAt), serviceCommissions.id)
      .limit(LIMIT + 1)

    const truncated = raw.length > LIMIT
    const page = truncated ? raw.slice(0, LIMIT) : raw

    const round2 = (n: number) => Math.round(n * 100) / 100
    const rows: ExportAllocationServiceRow[] = page.map((r) => {
      const unit = r.unitRealPrice == null ? null : Number(r.unitRealPrice)
      const sessions = r.sessionUsed ?? null
      const consumeMoney = unit == null || sessions == null ? null : round2(unit * sessions)
      const ratioNum = r.allocationRatio == null ? null : Number(r.allocationRatio)
      const allocationAmount =
        consumeMoney == null || ratioNum == null ? null : round2(consumeMoney * ratioNum)
      return {
        market: r.market,
        storeName: r.storeName,
        serviceOrderId: r.serviceOrderId,
        saleOrderType: r.saleOrderType,
        serviceOrderType: r.serviceOrderType,
        customerName: r.customerName,
        customerPhone: r.customerPhone ?? r.fallbackPhone ?? null,
        productType: r.productType,
        categoryL1: r.categoryL1,
        categoryL2: r.categoryL2,
        productName: r.productName,
        sessionUsed: sessions,
        consumeMoney,
        unitRealPrice: unit,
        status: r.status,
        employeeName: r.employeeName,
        positionName: r.positionName,
        allocationRatio: r.allocationRatio,
        allocationAmount,
        commissionRate: r.commissionRate,
        commissionAmount: r.commissionAmount == null ? null : Number(r.commissionAmount),
        rating: r.rating ?? null,
        reviewComment: r.reviewComment,
        salesCategory: r.salesCategory,
        customerType: r.customerType,
        openedByName: r.openedByName,
        sourceSaleOrderId: r.sourceSaleOrderId,
        serviceDate: r.serviceDate,
        createdAt: r.createdAt ? r.createdAt.toISOString() : null,
        remark: r.remark,
      }
    })

    return { rows, truncated }
  },
)

export const getServiceOrderById = withPermission(
  'service:list',
  async (session, serviceOrderId: string): Promise<ServiceOrder | null> => {
  
  
  const rows = await db
    .select({
      service_order: serviceOrders,
      storeName: stores.storeName,
      employeeName: staffWechatUsers.name,
      customerName: clientWechatUsers.name,
    })
    .from(serviceOrders)
    .leftJoin(stores, eq(serviceOrders.storeId, stores.storeId))
    .leftJoin(staffWechatUsers, eq(serviceOrders.assignedEmployeeId, staffWechatUsers.employeeId))
    .leftJoin(clientWechatUsers, eq(serviceOrders.clientUserId, clientWechatUsers.userId))
    .where(eq(serviceOrders.serviceOrderId, serviceOrderId))
    .limit(1)

  if (rows.length === 0) return null
  return {
    ...serializeServiceOrder(rows[0]),
    readOnly: !isInScope(session, rows[0].service_order.storeId),
  }
  },
)

export interface ServiceItemDetail {
  serviceItemId: string
  saleItemId: string
  sessionUsed: number
  unitRealPrice: string | null
  employeeName: string | null
  employeeId: string | null
  productName: string | null
  skuName: string | null
  salesCategory: string | null
  remainingSessions: number | null
  sessionCount: number | null
  paidSessions: number | null
  quantity: number | null
}

export const getServiceItems = withPermission(
  'service:list',
  async (_session, serviceOrderId: string): Promise<ServiceItemDetail[]> => {
  const rows = await db.execute(sql`
    SELECT
      si.service_item_id,
      si.sale_item_id,
      si.session_used,
      si.unit_real_price,
      si.employee_id,
      e.name AS employee_name,
      sli.product_name,
      sli.product_name AS sku_name,
      sli.sales_category,
      sli.remaining_sessions,
      sli.session_count,
      sli.paid_sessions,
      sli.quantity AS sli_quantity
    FROM service_items si
    LEFT JOIN staff_wechat_users e ON e.employee_id = si.employee_id
    LEFT JOIN sale_items sli ON sli.sale_item_id = si.sale_item_id
    WHERE si.service_order_id = ${serviceOrderId}
  `)

  return (rows as any[]).map((r: any) => ({
    serviceItemId: r.service_item_id,
    saleItemId: r.sale_item_id,
    sessionUsed: Number(r.session_used),
    unitRealPrice: r.unit_real_price,
    employeeName: r.employee_name,
    employeeId: r.employee_id,
    productName: r.product_name,
    skuName: r.sku_name,
    salesCategory: r.sales_category ?? null,
    remainingSessions: r.remaining_sessions !== null ? Number(r.remaining_sessions) : null,
    sessionCount: r.session_count !== null ? Number(r.session_count) : null,
    paidSessions: r.paid_sessions !== null && r.paid_sessions !== undefined ? Number(r.paid_sessions) : null,
    quantity: r.sli_quantity !== null && r.sli_quantity !== undefined ? Number(r.sli_quantity) : null,
  }))
  },
)


export interface ServiceReview {
  rating: number
  comment: string | null
  createdAt: string
}

export const getServiceReview = withPermission(
  'service:list',
  async (_session, serviceOrderId: string): Promise<ServiceReview | null> => {
    const rows = await db
      .select({
        rating: serviceReviews.rating,
        comment: serviceReviews.comment,
        createdAt: serviceReviews.createdAt,
      })
      .from(serviceReviews)
      .where(eq(serviceReviews.serviceOrderId, serviceOrderId))
      .limit(1)
    if (rows.length === 0) return null
    return {
      rating: rows[0].rating,
      comment: rows[0].comment,
      createdAt: rows[0].createdAt.toISOString(),
    }
  },
)


export interface AvailableSaleItem {
  saleItemId: string
  saleOrderId: string
  productName: string | null
  productType: string | null
  sessionCount: number | null
  remainingSessions: number | null
  paidSessions: number | null
  
  paidUnusedSessions: number
  unitRealPrice: string
  expireDate: string | null
}

export const getAvailableSaleItems = withPermission(
  'service:create',
  async (_session, clientUserId: string): Promise<AvailableSaleItem[]> => {
  const rows = await db.execute(sql`
    SELECT
      si.sale_item_id,
      si.sale_order_id,
      si.product_name,
      si.product_type,
      si.session_count,
      si.remaining_sessions,
      si.paid_sessions,
      si.unit_real_price,
      si.expire_date
    FROM sale_items si
    INNER JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
    WHERE o.client_user_id = ${clientUserId}
      AND o.status IN ('已支付', '部分支付')
      AND si.item_direction = '购买'
      AND si.product_type = '疗程卡'
      AND si.remaining_sessions IS NOT NULL
      AND si.remaining_sessions > 0
      AND (si.expire_date IS NULL OR si.expire_date > CURRENT_DATE)
      -- 在途退款冻结：原订单存在 '待审批' 退款时排除整单的卡
      AND NOT EXISTS (
        SELECT 1 FROM sale_order_payments sop
        WHERE sop.sale_order_id = o.sale_order_id
          AND sop.change_type = '退款' AND sop.status = '待审批'
      )
      -- #5 收紧到「已付未用」口径：只列出还有已付未用次数的卡（paid <= used 即欠款已用满则排除）。
      -- 推翻 2026-05-20 D6=A 放宽决策，与 staff service-create 的 consumable 门控对齐。
      -- 历史 NULL 行（paid_sessions IS NULL）视作物理剩余可用，不排除。
      AND (
        si.paid_sessions IS NULL
        OR si.paid_sessions > (si.session_count - si.remaining_sessions)
      )
    ORDER BY o.paid_at DESC, si.sale_item_id
  `)

  return (rows as any[]).map((r: any) => {
    const total = r.session_count !== null ? Number(r.session_count) : 0
    const remain = r.remaining_sessions !== null ? Number(r.remaining_sessions) : 0
    const paid = (r.paid_sessions !== null && r.paid_sessions !== undefined) ? Number(r.paid_sessions) : null
    const used = Math.max(total - remain, 0)
    return {
      saleItemId: r.sale_item_id,
      saleOrderId: r.sale_order_id,
      productName: r.product_name,
      productType: r.product_type,
      sessionCount: r.session_count !== null ? Number(r.session_count) : null,
      remainingSessions: r.remaining_sessions !== null ? Number(r.remaining_sessions) : null,
      paidSessions: r.paid_sessions !== null && r.paid_sessions !== undefined ? Number(r.paid_sessions) : null,
      paidUnusedSessions: paid === null ? remain : Math.max(0, paid - used),
      unitRealPrice: r.unit_real_price ?? '0',
      expireDate: r.expire_date,
    }
  })
  },
)


export const startServiceOrder = withPermission(
  'service:update',
  async (session, serviceOrderId: string): Promise<{ success: boolean; message: string }> => {
  
  const [svcCtx] = await db
    .select({
      assignedEmployeeId: serviceOrders.assignedEmployeeId,
      employeeName: staffWechatUsers.name,
      clientUserId: serviceOrders.clientUserId,
      customerName: clientWechatUsers.name,
    })
    .from(serviceOrders)
    .leftJoin(staffWechatUsers, eq(serviceOrders.assignedEmployeeId, staffWechatUsers.employeeId))
    .leftJoin(clientWechatUsers, eq(serviceOrders.clientUserId, clientWechatUsers.userId))
    .where(eq(serviceOrders.serviceOrderId, serviceOrderId))
    .limit(1)

  let result: any
  try {
    result = await db
      .update(serviceOrders)
      .set({ status: '服务中', startedAt: nowTs() })
      .where(and(
        eq(serviceOrders.serviceOrderId, serviceOrderId),
        eq(serviceOrders.status, '待服务'),
        scopeCondition(session, serviceOrders.storeId),
      ))
  } catch {
    return { success: false, message: '开始服务失败，请稍后重试' }
  }

  if ((result as any).count === 0) {
    return { success: false, message: '服务单状态已变更，无法开始' }
  }

  await logTransition(session, 'service.start', 'service_order', serviceOrderId, '待服务', '服务中', {
    employeeName: svcCtx?.employeeName, customerName: svcCtx?.customerName,
  })

  revalidatePath('/services')
  return { success: true, message: '服务已开始' }
  },
)


export const completeServiceOrder = withPermission(
  'service:update',
  async (session, serviceOrderId: string): Promise<{ success: boolean; message: string }> => {
  
  const [svcCtx] = await db
    .select({
      storeId: serviceOrders.storeId,
      employeeName: staffWechatUsers.name,
      customerName: clientWechatUsers.name,
    })
    .from(serviceOrders)
    .leftJoin(staffWechatUsers, eq(serviceOrders.assignedEmployeeId, staffWechatUsers.employeeId))
    .leftJoin(clientWechatUsers, eq(serviceOrders.clientUserId, clientWechatUsers.userId))
    .where(eq(serviceOrders.serviceOrderId, serviceOrderId))
    .limit(1)

  if (!isAdminScope(session)) {
    const scopeStoreIds = session.permissions.scopeStoreIds
    if (scopeStoreIds.length === 0 || !svcCtx || !scopeStoreIds.includes(svcCtx.storeId)) {
      return { success: false, message: '无权操作该服务单' }
    }
  }

  let result: any
  try {
    result = await db
      .update(serviceOrders)
      .set({ status: '待客户确认', staffCompletedAt: nowTs() })
      .where(and(
        eq(serviceOrders.serviceOrderId, serviceOrderId),
        eq(serviceOrders.status, '服务中'),
        scopeCondition(session, serviceOrders.storeId),
      ))
  } catch {
    return { success: false, message: '标记完成失败，请稍后重试' }
  }

  if ((result as any).count === 0) {
    return { success: false, message: '服务单状态已变更，无法完成' }
  }

  await logTransition(session, 'service.complete', 'service_order', serviceOrderId, '服务中', '待客户确认', {
    employeeName: svcCtx?.employeeName, customerName: svcCtx?.customerName,
  })

  revalidatePath('/services')
  return { success: true, message: '已标记完成，待客户确认' }
  },
)


export const confirmServiceOrder = withPermission(
  'service:update',
  async (session, serviceOrderId: string): Promise<{ success: boolean; message: string }> => {
  
  const [svcCtx] = await db
    .select({
      storeId: serviceOrders.storeId,
      employeeName: staffWechatUsers.name,
      customerName: clientWechatUsers.name,
    })
    .from(serviceOrders)
    .leftJoin(staffWechatUsers, eq(serviceOrders.assignedEmployeeId, staffWechatUsers.employeeId))
    .leftJoin(clientWechatUsers, eq(serviceOrders.clientUserId, clientWechatUsers.userId))
    .where(eq(serviceOrders.serviceOrderId, serviceOrderId))
    .limit(1)

  if (!isAdminScope(session)) {
    const scopeStoreIds = session.permissions.scopeStoreIds
    if (scopeStoreIds.length === 0 || !svcCtx || !scopeStoreIds.includes(svcCtx.storeId)) {
      return { success: false, message: '无权操作该服务单' }
    }
  }

  
  if (await hasPendingRefundByServiceOrder(db, serviceOrderId)) {
    return { success: false, message: '关联订单退款审批中，暂不可确认' }
  }

  let result: any
  try {
    
    
    
    
    result = await db.execute(sql`
      WITH status_check AS (
        UPDATE service_orders
        SET status = '已完成', completed_at = NOW(), updated_at = NOW()
        WHERE service_order_id = ${serviceOrderId} AND status = '待客户确认'
        RETURNING service_order_id
      ),
      deduct AS (
        UPDATE sale_items
        SET remaining_sessions = remaining_sessions - si.session_used,
            updated_at = NOW()
        FROM service_items si
        WHERE sale_items.sale_item_id = si.sale_item_id
          AND si.service_order_id = ${serviceOrderId}
          AND sale_items.remaining_sessions >= si.session_used
          AND (sale_items.session_count - sale_items.remaining_sessions + si.session_used) <= COALESCE(sale_items.paid_sessions, sale_items.session_count)
          AND EXISTS (SELECT 1 FROM status_check)
        RETURNING sale_items.sale_item_id
      ),
      total_items AS (
        SELECT COUNT(*) AS n FROM service_items WHERE service_order_id = ${serviceOrderId}
      )
      SELECT
        (SELECT COUNT(*) FROM status_check) AS status_updated,
        (SELECT COUNT(*) FROM deduct) AS items_deducted,
        (SELECT n FROM total_items) AS items_total
    `)
  } catch {
    return { success: false, message: '确认服务失败，请稍后重试' }
  }

  const row = (result as any[])[0]
  if (!row || Number(row.status_updated) === 0) {
    return { success: false, message: '服务单状态已变更，无法确认' }
  }
  
  if (row && Number(row.items_deducted) < Number(row.items_total)) {
    return { success: false, message: '部分服务行已支付次数不足，请先完成订单付款后再确认服务' }
  }

  await logTransition(session, 'service.confirm', 'service_order', serviceOrderId, '待客户确认', '已完成', {
    employeeName: svcCtx?.employeeName, customerName: svcCtx?.customerName,
  })

  revalidatePath('/services')
  return { success: true, message: '服务已确认完成' }
  },
)


export const cancelServiceOrder = withPermission(
  'service:update',
  async (session, serviceOrderId: string): Promise<{ success: boolean; message: string }> => {
  
  const [svcCtx] = await db
    .select({ customerName: clientWechatUsers.name })
    .from(serviceOrders)
    .leftJoin(clientWechatUsers, eq(serviceOrders.clientUserId, clientWechatUsers.userId))
    .where(eq(serviceOrders.serviceOrderId, serviceOrderId))
    .limit(1)

  let cancelResult: any
  try {
    cancelResult = await db
      .update(serviceOrders)
      .set({ status: '已取消' })
      .where(and(
        eq(serviceOrders.serviceOrderId, serviceOrderId),
        eq(serviceOrders.status, '待服务'),
        scopeCondition(session, serviceOrders.storeId),
      ))
  } catch {
    return { success: false, message: '取消服务失败，请稍后重试' }
  }

  if ((cancelResult as any).count === 0) {
    return { success: false, message: '服务单状态已变更，无法取消' }
  }

  await logTransition(session, 'service.cancel', 'service_order', serviceOrderId, '待服务', '已取消', {
    customerName: svcCtx?.customerName,
  })

  revalidatePath('/services')
  return { success: true, message: '服务已取消' }
  },
)


export const deleteServiceOrder = withPermission(
  'service:delete',
  async (session, serviceOrderId: string): Promise<{ success: boolean; message: string }> => {
    const [svc] = await db
      .select({
        status: serviceOrders.status,
        serviceDate: serviceOrders.serviceDate,
        assignedEmployeeId: serviceOrders.assignedEmployeeId,
        commissionStatus: serviceOrders.commissionStatus,
      })
      .from(serviceOrders)
      .where(and(eq(serviceOrders.serviceOrderId, serviceOrderId), scopeCondition(session, serviceOrders.storeId)))
      .limit(1)

    if (!svc) {
      return { success: false, message: '服务单不存在或无权操作' }
    }
    if (svc.status !== '待服务' && svc.status !== '已取消') {
      return { success: false, message: '仅「待服务 / 已取消」服务单可删除（进行中或已完成不可删）' }
    }

    try {
      const txResult = await db.transaction(async (tx) => {
        await tx.execute(sql`
          DELETE FROM service_commissions
          WHERE service_item_id IN (SELECT service_item_id FROM service_items WHERE service_order_id = ${serviceOrderId})
        `)
        await tx.execute(sql`DELETE FROM service_items WHERE service_order_id = ${serviceOrderId}`)
        await tx.execute(sql`DELETE FROM service_reviews WHERE service_order_id = ${serviceOrderId}`)

        const result = await tx
          .delete(serviceOrders)
          .where(and(
            eq(serviceOrders.serviceOrderId, serviceOrderId),
            inArray(serviceOrders.status, ['待服务', '已取消']),
            scopeCondition(session, serviceOrders.storeId),
          ))
        if ((result as any).count === 0) {
          throw new Error('SERVICE_STATE_CHANGED')
        }
        return true
      })
      if (!txResult) {
        return { success: false, message: '服务单状态已变更，请刷新重试' }
      }
    } catch (e) {
      if (e instanceof Error && e.message === 'SERVICE_STATE_CHANGED') {
        return { success: false, message: '服务单状态已变更，请刷新重试' }
      }
      if (pgErrorCode(e) === '23503') {
        return { success: false, message: '服务单存在关联业务数据，无法删除' }
      }
      throw e
    }

    await logOperation(session, 'service.delete', 'service_order', serviceOrderId, {
      snapshot: {
        status: svc.status,
        serviceDate: svc.serviceDate,
        assignedEmployeeId: svc.assignedEmployeeId,
        commissionStatus: svc.commissionStatus,
      },
    })

    revalidatePath('/services')
    revalidatePath('/allocations')
    return { success: true, message: '服务单已删除' }
  },
)


export const createServiceOrder = withPermission(
  'service:create',
  async (
    session,
    data: {
  storeId: string
  marketName: string
  clientUserId: string
  assignedEmployeeId: string
  serviceDate: string
  remark?: string | null
  items: Array<{
    saleItemId: string
    sessionUsed: number
  }>
    },
  ): Promise<{ success: boolean; message: string; serviceOrderId?: string }> => {
  
  if (!isInScope(session, data.storeId)) {
    return { success: false, message: '无权在该门店创建服务单' }
  }

  
  
  const [customerRow] = await db
    .select({ becameMemberAt: clientWechatUsers.becameMemberAt, boundStoreId: clientWechatUsers.boundStoreId })
    .from(clientWechatUsers)
    .where(eq(clientWechatUsers.userId, data.clientUserId))
    .limit(1)
  
  if (customerRow?.boundStoreId !== data.storeId) {
    return { success: false, message: '顾客当前绑定门店非该门店，疗程卡只能在其绑定门店核销/开单' }
  }
  const serviceOrderType: '售前' | '售后' =
    customerRow?.becameMemberAt && customerRow.becameMemberAt <= new Date() ? '售后' : '售前'

  
  const [pendingAppt] = await db
    .select({ appointmentId: appointments.appointmentId })
    .from(appointments)
    .where(
      and(
        eq(appointments.clientUserId, data.clientUserId),
        eq(appointments.storeId, data.storeId),
        eq(appointments.status, '已确认'),
        isNotNull(appointments.checkinAt),
        notExists(
          db.select({ id: serviceOrders.serviceOrderId })
            .from(serviceOrders)
            .where(eq(serviceOrders.appointmentId, appointments.appointmentId))
        ),
      )
    )
    .orderBy(desc(appointments.checkinAt))
    .limit(1)
  const resolvedAppointmentId = pendingAppt?.appointmentId ?? null

  
  
  
  
  const saleItemSnapshots: Array<{
    saleItemId: string
    unitRealPrice: string
    isShengmei: boolean | null
    salesCategory: (typeof saleItems.$inferInsert)['salesCategory']
  }> = []
  for (const item of data.items) {
    const [saleItem] = await db
      .select({
        sessionCount: saleItems.sessionCount,
        remainingSessions: saleItems.remainingSessions,
        paidSessions: saleItems.paidSessions,
        unitRealPrice: saleItems.unitRealPrice,
        saleOrderType: saleOrders.saleOrderType,
        orderStatus: saleOrders.status,
        
        
        isShengmei: sql<boolean | null>`COALESCE(${saleItems.isShengmei}, ${productSkus.isShengmei})`,
        salesCategory: sql<(typeof saleItems.$inferInsert)['salesCategory']>`COALESCE(${saleItems.salesCategory}, ${productCategories.salesCategory})`,
        hasPendingRefund: sql<boolean>`EXISTS (SELECT 1 FROM sale_order_payments sop WHERE sop.sale_order_id = ${saleOrders.saleOrderId} AND sop.change_type = '退款' AND sop.status = '待审批')`,
        hasApprovedRefund: sql<boolean>`EXISTS (SELECT 1 FROM sale_order_payments sop WHERE sop.sale_order_id = ${saleOrders.saleOrderId} AND sop.change_type = '退款' AND sop.status = '已支付')`,
      })
      .from(saleItems)
      .innerJoin(saleOrders, eq(saleItems.saleOrderId, saleOrders.saleOrderId))
      .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
      .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
      .where(eq(saleItems.saleItemId, item.saleItemId))
      .limit(1)

    if (!saleItem) {
      return { success: false, message: `销售明细 ${item.saleItemId} 不存在` }
    }
    
    if (saleItem.orderStatus && !['已支付', '部分支付'].includes(saleItem.orderStatus)) {
      return { success: false, message: `销售明细 ${item.saleItemId} 对应订单状态为 ${saleItem.orderStatus}，不可消费` }
    }
    
    if (saleItem.hasPendingRefund) {
      return { success: false, message: `销售明细 ${item.saleItemId} 对应订单退款审批中，不可开单` }
    }
    
    
    if (saleItem.remainingSessions != null) {
      const used = saleItem.sessionCount == null
        ? 0
        : Math.max(saleItem.sessionCount - saleItem.remainingSessions, 0)
      const paidUnused = saleItem.paidSessions == null
        ? saleItem.remainingSessions
        : Math.max(0, saleItem.paidSessions - used)
      if (paidUnused < item.sessionUsed) {
        return { success: false, message: `销售明细 ${item.saleItemId} 可用次数不足（已付未用 ${paidUnused}，需要 ${item.sessionUsed}）` }
      }
    }
    saleItemSnapshots.push({
      saleItemId: item.saleItemId,
      unitRealPrice: saleItem.unitRealPrice,
      isShengmei: saleItem.isShengmei ?? null,
      salesCategory: saleItem.salesCategory ?? null,
    })
  }

  
  let serviceOrderId: string
  try {
    serviceOrderId = await db.transaction(async (tx) => {
      const idRows = await tx.execute(sql`
        WITH lock AS (
          SELECT pg_advisory_xact_lock(hashtext('service_order_id_gen'))
        )
        SELECT 'FY-FW-' || to_char(NOW(), 'YYMMDD') ||
          LPAD(
            (SELECT COALESCE(MAX(
              CAST(NULLIF(SUBSTRING(service_order_id FROM '.{4}$'), '') AS INTEGER)
            ), 0) + 1
            FROM service_orders
            WHERE service_order_id LIKE 'FY-FW-' || to_char(NOW(), 'YYMMDD') || '%'
            )::TEXT, 4, '0'
          ) AS id
        FROM lock
      `)
      const id = (idRows as any[])[0]?.id as string
      if (!id) throw new ApiError('INVALID_STATE', '服务单号生成失败')

      await tx.insert(serviceOrders).values({
        serviceOrderId: id,
        status: '待服务',
        serviceOrderType,
        marketName: data.marketName,
        storeId: data.storeId,
        serviceDate: data.serviceDate,
        assignedEmployeeId: data.assignedEmployeeId,
        clientUserId: data.clientUserId,
        appointmentId: resolvedAppointmentId,
        remark: data.remark || null,
      })

      for (let i = 0; i < data.items.length; i++) {
        const item = data.items[i]
        const serviceItemId = `${id}-${String(i + 1).padStart(2, '0')}`
        const snapshot = saleItemSnapshots[i]

        await tx.insert(serviceItems).values({
          serviceItemId,
          serviceOrderId: id,
          saleItemId: item.saleItemId,
          sessionUsed: item.sessionUsed,
          unitRealPrice: snapshot.unitRealPrice || '0',
          employeeId: data.assignedEmployeeId,
          
          isShengmei: snapshot.isShengmei,
          salesCategory: snapshot.salesCategory,
        })
      }

      return id
    })
  } catch (err: any) {
    
    if (pgErrorCode(err) === '23503') {
      return { success: false, message: '关联数据不存在，请检查员工或顾客信息' }
    }
    throw err
  }

  await logOperation(session, 'service.create', 'service_order', serviceOrderId, {
    storeId: data.storeId, itemCount: data.items.length,
  })

  revalidatePath('/services')
  return { success: true, message: '服务单创建成功', serviceOrderId }
  },
)
