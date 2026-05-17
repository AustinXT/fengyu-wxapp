'use server'

import { db } from '@/db'
import { saleAllocations, saleOrders, saleItems } from '@db/order'
import { eq, sql, and, inArray } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { SaleAllocation, AuthSession } from '@/lib/types'
import { isAdminScope } from '@/lib/permissions'
import { withPermission } from '@/lib/with-permission'
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

export const getOrderAllocations = withPermission(
  'allocation:list',
  async (session, saleOrderId: string): Promise<SaleAllocation[]> => {
  // 校验订单 scope
  if (!(await verifyOrderScope(saleOrderId, session))) {
    return []
  }

  // 尝试含 role_type 的查询，迁移未执行时回退到不含该列的查询
  let rows: any[]
  try {
    rows = await db.execute(sql`
      SELECT
        sa.id, sa.sale_item_id, sa.employee_id, sa.allocation_ratio,
        sa.role_type, sa.total_amount, sa.is_void, sa.created_at, sa.updated_at,
        swu.name AS employee_name, orn.name AS department_name
      FROM sale_allocations sa
      LEFT JOIN staff_wechat_users swu ON sa.employee_id = swu.employee_id
      LEFT JOIN org_nodes orn ON swu.org_node_id = orn.id
      WHERE sa.sale_item_id IN (
        SELECT si.sale_item_id FROM sale_items si WHERE si.sale_order_id = ${saleOrderId}
      ) AND sa.is_void = false
    `) as any[]
  } catch {
    rows = await db.execute(sql`
      SELECT
        sa.id, sa.sale_item_id, sa.employee_id, sa.allocation_ratio,
        sa.total_amount, sa.is_void, sa.created_at, sa.updated_at,
        swu.name AS employee_name, orn.name AS department_name
      FROM sale_allocations sa
      LEFT JOIN staff_wechat_users swu ON sa.employee_id = swu.employee_id
      LEFT JOIN org_nodes orn ON swu.org_node_id = orn.id
      WHERE sa.sale_item_id IN (
        SELECT si.sale_item_id FROM sale_items si WHERE si.sale_order_id = ${saleOrderId}
      ) AND sa.is_void = false
    `) as any[]
  }

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
  },
)

export const saveAllocation = withPermission(
  'allocation:save',
  async (
    session,
    data: {
      saleItemId: string
      employeeId: string
      roleType?: string
      allocationRatio: string
      totalAmount: string
      departmentName?: string
    },
  ): Promise<{ success: boolean; message: string }> => {
  // 校验 saleItemId 对应的订单在 scope 内
  if (!(await verifySaleItemScope(data.saleItemId, session))) {
    return { success: false, message: '无权操作该订单的分配' }
  }

  // role_type 兜底：缺省时按员工 skills[1] 派生（与 payNotify / staffApi 一致），
  // 仍缺则回退 '美容师'（与 backfill-allocations-roletype.js 兜底一致）。
  let resolvedRoleType: string = data.roleType || ''
  if (!resolvedRoleType) {
    const [staff] = await db.execute<{ skills: string[] | null }>(sql`
      SELECT skills FROM staff_wechat_users WHERE employee_id = ${data.employeeId} LIMIT 1
    `) as unknown as Array<{ skills: string[] | null }>
    const skills = Array.isArray(staff?.skills) ? staff.skills : []
    resolvedRoleType = skills[0] || '美容师'
  }

  await db.insert(saleAllocations).values({
    saleItemId: data.saleItemId,
    employeeId: data.employeeId,
    roleType: resolvedRoleType,
    allocationRatio: data.allocationRatio,
    totalAmount: data.totalAmount,
    departmentName: data.departmentName || null,
  })

  await logOperation(session, 'allocation.save', 'sale_allocation', data.saleItemId, {
    employeeId: data.employeeId, totalAmount: data.totalAmount,
  })

  revalidatePath('/allocations')
  return { success: true, message: '分配已保存' }
  },
)

export const deleteAllocation = withPermission(
  'allocation:save',
  async (session, id: number): Promise<{ success: boolean; message: string }> => {
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
  },
)

/** 技能标签池键：每个 roleType 独立建池（P2-14 Q5：池间互不约束） */
function getPoolKey(roleType: string): string {
  return roleType
}

/** 合法的分配比例（整十百分比） */
const VALID_RATIOS = new Set(['0.10', '0.20', '0.30', '0.40', '0.50', '0.60', '0.70', '0.80', '0.90', '1.00'])

/** 池金额合计与 received 比较的容差（整十档 × 浮点舍入） */
const AMOUNT_TOLERANCE = 0.02

/** 批量保存分配（先作废旧的，再插入新的） */
export const batchSaveAllocations = withPermission(
  'allocation:save',
  async (
    session,
    saleOrderId: string,
    allocations: Array<{
      saleItemId: string
      employeeId: string
      roleType: string
      allocationRatio: string
      totalAmount: string
      departmentName?: string
    }>,
  ): Promise<{ success: boolean; message: string }> => {
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

    // 校验分配比例为整十 + 服务端重算 totalAmount（P2-14：忽略前端传入值防篡改）
    const enriched = allocations.map((a) => {
      if (!VALID_RATIOS.has(a.allocationRatio)) {
        return { ...a, totalAmount: '', _error: '分配比例必须为整十百分比（10%~100%）' }
      }
      const received = itemReceivedMap.get(a.saleItemId) || 0
      const totalAmount = (received * Number(a.allocationRatio)).toFixed(2)
      return { ...a, totalAmount }
    })
    const ratioError = enriched.find((e) => (e as any)._error)
    if (ratioError) {
      return { success: false, message: (ratioError as any)._error }
    }

    // 按 (saleItemId, roleType) 分池校验（P2-14 Q5：三角色独立池）
    const pools = new Map<string, typeof enriched>()
    for (const a of enriched) {
      const key = `${a.saleItemId}|${getPoolKey(a.roleType)}`
      const pool = pools.get(key) || []
      pool.push(a)
      pools.set(key, pool)
    }

    for (const [, pool] of pools) {
      // 每池最多 3 人
      if (pool.length > 3) {
        return { success: false, message: '每个商品每个技能标签最多分配 3 人' }
      }

      // 池内分配比例合计 ≤ 100%（1.00，容差 0.01）
      const ratioSum = pool.reduce((s, a) => s + Number(a.allocationRatio), 0)
      if (ratioSum > 1.01) {
        return { success: false, message: '同技能标签的分配比例合计不能超过 100%' }
      }

      // 池内总金额合计 ≤ received（容差 AMOUNT_TOLERANCE，P2-14 Q5）
      const itemReceived = itemReceivedMap.get(pool[0].saleItemId) || 0
      const amountSum = pool.reduce((s, a) => s + Number(a.totalAmount), 0)
      if (amountSum > itemReceived + AMOUNT_TOLERANCE) {
        return { success: false, message: '分配金额合计超过商品金额' }
      }

      // 同池内不能重复分配同一员工
      const empIds = new Set<string>()
      for (const a of pool) {
        if (empIds.has(a.employeeId)) {
          return { success: false, message: '同一商品同一技能标签不能重复分配同一员工' }
        }
        empIds.add(a.employeeId)
      }
    }
  }

  // 构造 INSERT 用的 enriched 数组（allocations.length === 0 时为空，下面事务分支会处理）
  const finalAllocations = allocations.length > 0
    ? allocations.map((a) => ({
        ...a,
        totalAmount: ((itemReceivedMap.get(a.saleItemId) || 0) * Number(a.allocationRatio)).toFixed(2),
      }))
    : []

  // 事务：作废旧分配 + 插入新分配 + 更新订单状态，原子提交
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE sale_allocations SET is_void = true, voided_at = NOW()
        WHERE sale_item_id IN (
          SELECT sale_item_id FROM sale_items WHERE sale_order_id = ${saleOrderId}
        ) AND is_void = false
      `)

      if (finalAllocations.length > 0) {
        await tx.insert(saleAllocations).values(
          finalAllocations.map((a) => ({
            saleItemId: a.saleItemId,
            employeeId: a.employeeId,
            roleType: a.roleType,
            allocationRatio: a.allocationRatio,
            totalAmount: a.totalAmount, // 服务端重算值（P2-14）
            departmentName: a.departmentName || null,
          }))
        )
      }

      await tx
        .update(saleOrders)
        .set({ allocationStatus: allocations.length > 0 ? '已分配' : '待分配' })
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
