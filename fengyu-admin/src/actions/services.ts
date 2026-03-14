'use server'

import { db } from '@/db'
import { serviceOrders } from '@db/service'
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
  return serializeServiceOrder(rows[0])
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
