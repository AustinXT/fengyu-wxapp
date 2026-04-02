'use server'

import { db } from '@/db'
import { serviceOrders, serviceItems } from '@db/service'
import { saleItems, saleOrders } from '@db/order'
import { stores } from '@db/org'
import { staffWechatUsers, clientWechatUsers } from '@db/user'
import { eq, desc, and, or, sql, ilike, gte, lte } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { ServiceOrder } from '@/lib/types'
import { getSession } from '@/lib/auth'
import { requirePermission, scopeCondition, isInScope, isAdminScope } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'

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

export async function getServiceOrders(): Promise<ServiceOrder[]> {
  const session = await getSession()
  requirePermission(session, 'service:list')

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
    .orderBy(desc(serviceOrders.createdAt))
    .limit(500)

  return rows.map(serializeServiceOrder)
}

/** 服务单列表筛选参数 */
export interface ServiceOrderFilters {
  status?: string
  storeId?: string
  dateFrom?: string
  dateTo?: string
  search?: string
  page?: number
  pageSize?: number
}

/** 分页结果 */
export interface PaginatedServiceOrders {
  data: ServiceOrder[]
  total: number
}

/**
 * 服务端分页服务单列表 — DB 级过滤 + LIMIT/OFFSET
 *
 * 替代 getServiceOrders() 的客户端过滤模式。
 * 搜索支持：服务单号、顾客姓名、美容师姓名（跨表 ILIKE）。
 */
export async function getServiceOrdersPaginated(filters: ServiceOrderFilters = {}): Promise<PaginatedServiceOrders> {
  const session = await getSession()
  requirePermission(session, 'service:list')

  const page = Math.max(1, filters.page || 1)
  const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
  const offset = (page - 1) * pageSize

  // 构建 WHERE 条件（DB 级过滤）
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
        // 跨表搜索通过子查询实现，避免 JOIN 影响 COUNT
        sql`EXISTS (SELECT 1 FROM staff_wechat_users sw WHERE sw.employee_id = ${serviceOrders.assignedEmployeeId} AND sw.name ILIKE ${pattern})`,
        sql`EXISTS (SELECT 1 FROM client_wechat_users cw WHERE cw.user_id = ${serviceOrders.clientUserId} AND cw.name ILIKE ${pattern})`,
      ),
    )
  }

  const whereClause = and(...conditions)

  // COUNT 查询
  const [countRow] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(serviceOrders)
    .where(whereClause)

  const total = countRow?.count ?? 0

  // 数据查询 — JOIN + ORDER + LIMIT/OFFSET
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
    .orderBy(desc(serviceOrders.createdAt))
    .limit(pageSize)
    .offset(offset)

  return { data: rows.map(serializeServiceOrder), total }
}

export async function getServiceOrderById(serviceOrderId: string): Promise<ServiceOrder | null> {
  const session = await getSession()
  requirePermission(session, 'service:list')

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
    .where(and(eq(serviceOrders.serviceOrderId, serviceOrderId), scopeCondition(session, serviceOrders.storeId)))
    .limit(1)

  if (rows.length === 0) return null
  return serializeServiceOrder(rows[0])
}

export interface ServiceItemDetail {
  serviceItemId: string
  saleItemId: string
  sessionUsed: number
  unitRealPrice: string | null
  isPresale: boolean
  employeeName: string | null
  employeeId: string | null
  productName: string | null
  skuName: string | null
  salesCategory: string | null
  remainingSessions: number | null
  sessionCount: number | null
}

export async function getServiceItems(serviceOrderId: string): Promise<ServiceItemDetail[]> {
  const session = await getSession()
  requirePermission(session, 'service:list')

  const rows = await db.execute(sql`
    SELECT
      si.service_item_id,
      si.sale_item_id,
      si.session_used,
      si.unit_real_price,
      si.is_presale,
      si.employee_id,
      e.name AS employee_name,
      sli.product_name,
      sli.sku_spec_name AS sku_name,
      sli.sales_category,
      sli.remaining_sessions,
      sli.session_count
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
    isPresale: !!r.is_presale,
    employeeName: r.employee_name,
    employeeId: r.employee_id,
    productName: r.product_name,
    skuName: r.sku_name,
    salesCategory: r.sales_category ?? null,
    remainingSessions: r.remaining_sessions !== null ? Number(r.remaining_sessions) : null,
    sessionCount: r.session_count !== null ? Number(r.session_count) : null,
  }))
}

/** 顾客可用服务项目（已支付订单中有剩余次数的疗程卡/单品） */
export interface AvailableSaleItem {
  saleItemId: string
  saleOrderId: string
  productName: string | null
  skuSpecName: string | null
  productType: string | null
  sessionCount: number | null
  remainingSessions: number | null
  unitRealPrice: string
  expireDate: string | null
}

export async function getAvailableSaleItems(clientUserId: string): Promise<AvailableSaleItem[]> {
  const session = await getSession()
  requirePermission(session, 'service:create')

  const rows = await db.execute(sql`
    SELECT
      si.sale_item_id,
      si.sale_order_id,
      si.product_name,
      si.sku_spec_name,
      si.product_type,
      si.session_count,
      si.remaining_sessions,
      si.unit_real_price,
      si.expire_date
    FROM sale_items si
    INNER JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
    WHERE o.client_user_id = ${clientUserId}
      AND o.status = '已支付'
      AND si.item_direction = '购买'
      AND si.product_type IN ('疗程卡', '单品')
      AND si.remaining_sessions IS NOT NULL
      AND si.remaining_sessions > 0
      AND (si.expire_date IS NULL OR si.expire_date > CURRENT_DATE)
    ORDER BY o.paid_at DESC, si.sale_item_id
  `)

  return (rows as any[]).map((r: any) => ({
    saleItemId: r.sale_item_id,
    saleOrderId: r.sale_order_id,
    productName: r.product_name,
    skuSpecName: r.sku_spec_name,
    productType: r.product_type,
    sessionCount: r.session_count !== null ? Number(r.session_count) : null,
    remainingSessions: r.remaining_sessions !== null ? Number(r.remaining_sessions) : null,
    unitRealPrice: r.unit_real_price ?? '0',
    expireDate: r.expire_date,
  }))
}

/** C4: 开始服务 — WHERE status = '待服务' */
export async function startServiceOrder(serviceOrderId: string): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'service:update')

  let result: any
  try {
    result = await db
      .update(serviceOrders)
      .set({ status: '服务中', startedAt: new Date() })
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

  await logOperation(session, 'service.start', 'service_order', serviceOrderId)

  revalidatePath('/services')
  return { success: true, message: '服务已开始' }
}

/**
 * C1+C4: 完成服务 — 原子扣减 remaining_sessions + 状态推进
 * scope 通过预检查实现：非 admin 先验证服务单归属，再执行原子 SQL
 */
export async function completeServiceOrder(serviceOrderId: string): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'service:update')

  // 非 admin 需校验 scope（原子 SQL 不支持 Drizzle scopeCondition，此处预检查）
  if (!isAdminScope(session)) {
    const scopeStoreIds = session.permissions.scopeStoreIds
    if (scopeStoreIds.length === 0) return { success: false, message: '无权操作该服务单' }
    const [so] = await db
      .select({ storeId: serviceOrders.storeId })
      .from(serviceOrders)
      .where(eq(serviceOrders.serviceOrderId, serviceOrderId))
      .limit(1)
    if (!so || !scopeStoreIds.includes(so.storeId)) {
      return { success: false, message: '无权操作该服务单' }
    }
  }

  let result: any
  try {
    result = await db.execute(sql`
      WITH status_check AS (
        UPDATE service_orders
        SET status = '已完成', completed_at = NOW(), updated_at = NOW()
        WHERE service_order_id = ${serviceOrderId} AND status = '服务中'
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
          AND EXISTS (SELECT 1 FROM status_check)
        RETURNING sale_items.sale_item_id
      )
      SELECT
        (SELECT COUNT(*) FROM status_check) AS status_updated,
        (SELECT COUNT(*) FROM deduct) AS items_deducted
    `)
  } catch {
    return { success: false, message: '完成服务失败，请稍后重试' }
  }

  const row = (result as any[])[0]
  if (!row || Number(row.status_updated) === 0) {
    return { success: false, message: '服务单状态已变更，无法完成' }
  }

  await logOperation(session, 'service.complete', 'service_order', serviceOrderId)

  revalidatePath('/services')
  return { success: true, message: '服务已完成' }
}

/** C4: 取消服务 — WHERE status = '待服务'，不扣次数 */
export async function cancelServiceOrder(serviceOrderId: string): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'service:update')

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

  await logOperation(session, 'service.cancel', 'service_order', serviceOrderId)

  revalidatePath('/services')
  return { success: true, message: '服务已取消' }
}

/** 管理后台创建服务单 */
export async function createServiceOrder(data: {
  storeId: string
  marketName: string
  clientUserId: string
  assignedEmployeeId: string
  serviceDate: string
  appointmentId?: string | null
  remark?: string | null
  items: Array<{
    saleItemId: string
    sessionUsed: number
  }>
}): Promise<{ success: boolean; message: string; serviceOrderId?: string }> {
  const session = await getSession()
  requirePermission(session, 'service:create')

  // 校验 storeId 在用户 scope 内
  if (!isInScope(session, data.storeId)) {
    return { success: false, message: '无权在该门店创建服务单' }
  }

  // 根据顾客类型判定服务单类型：会员客→售后，其他→售前
  const [customerRow] = await db
    .select({ customerType: clientWechatUsers.customerType })
    .from(clientWechatUsers)
    .where(eq(clientWechatUsers.userId, data.clientUserId))
    .limit(1)
  const serviceOrderType = customerRow?.customerType === '会员客' ? '售后' : '售前'

  // 先校验剩余次数（事务外，只读查询）
  const saleItemSnapshots: Array<{ saleItemId: string; unitRealPrice: string; isPresale: boolean }> = []
  for (const item of data.items) {
    const [saleItem] = await db
      .select({
        remainingSessions: saleItems.remainingSessions,
        unitRealPrice: saleItems.unitRealPrice,
        saleOrderType: saleOrders.saleOrderType,
      })
      .from(saleItems)
      .innerJoin(saleOrders, eq(saleItems.saleOrderId, saleOrders.saleOrderId))
      .where(eq(saleItems.saleItemId, item.saleItemId))
      .limit(1)

    if (!saleItem) {
      return { success: false, message: `销售明细 ${item.saleItemId} 不存在` }
    }
    if (saleItem.remainingSessions !== null && saleItem.remainingSessions < item.sessionUsed) {
      return { success: false, message: `销售明细 ${item.saleItemId} 剩余次数不足（剩余 ${saleItem.remainingSessions}，需要 ${item.sessionUsed}）` }
    }
    saleItemSnapshots.push({
      saleItemId: item.saleItemId,
      unitRealPrice: saleItem.unitRealPrice,
      isPresale: saleItem.saleOrderType === '体验',
    })
  }

  // 事务：ID 生成 + 服务单 + 服务明细，原子提交
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
      if (!id) throw new Error('服务单号生成失败')

      await tx.insert(serviceOrders).values({
        serviceOrderId: id,
        status: '待服务',
        serviceOrderType,
        marketName: data.marketName,
        storeId: data.storeId,
        serviceDate: data.serviceDate,
        assignedEmployeeId: data.assignedEmployeeId,
        clientUserId: data.clientUserId,
        appointmentId: data.appointmentId || null,
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
          isPresale: snapshot.isPresale,
          employeeId: data.assignedEmployeeId,
        })
      }

      return id
    })
  } catch (err: any) {
    // PG 外键违反（storeId / clientUserId / assignedEmployeeId 不存在）
    if (err?.code === '23503') {
      return { success: false, message: '关联数据不存在，请检查员工或顾客信息' }
    }
    throw err
  }

  await logOperation(session, 'service.create', 'service_order', serviceOrderId, {
    storeId: data.storeId, itemCount: data.items.length,
  })

  revalidatePath('/services')
  return { success: true, message: '服务单创建成功', serviceOrderId }
}
