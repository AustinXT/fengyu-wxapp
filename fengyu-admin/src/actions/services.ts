'use server'

import { db } from '@/db'
import { serviceOrders, serviceItems } from '@db/service'
import { saleItems } from '@db/order'
import { stores } from '@db/org'
import { staffWechatUsers, clientWechatUsers } from '@db/user'
import { eq, desc, and, sql, inArray } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { ServiceOrder } from '@/lib/types'
import { getSession } from '@/lib/auth'
import { requirePermission } from '@/lib/permissions'
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

  const scopeIds = session.permissions.scopeStoreIds
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
    .where(scopeIds.length > 0 ? inArray(serviceOrders.storeId, scopeIds) : sql`FALSE`)
    .orderBy(desc(serviceOrders.createdAt))

  return rows.map(serializeServiceOrder)
}

export async function getServiceOrderById(serviceOrderId: string): Promise<ServiceOrder | null> {
  const session = await getSession()
  requirePermission(session, 'service:list')

  const scopeIds = session.permissions.scopeStoreIds
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
    .where(
      scopeIds.length > 0
        ? and(eq(serviceOrders.serviceOrderId, serviceOrderId), inArray(serviceOrders.storeId, scopeIds))
        : and(eq(serviceOrders.serviceOrderId, serviceOrderId), sql`FALSE`)
    )
    .limit(1)

  if (rows.length === 0) return null
  return serializeServiceOrder(rows[0])
}

export interface ServiceItemDetail {
  serviceItemId: string
  saleItemId: string
  sessionUsed: number
  unitRealPrice: string | null
  employeeName: string | null
  productName: string | null
  skuName: string | null
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
      e.name AS employee_name,
      sli.product_name,
      sli.sku_spec_name AS sku_name,
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
    employeeName: r.employee_name,
    productName: r.product_name,
    skuName: r.sku_name,
    remainingSessions: r.remaining_sessions !== null ? Number(r.remaining_sessions) : null,
    sessionCount: r.session_count !== null ? Number(r.session_count) : null,
  }))
}

/** C4: 开始服务 — WHERE status = '待服务' */
export async function startServiceOrder(serviceOrderId: string): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'service:update')

  const result = await db
    .update(serviceOrders)
    .set({ status: '服务中', startedAt: new Date() })
    .where(and(eq(serviceOrders.serviceOrderId, serviceOrderId), eq(serviceOrders.status, '待服务')))

  if ((result as any).rowCount === 0) {
    return { success: false, message: '服务单状态已变更，无法开始' }
  }

  await logOperation(session, 'service.start', 'service_order', serviceOrderId)

  revalidatePath('/services')
  return { success: true, message: '服务已开始' }
}

/**
 * C1+C4: 完成服务 — 原子扣减 remaining_sessions + 状态推进
 */
export async function completeServiceOrder(serviceOrderId: string): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'service:update')

  const result = await db.execute(sql`
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

  const result = await db
    .update(serviceOrders)
    .set({ status: '已取消' })
    .where(and(eq(serviceOrders.serviceOrderId, serviceOrderId), eq(serviceOrders.status, '待服务')))

  if ((result as any).rowCount === 0) {
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
  serviceOrderType?: '普通' | '体验'
  appointmentId?: string | null
  remark?: string | null
  items: Array<{
    saleItemId: string
    sessionUsed: number
  }>
}): Promise<{ success: boolean; message: string; serviceOrderId?: string }> {
  const session = await getSession()
  requirePermission(session, 'service:create')

  // 生成服务单号
  const idRows = await db.execute(sql`
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
  const serviceOrderId = (idRows as any[])[0]?.id as string
  if (!serviceOrderId) {
    return { success: false, message: '服务单号生成失败，请重试' }
  }

  // 先校验所有明细的剩余次数，避免校验失败时留下孤儿服务单
  const saleItemSnapshots: Array<{ saleItemId: string; unitRealPrice: string }> = []
  for (const item of data.items) {
    const [saleItem] = await db
      .select({
        remainingSessions: saleItems.remainingSessions,
        unitRealPrice: saleItems.unitRealPrice,
      })
      .from(saleItems)
      .where(eq(saleItems.saleItemId, item.saleItemId))
      .limit(1)

    if (!saleItem) {
      return { success: false, message: `销售明细 ${item.saleItemId} 不存在` }
    }
    if (saleItem.remainingSessions !== null && saleItem.remainingSessions < item.sessionUsed) {
      return { success: false, message: `销售明细 ${item.saleItemId} 剩余次数不足（剩余 ${saleItem.remainingSessions}，需要 ${item.sessionUsed}）` }
    }
    saleItemSnapshots.push({ saleItemId: item.saleItemId, unitRealPrice: saleItem.unitRealPrice })
  }

  // 校验通过后再插入服务单
  await db.insert(serviceOrders).values({
    serviceOrderId,
    status: '待服务',
    serviceOrderType: data.serviceOrderType || '普通',
    marketName: data.marketName,
    storeId: data.storeId,
    serviceDate: data.serviceDate,
    assignedEmployeeId: data.assignedEmployeeId,
    clientUserId: data.clientUserId,
    appointmentId: data.appointmentId || null,
    remark: data.remark || null,
  })

  // 插入服务明细（使用预先查询的快照数据，避免重复查询）
  for (let i = 0; i < data.items.length; i++) {
    const item = data.items[i]
    const serviceItemId = `${serviceOrderId}-${String(i + 1).padStart(2, '0')}`
    const snapshot = saleItemSnapshots[i]

    await db.insert(serviceItems).values({
      serviceItemId,
      serviceOrderId,
      saleItemId: item.saleItemId,
      sessionUsed: item.sessionUsed,
      unitRealPrice: snapshot.unitRealPrice || '0',
      employeeId: data.assignedEmployeeId,
    })
  }

  await logOperation(session, 'service.create', 'service_order', serviceOrderId, {
    storeId: data.storeId, itemCount: data.items.length,
  })

  revalidatePath('/services')
  return { success: true, message: '服务单创建成功', serviceOrderId }
}
