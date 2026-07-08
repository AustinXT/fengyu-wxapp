'use server'

import { db } from '@/db'
import { pgErrorCode } from '@/lib/pg-error'
import { saleAllocations, saleOrders, saleItems, saleOrderPayments } from '@db/order'
import { clientWechatUsers } from '@db/user'
import { eq, sql, and, or, inArray, desc, ilike } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { SaleAllocation, AuthSession } from '@/lib/types'
import { isAdminScope, isInScope } from '@/lib/permissions'
import { withPermission } from '@/lib/with-permission'
import { logOperation } from '@/lib/operation-log'
import { hasPendingRefund, hasSettledRefund, hasSettledRefundForPayment } from '@/lib/refund-cascade'
import { rowsAffected } from '@/lib/pg-rows'
import { refreshOrderAllocationRollup } from '@/lib/payment-allocatable'
import { nowTs } from '@/lib/db-time'


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
  async (session, saleOrderId: string): Promise<Array<SaleAllocation & { salePaymentId?: number }>> => {
  
  if (!(await verifyOrderScope(saleOrderId, session))) {
    return []
  }

  
  let rows: any[]
  try {
    rows = await db.execute(sql`
      SELECT
        sa.id, sa.sale_item_id, sa.employee_id, sa.allocation_ratio,
        sa.role_type, sa.total_amount, sa.commission_rate, sa.commission_amount,
        sa.sale_payment_id, sa.is_void, sa.created_at, sa.updated_at,
        swu.name AS employee_name, orn.name AS department_name,
        si.product_name AS sale_item_name
      FROM sale_allocations sa
      JOIN sale_items si ON sa.sale_item_id = si.sale_item_id
      LEFT JOIN staff_wechat_users swu ON sa.employee_id = swu.employee_id
      LEFT JOIN org_nodes orn ON swu.org_node_id = orn.id
      WHERE si.sale_order_id = ${saleOrderId} AND sa.is_void = false
      ORDER BY sa.sale_payment_id DESC NULLS LAST, sa.created_at DESC
    `) as any[]
  } catch {
    rows = await db.execute(sql`
      SELECT
        sa.id, sa.sale_item_id, sa.employee_id, sa.allocation_ratio,
        sa.total_amount, sa.is_void, sa.created_at, sa.updated_at,
        swu.name AS employee_name, orn.name AS department_name,
        si.product_name AS sale_item_name
      FROM sale_allocations sa
      JOIN sale_items si ON sa.sale_item_id = si.sale_item_id
      LEFT JOIN staff_wechat_users swu ON sa.employee_id = swu.employee_id
      LEFT JOIN org_nodes orn ON swu.org_node_id = orn.id
      WHERE si.sale_order_id = ${saleOrderId} AND sa.is_void = false
    `) as any[]
  }

  return (rows as any[]).map((r: any) => ({
    id: Number(r.id),
    saleItemId: r.sale_item_id,
    employeeId: r.employee_id,
    allocationRatio: r.allocation_ratio,
    roleType: r.role_type ?? undefined,
    totalAmount: r.total_amount,
    commissionRate: r.commission_rate ?? undefined,
    commissionAmount: r.commission_amount ?? undefined,
    salePaymentId: r.sale_payment_id ?? undefined,
    isVoid: r.is_void,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    employeeName: r.employee_name ?? undefined,
    departmentName: r.department_name ?? undefined,
    saleItemName: r.sale_item_name ?? undefined,
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
  
  if (!(await verifySaleItemScope(data.saleItemId, session))) {
    return { success: false, message: '无权操作该订单的分配' }
  }

  
  
  let resolvedRoleType: string = data.roleType || ''
  if (!resolvedRoleType) {
    const [staff] = await db.execute<{ skills: string[] | null }>(sql`
      SELECT skills FROM staff_wechat_users WHERE employee_id = ${data.employeeId} LIMIT 1
    `) as unknown as Array<{ skills: string[] | null }>
    const skills = Array.isArray(staff?.skills) ? staff.skills : []
    resolvedRoleType = skills[0] || '美容师'
  }

  
  const [itemRow] = (await db.execute(sql`
    SELECT sale_order_id FROM sale_items WHERE sale_item_id = ${data.saleItemId} LIMIT 1
  `)) as any[]
  
  if (itemRow?.sale_order_id && (await hasPendingRefund(db, itemRow.sale_order_id as string))) {
    return { success: false, message: '该订单退款审批中，暂不可修改分配' }
  }
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

  
  const [delItemRow] = (await db.execute(sql`
    SELECT sale_order_id FROM sale_items WHERE sale_item_id = ${alloc.saleItemId} LIMIT 1
  `)) as any[]
  if (delItemRow?.sale_order_id && (await hasPendingRefund(db, delItemRow.sale_order_id as string))) {
    return { success: false, message: '该订单退款审批中，暂不可删除分配' }
  }

  await db
    .update(saleAllocations)
    .set({ isVoid: true, voidedAt: nowTs() })
    .where(eq(saleAllocations.id, id))

  await logOperation(session, 'allocation.delete', 'sale_allocation', String(id))

  revalidatePath('/allocations')
  return { success: true, message: '分配已删除' }
  },
)


function getPoolKey(roleType: string): string {
  return roleType
}


const VALID_RATIOS = new Set(['0.10', '0.20', '0.30', '0.40', '0.50', '0.60', '0.70', '0.80', '0.90', '1.00'])


const AMOUNT_TOLERANCE = 0.02


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
  
  if (!(await verifyOrderScope(saleOrderId, session))) {
    return { success: false, message: '无权操作该订单的分配' }
  }

  
  const [typeRow] = await db
    .select({ saleOrderType: saleOrders.saleOrderType, legacySource: saleOrders.legacySource })
    .from(saleOrders)
    .where(eq(saleOrders.saleOrderId, saleOrderId))
    .limit(1)
  if (!typeRow || !['销售单', '转换单'].includes(typeRow.saleOrderType)) {
    return { success: false, message: '该订单类型不参与营业额分配' }
  }
  
  if (typeRow.legacySource === 'workfine') {
    return { success: false, message: '历史订单不参与营业额分配' }
  }
  
  if (await hasPendingRefund(db, saleOrderId)) {
    return { success: false, message: '该订单退款审批中，暂不可修改分配' }
  }
  
  
  
  if (await hasSettledRefund(db, saleOrderId)) {
    return { success: false, message: '该订单已退款，营业额分配已锁定，不可再修改' }
  }

  
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

    
    const pools = new Map<string, typeof enriched>()
    for (const a of enriched) {
      const key = `${a.saleItemId}|${getPoolKey(a.roleType)}`
      const pool = pools.get(key) || []
      pool.push(a)
      pools.set(key, pool)
    }

    for (const [, pool] of pools) {
      
      if (pool.length > 3) {
        return { success: false, message: '每个商品每个技能标签最多分配 3 人' }
      }

      
      const ratioSum = pool.reduce((s, a) => s + Number(a.allocationRatio), 0)
      if (ratioSum > 1.01) {
        return { success: false, message: '同技能标签的分配比例合计不能超过 100%' }
      }

      
      const itemReceived = itemReceivedMap.get(pool[0].saleItemId) || 0
      const amountSum = pool.reduce((s, a) => s + Number(a.totalAmount), 0)
      if (amountSum > itemReceived + AMOUNT_TOLERANCE) {
        return { success: false, message: '分配金额合计超过商品金额' }
      }

      
      const empIds = new Set<string>()
      for (const a of pool) {
        if (empIds.has(a.employeeId)) {
          return { success: false, message: '同一商品同一技能标签不能重复分配同一员工' }
        }
        empIds.add(a.employeeId)
      }
    }
  }

  
  const { marketName, orderTotalReceived, salesCategoryByItem } =
    allocations.length > 0
      ? await loadOrderCommissionContext(saleOrderId)
      : { marketName: null, orderTotalReceived: 0, salesCategoryByItem: new Map<string, string>() }
  const rateLookup = await buildSalesRateLookup(marketName)

  
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
            totalAmount: a.totalAmount, 
            commissionRate: a.commissionRate, 
            commissionAmount: a.commissionAmount, 
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
    
    if (pgErrorCode(err) === '23503') {
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








export const getPendingPayments = withPermission(
  'allocation:list',
  async (
    session,
    params: {
      allocationStatus?: '待分配' | '已分配'
      page?: number
      pageSize?: number
      storeId?: string
      search?: string
    } = {},
  ): Promise<{
    data: Array<{
      salePaymentId: number
      saleOrderId: string
      changeType: string
      amount: string
      paymentMethod: string
      paidAt: string | null
      allocationStatus: string | null
      customerName: string | null
      clientPhone: string | null
      storeName: string | null
      preferredEmployeeId: string | null
    }>
    total: number
  }> => {
    const status: '待分配' | '已分配' = params.allocationStatus === '已分配' ? '已分配' : '待分配'
    const page = Math.max(1, Number(params.page) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 20))
    const offset = (page - 1) * pageSize

    const scopeIds = session.permissions.scopeStoreIds
    const conds = [
      eq(saleOrderPayments.allocationStatus, status),
      inArray(saleOrders.saleOrderType, ['销售单', '转换单'] as any),
      sql`${saleOrders.legacySource} IS DISTINCT FROM 'workfine'`,
      isAdminScope(session)
        ? undefined
        : inArray(saleOrders.storeId, scopeIds.length > 0 ? scopeIds : ['__none__']),
      params.storeId ? eq(saleOrders.storeId, params.storeId) : undefined,
      params.search
        ? or(
            ilike(saleOrders.customerName, `%${params.search}%`),
            ilike(saleOrders.clientPhone, `%${params.search}%`),
            ilike(saleOrderPayments.saleOrderId, `%${params.search}%`),
          )
        : undefined,
    ].filter(Boolean)

    const where = and(...(conds as any[]))

    
    const rows = await db
      .select({
        salePaymentId: saleOrderPayments.id,
        saleOrderId: saleOrderPayments.saleOrderId,
        changeType: saleOrderPayments.changeType,
        amount: saleOrderPayments.amount,
        paymentMethod: saleOrderPayments.paymentMethod,
        paidAt: saleOrderPayments.paidAt,
        allocationStatus: saleOrderPayments.allocationStatus,
        fallbackName: saleOrders.customerName,
        fallbackPhone: saleOrders.clientPhone,
        custName: clientWechatUsers.name,
        custPhone: clientWechatUsers.phone,
        storeName: saleOrders.storeName,
        preferredEmployeeId: saleOrders.preferredEmployeeId,
      })
      .from(saleOrderPayments)
      .innerJoin(saleOrders, eq(saleOrders.saleOrderId, saleOrderPayments.saleOrderId))
      .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
      .where(where)
      .orderBy(desc(saleOrderPayments.paidAt), desc(saleOrderPayments.id))
      .limit(pageSize)
      .offset(offset)

    const [{ count }] = (await db
      .select({ count: sql<number>`count(*)::int` })
      .from(saleOrderPayments)
      .innerJoin(saleOrders, eq(saleOrders.saleOrderId, saleOrderPayments.saleOrderId))
      .where(where)) as any[]

    return {
      data: rows.map((r: any) => ({
        salePaymentId: Number(r.salePaymentId),
        saleOrderId: r.saleOrderId,
        changeType: r.changeType,
        amount: String(r.amount),
        paymentMethod: r.paymentMethod,
        paidAt: r.paidAt instanceof Date ? r.paidAt.toISOString() : (r.paidAt ?? null),
        allocationStatus: r.allocationStatus ?? null,
        
        customerName: r.custName || r.fallbackName || null,
        clientPhone: r.custPhone || r.fallbackPhone || null,
        storeName: r.storeName ?? null,
        preferredEmployeeId: r.preferredEmployeeId ?? null,
      })),
      total: Number(count) || 0,
    }
  },
)


export const getPaymentAllocatables = withPermission(
  'allocation:list',
  async (
    session,
    salePaymentId: number | string,
  ): Promise<{
    salePaymentId: number
    saleOrderId: string
    paymentAmount: number
    eventAmount: number
    paymentMethod: string
    changeType: string
    allocationStatus: string | null
    marketName: string | null
    items: Array<{
      saleItemId: string
      productName: string | null
      allocatableAmount: number
      received: number
      salesCategory: string | null
      suggestedRate: number
    }>
    existingAllocations: Array<{
      id: number
      saleItemId: string
      employeeId: string
      roleType: string | null
      allocationRatio: string
      totalAmount: string
      employeeName: string | null
    }>
  } | null> => {
    const [pay] = (await db.execute(sql`
      SELECT sop.id, sop.sale_order_id, sop.amount, sop.payment_method, sop.change_type,
             sop.allocation_status, so.store_id, so.market_name, so.sale_order_type, so.legacy_source
      FROM sale_order_payments sop
      JOIN sale_orders so ON so.sale_order_id = sop.sale_order_id
      WHERE sop.id = ${salePaymentId} LIMIT 1
    `)) as any[]
    if (!pay || !isInScope(session, pay.store_id as string)) return null
    if (!['销售单', '转换单'].includes(pay.sale_order_type) || pay.legacy_source === 'workfine') return null

    const items = (await db.execute(sql`
      SELECT spai.sale_item_id, spai.amount, spai.sales_category, si.product_name
      FROM sale_payment_allocatable_items spai
      JOIN sale_items si ON si.sale_item_id = spai.sale_item_id
      WHERE spai.sale_payment_id = ${salePaymentId}
      ORDER BY spai.sale_item_id
    `)) as any[]
    const eventAmount =
      Math.round(items.reduce((s: number, i: any) => s + (Number(i.amount) || 0), 0) * 100) / 100

    const rateLookup = await buildSalesRateLookup(pay.market_name as string | null)

    const existing = (await db.execute(sql`
      SELECT sa.id, sa.sale_item_id, sa.employee_id, sa.role_type, sa.allocation_ratio,
             sa.total_amount, swu.name AS employee_name
      FROM sale_allocations sa
      LEFT JOIN staff_wechat_users swu ON swu.employee_id = sa.employee_id
      WHERE sa.sale_payment_id = ${salePaymentId} AND sa.is_void = false
      ORDER BY sa.sale_item_id
    `)) as any[]

    return {
      salePaymentId: Number(pay.id),
      saleOrderId: pay.sale_order_id,
      paymentAmount: Number(pay.amount),
      eventAmount,
      paymentMethod: pay.payment_method,
      changeType: pay.change_type,
      allocationStatus: pay.allocation_status ?? null,
      marketName: pay.market_name ?? null,
      items: items.map((i: any) => ({
        saleItemId: i.sale_item_id,
        productName: i.product_name ?? null,
        allocatableAmount: Number(i.amount),
        received: Number(i.amount), 
        salesCategory: i.sales_category ?? null,
        suggestedRate: rateLookup('美容师', i.sales_category || '自销自耗', eventAmount),
      })),
      existingAllocations: existing.map((r: any) => ({
        id: Number(r.id),
        saleItemId: r.sale_item_id,
        employeeId: r.employee_id,
        roleType: r.role_type ?? null,
        allocationRatio: r.allocation_ratio,
        totalAmount: r.total_amount,
        employeeName: r.employee_name ?? null,
      })),
    }
  },
)


export const savePaymentAllocations = withPermission(
  'allocation:save',
  async (
    session,
    salePaymentId: number | string,
    allocations: Array<{
      saleItemId: string
      employeeId: string
      roleType: string
      allocationRatio: string
      totalAmount?: string
      departmentName?: string
    }>,
  ): Promise<{ success: boolean; message: string }> => {
    const [pay] = (await db.execute(sql`
      SELECT sop.id, sop.sale_order_id, sop.allocation_status, so.store_id, so.market_name,
             so.sale_order_type, so.legacy_source
      FROM sale_order_payments sop
      JOIN sale_orders so ON so.sale_order_id = sop.sale_order_id
      WHERE sop.id = ${salePaymentId} LIMIT 1
    `)) as any[]
    if (!pay) return { success: false, message: '该回款不存在' }
    if (!isInScope(session, pay.store_id as string)) {
      return { success: false, message: '无权操作该订单的分配' }
    }
    if (!['销售单', '转换单'].includes(pay.sale_order_type)) {
      return { success: false, message: '该订单类型不参与营业额分配' }
    }
    if (pay.legacy_source === 'workfine') {
      return { success: false, message: '历史订单不参与营业额分配' }
    }
    
    
    if (!['待分配', '已分配'].includes(pay.allocation_status as string)) {
      return { success: false, message: '该回款不可分配（状态异常）' }
    }
    
    if (await hasPendingRefund(db, pay.sale_order_id as string)) {
      return { success: false, message: '该订单退款审批中，暂不可修改分配' }
    }
    
    
    if (await hasSettledRefundForPayment(db, salePaymentId)) {
      return { success: false, message: '该订单已退款，营业额分配已锁定，不可再修改' }
    }

    
    const allocItems = (await db.execute(sql`
      SELECT sale_item_id, amount, sales_category
      FROM sale_payment_allocatable_items WHERE sale_payment_id = ${salePaymentId}
    `)) as any[]
    const baseMap = new Map<string, number>(allocItems.map((i: any) => [i.sale_item_id, Number(i.amount) || 0]))
    const catMap = new Map<string, string>(
      allocItems.map((i: any) => [i.sale_item_id, i.sales_category || '自销自耗']),
    )
    const eventAmount =
      Math.round(allocItems.reduce((s: number, i: any) => s + (Number(i.amount) || 0), 0) * 100) / 100
    const rateLookup = await buildSalesRateLookup(pay.market_name as string | null)

    
    const enriched: Array<{
      saleItemId: string
      employeeId: string
      roleType: string
      allocationRatio: string
      totalAmount: string
      commissionRate: string
      commissionAmount: string
      departmentName: string | null
    }> = []
    for (const a of allocations) {
      if (!baseMap.has(a.saleItemId)) {
        return { success: false, message: `分配项 ${a.saleItemId} 不属于该回款` }
      }
      if (!a.employeeId || !a.roleType) {
        return { success: false, message: '分配记录缺少员工或技能标签' }
      }
      
      const ratioStr = Number(a.allocationRatio).toFixed(2)
      if (!VALID_RATIOS.has(ratioStr)) {
        return { success: false, message: '分配比例必须为整十百分比（10%~100%）' }
      }
      const base = baseMap.get(a.saleItemId) || 0
      const totalAmount = Math.round(base * Number(ratioStr) * 100) / 100
      const salesCategory = catMap.get(a.saleItemId) || '自销自耗'
      const commissionRate = rateLookup(a.roleType, salesCategory, eventAmount)
      const commissionAmount = Math.round(totalAmount * commissionRate * 100) / 100
      enriched.push({
        saleItemId: a.saleItemId,
        employeeId: a.employeeId,
        roleType: a.roleType,
        allocationRatio: ratioStr,
        totalAmount: totalAmount.toFixed(2),
        commissionRate: commissionRate.toFixed(4),
        commissionAmount: commissionAmount.toFixed(2),
        departmentName: a.departmentName || null,
      })
    }

    
    const pools = new Map<string, typeof enriched>()
    for (const a of enriched) {
      const key = `${a.saleItemId}|${getPoolKey(a.roleType)}`
      const pool = pools.get(key) || []
      pool.push(a)
      pools.set(key, pool)
    }
    for (const [, pool] of pools) {
      if (pool.length > 3) {
        return { success: false, message: '每个商品每个技能标签最多分配 3 人' }
      }
      const base = baseMap.get(pool[0].saleItemId) || 0
      const amountSum = pool.reduce((s, a) => s + Number(a.totalAmount), 0)
      if (amountSum > base + AMOUNT_TOLERANCE) {
        return { success: false, message: '分配金额合计超过本次回款该商品可分配额' }
      }
      const empIds = new Set<string>()
      for (const a of pool) {
        if (empIds.has(a.employeeId)) {
          return { success: false, message: '同一商品同一技能标签不能重复分配同一员工' }
        }
        empIds.add(a.employeeId)
      }
    }

    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE sale_allocations SET is_void = true, voided_at = NOW(), updated_at = NOW()
          WHERE sale_payment_id = ${salePaymentId} AND is_void = false
        `)
        if (enriched.length > 0) {
          await tx.insert(saleAllocations).values(
            enriched.map((a) => ({
              saleItemId: a.saleItemId,
              employeeId: a.employeeId,
              roleType: a.roleType,
              allocationRatio: a.allocationRatio,
              totalAmount: a.totalAmount,
              commissionRate: a.commissionRate,
              commissionAmount: a.commissionAmount,
              departmentName: a.departmentName,
              salePaymentId: Number(salePaymentId),
            })),
          )
        }
        
        
        const upd = await tx.execute(sql`
          UPDATE sale_order_payments SET allocation_status = '已分配'
          WHERE id = ${salePaymentId} AND allocation_status IN ('待分配', '已分配')
        `)
        if (rowsAffected(upd) === 0) {
          throw new Error('PAYMENT_NOT_FOUND')
        }
        await refreshOrderAllocationRollup(tx, pay.sale_order_id as string)
      })
    } catch (err: any) {
      if (err?.message === 'PAYMENT_NOT_FOUND') {
        return { success: false, message: '回款状态已变更，请刷新后重试' }
      }
      if (pgErrorCode(err) === '23503') {
        return { success: false, message: '员工信息不存在，请检查后重试' }
      }
      throw err
    }

    await logOperation(session, 'allocation.savePayment', 'sale_order_payment', String(salePaymentId), {
      allocationCount: allocations.length,
    })
    revalidatePath('/allocations')
    return { success: true, message: enriched.length > 0 ? '分配保存成功' : '已标记为无需分配' }
  },
)
