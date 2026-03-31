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
      sa.role_type,
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
    roleType: r.role_type ?? undefined,
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
  roleType?: string
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
    roleType: data.roleType || null,
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

/** 角色组映射：美容师/养生师为同一组，推广师为独立组 */
function getRoleGroup(roleType: string): string {
  return roleType === '推广师' ? 'promoter' : 'beautician'
}

/** 合法的分配比例（整十百分比） */
const VALID_RATIOS = new Set(['0.10', '0.20', '0.30', '0.40', '0.50', '0.60', '0.70', '0.80', '0.90', '1.00'])

/** 批量保存分配（先作废旧的，再插入新的） */
export async function batchSaveAllocations(
  saleOrderId: string,
  allocations: Array<{
    saleItemId: string
    employeeId: string
    roleType: string
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
  let itemReceivedMap = new Map<string, number>()
  if (allocations.length > 0) {
    const saleItemIds = [...new Set(allocations.map((a) => a.saleItemId))]
    const validItems = await db
      .select({ saleItemId: saleItems.saleItemId, received: saleItems.received })
      .from(saleItems)
      .where(and(
        inArray(saleItems.saleItemId, saleItemIds),
        eq(saleItems.saleOrderId, saleOrderId),
      ))
    itemReceivedMap = new Map(validItems.map((i) => [i.saleItemId, Number(i.received)]))
    const invalid = saleItemIds.find((id) => !itemReceivedMap.has(id))
    if (invalid) {
      return { success: false, message: '明细项不属于该订单，请刷新后重试' }
    }

    // 校验分配比例为整十
    for (const a of allocations) {
      if (!VALID_RATIOS.has(a.allocationRatio)) {
        return { success: false, message: '分配比例必须为整十百分比（10%~100%）' }
      }
    }

    // 按 (saleItemId, roleGroup) 分组校验
    const groups = new Map<string, typeof allocations>()
    for (const a of allocations) {
      const key = `${a.saleItemId}|${getRoleGroup(a.roleType)}`
      const group = groups.get(key) || []
      group.push(a)
      groups.set(key, group)
    }

    for (const [key, group] of groups) {
      // 每角色组最多 3 人
      if (group.length > 3) {
        return { success: false, message: '每个商品每种角色最多分配 3 人' }
      }

      // 角色组内金额合计 ≤ 实收（容差 0.01）
      const [itemId] = key.split('|')
      const received = itemReceivedMap.get(itemId) ?? 0
      const sum = group.reduce((s, a) => s + Number(a.totalAmount), 0)
      if (sum > received + 0.01) {
        return { success: false, message: '同角色组的分配金额合计不能超过商品实收金额' }
      }

      // 同角色组内不能重复分配同一员工
      const empIds = new Set<string>()
      for (const a of group) {
        if (empIds.has(a.employeeId)) {
          return { success: false, message: '同一商品同一角色组不能重复分配同一员工' }
        }
        empIds.add(a.employeeId)
      }
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
            roleType: a.roleType,
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
