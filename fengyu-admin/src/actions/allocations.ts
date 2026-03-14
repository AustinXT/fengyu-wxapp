'use server'

import { db } from '@/db'
import { saleAllocations } from '@db/order'
import { eq, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { SaleAllocation } from '@/lib/types'
import { getSession } from '@/lib/auth'
import { requirePermission } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'

export async function getOrderAllocations(saleOrderId: string): Promise<SaleAllocation[]> {
  const session = await getSession()
  requirePermission(session, 'allocation:list')

  const rows = await db.execute(sql`
    SELECT
      sa.id,
      sa.sale_item_id,
      sa.employee_id,
      sa.allocation_ratio,
      sa.total_amount,
      sa.is_void,
      sa.created_at,
      sa.updated_at,
      swu.name AS employee_name,
      orn.name AS department_name
    FROM sale_allocations sa
    LEFT JOIN staff_wechat_users swu ON sa.employee_id = swu.employee_id
    LEFT JOIN org_nodes orn ON swu.org_node_id = orn.id
    WHERE sa.sale_item_id IN (
      SELECT si.sale_item_id FROM sale_items si WHERE si.sale_order_id = ${saleOrderId}
    )
    AND sa.is_void = false
  `)

  return (rows as any[]).map((r: any) => ({
    id: Number(r.id),
    saleItemId: r.sale_item_id,
    employeeId: r.employee_id,
    allocationRatio: r.allocation_ratio,
    totalAmount: r.total_amount,
    isVoid: r.is_void,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    employeeName: r.employee_name ?? undefined,
    departmentName: r.department_name ?? undefined,
  }))
}

export async function saveAllocation(data: {
  saleItemId: string
  employeeId: string
  allocationRatio: string
  totalAmount: string
  departmentName?: string
}): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'allocation:save')

  await db.insert(saleAllocations).values({
    saleItemId: data.saleItemId,
    employeeId: data.employeeId,
    allocationRatio: data.allocationRatio,
    totalAmount: data.totalAmount,
    departmentName: data.departmentName || null,
  })

  await logOperation(session, 'allocation.save', 'sale_allocation', data.saleItemId, {
    employeeId: data.employeeId, totalAmount: data.totalAmount,
  })

  revalidatePath('/allocations')
  return { success: true, message: '分配已保存' }
}

export async function deleteAllocation(id: number): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'allocation:save')

  await db
    .update(saleAllocations)
    .set({ isVoid: true, voidedAt: new Date() })
    .where(eq(saleAllocations.id, id))

  await logOperation(session, 'allocation.delete', 'sale_allocation', String(id))

  revalidatePath('/allocations')
  return { success: true, message: '分配已删除' }
}

/** 批量保存分配（先作废旧的，再插入新的） */
export async function batchSaveAllocations(
  saleOrderId: string,
  allocations: Array<{
    saleItemId: string
    employeeId: string
    allocationRatio: string
    totalAmount: string
    departmentName?: string
  }>
): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'allocation:save')

  // Void existing allocations for this order's items
  await db.execute(sql`
    UPDATE sale_allocations SET is_void = true, voided_at = NOW()
    WHERE sale_item_id IN (
      SELECT sale_item_id FROM sale_items WHERE sale_order_id = ${saleOrderId}
    ) AND is_void = false
  `)

  // Insert new allocations
  if (allocations.length > 0) {
    await db.insert(saleAllocations).values(
      allocations.map((a) => ({
        saleItemId: a.saleItemId,
        employeeId: a.employeeId,
        allocationRatio: a.allocationRatio,
        totalAmount: a.totalAmount,
        departmentName: a.departmentName || null,
      }))
    )
  }

  // Update order allocation status
  const { saleOrders } = await import('@db/order')
  await db
    .update(saleOrders)
    .set({ allocationStatus: allocations.length > 0 ? 'allocated' : 'pending' })
    .where(eq(saleOrders.saleOrderId, saleOrderId))

  await logOperation(session, 'allocation.batchSave', 'sale_order', saleOrderId, {
    allocationCount: allocations.length,
  })

  revalidatePath('/allocations')
  return { success: true, message: '分配保存成功' }
}
