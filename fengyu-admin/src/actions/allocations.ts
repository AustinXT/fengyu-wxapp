'use server'

import { db } from '@/db'
import { pgErrorCode } from '@/lib/pg-error'
import { saleOrders, saleItems, saleOrderPayments, salePaymentItemAllocations } from '@db/order'
import { clientWechatUsers } from '@db/user'
import { eq, sql, and, or, inArray, desc, ilike, gte, lt } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { SaleAllocation, AuthSession } from '@/lib/types'
import { isAdminScope, isInScope } from '@/lib/permissions'
import { withPermission } from '@/lib/with-permission'
import { logOperation } from '@/lib/operation-log'
import { hasPendingRefund, hasSettledRefundForPayment } from '@/lib/refund-cascade'
import { rowsAffected } from '@/lib/pg-rows'
import { refreshOrderAllocationRollup } from '@/lib/payment-allocatable'
import { nowTs, beijingBoundaryTs } from '@/lib/db-time'
import { storeInMarketCondition } from '@/lib/market-store-sql'
import { getInvalidEmployeeAssignmentId } from '@/lib/employee-assignment-server'

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
  async (session, saleOrderId: string): Promise<Array<SaleAllocation & { salePaymentId?: number }>> => {
  // 校验订单 scope
  if (!(await verifyOrderScope(saleOrderId, session))) {
    return []
  }

  const rows = await db.execute(sql`
    SELECT
      spia.id, spir.sale_item_id, spia.employee_id, spia.allocation_ratio,
      spia.role_type, spia.allocated_amount AS total_amount,
      spia.commission_rate, spia.commission_amount, spir.sale_payment_id,
      spia.is_void, spia.created_at, spia.updated_at,
      swu.name AS employee_name,
      COALESCE(spia.department_name, orn.name) AS department_name,
      si.product_name AS sale_item_name
    FROM sale_payment_item_allocations spia
    JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id
    JOIN sale_items si ON si.sale_item_id = spir.sale_item_id
    LEFT JOIN staff_wechat_users swu ON spia.employee_id = swu.employee_id
    LEFT JOIN org_nodes orn ON swu.org_node_id = orn.id
    WHERE spir.sale_order_id = ${saleOrderId} AND spia.is_void = false
    ORDER BY spir.sale_payment_id DESC, spia.created_at DESC
  `) as any[]

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
  return { success: false, message: '订单级营业额分配已下线，请从回款详情保存分配' }
  },
)

export const deleteAllocation = withPermission(
  'allocation:save',
  async (session, id: number): Promise<{ success: boolean; message: string }> => {
  const [alloc] = (await db.execute(sql`
    SELECT spir.sale_item_id, spia.is_void
      FROM sale_payment_item_allocations spia
      JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id
     WHERE spia.id = ${id}
     LIMIT 1
  `)) as any[]

  if (!alloc) return { success: false, message: '分配记录不存在' }
  if (alloc.is_void) return { success: false, message: '分配记录已被删除' }

  if (!(await verifySaleItemScope(alloc.sale_item_id, session))) {
    return { success: false, message: '无权操作该订单的分配' }
  }

  // 冻结闭环（Bug I）：退款审批中禁止删除营业额分配
  const [delItemRow] = (await db.execute(sql`
    SELECT sale_order_id FROM sale_items WHERE sale_item_id = ${alloc.sale_item_id} LIMIT 1
  `)) as any[]
  if (delItemRow?.sale_order_id && (await hasPendingRefund(db, delItemRow.sale_order_id as string))) {
    return { success: false, message: '该订单退款审批中，暂不可删除分配' }
  }

  await db
    .update(salePaymentItemAllocations)
    .set({ isVoid: true, voidedAt: nowTs() })
    .where(eq(salePaymentItemAllocations.id, id))

  await logOperation(session, 'allocation.delete', 'sale_payment_item_allocation', String(id))

  revalidatePath('/allocations')
  return { success: true, message: '分配已删除' }
  },
)

/** 技能标签池键：每个 roleType 独立建池（P2-14 Q5：池间互不约束） */
function getPoolKey(roleType: string): string {
  return roleType
}

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
  if (!(await verifyOrderScope(saleOrderId, session))) {
    return { success: false, message: '无权操作该订单的分配' }
  }
  void allocations
  return { success: false, message: '订单级营业额分配已下线，请按每笔回款保存分配' }
  },
)

// ============================================================================
// 按回款逐笔分配（2026-06 需求变更）：分配单元从「订单」下沉到「回款事件」。
// 列表/建议/保存均以 sale_payment_id 为粒度；提成率档位基准 = 本次回款额。
// 与 staff allocation.js pendingPayments/suggestPayment/savePayment 同语义。
// ============================================================================

/** 待分配/已分配回款列表（按回款逐笔分配；分页） */
export const getPendingPayments = withPermission(
  'allocation:list',
  async (
    session,
    params: {
      allocationStatus?: '待分配' | '已分配'
      page?: number
      pageSize?: number
      marketId?: string
      storeId?: string
      search?: string
      /** 按下单日期（sale_order_datetime）过滤的日期区间，'YYYY-MM-DD' 串；匹配 UI『下单日期』标签，与导出 buildOrderConditions 同口径 */
      dateFrom?: string
      dateTo?: string
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
      saleOrderType: string
      customerName: string | null
      clientPhone: string | null
      storeName: string | null
      preferredEmployeeId: string | null
    }>
    total: number
  }> => {
    // allocationStatus 缺省（「全部状态」）时不按状态过滤，只限定 allocation_status IS NOT NULL
    // 命中主流水行（走 partial index idx_sop_alloc_status，排除退款/储值卡抵扣从行/待支付等 NULL 行）。
    const page = Math.max(1, Number(params.page) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 20))
    const offset = (page - 1) * pageSize

    const scopeIds = session.permissions.scopeStoreIds
    const conds = [
      params.allocationStatus
        ? eq(saleOrderPayments.allocationStatus, params.allocationStatus)
        : sql`${saleOrderPayments.allocationStatus} IS NOT NULL`,
      params.allocationStatus === '待分配'
        ? sql`(
            EXISTS (
              SELECT 1
                FROM sale_payment_item_receipts spir
               WHERE spir.sale_payment_id = ${saleOrderPayments.id}
                 AND spir.amount::numeric <> 0
                 AND NOT EXISTS (
                   SELECT 1
                     FROM sale_payment_item_allocations spia
                    WHERE spia.sale_payment_item_receipt_id = spir.id
                      AND spia.is_void = false
                 )
            )
            OR (
              NOT EXISTS (
                SELECT 1 FROM sale_payment_item_receipts spir WHERE spir.sale_payment_id = ${saleOrderPayments.id}
              )
              AND GREATEST(COALESCE(${saleOrders.received}::numeric, 0) - COALESCE(${saleOrders.refundedAmount}::numeric, 0), 0) > 0
            )
          )`
        : undefined,
      inArray(saleOrders.saleOrderType, ['销售单', '转换单'] as any),
      // WorkFine 历史单业务排除；展示口径见 @/lib/workfine-legacy。
      sql`${saleOrders.legacySource} IS DISTINCT FROM 'workfine'`,
      isAdminScope(session)
        ? undefined
        : inArray(saleOrders.storeId, scopeIds.length > 0 ? scopeIds : ['__none__']),
      params.marketId ? storeInMarketCondition(saleOrders.storeId, params.marketId) : undefined,
      params.storeId ? eq(saleOrders.storeId, params.storeId) : undefined,
      // 按下单日期过滤（匹配 UI「下单日期」标签；与导出 buildOrderConditions 用 sale_order_datetime 同口径）
      params.dateFrom
        ? gte(saleOrders.saleOrderDatetime, beijingBoundaryTs(params.dateFrom, '00:00:00'))
        : undefined,
      params.dateTo ? lt(saleOrders.saleOrderDatetime, beijingBoundaryTs(params.dateTo, '23:59:59')) : undefined,
      params.search
        ? or(
            ilike(saleOrders.customerName, `%${params.search}%`),
            ilike(saleOrders.clientPhone, `%${params.search}%`),
            ilike(saleOrderPayments.saleOrderId, `%${params.search}%`),
          )
        : undefined,
    ].filter(Boolean)

    const where = and(...(conds as any[]))

    // 2026-07-08 修复 T1：与 orders.ts 对齐，left join clientWechatUsers 做 name/phone 兜底。
    const rows = await db
      .select({
        salePaymentId: saleOrderPayments.id,
        saleOrderId: saleOrderPayments.saleOrderId,
        changeType: saleOrderPayments.changeType,
        amount: saleOrderPayments.amount,
        paymentMethod: saleOrderPayments.paymentMethod,
        paidAt: saleOrderPayments.paidAt,
        allocationStatus: saleOrderPayments.allocationStatus,
        saleOrderType: saleOrders.saleOrderType,
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
        saleOrderType: r.saleOrderType,
        // 顾客档案权威 > sale_orders 兜底
        customerName: r.custName || r.fallbackName || null,
        clientPhone: r.custPhone || r.fallbackPhone || null,
        storeName: r.storeName ?? null,
        preferredEmployeeId: r.preferredEmployeeId ?? null,
      })),
      total: Number(count) || 0,
    }
  },
)

/** 某笔回款的可分配项 + 已有分配（镜像 staff suggestPayment；档位基准 = 本回款额） */
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
      skuId: string | null
      productName: string | null
      productType: string | null
      allocatableAmount: number
      received: number
      salesCategory: string | null
      itemDirection: string | null
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
    // WorkFine 历史单业务排除；展示口径见 @/lib/workfine-legacy。
    if (!['销售单', '转换单'].includes(pay.sale_order_type) || pay.legacy_source === 'workfine') return null

    const items = (await db.execute(sql`
      SELECT spir.id AS receipt_id, spir.sale_item_id, spir.amount, spir.sales_category,
             si.sku_id, si.product_name, si.product_type, si.item_direction
      FROM sale_payment_item_receipts spir
      JOIN sale_items si ON si.sale_item_id = spir.sale_item_id
      WHERE spir.sale_payment_id = ${salePaymentId}
      ORDER BY spir.sale_item_id
    `)) as any[]
    const eventAmount =
      Math.round(items.reduce((s: number, i: any) => s + (Number(i.amount) || 0), 0) * 100) / 100

    const rateLookup = await buildSalesRateLookup(pay.market_name as string | null)

    const existing = (await db.execute(sql`
      SELECT spia.id, spir.sale_item_id, spia.employee_id, spia.role_type, spia.allocation_ratio,
             spia.allocated_amount AS total_amount, swu.name AS employee_name
      FROM sale_payment_item_allocations spia
      JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id
      LEFT JOIN staff_wechat_users swu ON swu.employee_id = spia.employee_id
      WHERE spir.sale_payment_id = ${salePaymentId} AND spia.is_void = false
      ORDER BY spir.sale_item_id
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
        skuId: i.sku_id ?? null,
        productName: i.product_name ?? null,
        productType: i.product_type ?? null,
        allocatableAmount: Number(i.amount),
        received: Number(i.amount), // 别名：前端复用「实收×比例」算法的基数
        salesCategory: i.sales_category ?? null,
        itemDirection: i.item_direction ?? null,
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

/** 保存某笔回款的营业额分配（镜像 staff savePayment；档位按本回款额；池 ≤3，池内 Σ ≤ 该项可分配额） */
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
      SELECT sop.id, sop.sale_order_id, sop.allocation_status, sop.change_type, so.store_id, so.market_name,
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
    // WorkFine 历史单业务排除；展示口径见 @/lib/workfine-legacy。
    if (pay.legacy_source === 'workfine') {
      return { success: false, message: '历史订单不参与营业额分配' }
    }
    // allocation_status 状态守卫（两端镜像 staff allocation.savePayment）：仅「待分配/已分配」可改；
    // NULL（capture 未跑的非营业额事件行）等异常状态不应被无条件翻成「已分配」。
    if (!['待分配', '已分配'].includes(pay.allocation_status as string)) {
      return { success: false, message: '该回款不可分配（状态异常）' }
    }
    if (pay.change_type === '退款') {
      return { success: false, message: '退款赤字分配由系统自动生成，不可手动修改' }
    }
    // 冻结闭环（Bug I）：退款审批中禁止改分配
    if (await hasPendingRefund(db, pay.sale_order_id as string)) {
      return { success: false, message: '该订单退款审批中，暂不可修改分配' }
    }
    // 退款后重分配守卫（2026-06-24）：本回款的可分配 item 中存在「已支付退款」冲销时禁止重分配——退款已记负数冲销行（挂退款流水 id），
    // 重保存会作废原回款正数行 + 写新正数行，与退款负数行脱节 → 净额错乱。回款级守卫：同单其它无关 item 的回款不受影响。两端镜像 staff allocation.savePayment。
    if (await hasSettledRefundForPayment(db, salePaymentId)) {
      return { success: false, message: '该订单已退款，营业额分配已锁定，不可再修改' }
    }
    if (await getInvalidEmployeeAssignmentId(
      allocations.map((allocation) => allocation.employeeId),
      pay.store_id as string,
      { assignmentScope: 'allocationSupport' },
    )) {
      return { success: false, message: '所选员工不属于本门店且未开启出差支援' }
    }

    // 可分配额快照（基数 amount + 销售类别）
    const allocItems = (await db.execute(sql`
      SELECT id AS receipt_id, sale_item_id, amount, sales_category
      FROM sale_payment_item_receipts WHERE sale_payment_id = ${salePaymentId}
    `)) as any[]
    const baseMap = new Map<string, { receiptId: number; amount: number }>(
      allocItems.map((i: any) => [i.sale_item_id, { receiptId: Number(i.receipt_id), amount: Number(i.amount) || 0 }]),
    )
    const catMap = new Map<string, string>(
      allocItems.map((i: any) => [i.sale_item_id, i.sales_category || '自销自耗']),
    )
    const eventAmount =
      Math.round(allocItems.reduce((s: number, i: any) => s + (Number(i.amount) || 0), 0) * 100) / 100
    const rateLookup = await buildSalesRateLookup(pay.market_name as string | null)

    // 校验 + 服务端重算
    const enriched: Array<{
      saleItemId: string
      employeeId: string
      roleType: string
      receiptId: number
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
      // 规范化为 3 位小数字符串（与 staff savePayment 一致，支持自定义小数比例）
      const ratioStr = Number(a.allocationRatio).toFixed(3)
      if (!(Number(ratioStr) > 0 && Number(ratioStr) <= 1)) {
        return { success: false, message: '分配比例必须为 0~1 之间（精度 0.001）' }
      }
      const base = baseMap.get(a.saleItemId)
      if (!base) {
        return { success: false, message: `分配项 ${a.saleItemId} 不属于该回款` }
      }
      const totalAmount = Math.round(base.amount * Number(ratioStr) * 100) / 100
      const salesCategory = catMap.get(a.saleItemId) || '自销自耗'
      const commissionRate = rateLookup(a.roleType, salesCategory, eventAmount)
      const commissionAmount = Math.round(totalAmount * commissionRate * 100) / 100
      enriched.push({
        saleItemId: a.saleItemId,
        employeeId: a.employeeId,
        roleType: a.roleType,
        receiptId: base.receiptId,
        allocationRatio: ratioStr,
        totalAmount: totalAmount.toFixed(2),
        commissionRate: commissionRate.toFixed(4),
        commissionAmount: commissionAmount.toFixed(2),
        departmentName: a.departmentName || null,
      })
    }

    // 按 (saleItemId, roleType) 分池校验：≤3 人、池内 Σ ≤ 该项可分配额、同员工不重复
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
      // 池内分配比例合计 ≤ 100%（容差 0.0001：仅吸收浮点漂移，不放过 ≥0.1% 真实超额）。回款级 base 恒正，比例校验与原金额校验等价；
      // 改用比例校验避免对负数 received（转换单转出行等）方向反转误报，与订单级/前端统一「只看比例」。
      const ratioSum = pool.reduce((s, a) => s + Number(a.allocationRatio), 0)
      if (ratioSum > 1.0001) {
        return { success: false, message: '同技能标签的分配比例合计不能超过 100%' }
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
          UPDATE sale_payment_item_allocations
             SET is_void = true, voided_at = NOW(), updated_at = NOW()
           WHERE sale_payment_item_receipt_id IN (
             SELECT id FROM sale_payment_item_receipts WHERE sale_payment_id = ${salePaymentId}
           )
             AND is_void = false
        `)
        if (enriched.length > 0) {
          await tx.insert(salePaymentItemAllocations).values(
            enriched.map((a) => ({
              salePaymentItemReceiptId: a.receiptId,
              employeeId: a.employeeId,
              roleType: a.roleType,
              allocationRatio: a.allocationRatio,
              allocatedAmount: a.totalAmount,
              commissionRate: a.commissionRate,
              commissionAmount: a.commissionAmount,
              departmentName: a.departmentName,
            })),
          )
        }
        // CAS 守卫：allocation_status 仅 2 值轻量级状态机；IN ('待分配','已分配') 幂等收敛
        // 允许重分配，同时挡住 NULL/脏态历史行与并发覆盖。rowCount=0 → 回款不存在或状态非法。
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
