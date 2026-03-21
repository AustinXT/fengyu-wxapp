'use server'

import { db } from '@/db'
import { serviceCommissions } from '@db/service-commission'
import { serviceOrders, serviceItems } from '@db/service'
import { eq, sql, and, inArray } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { ServiceCommission, AuthSession } from '@/lib/types'
import { getSession } from '@/lib/auth'
import { requirePermission, isAdminScope } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'

/** 校验服务单是否在用户 scope 内 */
async function verifyServiceOrderScope(serviceOrderId: string, session: AuthSession): Promise<boolean> {
  if (isAdminScope(session)) return true
  const scopeIds = session.permissions.scopeStoreIds
  if (scopeIds.length === 0) return false
  const [order] = await db
    .select({ storeId: serviceOrders.storeId })
    .from(serviceOrders)
    .where(eq(serviceOrders.serviceOrderId, serviceOrderId))
    .limit(1)
  return !!order && scopeIds.includes(order.storeId)
}

export async function getServiceOrderCommissions(serviceOrderId: string): Promise<ServiceCommission[]> {
  const session = await getSession()
  requirePermission(session, 'allocation:list')

  if (!(await verifyServiceOrderScope(serviceOrderId, session))) {
    return []
  }

  const rows = await db.execute(sql`
    SELECT
      sc.id,
      sc.service_item_id,
      sc.employee_id,
      sc.commission_rate,
      sc.commission_amount,
      sc.is_void,
      sc.created_at,
      sc.updated_at,
      swu.name AS employee_name,
      orn.name AS department_name
    FROM service_commissions sc
    LEFT JOIN staff_wechat_users swu ON sc.employee_id = swu.employee_id
    LEFT JOIN org_nodes orn ON swu.org_node_id = orn.id
    WHERE sc.service_item_id IN (
      SELECT si.service_item_id FROM service_items si WHERE si.service_order_id = ${serviceOrderId}
    )
    AND sc.is_void = false
  `)

  return (rows as any[]).map((r: any) => ({
    id: Number(r.id),
    serviceItemId: r.service_item_id,
    employeeId: r.employee_id,
    commissionRate: r.commission_rate,
    commissionAmount: r.commission_amount,
    isVoid: r.is_void,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    employeeName: r.employee_name ?? undefined,
    departmentName: r.department_name ?? undefined,
  }))
}

/** 批量保存服务提成（先作废旧的，再插入新的） */
export async function batchSaveServiceCommissions(
  serviceOrderId: string,
  commissions: Array<{
    serviceItemId: string
    employeeId: string
    commissionRate: string
    commissionAmount: string
  }>
): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'allocation:save')

  if (!(await verifyServiceOrderScope(serviceOrderId, session))) {
    return { success: false, message: '无权操作该服务单的提成分配' }
  }

  // 校验所有 serviceItemId 属于该服务单
  if (commissions.length > 0) {
    const serviceItemIds = [...new Set(commissions.map((c) => c.serviceItemId))]
    const validItems = await db
      .select({ serviceItemId: serviceItems.serviceItemId })
      .from(serviceItems)
      .where(and(
        inArray(serviceItems.serviceItemId, serviceItemIds),
        eq(serviceItems.serviceOrderId, serviceOrderId),
      ))
    const validSet = new Set(validItems.map((i) => i.serviceItemId))
    const invalid = serviceItemIds.find((id) => !validSet.has(id))
    if (invalid) {
      return { success: false, message: '服务明细不属于该服务单，请刷新后重试' }
    }
  }

  try {
    await db.transaction(async (tx) => {
      // 作废旧提成记录
      await tx.execute(sql`
        UPDATE service_commissions SET is_void = true
        WHERE service_item_id IN (
          SELECT service_item_id FROM service_items WHERE service_order_id = ${serviceOrderId}
        ) AND is_void = false
      `)

      // 插入新提成记录
      if (commissions.length > 0) {
        await tx.insert(serviceCommissions).values(
          commissions.map((c) => ({
            serviceItemId: c.serviceItemId,
            employeeId: c.employeeId,
            commissionRate: c.commissionRate,
            commissionAmount: c.commissionAmount,
          }))
        )
      }

      // 更新服务单提成状态
      await tx
        .update(serviceOrders)
        .set({ commissionStatus: commissions.length > 0 ? 'allocated' : 'pending' })
        .where(eq(serviceOrders.serviceOrderId, serviceOrderId))
    })
  } catch (err: any) {
    if (err?.code === '23503') {
      return { success: false, message: '员工信息不存在，请检查后重试' }
    }
    throw err
  }

  await logOperation(session, 'serviceCommission.batchSave', 'service_order', serviceOrderId, {
    commissionCount: commissions.length,
  })

  revalidatePath('/allocations')
  return { success: true, message: '服务提成保存成功' }
}
