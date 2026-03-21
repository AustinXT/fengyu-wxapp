'use server'

import { db } from '@/db'
import { saleAllocations, saleOrders, saleItems } from '@db/order'
import { eq, sql, and, inArray } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { SaleAllocation, AuthSession } from '@/lib/types'
import { getSession } from '@/lib/auth'
import { requirePermission, isAdminScope, isInScope } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'

/** 校验订单是否在用户 scope 内（admin 始终通过） */
async function verifyOrderScope(saleOrderId: string, session: AuthSession): Promise<boolean> {
  if (isAdminScope(session)) return true
  const scopeIds = session.permissions.scopeStoreIds
  if (scopeIds.length === 0) return false
  const [order] = await db
    .select({ storeId: saleOrders.storeId })
    .from(saleOrders)
    .where(eq(saleOrders.saleOrderId, saleOrderId))
    .limit(1)
  return !!order && scopeIds.includes(order.storeId)
}

/** 校验 saleItemId 对应的订单是否在用户 scope 内 */
async function verifySaleItemScope(saleItemId: string, session: AuthSession): Promise<boolean> {
  if (isAdminScope(session)) return true
  const scopeIds = session.permissions.scopeStoreIds
  if (scopeIds.length === 0) return false
  const [item] = await db
    .select({ saleOrderId: saleItems.saleOrderId })
    .from(saleItems)
    .where(eq(saleItems.saleItemId, saleItemId))
    .limit(1)
  if (!item) return false
  return verifyOrderScope(item.saleOrderId, session)
}

export async function getOrderAllocations(saleOrderId: string): Promise<SaleAllocation[]> {
  const session = await getSession()
  requirePermission(session, 'allocation:list')

  // 校验订单 scope
  if (!(await verifyOrderScope(saleOrderId, session))) {
    return []
  }

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

  // 校验 saleItemId 对应的订单在 scope 内
  if (!(await verifySaleItemScope(data.saleItemId, session))) {
    return { success: false, message: '无权操作该订单的分配' }
  }

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

  // 先查出分配记录，校验存在性 + scope
  const [alloc] = await db
    .select({ saleItemId: saleAllocations.saleItemId, isVoid: saleAllocations.isVoid })
    .from(saleAllocations)
    .where(eq(saleAllocations.id, id))
    .limit(1)

  if (!alloc) return { success: false, message: '分配记录不存在' }
  if (alloc.isVoid) return { success: false, message: '分配记录已被删除' }

  if (!(await verifySaleItemScope(alloc.saleItemId, session))) {
    return { success: false, message: '无权操作该订单的分配' }
  }

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

  // 校验订单 scope
  if (!(await verifyOrderScope(saleOrderId, session))) {
    return { success: false, message: '无权操作该订单的分配' }
  }

  // 校验所有 saleItemId 属于该订单（防跨订单分配篡改）
  if (allocations.length > 0) {
    const saleItemIds = [...new Set(allocations.map((a) => a.saleItemId))]
    const validItems = await db
      .select({ saleItemId: saleItems.saleItemId })
      .from(saleItems)
      .where(and(
        inArray(saleItems.saleItemId, saleItemIds),
        eq(saleItems.saleOrderId, saleOrderId),
      ))
    const validSet = new Set(validItems.map((i) => i.saleItemId))
    const invalid = saleItemIds.find((id) => !validSet.has(id))
    if (invalid) {
      return { success: false, message: '明细项不属于该订单，请刷新后重试' }
    }
  }

  // 事务：作废旧分配 + 插入新分配 + 更新订单状态，原子提交
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE sale_allocations SET is_void = true, voided_at = NOW()
        WHERE sale_item_id IN (
          SELECT sale_item_id FROM sale_items WHERE sale_order_id = ${saleOrderId}
        ) AND is_void = false
      `)

      if (allocations.length > 0) {
        await tx.insert(saleAllocations).values(
          allocations.map((a) => ({
            saleItemId: a.saleItemId,
            employeeId: a.employeeId,
            allocationRatio: a.allocationRatio,
            totalAmount: a.totalAmount,
            departmentName: a.departmentName || null,
          }))
        )
      }

      await tx
        .update(saleOrders)
        .set({ allocationStatus: allocations.length > 0 ? 'allocated' : 'pending' })
        .where(eq(saleOrders.saleOrderId, saleOrderId))
    })
  } catch (err: any) {
    // PG 外键违反（employeeId 不存在）
    if (err?.code === '23503') {
      return { success: false, message: '员工信息不存在，请检查后重试' }
    }
    throw err
  }

  await logOperation(session, 'allocation.batchSave', 'sale_order', saleOrderId, {
    allocationCount: allocations.length,
  })

  revalidatePath('/allocations')
  return { success: true, message: '分配保存成功' }
}
