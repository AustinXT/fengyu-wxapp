'use server'

import { db } from '@/db'
import { saleAllocations, saleOrders, saleItems } from '@db/order'
import { eq, sql, and, inArray } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { SaleAllocation, AuthSession } from '@/lib/types'
import { isAdminScope } from '@/lib/permissions'
import { withPermission } from '@/lib/with-permission'
import { logOperation } from '@/lib/operation-log'

/**
 * 销售提成率查找（销售提成固化快照用）。
 *
 * 跨端约定（no-shared-cloudfunctions）：与 staffApi allocation.js buildSalesRateLookup /
 * payNotify 同语义独立副本。一次性加载市场「销售单」commission_rate_matrix，
 * 返回 (role, salesCat, amount) => rate，口径与 allocation.suggest 的 lookupTierRate 一致：
 * amountMin <= amount <= amountMax，多 tier 命中取 amountMin 最大者，跳过 rate<=0；
 * market 为空 / 无配置 → 恒返回 0。amount 传订单级 received 合计。
 */
async function buildSalesRateLookup(
  marketName: string | null,
): Promise<(role: string, salesCat: string, amount: number) => number> {
  if (!marketName) return () => 0

  const rows = (await db.execute(sql`
    SELECT crm.role_type, crm.sales_category,
           crm.amount_tier_min, crm.amount_tier_max, crm.commission_rate
    FROM commission_rate_matrix crm
    JOIN org_nodes n ON n.id = crm.org_id
    WHERE n.name = ${marketName} AND crm.order_type = '销售单'
    ORDER BY crm.role_type, crm.amount_tier_min
  `)) as any[]

  type Grouped = { department: string; amountMin: number; amountMax: number; orderRates: Record<string, number> }
  const grouped: Grouped[] = []
  const byKey = new Map<string, Grouped>()
  for (const r of rows) {
    const dept = String(r.role_type || '').trim()
    const key = `${dept}|${r.amount_tier_min}|${r.amount_tier_max}`
    let entry = byKey.get(key)
    if (!entry) {
      entry = {
        department: dept,
        amountMin: r.amount_tier_min != null ? Number(r.amount_tier_min) : -9999.9,
        amountMax: r.amount_tier_max != null ? Number(r.amount_tier_max) : 10000000,
        orderRates: { 自销自耗: 0, 他销自耗: 0, 他销他耗: 0, 生态合作: 0 },
      }
      byKey.set(key, entry)
      grouped.push(entry)
    }
    entry.orderRates[r.sales_category] = Number(r.commission_rate) || 0
  }

  return (role: string, salesCat: string, amount: number): number => {
    let hit: Grouped | null = null
    for (const r of grouped) {
      if (r.department !== role) continue
      if (amount < r.amountMin || amount > r.amountMax) continue
      const rate = r.orderRates[salesCat]
      if (!rate || rate <= 0) continue
      if (!hit || r.amountMin > hit.amountMin) hit = r
    }
    return (hit && hit.orderRates[salesCat]) || 0
  }
}

/** 加载订单市场名 + 订单级 received 合计（提成率 tier 基准）+ 各 item 销售类别 */
async function loadOrderCommissionContext(saleOrderId: string): Promise<{
  marketName: string | null
  orderTotalReceived: number
  salesCategoryByItem: Map<string, string>
}> {
  const [orderRow] = (await db.execute(sql`
    SELECT market_name FROM sale_orders WHERE sale_order_id = ${saleOrderId} LIMIT 1
  `)) as any[]
  const itemRows = (await db.execute(sql`
    SELECT sale_item_id, received, sales_category FROM sale_items WHERE sale_order_id = ${saleOrderId}
  `)) as any[]
  const orderTotalReceived = itemRows.reduce((s, i) => s + (Number(i.received) || 0), 0)
  const salesCategoryByItem = new Map<string, string>(
    itemRows.map((i) => [i.sale_item_id as string, (i.sales_category as string) || '自销自耗']),
  )
  return { marketName: (orderRow?.market_name as string) ?? null, orderTotalReceived, salesCategoryByItem }
}

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

  // 销售提成固化快照：从 commission_rate_matrix 命中费率，提成额 = 份额 × 费率
  const [itemRow] = (await db.execute(sql`
    SELECT sale_order_id FROM sale_items WHERE sale_item_id = ${data.saleItemId} LIMIT 1
  `)) as any[]
  const { marketName, orderTotalReceived, salesCategoryByItem } = await loadOrderCommissionContext(
    itemRow?.sale_order_id as string,
  )
  const rateLookup = await buildSalesRateLookup(marketName)
  const salesCategory = salesCategoryByItem.get(data.saleItemId) || '自销自耗'
  const commissionRate = rateLookup(resolvedRoleType, salesCategory, orderTotalReceived)
  const commissionAmount = (Number(data.totalAmount) * commissionRate).toFixed(2)

  await db.insert(saleAllocations).values({
    saleItemId: data.saleItemId,
    employeeId: data.employeeId,
    roleType: resolvedRoleType,
    allocationRatio: data.allocationRatio,
    totalAmount: data.totalAmount,
    commissionRate: commissionRate.toFixed(4),
    commissionAmount,
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

  // 营业额口径白名单：仅销售单/转换单参与营业额分配，拒绝寄存单/充值单/内部单
  const [typeRow] = await db
    .select({ saleOrderType: saleOrders.saleOrderType, legacySource: saleOrders.legacySource })
    .from(saleOrders)
    .where(eq(saleOrders.saleOrderId, saleOrderId))
    .limit(1)
  if (!typeRow || !['销售单', '转换单'].includes(typeRow.saleOrderType)) {
    return { success: false, message: '该订单类型不参与营业额分配' }
  }
  // 历史订单（WorkFine 核对补登）不参与营业额分配（无 sale_items 天然不可分，补显式拦截防绕过）
  if (typeRow.legacySource === 'workfine') {
    return { success: false, message: '历史订单不参与营业额分配' }
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

  // 销售提成固化快照：加载订单市场 + 订单级 received 合计 + 各 item 销售类别，命中费率
  const { marketName, orderTotalReceived, salesCategoryByItem } =
    allocations.length > 0
      ? await loadOrderCommissionContext(saleOrderId)
      : { marketName: null, orderTotalReceived: 0, salesCategoryByItem: new Map<string, string>() }
  const rateLookup = await buildSalesRateLookup(marketName)

  // 构造 INSERT 用的 enriched 数组（allocations.length === 0 时为空，下面事务分支会处理）
  const finalAllocations = allocations.length > 0
    ? allocations.map((a) => {
        const totalAmount = (itemReceivedMap.get(a.saleItemId) || 0) * Number(a.allocationRatio)
        const salesCategory = salesCategoryByItem.get(a.saleItemId) || '自销自耗'
        const commissionRate = rateLookup(a.roleType, salesCategory, orderTotalReceived)
        return {
          ...a,
          totalAmount: totalAmount.toFixed(2),
          commissionRate: commissionRate.toFixed(4),
          commissionAmount: (totalAmount * commissionRate).toFixed(2),
        }
      })
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
            commissionRate: a.commissionRate, // 销售提成率快照
            commissionAmount: a.commissionAmount, // 真实销售提成额
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
  },
)
