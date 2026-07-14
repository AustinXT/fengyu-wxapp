'use server'

import { db } from '@/db'
import { rowsAffected } from '@/lib/pg-rows'
import { saleOrders, saleItems, saleOrderPayments, saleAllocations, salePaymentAllocatableItems } from '@db/order'
import { userCoupons, couponTemplates } from '@db/coupon'
import { stores, orgNodes } from '@db/org'
import { clientWechatUsers, staffWechatUsers } from '@db/user'
import { productSkus, productCategories, mallProductSkus } from '@db/product'
import { prepaidCards, cardTransactions } from '@db/prepaid-card'
import { eq, desc, asc, and, or, sql, ilike, gte, lt, gt, inArray, isNull } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import type { SaleOrder, SaleItem, OrderStatus } from '@/lib/types'
import { revalidatePath } from 'next/cache'
import { scopeCondition, isInScope, requireAdmin } from '@/lib/permissions'
import { withPermission, withAnyPermission } from '@/lib/with-permission'
import { logOperation, logTransition } from '@/lib/operation-log'
import { ApiError, parseErrorPrefix } from '@/lib/api-error'
import { hasPendingRefund } from '@/lib/refund-cascade'
import { pgErrorCode, pgErrorConstraint } from '@/lib/pg-error'
import { calcCouponDiscount } from '@/lib/utils'
import { getMemberThreshold } from '@/lib/member-threshold'
import { isMember, resolveUnitPrice } from '@/lib/member-pricing'

import { settlePointsSafe } from '@/lib/points-settle'
import { recalcPaidSessionsForOrder, paidUnusedSessionsExpr } from '@/lib/paid-sessions'
import { capturePaymentAllocatables, refreshOrderAllocationRollup } from '@/lib/payment-allocatable'
import { shanghaiYmd } from '@/lib/datetime'
import { nowTs, beijingBoundaryTs } from '@/lib/db-time'
import { parseOrderFilters, parseAllocationOrderFilters } from '@/lib/list-filters'


const opener = alias(staffWechatUsers, 'opener') as unknown as typeof staffWechatUsers

const preferredStaff = alias(staffWechatUsers, 'preferredStaff') as unknown as typeof staffWechatUsers
const offlineConfirmer = alias(staffWechatUsers, 'offlineConfirmer') as unknown as typeof staffWechatUsers



const DEPOSIT_RECEIPT_NOTE = '寄存单初始化实收'


const LEGACY_INFLOW_NOTE = '旧系统充值金转入'


type DepositTx = Parameters<Parameters<typeof db.transaction>[0]>[0]






async function recomputeDepositRealPrice(tx: DepositTx, saleOrderId: string): Promise<void> {
  await tx.execute(sql`UPDATE sale_items
      SET unit_real_price = CASE
            WHEN session_count > 0 AND received > 0
              THEN ROUND(received::numeric / session_count, 2)
            ELSE unit_price
          END,
          updated_at = NOW()
      WHERE sale_order_id = ${saleOrderId} AND item_direction = '购买' AND product_type = '疗程卡'
      -- DEPOSIT_REAL_PRICE`)
}


async function applyRechargeOnOrderPaid(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  saleOrderId: string,
  
  
  externalRef?: string,
): Promise<void> {
  const [order] = await tx
    .select({
      clientUserId: saleOrders.clientUserId,
      saleOrderType: saleOrders.saleOrderType,
      totalAmount: saleOrders.totalAmount,
    })
    .from(saleOrders)
    .where(eq(saleOrders.saleOrderId, saleOrderId))
    .limit(1)

  
  if (!order || !order.clientUserId || order.saleOrderType !== '充值单') return

  const faceValue = Number(order.totalAmount)
  if (!(faceValue > 0)) return

  
  const dup = await tx.execute(sql`
    SELECT 1 FROM card_transactions WHERE ref_order_id = ${saleOrderId} AND type = '充值' LIMIT 1
  `)
  if ((dup as unknown as any[]).length > 0) return

  
  const newCardId = `FY-CARD-${order.clientUserId}`

  const upsertRows = await tx.execute(sql`
    INSERT INTO prepaid_cards (card_id, user_id, balance)
    VALUES (${newCardId}, ${order.clientUserId}, ${faceValue.toFixed(2)})
    ON CONFLICT (user_id) DO UPDATE
      SET balance = prepaid_cards.balance + EXCLUDED.balance,
          updated_at = NOW()
    RETURNING card_id
  `)
  const cardId = (upsertRows as unknown as any[])[0]?.card_id as string | undefined
  if (!cardId) throw new ApiError('CONFLICT', '充值卡数据写入冲突，请重试')

  await tx.execute(sql`
    INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref)
    VALUES (${cardId}, '充值', ${faceValue.toFixed(2)}, ${saleOrderId}, ${externalRef || 'card-topup-' + saleOrderId})
    ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING
  `)
}


type AdminTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function recalcCustomerType(tx: AdminTx, clientUserId: string): Promise<void> {
  if (!clientUserId) return

  const curRes = await tx.execute(sql`
    SELECT customer_type FROM client_wechat_users WHERE user_id = ${clientUserId}
  `)
  const curRows = curRes as unknown as Array<{ customer_type: string }>
  if (curRows[0]?.customer_type === '会员客') return

  const threshold = await getMemberThreshold()

  
  
  
  const typeRes = await tx.execute(sql`
    SELECT CASE
       WHEN EXISTS (
         SELECT 1 FROM sale_orders o
         WHERE o.client_user_id = ${clientUserId}
           AND o.status IN ('已支付', '已完成')
           AND o.sale_order_type = '销售单'
           AND o.total_amount >= ${threshold}
       ) THEN '会员客'
       WHEN EXISTS (
         SELECT 1
         FROM sale_orders o
         JOIN sale_items si ON si.sale_order_id = o.sale_order_id
         WHERE o.client_user_id = ${clientUserId}
           AND o.status IN ('已支付', '已完成')
           AND o.sale_order_type = '销售单'
           AND si.is_experience = false
       ) THEN '小美客'
       WHEN EXISTS (
         SELECT 1
         FROM sale_orders o
         JOIN sale_items si ON si.sale_order_id = o.sale_order_id
         WHERE o.client_user_id = ${clientUserId}
           AND o.status IN ('已支付', '已完成')
           AND o.sale_order_type = '销售单'
           AND si.is_experience = true
       ) THEN '体验客'
       ELSE '流量客'
     END AS computed_type
  `)
  const typeRows = typeRes as unknown as Array<{ computed_type: string }>
  const newType = typeRows[0]?.computed_type
  if (!newType) return

  const updRes = await tx.execute(sql`
    UPDATE client_wechat_users
       SET customer_type = ${newType}::customer_type, updated_at = NOW()
     WHERE user_id = ${clientUserId}
       AND (CASE customer_type
              WHEN '流量客' THEN 0 WHEN '体验客' THEN 1
              WHEN '小美客' THEN 2 WHEN '会员客' THEN 3
            END)
         < (CASE ${newType}::customer_type
              WHEN '流量客' THEN 0 WHEN '体验客' THEN 1
              WHEN '小美客' THEN 2 WHEN '会员客' THEN 3
            END)
     RETURNING customer_type
  `)
  const updRowCount = rowsAffected(updRes)
  const updRows = updRes as unknown as Array<{ customer_type: string }>
  if (updRowCount > 0 && updRows[0]?.customer_type === '会员客') {
    await tx.execute(sql`
      UPDATE client_wechat_users SET became_member_at = NOW() WHERE user_id = ${clientUserId}
    `)
    
    
    await tx.execute(sql`
      UPDATE sale_orders SET is_membership_upgrade = true
      WHERE sale_order_id = (
        SELECT o.sale_order_id FROM sale_orders o
        WHERE o.client_user_id = ${clientUserId}
          AND o.status IN ('已支付', '已完成')
          AND o.sale_order_type = '销售单'
          AND o.total_amount >= ${threshold}
        ORDER BY o.paid_at ASC NULLS LAST, o.created_at ASC
        LIMIT 1
      )
    `)
  }
}


async function deductPrepaidCardAtCreation(
  tx: AdminTx,
  args: { saleOrderId: string; clientUserId: string; amount: number; employeeId: string; note: string },
): Promise<number | string | null> {
  const { saleOrderId, clientUserId, amount, employeeId, note } = args
  if (!(amount > 0) || !clientUserId) return null

  
  const dupRes = await tx.execute(sql`
    SELECT 1 FROM card_transactions
    WHERE ref_order_id = ${saleOrderId} AND type = '扣款' LIMIT 1
  `)
  if ((dupRes as unknown as any[]).length > 0) return null

  const balRes = await tx.execute(sql`
    SELECT card_id, balance FROM prepaid_cards
    WHERE user_id = ${clientUserId} FOR UPDATE
  `)
  const balRows = balRes as unknown as any[]
  if (balRows.length === 0) {
    throw new Error('INSUFFICIENT_BALANCE:NO_CARD: 顾客无储值卡账户')
  }
  const currentBalance = Number(balRows[0].balance)
  if (currentBalance + 0.001 < amount) {
    throw new Error(`INSUFFICIENT_BALANCE:${currentBalance}: 顾客储值卡余额不足，期望扣 ${amount}，实际 ${currentBalance}`)
  }
  const cardId = balRows[0].card_id as string
  await tx.execute(sql`
    UPDATE prepaid_cards
    SET balance = balance - ${amount}::numeric,
        updated_at = NOW()
    WHERE card_id = ${cardId}
  `)
  await tx.execute(sql`
    INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref, created_at)
    VALUES (${cardId}, '扣款', ${-amount}::numeric, ${saleOrderId}, ${`card-deduct-${saleOrderId}`}, NOW())
    ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING
  `)
  const insRes = await tx.execute(sql`
    INSERT INTO sale_order_payments (
      sale_order_id, change_type, payment_method, amount, status,
      paid_at, source_end, operator_employee_id, note, created_at
    ) VALUES (
      ${saleOrderId}, '储值卡抵扣', '储值卡', ${amount}::numeric, '已支付',
      NOW(), 'admin', ${employeeId}, ${note}, NOW()
    )
    RETURNING id
  `)
  return (insRes as unknown as Array<{ id: number | string }>)[0]?.id ?? null
}

export const getOrders = withPermission(
  'sale_order:list',
  async (session): Promise<SaleOrder[]> => {
  
  
  
  const rows = await db
    .select({
      order: saleOrders,
      storeName: stores.storeName,
      openedByName: opener.name,
      custName: clientWechatUsers.name,
      custPhone: clientWechatUsers.phone,
    })
    .from(saleOrders)
    .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
    .leftJoin(opener, eq(saleOrders.openedBy, opener.employeeId))
    .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
    .where(scopeCondition(session, saleOrders.storeId))
    
    .orderBy(desc(saleOrders.saleOrderDatetime))
    .limit(500)

  return rows.map((r) => ({
    saleOrderId: r.order.saleOrderId,
    status: r.order.status as SaleOrder['status'],
    saleOrderType: r.order.saleOrderType as SaleOrder['saleOrderType'],
    documentType: r.order.documentType as SaleOrder['documentType'],
    refSaleOrderId: r.order.refSaleOrderId,
    legacySource: r.order.legacySource ?? null,
    marketName: r.order.marketName,
    storeId: r.order.storeId,
    saleOrderDatetime: r.order.saleOrderDatetime.toISOString(),
    clientUserId: r.order.clientUserId,
    
    clientPhone: r.custPhone || r.order.clientPhone || null,
    customerName: r.custName || r.order.customerName || null,
    totalAmount: r.order.totalAmount,
    prepaidCardAmount: r.order.prepaidCardAmount ?? '0',
    received: r.order.received ?? '0',
    refundedAmount: r.order.refundedAmount ?? '0',
    paymentMethod: r.order.paymentMethod as SaleOrder['paymentMethod'],
    openedBy: r.order.openedBy,
    preferredEmployeeId: r.order.preferredEmployeeId,
    paidAt: r.order.paidAt?.toISOString() ?? null,
    allocationStatus: r.order.allocationStatus as SaleOrder['allocationStatus'],
    couponId: r.order.couponId,
    couponDiscount: r.order.couponDiscount,
    remark: r.order.remark,
    isActivity: r.order.isActivity ?? false,
    createdAt: r.order.createdAt.toISOString(),
    updatedAt: r.order.updatedAt.toISOString(),
    storeName: r.storeName ?? undefined,
    openedByName: r.openedByName ?? undefined,
  }))
  },
)


export interface OrderFilters {
  status?: string
  type?: string
  storeId?: string
  dateFrom?: string
  dateTo?: string
  search?: string
  
  paymentMethod?: string
  
  hasPrepaidDeduction?: boolean
  
  allocationStatus?: string
  
  allocationEligibleOnly?: boolean
  page?: number
  pageSize?: number
}


function buildOrderConditions(
  session: Parameters<typeof scopeCondition>[0],
  filters: OrderFilters,
): (SQL | undefined)[] {
  const conditions: (SQL | undefined)[] = [
    scopeCondition(session, saleOrders.storeId),
  ]

  if (filters.status) {
    conditions.push(eq(saleOrders.status, filters.status as typeof saleOrders.status.enumValues[number]))
  }
  if (filters.type) {
    conditions.push(eq(saleOrders.saleOrderType, filters.type as typeof saleOrders.saleOrderType.enumValues[number]))
  }
  if (filters.storeId) {
    conditions.push(eq(saleOrders.storeId, filters.storeId))
  }
  if (filters.dateFrom) {
    
    
    
    conditions.push(gte(saleOrders.saleOrderDatetime, beijingBoundaryTs(filters.dateFrom, '00:00:00')))
  }
  if (filters.dateTo) {
    
    conditions.push(lt(saleOrders.saleOrderDatetime, beijingBoundaryTs(filters.dateTo, '23:59:59')))
  }
  if (filters.search) {
    const pattern = `%${filters.search}%`
    conditions.push(
      or(
        ilike(saleOrders.saleOrderId, pattern),
        ilike(saleOrders.customerName, pattern),
        ilike(saleOrders.clientPhone, pattern),
      ),
    )
  }
  
  if (
    filters.paymentMethod === '微信' ||
    filters.paymentMethod === '支付宝' ||
    filters.paymentMethod === '线下' ||
    filters.paymentMethod === '无'
  ) {
    conditions.push(eq(saleOrders.paymentMethod, filters.paymentMethod))
  }
  
  if (filters.hasPrepaidDeduction) {
    conditions.push(gt(saleOrders.prepaidCardAmount, '0'))
  }
  if (filters.allocationStatus === '待分配' || filters.allocationStatus === '已分配') {
    conditions.push(eq(saleOrders.allocationStatus, filters.allocationStatus))
  }
  
  if (filters.allocationEligibleOnly) {
    conditions.push(inArray(saleOrders.saleOrderType, ['销售单', '转换单']))
    conditions.push(sql`${saleOrders.legacySource} IS DISTINCT FROM 'workfine'`)
  }

  return conditions
}


export interface PaginatedOrders {
  data: SaleOrder[]
  total: number
}


export const getOrdersPaginated = withPermission(
  'sale_order:list',
  async (session, filters: OrderFilters = {}): Promise<PaginatedOrders> => {
  const page = Math.max(1, filters.page || 1)
  const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
  const offset = (page - 1) * pageSize

  
  const whereClause = and(...buildOrderConditions(session, filters))

  
  const [countRow] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(saleOrders)
    .where(whereClause)

  const total = countRow?.count ?? 0

  
  
  const rows = await db
    .select({
      order: saleOrders,
      storeName: stores.storeName,
      openedByName: opener.name,
      custName: clientWechatUsers.name,
      custPhone: clientWechatUsers.phone,
    })
    .from(saleOrders)
    .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
    .leftJoin(opener, eq(saleOrders.openedBy, opener.employeeId))
    .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
    .where(whereClause)
    
    .orderBy(desc(saleOrders.saleOrderDatetime))
    .limit(pageSize)
    .offset(offset)

  const data = rows.map((r) => ({
    saleOrderId: r.order.saleOrderId,
    status: r.order.status as SaleOrder['status'],
    saleOrderType: r.order.saleOrderType as SaleOrder['saleOrderType'],
    documentType: r.order.documentType as SaleOrder['documentType'],
    refSaleOrderId: r.order.refSaleOrderId,
    legacySource: r.order.legacySource ?? null,
    marketName: r.order.marketName,
    storeId: r.order.storeId,
    saleOrderDatetime: r.order.saleOrderDatetime.toISOString(),
    clientUserId: r.order.clientUserId,
    clientPhone: r.custPhone || r.order.clientPhone || null,
    customerName: r.custName || r.order.customerName || null,
    totalAmount: r.order.totalAmount,
    prepaidCardAmount: r.order.prepaidCardAmount ?? '0',
    received: r.order.received ?? '0',
    refundedAmount: r.order.refundedAmount ?? '0',
    paymentMethod: r.order.paymentMethod as SaleOrder['paymentMethod'],
    openedBy: r.order.openedBy,
    preferredEmployeeId: r.order.preferredEmployeeId,
    paidAt: r.order.paidAt?.toISOString() ?? null,
    allocationStatus: r.order.allocationStatus as SaleOrder['allocationStatus'],
    couponId: r.order.couponId,
    couponDiscount: r.order.couponDiscount,
    remark: r.order.remark,
    isActivity: r.order.isActivity ?? false,
    
    isMembershipUpgrade: r.order.isMembershipUpgrade ?? false,
    createdAt: r.order.createdAt.toISOString(),
    updatedAt: r.order.updatedAt.toISOString(),
    storeName: r.storeName ?? undefined,
    openedByName: r.openedByName ?? undefined,
  }))

  return { data, total }
  },
)


export interface ExportOrderRow {
  
  marketName: string
  storeName: string | null
  saleOrderId: string
  saleOrderType: string
  documentType: string | null
  status: string
  customerName: string | null
  clientPhone: string | null
  
  totalAmount: string
  
  prepaidCardAmount: string
  
  received: string
  
  refundedAmount: string
  paymentMethod: string | null
  
  isMembershipUpgrade: boolean
  isActivity: boolean
  
  salesCategory: string | null
  
  customerType: string | null
  openedByName: string | null
  saleOrderDatetime: string
  createdAt: string
  
  
  productType: string | null
  
  categoryL1: string | null
  
  categoryL2: string | null
  
  productName: string | null
  
  sessionCount: number | null
  
  paidUnusedSessions: number | null
  
  unitRealPrice: number | null
  
  remark: string | null
}


export const exportOrders = withPermission(
  'sale_order:list',
  async (
    session,
    params: Record<string, string | undefined>,
  ): Promise<{ rows: ExportOrderRow[]; truncated: boolean }> => {
    const LIMIT = 10000
    const filters = parseOrderFilters(params)
    const whereClause = and(...buildOrderConditions(session, filters))

    
    
    
    
    const itemRows = await db
      .select({
        
        marketName: saleOrders.marketName,
        storeName: saleOrders.storeName,
        saleOrderId: saleOrders.saleOrderId,
        saleOrderType: saleOrders.saleOrderType,
        documentType: saleOrders.documentType,
        status: saleOrders.status,
        custName: clientWechatUsers.name,
        custPhone: clientWechatUsers.phone,
        fallbackName: saleOrders.customerName,
        fallbackPhone: saleOrders.clientPhone,
        totalAmount: saleItems.saleAmount,        
        prepaidCardAmount: saleOrders.prepaidCardAmount,
        received: saleItems.received,             
        refundedAmount: saleOrders.refundedAmount,
        paymentMethod: saleOrders.paymentMethod,
        isMembershipUpgrade: saleOrders.isMembershipUpgrade,
        isActivity: saleOrders.isActivity,
        customerType: clientWechatUsers.customerType,
        openedByName: opener.name,
        saleOrderDatetime: saleOrders.saleOrderDatetime,
        createdAt: saleOrders.createdAt,
        remark: saleOrders.remark,
        
        productType: saleItems.productType,
        salesCategory: saleItems.salesCategory,
        productName: saleItems.productName,
        sessionCount: saleItems.sessionCount,
        paidUnusedSessions: paidUnusedSessionsExpr,
        unitRealPrice: saleItems.unitRealPrice,
        categoryL1: productCategories.productKind,
        categoryL2: productCategories.categoryName,
      })
      .from(saleItems)
      .innerJoin(saleOrders, eq(saleItems.saleOrderId, saleOrders.saleOrderId))
      .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
      .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
      .leftJoin(opener, eq(saleOrders.openedBy, opener.employeeId))
      .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
      .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
      .where(and(whereClause, eq(saleItems.itemDirection, '购买')))
      .orderBy(desc(saleOrders.saleOrderDatetime), saleItems.saleItemId)
      .limit(LIMIT + 1)

    const truncated = itemRows.length > LIMIT
    const page = truncated ? itemRows.slice(0, LIMIT) : itemRows

    const num = (v: string | null) => (v == null ? null : Number(v))

    const rows: ExportOrderRow[] = page.map((r) => {
      
      
      
      const isDeposit = r.saleOrderType === '寄存单'
      return {
        
        marketName: r.marketName,
        storeName: r.storeName,
        saleOrderId: r.saleOrderId,
        saleOrderType: r.saleOrderType,
        documentType: r.documentType,
        status: r.status,
        customerName: r.custName || r.fallbackName || null,
        clientPhone: r.custPhone || r.fallbackPhone || null,
        totalAmount: isDeposit ? '' : r.totalAmount,
        prepaidCardAmount: isDeposit ? '' : (r.prepaidCardAmount ?? '0'),
        received: isDeposit ? '' : (r.received ?? '0'),
        refundedAmount: isDeposit ? '' : (r.refundedAmount ?? '0'),
        paymentMethod: r.paymentMethod,
        isMembershipUpgrade: r.isMembershipUpgrade ?? false,
        isActivity: r.isActivity ?? false,
        salesCategory: r.salesCategory,
        customerType: r.customerType,
        openedByName: r.openedByName,
        saleOrderDatetime: r.saleOrderDatetime.toISOString(),
        createdAt: r.createdAt.toISOString(),
        
        productType: r.productType,
        categoryL1: r.categoryL1,
        categoryL2: r.categoryL2,
        productName: r.productName,
        sessionCount: r.sessionCount ?? null,
        paidUnusedSessions: r.paidUnusedSessions ?? null,
        unitRealPrice: num(r.unitRealPrice),
        remark: r.remark,
      }
    })

    return { rows, truncated }
  },
)


export interface ExportAllocationOrderRow {
  market: string | null
  storeName: string | null
  saleOrderId: string
  saleOrderType: string | null
  documentType: string | null
  customerName: string | null
  customerPhone: string | null
  productType: string | null
  categoryL1: string | null
  categoryL2: string | null
  productName: string | null
  sessionCount: number | null
  
  paidUnusedSessions: number | null
  saleAmount: number | null
  prepaidCardAmount: number | null
  received: number | null
  refundedAmount: number | null
  unitRealPrice: number | null
  status: string | null
  allocationStatus: string | null
  employeeName: string | null
  positionName: string | null
  allocationRatio: string | null
  allocationAmount: number | null
  commissionRate: string | null
  commissionAmount: number | null
  isActivity: boolean
  isMembershipUpgrade: boolean
  salesCategory: string | null
  customerType: string | null
  openedByName: string | null
  paidAt: string | null
  remark: string | null
}


export const exportAllocationOrders = withPermission(
  'sale_order:list',
  async (
    session,
    params: Record<string, string | undefined>,
  ): Promise<{ rows: ExportAllocationOrderRow[]; truncated: boolean }> => {
    const LIMIT = 10000

    
    
    
    const filters = parseAllocationOrderFilters(params)
    filters.status = undefined
    filters.allocationStatus = undefined
    const allocStatus = params.allocStatus

    const num = (v: string | null | undefined) => (v == null ? null : Number(v))
    
    const toMs = (d: unknown) => (d instanceof Date ? d.getTime() : d ? Date.parse(String(d)) : 0)
    const merged: Array<{ row: ExportAllocationOrderRow; sort: number }> = []

    
    if (allocStatus !== '待分配') {
      const whereClause = and(eq(saleAllocations.isVoid, false), ...buildOrderConditions(session, filters))
      const raw = await db
        .select({
          market: saleOrders.marketName,
          storeName: stores.storeName,
          saleOrderId: saleOrders.saleOrderId,
          saleOrderType: saleOrders.saleOrderType,
          documentType: saleOrders.documentType,
          customerName: clientWechatUsers.name,
          customerPhone: clientWechatUsers.phone,
          fallbackName: saleOrders.customerName,
          fallbackPhone: saleOrders.clientPhone,
          productType: saleItems.productType,
          categoryL1: productCategories.productKind,
          categoryL2: productCategories.categoryName,
          productName: saleItems.productName,
          sessionCount: saleItems.sessionCount,
          paidUnusedSessions: paidUnusedSessionsExpr,
          saleAmount: saleItems.saleAmount,
          prepaidCardAmount: saleOrders.prepaidCardAmount,
          received: saleItems.received,
          refundedAmount: saleOrders.refundedAmount,
          unitRealPrice: saleItems.unitRealPrice,
          status: saleOrders.status,
          payAllocStatus: saleOrderPayments.allocationStatus,
          orderAllocStatus: saleOrders.allocationStatus,
          employeeName: staffWechatUsers.name,
          positionName: staffWechatUsers.positionName,
          allocationRatio: saleAllocations.allocationRatio,
          allocationAmount: saleAllocations.totalAmount,
          commissionRate: saleAllocations.commissionRate,
          commissionAmount: saleAllocations.commissionAmount,
          isActivity: saleOrders.isActivity,
          isMembershipUpgrade: saleOrders.isMembershipUpgrade,
          salesCategory: saleItems.salesCategory,
          customerType: clientWechatUsers.customerType,
          openedByName: opener.name,
          payPaidAt: saleOrderPayments.paidAt,
          orderPaidAt: saleOrders.paidAt,
          remark: saleOrders.remark,
          sortDatetime: saleOrders.saleOrderDatetime,
        })
        .from(saleAllocations)
        .innerJoin(saleItems, eq(saleAllocations.saleItemId, saleItems.saleItemId))
        .innerJoin(saleOrders, eq(saleItems.saleOrderId, saleOrders.saleOrderId))
        .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
        .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
        .leftJoin(staffWechatUsers, eq(saleAllocations.employeeId, staffWechatUsers.employeeId))
        .leftJoin(opener, eq(saleOrders.openedBy, opener.employeeId))
        .leftJoin(saleOrderPayments, eq(saleAllocations.salePaymentId, saleOrderPayments.id))
        .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
        .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
        .where(whereClause)
        .orderBy(desc(saleOrders.saleOrderDatetime), saleAllocations.id)
        .limit(LIMIT + 1)

      for (const r of raw as any[]) {
        merged.push({
          row: {
            market: r.market,
            storeName: r.storeName,
            saleOrderId: r.saleOrderId,
            saleOrderType: r.saleOrderType,
            documentType: r.documentType,
            customerName: r.customerName ?? r.fallbackName ?? null,
            customerPhone: r.customerPhone ?? r.fallbackPhone ?? null,
            productType: r.productType,
            categoryL1: r.categoryL1,
            categoryL2: r.categoryL2,
            productName: r.productName,
            sessionCount: r.sessionCount ?? null,
            paidUnusedSessions: r.paidUnusedSessions ?? null,
            saleAmount: num(r.saleAmount),
            prepaidCardAmount: num(r.prepaidCardAmount),
            received: num(r.received),
            refundedAmount: num(r.refundedAmount),
            unitRealPrice: num(r.unitRealPrice),
            status: r.status,
            allocationStatus: r.payAllocStatus ?? r.orderAllocStatus ?? null,
            employeeName: r.employeeName,
            positionName: r.positionName,
            allocationRatio: r.allocationRatio,
            allocationAmount: num(r.allocationAmount),
            commissionRate: r.commissionRate,
            commissionAmount: num(r.commissionAmount),
            isActivity: r.isActivity ?? false,
            isMembershipUpgrade: r.isMembershipUpgrade ?? false,
            salesCategory: r.salesCategory,
            customerType: r.customerType,
            openedByName: r.openedByName,
            paidAt: r.payPaidAt?.toISOString() ?? r.orderPaidAt?.toISOString() ?? null,
            remark: r.remark,
          },
          sort: toMs(r.sortDatetime),
        })
      }
    }

    
    if (allocStatus !== '已分配') {
      const whereClause = and(
        eq(saleOrderPayments.allocationStatus, '待分配'),
        eq(saleOrderPayments.status, '已支付'),
        ...buildOrderConditions(session, filters),
      )
      const raw = await db
        .select({
          market: saleOrders.marketName,
          storeName: stores.storeName,
          saleOrderId: saleOrders.saleOrderId,
          saleOrderType: saleOrders.saleOrderType,
          documentType: saleOrders.documentType,
          customerName: clientWechatUsers.name,
          customerPhone: clientWechatUsers.phone,
          fallbackName: saleOrders.customerName,
          fallbackPhone: saleOrders.clientPhone,
          productType: saleItems.productType,
          categoryL1: productCategories.productKind,
          categoryL2: productCategories.categoryName,
          productName: saleItems.productName,
          sessionCount: saleItems.sessionCount,
          paidUnusedSessions: paidUnusedSessionsExpr,
          saleAmount: saleItems.saleAmount,
          prepaidCardAmount: saleOrders.prepaidCardAmount,
          received: saleItems.received,
          refundedAmount: saleOrders.refundedAmount,
          unitRealPrice: saleItems.unitRealPrice,
          status: saleOrders.status,
          payAllocStatus: saleOrderPayments.allocationStatus,
          orderAllocStatus: saleOrders.allocationStatus,
          isActivity: saleOrders.isActivity,
          isMembershipUpgrade: saleOrders.isMembershipUpgrade,
          salesCategory: saleItems.salesCategory,
          customerType: clientWechatUsers.customerType,
          openedByName: opener.name,
          payPaidAt: saleOrderPayments.paidAt,
          orderPaidAt: saleOrders.paidAt,
          remark: saleOrders.remark,
          sortDatetime: saleOrders.saleOrderDatetime,
        })
        .from(saleOrderPayments)
        .innerJoin(
          salePaymentAllocatableItems,
          eq(salePaymentAllocatableItems.salePaymentId, saleOrderPayments.id),
        )
        .innerJoin(saleItems, eq(salePaymentAllocatableItems.saleItemId, saleItems.saleItemId))
        .innerJoin(saleOrders, eq(saleItems.saleOrderId, saleOrders.saleOrderId))
        .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
        .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
        .leftJoin(opener, eq(saleOrders.openedBy, opener.employeeId))
        .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
        .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
        .where(whereClause)
        .orderBy(desc(saleOrders.saleOrderDatetime), saleOrderPayments.id)
        .limit(LIMIT + 1)

      for (const r of raw as any[]) {
        merged.push({
          row: {
            market: r.market,
            storeName: r.storeName,
            saleOrderId: r.saleOrderId,
            saleOrderType: r.saleOrderType,
            documentType: r.documentType,
            customerName: r.customerName ?? r.fallbackName ?? null,
            customerPhone: r.customerPhone ?? r.fallbackPhone ?? null,
            productType: r.productType,
            categoryL1: r.categoryL1,
            categoryL2: r.categoryL2,
            productName: r.productName,
            sessionCount: r.sessionCount ?? null,
            paidUnusedSessions: r.paidUnusedSessions ?? null,
            saleAmount: num(r.saleAmount),
            prepaidCardAmount: num(r.prepaidCardAmount),
            received: num(r.received),
            refundedAmount: num(r.refundedAmount),
            unitRealPrice: num(r.unitRealPrice),
            status: r.status,
            allocationStatus: r.payAllocStatus ?? r.orderAllocStatus ?? null,
            
            employeeName: null,
            positionName: null,
            allocationRatio: null,
            allocationAmount: null,
            commissionRate: null,
            commissionAmount: null,
            isActivity: r.isActivity ?? false,
            isMembershipUpgrade: r.isMembershipUpgrade ?? false,
            salesCategory: r.salesCategory,
            customerType: r.customerType,
            openedByName: r.openedByName,
            paidAt: r.payPaidAt?.toISOString() ?? r.orderPaidAt?.toISOString() ?? null,
            remark: r.remark,
          },
          sort: toMs(r.sortDatetime),
        })
      }
    }

    
    merged.sort((a, b) => b.sort - a.sort)
    const truncated = merged.length > LIMIT
    const rows = (truncated ? merged.slice(0, LIMIT) : merged).map((m) => m.row)
    return { rows, truncated }
  },
)



export const getOrderById = withAnyPermission(
  ['sale_order:list', 'sale_order:refund_create', 'sale_order:refund_approve'],
  async (session, saleOrderId: string): Promise<SaleOrder | null> => {
  
  const rows = await db
    .select({
      order: saleOrders,
      storeName: stores.storeName,
      openedByName: opener.name,
      preferredEmployeeName: preferredStaff.name,
      offlineConfirmedByName: offlineConfirmer.name,
      custName: clientWechatUsers.name,
      custPhone: clientWechatUsers.phone,
    })
    .from(saleOrders)
    .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
    .leftJoin(opener, eq(saleOrders.openedBy, opener.employeeId))
    .leftJoin(preferredStaff, eq(saleOrders.preferredEmployeeId, preferredStaff.employeeId))
    .leftJoin(offlineConfirmer, eq(saleOrders.offlineConfirmedBy, offlineConfirmer.employeeId))
    .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
    .where(and(eq(saleOrders.saleOrderId, saleOrderId), scopeCondition(session, saleOrders.storeId)))
    .limit(1)

  if (rows.length === 0) return null

  const r = rows[0]

  
  const itemRows = await db
    .select({
      item: saleItems,
      skuName: productSkus.specName,
    })
    .from(saleItems)
    .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
    .where(eq(saleItems.saleOrderId, saleOrderId))

  const items: SaleItem[] = itemRows.map((ir) => ({
    saleItemId: ir.item.saleItemId,
    saleOrderId: ir.item.saleOrderId,
    itemDirection: ir.item.itemDirection as SaleItem['itemDirection'],
    refSaleItemId: ir.item.refSaleItemId,
    skuId: ir.item.skuId,
    sessionCount: ir.item.sessionCount,
    remainingSessions: ir.item.remainingSessions,
    paidSessions: ir.item.paidSessions,
    unitPrice: ir.item.unitPrice,
    quantity: ir.item.quantity,
    unitRealPrice: ir.item.unitRealPrice,
    saleAmount: ir.item.saleAmount,
    received: ir.item.received,
    pendingReceived: ir.item.pendingReceived,
    expireDate: ir.item.expireDate,
    pickedUpQuantity: ir.item.pickedUpQuantity,
    remark: ir.item.remark,
    salesCategory: ir.item.salesCategory as SaleItem['salesCategory'],
    createdAt: ir.item.createdAt.toISOString(),
    updatedAt: ir.item.updatedAt.toISOString(),
    skuName: ir.skuName ?? undefined,
    productName: ir.item.productName ?? undefined,
  }))

  return {
    saleOrderId: r.order.saleOrderId,
    status: r.order.status as SaleOrder['status'],
    saleOrderType: r.order.saleOrderType as SaleOrder['saleOrderType'],
    documentType: r.order.documentType as SaleOrder['documentType'],
    refSaleOrderId: r.order.refSaleOrderId,
    legacySource: r.order.legacySource ?? null,
    marketName: r.order.marketName,
    storeId: r.order.storeId,
    saleOrderDatetime: r.order.saleOrderDatetime.toISOString(),
    clientUserId: r.order.clientUserId,
    
    clientPhone: r.custPhone || r.order.clientPhone || null,
    customerName: r.custName || r.order.customerName || null,
    totalAmount: r.order.totalAmount,
    prepaidCardAmount: r.order.prepaidCardAmount ?? '0',
    received: r.order.received ?? '0',
    refundedAmount: r.order.refundedAmount ?? '0',
    paymentMethod: r.order.paymentMethod as SaleOrder['paymentMethod'],
    openedBy: r.order.openedBy,
    preferredEmployeeId: r.order.preferredEmployeeId,
    paidAt: r.order.paidAt?.toISOString() ?? null,
    allocationStatus: r.order.allocationStatus as SaleOrder['allocationStatus'],
    couponId: r.order.couponId,
    couponDiscount: r.order.couponDiscount,
    remark: r.order.remark,
    isActivity: r.order.isActivity ?? false,
    createdAt: r.order.createdAt.toISOString(),
    updatedAt: r.order.updatedAt.toISOString(),
    storeName: r.storeName ?? undefined,
    openedByName: r.openedByName ?? undefined,
    preferredEmployeeName: r.preferredEmployeeName ?? undefined,
    offlineConfirmedByName: r.offlineConfirmedByName ?? undefined,
    offlineConfirmedAt: r.order.offlineConfirmedAt?.toISOString() ?? null,
    
    allocatable: ['销售单', '转换单'].includes(r.order.saleOrderType) && r.order.legacySource !== 'workfine',
    items,
  }
  },
)



export const getOrderPayments = withAnyPermission(
  ['sale_order:list', 'sale_order:refund_create', 'sale_order:refund_approve'],
  async (session, saleOrderId: string): Promise<import('@/lib/types').SaleOrderPayment[]> => {
  
  const [order] = await db
    .select({ storeId: saleOrders.storeId })
    .from(saleOrders)
    .where(and(eq(saleOrders.saleOrderId, saleOrderId), scopeCondition(session, saleOrders.storeId)))
    .limit(1)
  if (!order) return []

  const rows = await db
    .select({
      payment: saleOrderPayments,
      operatorName: staffWechatUsers.name,
    })
    .from(saleOrderPayments)
    .leftJoin(staffWechatUsers, eq(saleOrderPayments.operatorEmployeeId, staffWechatUsers.employeeId))
    .where(eq(saleOrderPayments.saleOrderId, saleOrderId))
    
    .orderBy(asc(saleOrderPayments.createdAt))

  return rows.map((r) => ({
    id: r.payment.id,
    saleOrderId: r.payment.saleOrderId,
    changeType: r.payment.changeType as import('@/lib/types').PaymentChangeType,
    amount: r.payment.amount,
    paymentMethod: r.payment.paymentMethod as import('@/lib/types').SaleOrderPayment['paymentMethod'],
    externalTxnId: r.payment.externalTxnId,
    status: r.payment.status as import('@/lib/types').PaymentFlowStatus,
    sourceEnd: r.payment.sourceEnd as import('@/lib/types').PaymentSourceEnd,
    operatorEmployeeId: r.payment.operatorEmployeeId ?? null,
    note: r.payment.note ?? null,
    createdAt: r.payment.createdAt.toISOString(),
    paidAt: r.payment.paidAt?.toISOString() ?? null,
    operatorName: r.operatorName ?? null,
    refundReason: r.payment.refundReason ?? null,
    refSaleItemId: r.payment.refSaleItemId ?? null,
    sessionCount: r.payment.sessionCount ?? null,
    auditEmployeeId: r.payment.auditEmployeeId ?? null,
    auditAt: r.payment.auditAt?.toISOString() ?? null,
    auditRemark: r.payment.auditRemark ?? null,
  }))
  },
)


export const confirmOfflinePayment = withPermission(
  'sale_order:update',
  async (
    session,
    saleOrderId: string,
    confirmAmount?: number,
  ): Promise<{ success: boolean; message: string; status?: OrderStatus; received?: string }> => {
  let txResult:
    | { matched: false }
    | { matched: true; targetStatus: OrderStatus; newReceived: number; customerName: string | null; totalAmount: string | null }
    | null = null
  try {
    txResult = await db.transaction(async (tx) => {
      
      const lockRes = await tx.execute(sql`
        SELECT status, payment_method, store_id, total_amount, payable_amount,
               received, prepaid_card_amount, client_user_id, customer_name
        FROM sale_orders WHERE sale_order_id = ${saleOrderId} FOR UPDATE
      `)
      const lockedRows = lockRes as unknown as any[]
      if (lockedRows.length === 0) return { matched: false as const }
      const locked = lockedRows[0]
      if (locked.status !== '待支付' || locked.payment_method !== '线下') return { matched: false as const }
      if (!isInScope(session, locked.store_id)) return { matched: false as const }

      const orderTotal = Number(locked.total_amount || 0)
      const orderPrepaid = Number(locked.prepaid_card_amount || 0)
      const orderReceived = Number(locked.received || 0)
      const orderPayable = locked.payable_amount != null
        ? Number(locked.payable_amount)
        : Math.round((orderTotal - orderPrepaid) * 100) / 100
      const remainingPayable = Math.round((orderPayable - orderReceived) * 100) / 100

      
      
      
      const pendRes = await tx.execute(sql`
        SELECT COALESCE(SUM(pending_received), 0) AS pt FROM sale_items WHERE sale_order_id = ${saleOrderId}
      `)
      const pendingTotal = Math.round(Number((pendRes as unknown as Array<{ pt: number | string }>)[0]?.pt || 0) * 100) / 100

      
      let cashAmount: number
      if (confirmAmount === undefined || confirmAmount === null) {
        
        
        cashAmount = pendingTotal > 0
          ? Math.max(0, Math.min(remainingPayable, Math.round((pendingTotal - orderPrepaid - orderReceived) * 100) / 100))
          : remainingPayable
      } else {
        cashAmount = Math.round(Number(confirmAmount) * 100) / 100
        if (!Number.isFinite(cashAmount) || cashAmount < 0) {
          throw new ApiError('INVALID_PARAMS', '本次确认金额必须为非负数')
        }
        if (cashAmount > remainingPayable + 0.005) {
          throw new ApiError('INVALID_PARAMS', '本次确认金额不能超过剩余应付金额')
        }
      }

      
      await tx.execute(sql`
        UPDATE sale_items
        SET expire_date = (NOW() + INTERVAL '1 year')::date,
            updated_at = NOW()
        WHERE sale_order_id = ${saleOrderId}
          AND expire_date IS NULL
      `)

      
      
      
      const clientUserId = locked.client_user_id as string | null
      
      let cashPaymentId: number | string | null = null
      let cardPaymentId: number | string | null = null
      if (orderPrepaid > 0 && clientUserId) {
        const dupRes = await tx.execute(sql`
          SELECT 1 FROM card_transactions
          WHERE ref_order_id = ${saleOrderId} AND type = '扣款' LIMIT 1
        `)
        const dupRows = dupRes as unknown as any[]
        if (dupRows.length === 0) {
          const balRes = await tx.execute(sql`
            SELECT card_id, balance FROM prepaid_cards
            WHERE user_id = ${clientUserId} FOR UPDATE
          `)
          const balRows = balRes as unknown as any[]
          if (balRows.length === 0) {
            throw new Error('INSUFFICIENT_BALANCE:NO_CARD: 顾客无储值卡账户')
          }
          const currentBalance = Number(balRows[0].balance)
          if (currentBalance + 0.001 < orderPrepaid) {
            throw new Error(`INSUFFICIENT_BALANCE:${currentBalance}: 顾客储值卡余额不足，期望扣 ${orderPrepaid}，实际 ${currentBalance}`)
          }
          const cardId = balRows[0].card_id as string
          await tx.execute(sql`
            UPDATE prepaid_cards
            SET balance = balance - ${orderPrepaid}::numeric,
                updated_at = NOW()
            WHERE card_id = ${cardId}
          `)
          await tx.execute(sql`
            INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref, created_at)
            VALUES (${cardId}, '扣款', ${-orderPrepaid}::numeric, ${saleOrderId}, ${`card-deduct-${saleOrderId}`}, NOW())
            ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING
          `)
          const cardIns = await tx.execute(sql`
            INSERT INTO sale_order_payments (
              sale_order_id, change_type, payment_method, amount, status,
              paid_at, source_end, operator_employee_id, note, created_at
            ) VALUES (
              ${saleOrderId}, '储值卡抵扣', '储值卡', ${orderPrepaid}::numeric, '已支付',
              NOW(), 'admin', ${session.employeeId}, '管理后台确认线下收款-储值卡抵扣', NOW()
            )
            RETURNING id
          `)
          cardPaymentId = (cardIns as unknown as Array<{ id: number | string }>)[0]?.id ?? null
        }
      }

      
      
      if (cashAmount > 0) {
        const existRes = await tx.execute(sql`
          SELECT 1 FROM sale_order_payments
          WHERE sale_order_id = ${saleOrderId} AND status = '已支付'
            AND change_type IN ('首次支付','回款','退款') LIMIT 1
        `)
        const existRows = existRes as unknown as any[]
        const cashChangeType = existRows.length > 0 ? '回款' : '首次支付'
        const cashIns = await tx.execute(sql`
          INSERT INTO sale_order_payments (
            sale_order_id, change_type, payment_method, amount, status,
            paid_at, source_end, operator_employee_id, note, created_at
          ) VALUES (
            ${saleOrderId}, ${cashChangeType}, '线下', ${cashAmount.toFixed(2)}::numeric, '已支付',
            NOW(), 'admin', ${session.employeeId}, '管理后台确认线下收款', NOW()
          )
          RETURNING id
        `)
        cashPaymentId = (cashIns as unknown as Array<{ id: number | string }>)[0]?.id ?? null
      }

      
      
      
      const sumRes = await tx.execute(sql`
        SELECT
          COALESCE(SUM(CASE WHEN status = '已支付' AND change_type IN ('首次支付','回款','储值卡抵扣')
                            THEN amount::numeric ELSE 0 END), 0) AS new_received,
          COALESCE(SUM(CASE WHEN status = '已支付' AND change_type = '储值卡抵扣'
                            THEN amount::numeric ELSE 0 END), 0) AS new_prepaid
        FROM sale_order_payments
        WHERE sale_order_id = ${saleOrderId}
      `)
      const sumRow = (sumRes as unknown as any[])[0]
      const newReceived = Math.round(Number(sumRow.new_received) * 100) / 100
      const newPrepaid = Math.round(Number(sumRow.new_prepaid) * 100) / 100

      
      
      
      const settleTarget = Math.round((orderPayable + orderPrepaid) * 100) / 100
      const targetStatus: OrderStatus = newReceived + 0.005 >= settleTarget ? '已支付' : '部分支付'
      
      const paidAtExpr = targetStatus === '已支付' ? nowTs() : sql`NULL`
      const updRes = await tx.execute(sql`
        UPDATE sale_orders
        SET status = ${targetStatus}::order_status,
            received = ${newReceived.toFixed(2)}::numeric,
            prepaid_card_amount = ${newPrepaid.toFixed(2)}::numeric,
            paid_at = ${paidAtExpr},
            offline_confirmed_by = ${session.employeeId},
            offline_confirmed_at = NOW(),
            updated_at = NOW()
        WHERE sale_order_id = ${saleOrderId} AND status = '待支付'
      `)
      if (rowsAffected(updRes) === 0) {
        
        return { matched: false as const }
      }

      
      if (targetStatus === '已支付') {
        await applyRechargeOnOrderPaid(tx, saleOrderId)
      }
      
      
      const cashThis = cashPaymentId ? cashAmount : 0
      const cardThis = cardPaymentId ? orderPrepaid : 0
      const allocEventAmount = Math.round((cashThis + cardThis) * 100) / 100
      const allocPrimaryId = cashPaymentId || cardPaymentId
      if (allocPrimaryId && allocEventAmount > 0) {
        await capturePaymentAllocatables(tx, {
          salePaymentId: allocPrimaryId,
          saleOrderId,
          eventAmount: allocEventAmount,
          directedItems: null,
        })
        await refreshOrderAllocationRollup(tx, saleOrderId)
      }

      
      
      await settlePointsSafe(tx, saleOrderId, 'admin.confirmOffline')
      await recalcPaidSessionsForOrder(tx, saleOrderId)
      if (targetStatus === '已支付' && clientUserId) {
        await recalcCustomerType(tx, clientUserId)
      }

      return {
        matched: true as const,
        targetStatus,
        newReceived,
        customerName: locked.customer_name ?? null,
        totalAmount: locked.total_amount ?? null,
      }
    })
  } catch (err: any) {
    if (err instanceof ApiError && err.prefix === 'INVALID_PARAMS') {
      return { success: false, message: err.message.replace(/^INVALID_PARAMS:\s*/, '') }
    }
    
    const msg: string = err?.message || ''
    if (msg.startsWith('INSUFFICIENT_BALANCE')) {
      const stripped = msg.replace(/^INSUFFICIENT_BALANCE:?(NO_CARD)?:?\s*/, '')
      return { success: false, message: stripped || '顾客储值卡余额不足' }
    }
    return { success: false, message: '确认收款失败，请稍后重试' }
  }

  if (!txResult || !txResult.matched) {
    return { success: false, message: '订单状态已变更，无法确认收款' }
  }

  await logTransition(session, 'order.confirmPayment', 'sale_order', saleOrderId, '待支付', txResult.targetStatus, {
    customerName: txResult.customerName, totalAmount: txResult.totalAmount,
  })

  revalidatePath('/orders')
  revalidatePath(`/orders/${saleOrderId}`)
  return {
    success: true,
    message: txResult.targetStatus === '已支付' ? '确认收款成功' : '已确认部分收款',
    status: txResult.targetStatus,
    received: txResult.newReceived.toFixed(2),
  }
  },
)


export const closeOrder = withPermission(
  'sale_order:update',
  async (session, saleOrderId: string): Promise<{ success: boolean; message: string }> => {
  
  const [orderCtx] = await db
    .select({ status: saleOrders.status, customerName: saleOrders.customerName, totalAmount: saleOrders.totalAmount })
    .from(saleOrders)
    .where(eq(saleOrders.saleOrderId, saleOrderId))
    .limit(1)

  
  try {
    const txResult = await db.transaction(async (tx) => {
      const result = await tx
        .update(saleOrders)
        .set({ status: '已关闭' })
        .where(and(
          eq(saleOrders.saleOrderId, saleOrderId),
          or(eq(saleOrders.status, '待支付'), eq(saleOrders.status, '支付失败')),
          scopeCondition(session, saleOrders.storeId),
        ))

      if ((result as any).count === 0) {
        return { matched: false }
      }

      
      await tx.execute(sql`
        UPDATE sale_allocations SET is_void = true, voided_at = NOW()
        WHERE sale_item_id IN (
          SELECT sale_item_id FROM sale_items WHERE sale_order_id = ${saleOrderId}
        ) AND is_void = false
      `)

      
      await tx
        .update(userCoupons)
        .set({ status: '未使用', usedSaleOrderId: null, usedAt: null })
        .where(eq(userCoupons.usedSaleOrderId, saleOrderId))

      return { matched: true }
    })

    if (!txResult.matched) {
      return { success: false, message: '订单状态已变更，无法关闭' }
    }
  } catch {
    return { success: false, message: '关闭订单失败，请稍后重试' }
  }

  await logTransition(session, 'order.close', 'sale_order', saleOrderId, orderCtx?.status ?? '待支付', '已关闭', {
    customerName: orderCtx?.customerName, totalAmount: orderCtx?.totalAmount,
  })

  revalidatePath('/orders')
  revalidatePath('/allocations')
  return { success: true, message: '订单已关闭' }
  },
)


export const resetOrderFailed = withPermission(
  'sale_order:update',
  async (session, saleOrderId: string): Promise<{ success: boolean; message: string }> => {
  
  const [orderCtx] = await db
    .select({ customerName: saleOrders.customerName, totalAmount: saleOrders.totalAmount })
    .from(saleOrders)
    .where(eq(saleOrders.saleOrderId, saleOrderId))
    .limit(1)

  let result: any
  try {
    result = await db
      .update(saleOrders)
      .set({ status: '待支付' })
      .where(and(
        eq(saleOrders.saleOrderId, saleOrderId),
        eq(saleOrders.status, '支付失败'),
        scopeCondition(session, saleOrders.storeId),
      ))
  } catch (err: any) {
    throw err
  }

  if ((result as any).count === 0) {
    return { success: false, message: '订单状态已变更，无法重置' }
  }

  await logTransition(session, 'order.resetFailed', 'sale_order', saleOrderId, '支付失败', '待支付', {
    customerName: orderCtx?.customerName, totalAmount: orderCtx?.totalAmount,
  })

  revalidatePath('/orders')
  return { success: true, message: '已重置为待支付' }
  },
)


export const deleteOrder = withPermission(
  'sale_order:delete',
  async (session, saleOrderId: string): Promise<{ success: boolean; message: string }> => {
    requireAdmin(session)
    
    const [order] = await db
      .select({
        status: saleOrders.status,
        received: saleOrders.received,
        customerName: saleOrders.customerName,
        totalAmount: saleOrders.totalAmount,
        saleOrderType: saleOrders.saleOrderType,
        
        
        legacySource: saleOrders.legacySource,
      })
      .from(saleOrders)
      .where(and(eq(saleOrders.saleOrderId, saleOrderId), scopeCondition(session, saleOrders.storeId)))
      .limit(1)

    if (!order) {
      return { success: false, message: '订单不存在或无权操作' }
    }
    
    const isDeposit = order.saleOrderType === '寄存单'
    
    if (
      !isDeposit &&
      (Number(order.received) > 0 || (['已支付', '已完成', '部分支付'] as string[]).includes(order.status))
    ) {
      return { success: false, message: '订单已有实收或已支付，不可删除（财务数据受保护）' }
    }

    
    
    if (!isDeposit) {
      const [paidPayment] = await db
        .select({ id: saleOrderPayments.id })
        .from(saleOrderPayments)
        .where(and(eq(saleOrderPayments.saleOrderId, saleOrderId), eq(saleOrderPayments.status, '已支付')))
        .limit(1)
      if (paidPayment) {
        return { success: false, message: '订单存在已支付款项流水，不可删除' }
      }
    }

    
    const [ptRef] = await db.execute<{ one: number }>(
      sql`SELECT 1 AS one FROM point_transactions WHERE ref_order_id = ${saleOrderId} LIMIT 1`,
    ) as unknown as Array<{ one: number }>
    const [ctRef] = await db.execute<{ one: number }>(
      sql`SELECT 1 AS one FROM card_transactions WHERE ref_order_id = ${saleOrderId} LIMIT 1`,
    ) as unknown as Array<{ one: number }>
    if (ptRef || ctRef) {
      return { success: false, message: '订单关联了积分或储值卡流水，不可删除' }
    }

    
    
    const [downstream] = await db.execute<{ one: number }>(
      sql`SELECT 1 AS one
          FROM sale_items si
          WHERE si.sale_order_id = ${saleOrderId}
            AND (
              EXISTS (SELECT 1 FROM service_items WHERE sale_item_id = si.sale_item_id)
              OR EXISTS (SELECT 1 FROM pickup_records WHERE sale_item_id = si.sale_item_id)
              OR EXISTS (SELECT 1 FROM appointments WHERE sale_item_id = si.sale_item_id)
            )
          LIMIT 1`,
    ) as unknown as Array<{ one: number }>
    if (downstream) {
      return { success: false, message: '订单已产生服务单 / 提货 / 预约，不可删除' }
    }

    
    const [childOrder] = await db
      .select({ id: saleOrders.saleOrderId })
      .from(saleOrders)
      .where(eq(saleOrders.refSaleOrderId, saleOrderId))
      .limit(1)
    if (childOrder) {
      return { success: false, message: '存在引用本单的回款 / 退款 / 转换单据，不可删除' }
    }

    
    try {
      const txResult = await db.transaction(async (tx) => {
        await tx
          .update(userCoupons)
          .set({ status: '未使用', usedSaleOrderId: null, usedAt: null })
          .where(eq(userCoupons.usedSaleOrderId, saleOrderId))

        await tx.execute(sql`
          DELETE FROM sale_allocations
          WHERE sale_item_id IN (SELECT sale_item_id FROM sale_items WHERE sale_order_id = ${saleOrderId})
        `)
        
        await tx.execute(sql`DELETE FROM sale_order_payments WHERE sale_order_id = ${saleOrderId}`)
        await tx.execute(sql`DELETE FROM sale_items WHERE sale_order_id = ${saleOrderId}`)

        const result = await tx
          .delete(saleOrders)
          .where(and(
            eq(saleOrders.saleOrderId, saleOrderId),
            
            
            
            
            
            
            or(
              inArray(saleOrders.status, ['待支付', '支付失败', '已关闭']),
              eq(saleOrders.saleOrderType, '寄存单'),
              and(
                eq(saleOrders.legacySource, 'workfine'),
                eq(saleOrders.status, '已作废'),
              ),
            ),
            scopeCondition(session, saleOrders.storeId),
          ))
        if ((result as any).count === 0) {
          
          throw new Error('ORDER_STATE_CHANGED')
        }
        return true
      })
      if (!txResult) {
        return { success: false, message: '订单状态已变更，请刷新重试' }
      }
    } catch (e) {
      if (e instanceof Error && e.message === 'ORDER_STATE_CHANGED') {
        return { success: false, message: '订单状态已变更，请刷新重试' }
      }
      if (pgErrorCode(e) === '23503') {
        return { success: false, message: '订单存在关联业务数据，无法删除' }
      }
      throw e
    }

    await logOperation(session, 'order.delete', 'sale_order', saleOrderId, {
      snapshot: {
        status: order.status,
        received: order.received,
        totalAmount: order.totalAmount,
        customerName: order.customerName,
        saleOrderType: order.saleOrderType,
        
        
        legacySource: order.legacySource,
        auditReason: order.legacySource === 'workfine' && order.status === '已作废'
          ? 'historical_void_cleanup' : 'admin_cleanup',
      },
    })

    revalidatePath('/orders')
    revalidatePath('/allocations')
    
    
    
    revalidatePath('/legacy-orders')
    return { success: true, message: '订单已删除' }
  },
)


export const createOrder = withPermission(
  'sale_order:create',
  async (
    session,
    data: {
  storeId: string
  marketName: string
  clientUserId: string
  clientPhone: string
  customerName: string
  paymentMethod: '微信' | '支付宝' | '线下'
  
  
  
  
  saleOrderType: '销售单' | '内部单' | '转换单'
  openedBy?: string
  preferredEmployeeId?: string
  remark?: string | null
  
  isActivity?: boolean
  
  couponId?: string | null
  
  receivedAmount?: number
  
  prepaidCardAmount?: number
  items: Array<{
    skuId: string
    productName: string
    productType: '疗程卡' | '家居产品'
    sessionCount: number | null
    unitPrice: string
    unitRealPrice: string
    quantity: number
    
    saleAmount?: string
    
    received?: string
    salesCategory?: '自销自耗' | '他销自耗' | '他销他耗' | '生态合作' | null
    
    isBundle?: boolean
  }>
    },
  ): Promise<{
    success: boolean
    message: string
    saleOrderId?: string
    
    status?: '待支付' | '部分支付' | '已支付'
  }> => {
  
  
  
  const ALLOWED_SALE_ORDER_TYPES = ['销售单', '内部单', '转换单'] as const
  if (!ALLOWED_SALE_ORDER_TYPES.includes(data.saleOrderType as typeof ALLOWED_SALE_ORDER_TYPES[number])) {
    return {
      success: false,
      message: `INVALID_PARAMS: SALE_ORDER_TYPE_INVALID: 不允许的 saleOrderType: ${data.saleOrderType}（'回款单' 走 recordPayment；'退款单' 走 createRefund）`,
    }
  }

  
  
  if (Array.isArray(data.couponId)) {
    return {
      success: false,
      message: 'INVALID_PARAMS: MULTIPLE_COUPON_NOT_SUPPORTED: 一张订单仅支持 1 张优惠券',
    }
  }

  if (!data.clientUserId) {
    return { success: false, message: '顾客未注册小程序或未绑定门店' }
  }

  
  if (!isInScope(session, data.storeId)) {
    return { success: false, message: '无权在该门店创建订单' }
  }

  
  

  
  
  
  
  
  
  
  
  if (data.saleOrderType === '内部单' && data.couponId) {
    return { success: false, message: '内部单不允许叠加优惠券' }
  }

  
  const repriceSkuIds = data.items.map((i) => i.skuId).filter((s): s is string => !!s)
  const skuPricingMap = new Map<string, { price: string; specialPrice: string | null; isExperience: boolean; isManagerSpecial: boolean }>()
  if (repriceSkuIds.length > 0) {
    const pricingRows = await db
      .select({
        skuId: productSkus.skuId,
        price: productSkus.price,
        specialPrice: productSkus.specialPrice,
        isExperience: productSkus.isExperience,
        isManagerSpecial: productSkus.isManagerSpecial,
      })
      .from(productSkus)
      .where(and(inArray(productSkus.skuId, repriceSkuIds), isNull(productSkus.deletedAt)))
    for (const r of pricingRows) {
      skuPricingMap.set(r.skuId, {
        price: r.price,
        specialPrice: r.specialPrice,
        isExperience: r.isExperience === true,
        isManagerSpecial: r.isManagerSpecial === true,
      })
    }
  }

  
  
  
  
  
  if (data.saleOrderType === '内部单') {
    const missingInternalSkuId = repriceSkuIds.find((id) => !skuPricingMap.has(id))
    if (missingInternalSkuId) {
      return { success: false, message: `商品 ${missingInternalSkuId} 不存在或已下架，请刷新后重试` }
    }
  }

  
  
  let buyerCustomerType: string | null = null
  let buyerIsMember = false
  if (data.clientUserId) {
    const [buyerRow] = await db
      .select({ customerType: clientWechatUsers.customerType, memberLevel: clientWechatUsers.memberLevel })
      .from(clientWechatUsers)
      .where(eq(clientWechatUsers.userId, data.clientUserId))
      .limit(1)
    buyerCustomerType = buyerRow?.customerType ?? null
    buyerIsMember = isMember(buyerRow?.customerType, buyerRow?.memberLevel)
  }

  
  
  data = {
    ...data,
    items: data.items.map((item) => {
      const pricing = skuPricingMap.get(item.skuId)
      
      
      if (!pricing) return item
      const listUnit = Number(pricing.price) || 0
      const qty = item.quantity || 1
      const applicableUnit = resolveUnitPrice(
        { price: pricing.price, specialPrice: pricing.specialPrice, isExperience: pricing.isExperience },
        buyerIsMember,
      ).realUnit
      const clampReceived = (sale: number) =>
        item.received !== undefined ? Math.max(0, Math.min(Number(item.received), sale)).toFixed(2) : undefined

      
      if (data.saleOrderType === '内部单') {
        const realUnit = Math.round(listUnit * 50) / 100
        const sale = Math.round(realUnit * qty * 100) / 100
        return {
          ...item,
          unitPrice: listUnit.toFixed(2),
          unitRealPrice: realUnit.toFixed(2),
          saleAmount: sale.toFixed(2),
          received: clampReceived(sale),
        }
      }

      
      if (item.isBundle === true) return item

      
      if (pricing.isManagerSpecial) {
        const rawUnit = item.unitRealPrice != null && item.unitRealPrice !== ''
          ? Number(item.unitRealPrice)
          : (item.saleAmount != null && item.saleAmount !== '' ? Number(item.saleAmount) / qty : applicableUnit)
        const realUnit = Math.max(0, Math.min(Number.isFinite(rawUnit) ? rawUnit : applicableUnit, applicableUnit))
        const sale = Math.round(realUnit * qty * 100) / 100
        return {
          ...item,
          unitPrice: listUnit.toFixed(2),
          unitRealPrice: realUnit.toFixed(2),
          saleAmount: sale.toFixed(2),
          received: clampReceived(sale),
        }
      }

      
      const sale = Math.round(applicableUnit * qty * 100) / 100
      return {
        ...item,
        unitPrice: listUnit.toFixed(2),
        unitRealPrice: applicableUnit.toFixed(2),
        saleAmount: sale.toFixed(2),
        received: clampReceived(sale),
      }
    }),
  }

  
  for (const item of data.items) {
    if (item.saleAmount !== undefined) {
      const sa = Number(item.saleAmount)
      if (isNaN(sa) || sa < 0) return { success: false, message: '应付金额无效' }
    }
    if (item.received !== undefined) {
      const rc = Number(item.received)
      if (isNaN(rc) || rc < 0) return { success: false, message: '实付金额无效' }
      const sa = item.saleAmount ? Number(item.saleAmount) : Number(item.unitRealPrice) * item.quantity
      if (rc > sa + 0.005) return { success: false, message: '实付金额不能超过应付金额' }
    }
  }

  
  
  
  
  
  
  
  
  
  
  
  data = {
    ...data,
    items: data.items.flatMap((item) => {
      if (item.productType !== '疗程卡' || item.quantity <= 1) {
        return [item]
      }
      const n = item.quantity
      const totalSale = item.saleAmount !== undefined
        ? Number(item.saleAmount)
        : Number(item.unitRealPrice) * n
      const totalReceived = item.received !== undefined
        ? Number(item.received)
        : totalSale
      const perSaleCents = Math.round((totalSale * 100) / n)
      const totalSaleCents = Math.round(totalSale * 100)
      let remainingReceivedCents = item.received !== undefined ? Math.round(totalReceived * 100) : null
      const rows: typeof item[] = []
      for (let i = 0; i < n; i++) {
        const isLast = i === n - 1
        const saleCents = isLast
          ? totalSaleCents - perSaleCents * (n - 1)
          : perSaleCents
        const saleStr = (saleCents / 100).toFixed(2)
        
        let receivedStr: string | undefined = undefined
        if (remainingReceivedCents !== null) {
          const takenCents = Math.max(0, Math.min(remainingReceivedCents, saleCents))
          remainingReceivedCents -= takenCents
          receivedStr = (takenCents / 100).toFixed(2)
        }
        rows.push({
          ...item,
          quantity: 1,
          
          unitRealPrice: item.unitRealPrice,
          
          
          saleAmount: item.saleAmount !== undefined ? saleStr : undefined,
          received: receivedStr,
        })
      }
      return rows
    }),
  }

  
  
  
  
  const rawTotal = Math.round(data.items.reduce((sum, item) => {
    const computed = Number(item.unitRealPrice) * item.quantity
    const itemAmount = item.saleAmount ? Number(item.saleAmount) : computed
    return sum + Math.round(itemAmount * 100) / 100
  }, 0) * 100) / 100

  
  
  let couponDiscount = 0
  if (data.couponId && data.clientUserId) {
    
    const orderSkuIds = data.items.map(i => i.skuId).filter(Boolean)
    const [skuCatRows, skuProdRows] = await Promise.all([
      db.select({ skuId: productSkus.skuId, categoryId: productSkus.categoryId })
        .from(productSkus).where(and(inArray(productSkus.skuId, orderSkuIds), isNull(productSkus.deletedAt))),
      db.select({ skuId: mallProductSkus.skuId, productId: mallProductSkus.productId })
        .from(mallProductSkus).where(inArray(mallProductSkus.skuId, orderSkuIds)),
    ])
    const skuCatMap = new Map(skuCatRows.map(r => [r.skuId, r.categoryId]))
    const skuProdMap = new Map(skuProdRows.map(r => [r.skuId, r.productId]))
    const [coupon] = await db
      .select({
        status: userCoupons.status,
        expireAt: userCoupons.expireAt,
        userId: userCoupons.userId,
        couponType: couponTemplates.couponType,
        discountValue: sql<number>`COALESCE(${userCoupons.faceValueOverride}, ${couponTemplates.discountValue})`,
        maxDiscount: couponTemplates.maxDiscount,
        minSpend: couponTemplates.minSpend,
        isActive: couponTemplates.isActive,
        applicableStoreIds: couponTemplates.applicableStoreIds,
        applicableCategoryIds: couponTemplates.applicableCategoryIds,
        applicableProductIds: couponTemplates.applicableProductIds,
        applicableMarketIds: couponTemplates.applicableMarketIds,
      })
      .from(userCoupons)
      .innerJoin(couponTemplates, eq(userCoupons.templateId, couponTemplates.templateId))
      .where(eq(userCoupons.couponId, data.couponId))
      .limit(1)

    if (!coupon) return { success: false, message: '优惠券不存在' }
    if (coupon.userId !== data.clientUserId) return { success: false, message: '优惠券不属于该顾客' }
    if (coupon.status !== '未使用') return { success: false, message: '优惠券已被使用或已失效' }
    if (coupon.expireAt < new Date()) return { success: false, message: '优惠券已过期' }
    if (!coupon.isActive) return { success: false, message: '该优惠券模板已停用' }

    
    if (coupon.applicableStoreIds && coupon.applicableStoreIds.length > 0) {
      if (!data.storeId || !coupon.applicableStoreIds.includes(data.storeId)) {
        return { success: false, message: '该优惠券不适用于当前门店' }
      }
    }

    
    if (coupon.applicableMarketIds && coupon.applicableMarketIds.length > 0) {
      const [storeRow] = await db
        .select({ parentId: orgNodes.parentId })
        .from(stores)
        .innerJoin(orgNodes, eq(stores.orgNodeId, orgNodes.id))
        .where(eq(stores.storeId, data.storeId))
        .limit(1)
      const marketId = storeRow?.parentId
      if (!marketId || !coupon.applicableMarketIds.includes(marketId)) {
        return { success: false, message: '该优惠券不适用于当前市场' }
      }
    }

    
    
    
    
    const hasCatRestriction = !!(coupon.applicableCategoryIds && coupon.applicableCategoryIds.length > 0)
    const hasProdRestriction = !!(coupon.applicableProductIds && coupon.applicableProductIds.length > 0)
    let eligibleItems = data.items
    if (hasCatRestriction || hasProdRestriction) {
      eligibleItems = data.items.filter((item) => {
        const catMatch = !hasCatRestriction
          || coupon.applicableCategoryIds!.includes(skuCatMap.get(item.skuId) as string)
        const prodMatch = !hasProdRestriction
          || coupon.applicableProductIds!.includes(skuProdMap.get(item.skuId) as string)
        return catMatch && prodMatch
      })
      if (eligibleItems.length === 0) {
        const msg = hasCatRestriction && hasProdRestriction
          ? '订单商品不满足优惠券的品类与商品限制'
          : hasProdRestriction
            ? '订单商品不满足优惠券的商品限制'
            : '订单商品不满足优惠券的品类限制'
        return { success: false, message: msg }
      }
    }

    
    
    
    const eligibleTotalRaw = eligibleItems.reduce((sum, item) => {
      const itemSale = item.saleAmount ? Number(item.saleAmount) : Number(item.unitRealPrice) * item.quantity
      return sum + Math.round(itemSale * 100) / 100
    }, 0)
    const eligibleTotal = Math.round(eligibleTotalRaw * 100) / 100

    const minSpend = parseFloat(coupon.minSpend ?? '0')
    
    if (eligibleTotal + 0.001 < minSpend) {
      return { success: false, message: `订单金额未满足优惠券最低消费 ¥${minSpend.toFixed(2)}` }
    }
    couponDiscount = calcCouponDiscount(coupon.couponType, String(coupon.discountValue), coupon.maxDiscount ?? null, eligibleTotal)
    couponDiscount = Math.round(couponDiscount * 100) / 100

    
    
    
    if (couponDiscount > 0 && eligibleItems.length > 0) {
      
      
      const eligibleIdx = eligibleItems.map((it) => data.items.indexOf(it))
      data = { ...data, items: data.items.map((it) => ({ ...it })) }
      eligibleItems = eligibleIdx.map((i) => data.items[i])

      let distributed = 0
      for (let i = 0; i < eligibleItems.length; i++) {
        const it = eligibleItems[i]
        const itSaleRaw = it.saleAmount ? Number(it.saleAmount) : Number(it.unitRealPrice) * it.quantity
        const itSale = Math.round(itSaleRaw * 100) / 100
        let share: number
        if (i === eligibleItems.length - 1) {
          share = Math.round((couponDiscount - distributed) * 100) / 100
        } else {
          share = Math.round(couponDiscount * (itSale / eligibleTotal) * 100) / 100
          distributed += share
        }
        const newSale = Math.max(0, Math.round((itSale - share) * 100) / 100)
        it.saleAmount = newSale.toFixed(2)
        const inputReceived = it.received != null ? Number(it.received) : null
        const finalReceived = inputReceived != null ? Math.min(inputReceived, newSale) : newSale
        it.received = finalReceived.toFixed(2)
      }
    }
  }

  const totalAmount = Math.round(Math.max(0, rawTotal - couponDiscount) * 100) / 100

  
  
  const prepaidCardAmount = Math.max(0, data.prepaidCardAmount ?? 0)
  if (prepaidCardAmount > totalAmount + 0.005) {
    return { success: false, message: '储值卡抵扣金额不能超过订单总额' }
  }
  const payableAmount = Math.max(0, Math.round((totalAmount - prepaidCardAmount) * 100) / 100)

  
  
  
  
  
  
  const isOnlinePay = data.paymentMethod === '微信' || data.paymentMethod === '支付宝'
  const receivedAmount = isOnlinePay
    ? (data.receivedAmount !== undefined ? Math.round(Number(data.receivedAmount) * 100) / 100 : 0)
    : 0
  if (!Number.isFinite(receivedAmount) || receivedAmount < 0) {
    return { success: false, message: '本次收款金额无效' }
  }
  if (receivedAmount > payableAmount + 0.005) {
    return { success: false, message: '本次收款金额不能超过应付实金' }
  }

  
  
  const firstPaymentAmount: number | null =
    isOnlinePay && receivedAmount > 0 && receivedAmount + 0.005 < payableAmount
      ? Math.min(receivedAmount, payableAmount)
      : null

  
  
  
  const isFullCardCoverage = prepaidCardAmount > 0 && payableAmount === 0

  
  
  
  
  
  const initialStatus: typeof saleOrders.$inferInsert['status'] = isFullCardCoverage ? '已支付' : '待支付'

  
  const effectivePaymentMethod = isFullCardCoverage ? '无' : data.paymentMethod

  
  
  const paidAmountSnapshot = isFullCardCoverage ? prepaidCardAmount : 0

  
  
  
  const documentType: '售前' | '售后' = buyerCustomerType === '会员客' ? '售后' : '售前'

  
  
  
  
  
  
  const skuIdList = data.items.map(i => i.skuId).filter((s): s is string => !!s)
  const skuFeeMap = new Map<string, string>()
  const skuSessionMap = new Map<string, number | null>()
  const skuExperienceMap = new Map<string, boolean>()
  
  const skuManagerSpecialMap = new Map<string, boolean>()
  
  
  
  
  
  const skuShengmeiMap = new Map<string, boolean | null>()
  const skuSalesCategoryMap = new Map<string, (typeof saleItems.$inferInsert)['salesCategory']>()
  if (skuIdList.length > 0) {
    const skuRows = await db
      .select({
        skuId: productSkus.skuId,
        serviceFee: productSkus.serviceFee,
        sessionCount: productSkus.sessionCount,
        isExperience: productSkus.isExperience,
        isManagerSpecial: productSkus.isManagerSpecial,
        isShengmei: productSkus.isShengmei,
        salesCategory: productCategories.salesCategory,
      })
      .from(productSkus)
      .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
      .where(and(inArray(productSkus.skuId, skuIdList), isNull(productSkus.deletedAt)))
    for (const r of skuRows) {
      skuFeeMap.set(r.skuId, r.serviceFee)
      skuSessionMap.set(r.skuId, r.sessionCount)
      skuExperienceMap.set(r.skuId, r.isExperience === true)
      skuManagerSpecialMap.set(r.skuId, r.isManagerSpecial === true)
      skuShengmeiMap.set(r.skuId, r.isShengmei)
      skuSalesCategoryMap.set(r.skuId, r.salesCategory)
    }
  }

  

  
  
  
  
  let authoritativePhone = data.clientPhone
  let authoritativeName = data.customerName
  {
    const [authCust] = await db
      .select({ phone: clientWechatUsers.phone, name: clientWechatUsers.name })
      .from(clientWechatUsers)
      .where(eq(clientWechatUsers.userId, data.clientUserId))
      .limit(1)
    if (authCust?.phone) authoritativePhone = authCust.phone
    if (authCust?.name) authoritativeName = authCust.name
  }

  
  let saleOrderId: string
  try {
    saleOrderId = await db.transaction(async (tx) => {
      
      const idRows = await tx.execute(sql`
        WITH lock AS (
          SELECT pg_advisory_xact_lock(hashtext('sale_order_id_gen'))
        )
        SELECT 'FY-XSD-WX-' || to_char(NOW(), 'YYMMDD') ||
          LPAD(
            (SELECT COALESCE(MAX(
              CAST(NULLIF(SUBSTRING(sale_order_id FROM '.{4}$'), '') AS INTEGER)
            ), 0) + 1
            FROM sale_orders
            WHERE sale_order_id LIKE 'FY-XSD-WX-' || to_char(NOW(), 'YYMMDD') || '%'
            )::TEXT, 4, '0'
          ) AS id
        FROM lock
      `)
      const id = (idRows as any[])[0]?.id as string
      if (!id) throw new ApiError('INVALID_STATE', '订单号生成失败')

      
      
      if (initialStatus === '待支付' && data.clientUserId) {
        const existing = await tx
          .select({ saleOrderId: saleOrders.saleOrderId })
          .from(saleOrders)
          .where(
            and(
              eq(saleOrders.clientUserId, data.clientUserId),
              eq(saleOrders.status, '待支付')
            )
          )
          .limit(1)
        if (existing.length > 0) {
          throw new ApiError('CONFLICT', `该顾客已有待支付订单 ${existing[0].saleOrderId}，请先关闭后再创建新订单`)
        }
      }

      await tx.insert(saleOrders).values({
        saleOrderId: id,
        status: initialStatus,
        saleOrderType: data.saleOrderType,
        documentType,
        marketName: data.marketName,
        storeId: data.storeId,
        storeName: sql<string>`(SELECT store_name FROM stores WHERE store_id = ${data.storeId})`,
        saleOrderDatetime: nowTs(),
        clientUserId: data.clientUserId,
        clientPhone: authoritativePhone,
        customerName: authoritativeName,
        totalAmount: totalAmount.toFixed(2),
        prepaidCardAmount: prepaidCardAmount.toFixed(2),
        payableAmount: payableAmount.toFixed(2),
        received: paidAmountSnapshot.toFixed(2),
        firstPaymentAmount: firstPaymentAmount != null ? firstPaymentAmount.toFixed(2) : null,
        couponId: data.couponId ?? null,
        couponDiscount: couponDiscount > 0 ? couponDiscount.toFixed(2) : '0',
        paymentMethod: effectivePaymentMethod,
        openedBy: data.openedBy || session.employeeId,
        preferredEmployeeId: data.preferredEmployeeId || null,
        allocationStatus: '待分配',
        remark: data.remark || null,
        isActivity: data.isActivity ?? false,
        paidAt: isFullCardCoverage ? nowTs() : null,
      })

      
      
      
      

      
      
      if (data.couponId) {
        const voidResult = await tx
          .update(userCoupons)
          .set({ status: '已使用', usedSaleOrderId: id, usedAt: nowTs() })
          .where(and(eq(userCoupons.couponId, data.couponId), eq(userCoupons.status, '未使用')))

        if ((voidResult as any).count === 0) {
          throw new ApiError('CONFLICT', '优惠券已被使用，请刷新后重试')
        }
      }

      for (let i = 0; i < data.items.length; i++) {
        const item = data.items[i]
        const saleItemId = `${id}-${String(i + 1).padStart(2, '0')}`
        const computedSaleAmount = (Number(item.unitRealPrice) * item.quantity).toFixed(2)
        const saleAmount = item.saleAmount ?? computedSaleAmount
        
        
        
        
        const pendingReceived = item.received ?? saleAmount
        const received = '0.00'

        
        const skuServiceFee = Number(skuFeeMap.get(item.skuId) || 0)
        const serviceFee = (skuServiceFee * item.quantity).toFixed(2)

        
        
        
        
        const skuSessionCount = skuSessionMap.get(item.skuId) ?? item.sessionCount
        const sessionCount = skuSessionCount != null ? skuSessionCount * item.quantity : null

        
        
        const psDenom = (sessionCount != null && sessionCount > 0) ? sessionCount : item.quantity
        const listTotalRow = Number(item.unitPrice) * item.quantity
        const unitRealPrice = psDenom > 0 ? (Number(saleAmount) / psDenom).toFixed(2) : Number(saleAmount).toFixed(2)
        const unitPrice = psDenom > 0 ? (listTotalRow / psDenom).toFixed(2) : Number(item.unitPrice).toFixed(2)

        
        
        const isExperience = skuExperienceMap.get(item.skuId) ?? false

        
        const isManagerSpecial = skuManagerSpecialMap.get(item.skuId) ?? false

        await tx.insert(saleItems).values({
          saleItemId,
          saleOrderId: id,
          storeId: data.storeId,
          itemDirection: '购买',
          skuId: item.skuId,
          productName: item.productName,
          productType: item.productType,
          sessionCount,
          remainingSessions: sessionCount,
          unitPrice,
          quantity: item.quantity,
          unitRealPrice,
          saleAmount,
          received,
          pendingReceived,
          
          
          salesCategory: skuSalesCategoryMap.get(item.skuId) ?? item.salesCategory ?? null,
          isShengmei: skuShengmeiMap.get(item.skuId) ?? null,
          serviceFee,
          isExperience,
          isManagerSpecial,
        })
      }

      

      
      let fullCardPaymentId: number | string | null = null
      if (isFullCardCoverage && data.clientUserId) {
        fullCardPaymentId = await deductPrepaidCardAtCreation(tx, {
          saleOrderId: id,
          clientUserId: data.clientUserId,
          amount: prepaidCardAmount,
          employeeId: session.employeeId,
          note: '管理后台开单-储值卡全额抵扣',
        })
      }

      
      
      if (fullCardPaymentId && prepaidCardAmount > 0) {
        await capturePaymentAllocatables(tx, {
          salePaymentId: fullCardPaymentId,
          saleOrderId: id,
          eventAmount: prepaidCardAmount,
          directedItems: null,
        })
        await refreshOrderAllocationRollup(tx, id)
      }

      
      
      
      
      
      await recalcPaidSessionsForOrder(tx, id)

      
      if (isFullCardCoverage) {
        await settlePointsSafe(tx, id, 'admin.createOrder')
        if (data.clientUserId) {
          await recalcCustomerType(tx, data.clientUserId)
        }
      }

      return id
    })
  } catch (err: any) {
    
    
    
    
    
    if (err instanceof ApiError) {
      const parsed = parseErrorPrefix(err.message)
      return { success: false, message: parsed?.displayMessage ?? err.message }
    }
    
    
    
    if (typeof err?.message === 'string' && err.message.startsWith('INSUFFICIENT_BALANCE')) {
      const stripped = err.message.replace(/^INSUFFICIENT_BALANCE:?(NO_CARD)?:?\s*/, '')
      return { success: false, message: stripped || '顾客储值卡余额不足' }
    }
    
    if (pgErrorCode(err) === '23503') {
      return { success: false, message: '关联数据不存在，请检查门店、商品或顾客信息' }
    }
    
    if (pgErrorCode(err) === '23502') {
      console.error('[createOrder] not_null_violation:', err)
      return { success: false, message: '订单字段缺失，请联系管理员' }
    }
    
    if (pgErrorCode(err) === '23505') {
      return { success: false, message: '订单号冲突，请稍后重试' }
    }
    console.error('[createOrder] unexpected error:', err)
    return { success: false, message: '创建订单失败，请稍后重试' }
  }

  await logOperation(session, 'order.create', 'sale_order', saleOrderId, {
    storeId: data.storeId, totalAmount: totalAmount.toFixed(2), itemCount: data.items.length,
    couponId: data.couponId ?? null, couponDiscount: couponDiscount > 0 ? couponDiscount.toFixed(2) : null,
  })

  revalidatePath('/orders')
  return {
    success: true,
    message: '订单创建成功',
    saleOrderId,
    status: initialStatus as '待支付' | '部分支付' | '已支付',
  }
  },
)


export const createConversionOrder = withPermission(
  'sale_order:create',
  async (
    session,
    data: {
  storeId: string
  marketName: string
  
  clientUserId: string
  paymentMethod: '微信' | '支付宝' | '线下'
  preferredEmployeeId?: string
  remark?: string | null
  
  convertOutSaleItemIds: string[]
  
  convertInItems: Array<{
    skuId: string
    productName: string
    productType: '疗程卡' | '家居产品'
    sessionCount: number | null
    unitPrice: string
    quantity: number
    salesCategory?: '自销自耗' | '他销自耗' | '他销他耗' | '生态合作' | null
  }>
  
  prepaidCardAmount?: number
    },
  ): Promise<{
  success: boolean
  message: string
  saleOrderId?: string
  totalIn?: number
  totalOut?: number
  priceDiff?: number
  prepaidCardCredit?: number
  
  prepaidCardAmount?: number
  }> => {
  if (!isInScope(session, data.storeId)) {
    return { success: false, message: '无权在该门店创建订单' }
  }
  if (!data.clientUserId) {
    return { success: false, message: '转换单必须指定顾客' }
  }
  if (!data.convertOutSaleItemIds?.length) {
    return { success: false, message: '请选择至少一张折抵卡' }
  }
  if (!data.convertInItems?.length) {
    return { success: false, message: '请选择至少一个转入项目' }
  }

  
  const [client] = await db
    .select({
      userId: clientWechatUsers.userId,
      phone: clientWechatUsers.phone,
      name: clientWechatUsers.name,
      customerType: clientWechatUsers.customerType,
    })
    .from(clientWechatUsers)
    .where(eq(clientWechatUsers.userId, data.clientUserId))
    .limit(1)
  if (!client) {
    return { success: false, message: '顾客不存在' }
  }

  
  let result: {
    saleOrderId: string
    totalIn: number
    totalOut: number
    priceDiff: number
    prepaidCardCredit: number
    prepaidCardAmount: number
  }

  try {
    result = await db.transaction(async (tx) => {
      
      const heldRows = await tx.execute(sql`
        SELECT
          si.sale_item_id,
          si.sale_order_id,
          si.store_id,
          si.item_direction,
          si.sku_id,
          si.product_name,
          si.product_type,
          si.session_count,
          si.remaining_sessions,
          si.quantity,
          si.picked_up_quantity,
          si.unit_price,
          si.unit_real_price,
          si.sales_category,
          COALESCE(si.is_shengmei, psk.is_shengmei) AS is_shengmei,
          si.service_fee,
          si.is_experience,
          so.client_user_id,
          so.status AS order_status,
          pc.product_kind
        FROM sale_items si
        INNER JOIN sale_orders so ON si.sale_order_id = so.sale_order_id
        LEFT JOIN product_skus psk ON psk.sku_id = si.sku_id
        LEFT JOIN product_categories pc ON pc.category_id = psk.category_id
        WHERE si.sale_item_id IN (${sql.join(
          data.convertOutSaleItemIds.map((id) => sql`${id}`),
          sql`, `,
        )})
        FOR UPDATE OF si
      `)

      const held = Array.from(heldRows as unknown as Iterable<Record<string, unknown>>)
      if (held.length !== data.convertOutSaleItemIds.length) {
        throw new ApiError('NOT_FOUND', 'CARD_NOT_FOUND: 部分卡不存在或已失效')
      }

      let totalOut = 0
      type OutItem = {
        refSaleItemId: string
        skuId: string | null
        productName: string | null
        productType: '疗程卡' | '家居产品' | null
        sessionCount: number | null
        unitPrice: string
        unitRealPrice: string
        quantity: number
        amount: number
        salesCategory: string | null
        serviceFee: number
        isExperience: boolean
        isShengmei: boolean | null
      }
      const outItems: OutItem[] = []

      for (const row of held) {
        
        if (row.store_id !== data.storeId) throw new ApiError('INVALID_STATE', 'CARD_STORE_MISMATCH: 所选卡不属于当前门店')
        if (row.client_user_id !== data.clientUserId) throw new ApiError('INVALID_STATE', 'CARD_OWNER_MISMATCH: 所选卡不属于该顾客')
        if (row.item_direction !== '购买') throw new ApiError('INVALID_STATE', 'CARD_DIRECTION_INVALID: 所选行非购买行，不可折抵')
        if (row.order_status !== '已支付' && row.order_status !== '已完成') {
          throw new ApiError('INVALID_STATE', 'CARD_ORDER_STATUS_INVALID: 原订单状态不允许转换')
        }
        
        if (await hasPendingRefund(tx, row.sale_order_id as string)) {
          throw new ApiError('INVALID_STATE', 'REFUND_IN_PROGRESS: 部分卡所属订单退款审批中，暂不可折抵')
        }

        const unit = Number(row.unit_real_price)
        const productType = row.product_type as string

        
        let qty = 0
        if (productType === '疗程卡') {
          const rem = Number(row.remaining_sessions ?? 0)
          if (rem <= 0) throw new ApiError('INVALID_STATE', 'CARD_EXHAUSTED: 所选卡已耗尽，无法折抵')
          qty = rem
        } else {
          throw new ApiError('INVALID_PARAMS', 'CARD_TYPE_INVALID: 所选行类型不支持折抵')
        }

        const amount = Math.round(unit * qty * 100) / 100
        totalOut += amount
        
        const origServiceFee = Number(row.service_fee ?? 0)
        const origQty = Number(row.quantity) || 1
        const outServiceFee = -Math.round((origServiceFee * qty / origQty) * 100) / 100

        outItems.push({
          refSaleItemId: row.sale_item_id as string,
          skuId: (row.sku_id as string) ?? null,
          productName: (row.product_name as string) ?? null,
          productType: productType as OutItem['productType'],
          sessionCount: row.session_count !== null ? Number(row.session_count) : null,
          unitPrice: String(row.unit_price),
          unitRealPrice: String(row.unit_real_price),
          quantity: qty,
          amount,
          salesCategory: (row.sales_category as string) ?? null,
          serviceFee: outServiceFee,
          isExperience: row.is_experience === true,
          isShengmei: (row.is_shengmei as boolean | null) ?? null,
        })
      }

      
      const inSkuIds = data.convertInItems.map((i) => i.skuId)
      const skuRows = await tx
        .select({
          skuId: productSkus.skuId,
          price: productSkus.price,
          serviceFee: productSkus.serviceFee,
          sessionCount: productSkus.sessionCount,
          productType: productSkus.productType,
          isExperience: productSkus.isExperience,
          isShengmei: productSkus.isShengmei,
          salesCategory: productCategories.salesCategory,
        })
        .from(productSkus)
        .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
        .where(and(inArray(productSkus.skuId, inSkuIds), isNull(productSkus.deletedAt)))
      const skuMap = new Map(skuRows.map((r) => [r.skuId, r]))

      let totalIn = 0
      const inItems: Array<{
        item: (typeof data.convertInItems)[number]
        sku: typeof skuRows[number]
        amount: number
        serviceFee: number
      }> = []
      for (const inItem of data.convertInItems) {
        const sku = skuMap.get(inItem.skuId)
        if (!sku) throw new ApiError('NOT_FOUND', `SKU_NOT_FOUND: 转入商品不存在 (${inItem.skuId})`)
        const amount = Math.round(Number(sku.price) * inItem.quantity * 100) / 100
        totalIn += amount
        const serviceFee = Math.round(Number(sku.serviceFee ?? 0) * inItem.quantity * 100) / 100
        inItems.push({ item: inItem, sku, amount, serviceFee })
      }

      const priceDiff = Math.round((totalIn - totalOut) * 100) / 100

      
      
      const card = priceDiff > 0
        ? Math.min(Math.max(0, Math.round((data.prepaidCardAmount ?? 0) * 100) / 100), priceDiff)
        : 0
      const payable = Math.max(0, Math.round((Math.max(0, priceDiff) - card) * 100) / 100)
      const isFullCardCoverage = card > 0 && payable === 0

      
      const idRows = await tx.execute(sql`
        WITH lock AS (
          SELECT pg_advisory_xact_lock(hashtext('sale_order_id_gen'))
        )
        SELECT 'FY-XSD-WX-' || to_char(NOW(), 'YYMMDD') ||
          LPAD(
            (SELECT COALESCE(MAX(
              CAST(NULLIF(SUBSTRING(sale_order_id FROM '.{4}$'), '') AS INTEGER)
            ), 0) + 1
            FROM sale_orders
            WHERE sale_order_id LIKE 'FY-XSD-WX-' || to_char(NOW(), 'YYMMDD') || '%'
            )::TEXT, 4, '0'
          ) AS id
        FROM lock
      `)
      const saleOrderId = (idRows as any[])[0]?.id as string
      if (!saleOrderId) throw new ApiError('INVALID_STATE', 'ORDER_ID_GEN_FAILED: 订单号生成失败')

      
      const documentType: '售前' | '售后' = client.customerType === '会员客' ? '售后' : '售前'

      
      
      
      
      
      const orderTotal = Math.max(0, priceDiff).toFixed(2)
      const orderStatus: typeof saleOrders.$inferInsert['status'] =
        priceDiff > 0 ? (payable > 0 ? '待支付' : '已支付') : '已支付'
      const orderPaid = priceDiff <= 0 || isFullCardCoverage
      const effectivePaymentMethod = isFullCardCoverage ? '无' : data.paymentMethod

      await tx.insert(saleOrders).values({
        saleOrderId,
        status: orderStatus,
        saleOrderType: '转换单',
        documentType,
        marketName: data.marketName,
        storeId: data.storeId,
        storeName: sql<string>`(SELECT store_name FROM stores WHERE store_id = ${data.storeId})`,
        saleOrderDatetime: nowTs(),
        clientUserId: data.clientUserId,
        clientPhone: client.phone ?? null,
        customerName: client.name ?? null,
        totalAmount: orderTotal,
        prepaidCardAmount: card.toFixed(2),
        payableAmount: payable.toFixed(2),
        received: isFullCardCoverage ? card.toFixed(2) : '0',
        paymentMethod: effectivePaymentMethod,
        openedBy: session.employeeId,
        preferredEmployeeId: data.preferredEmployeeId || null,
        allocationStatus: '待分配',
        remark: data.remark || null,
        paidAt: orderPaid ? nowTs() : null,
      })

      
      let seq = 1
      for (const out of outItems) {
        const saleItemId = `${saleOrderId}-${String(seq).padStart(2, '0')}`
        seq++
        await tx.insert(saleItems).values({
          saleItemId,
          saleOrderId,
          storeId: data.storeId,
          itemDirection: '转出',
          refSaleItemId: out.refSaleItemId,
          skuId: out.skuId,
          productName: out.productName,
          productType: out.productType,
          sessionCount: out.sessionCount,
          unitPrice: out.unitPrice,
          quantity: out.quantity,
          unitRealPrice: out.unitRealPrice,
          saleAmount: (-out.amount).toFixed(2),
          received: (-out.amount).toFixed(2),
          salesCategory: (out.salesCategory as typeof saleItems.$inferInsert['salesCategory']) ?? null,
          serviceFee: out.serviceFee.toFixed(2),
          
          
          isExperience: out.isExperience,
          
          isShengmei: out.isShengmei,
        })

        
        if (out.productType === '疗程卡') {
          const upd = await tx
            .update(saleItems)
            .set({ remainingSessions: 0 })
            .where(
              and(
                eq(saleItems.saleItemId, out.refSaleItemId),
                eq(saleItems.storeId, data.storeId),
                sql`COALESCE(${saleItems.remainingSessions}, 0) >= ${out.quantity}`,
              ),
            )
          if ((upd as any).count === 0) throw new ApiError('CONFLICT', 'CARD_CONCURRENT_CHANGED: 卡状态变化，请重试')
        }
      }

      
      for (const inRow of inItems) {
        const saleItemId = `${saleOrderId}-${String(seq).padStart(2, '0')}`
        seq++
        
        
        
        
        const skuSessionCount = inRow.sku.sessionCount ?? inRow.item.sessionCount
        const sessionCount = skuSessionCount != null ? skuSessionCount * inRow.item.quantity : null
        
        const inDenom = (sessionCount != null && sessionCount > 0) ? sessionCount : inRow.item.quantity
        const unitPrice = inDenom > 0 ? (inRow.amount / inDenom).toFixed(2) : Number(inRow.sku.price).toFixed(2)
        await tx.insert(saleItems).values({
          saleItemId,
          saleOrderId,
          storeId: data.storeId,
          itemDirection: '转入',
          skuId: inRow.item.skuId,
          productName: inRow.item.productName,
          productType: inRow.item.productType,
          sessionCount,
          remainingSessions: sessionCount,
          unitPrice,
          quantity: inRow.item.quantity,
          unitRealPrice: unitPrice,
          saleAmount: inRow.amount.toFixed(2),
          received: inRow.amount.toFixed(2),
          salesCategory:
            (inRow.item.salesCategory as typeof saleItems.$inferInsert['salesCategory']) ??
            (inRow.sku.salesCategory as typeof saleItems.$inferInsert['salesCategory']) ??
            null,
          serviceFee: inRow.serviceFee.toFixed(2),
          
          isExperience: inRow.sku.isExperience === true,
          isShengmei: inRow.sku.isShengmei ?? null,
        })
      }

      
      let prepaidCardCredit = 0
      if (priceDiff < 0) {
        const creditAmount = Math.abs(priceDiff)
        prepaidCardCredit = creditAmount

        
        const upsertRows = await tx.execute(sql`
          INSERT INTO prepaid_cards (card_id, user_id, balance)
          VALUES (gen_random_uuid()::text, ${data.clientUserId}, ${creditAmount.toFixed(2)})
          ON CONFLICT (user_id) DO UPDATE
            SET balance = prepaid_cards.balance + EXCLUDED.balance,
                updated_at = NOW()
          RETURNING card_id
        `)
        const cardId = (upsertRows as any[])[0]?.card_id as string
        if (!cardId) throw new ApiError('CONFLICT', 'PREPAID_CARD_UPSERT_FAILED: 储值卡入账失败，请稍后重试')

        await tx.insert(cardTransactions).values({
          cardId,
          type: '充值',
          amount: creditAmount.toFixed(2),
          refOrderId: saleOrderId,
        })
      }

      
      
      let convFullCardPaymentId: number | string | null = null
      if (isFullCardCoverage) {
        convFullCardPaymentId = await deductPrepaidCardAtCreation(tx, {
          saleOrderId,
          clientUserId: data.clientUserId,
          amount: card,
          employeeId: session.employeeId,
          note: '管理后台转换单-储值卡全额抵扣',
        })
      }

      
      
      if (convFullCardPaymentId && card > 0) {
        await capturePaymentAllocatables(tx, {
          salePaymentId: convFullCardPaymentId,
          saleOrderId,
          eventAmount: card,
          directedItems: null,
        })
        await refreshOrderAllocationRollup(tx, saleOrderId)
      }

      
      
      await recalcPaidSessionsForOrder(tx, saleOrderId)

      
      if (isFullCardCoverage) {
        await settlePointsSafe(tx, saleOrderId, 'admin.createConversion')
        await recalcCustomerType(tx, data.clientUserId)
      }

      return {
        saleOrderId,
        totalIn: Math.round(totalIn * 100) / 100,
        totalOut: Math.round(totalOut * 100) / 100,
        priceDiff,
        prepaidCardCredit,
        prepaidCardAmount: card,
      }
    })
  } catch (err: any) {
    const m = err?.message as string | undefined
    if (m?.includes('CARD_NOT_FOUND')) return { success: false, message: '部分卡不存在或已失效' }
    if (m?.includes('CARD_STORE_MISMATCH')) return { success: false, message: '所选卡不属于当前门店' }
    if (m?.includes('CARD_OWNER_MISMATCH')) return { success: false, message: '所选卡不属于该顾客' }
    if (m?.includes('CARD_DIRECTION_INVALID')) return { success: false, message: '所选行非购买行，不可折抵' }
    if (m?.includes('CARD_ORDER_STATUS_INVALID')) return { success: false, message: '原订单状态不允许转换' }
    if (m?.includes('CARD_EXHAUSTED')) return { success: false, message: '所选卡已耗尽，无法折抵' }
    if (m?.includes('CARD_TYPE_INVALID')) return { success: false, message: '所选行类型不支持折抵' }
    if (m?.includes('CARD_CONCURRENT_CHANGED')) return { success: false, message: '卡状态变化，请重试' }
    if (m?.includes('ORDER_ID_GEN_FAILED')) return { success: false, message: '订单号生成失败，请稍后重试' }
    if (m?.includes('PREPAID_CARD_UPSERT_FAILED')) return { success: false, message: '储值卡入账失败，请稍后重试' }
    
    if (m?.startsWith('INSUFFICIENT_BALANCE')) {
      const stripped = m.replace(/^INSUFFICIENT_BALANCE:?(NO_CARD)?:?\s*/, '')
      return { success: false, message: stripped || '顾客储值卡余额不足' }
    }
    if (m?.includes('SKU_NOT_FOUND:')) return { success: false, message: '转入商品不存在' }
    if (pgErrorCode(err) === '23503') {
      console.error('[createConversionOrder] fk_violation:', err)
      return { success: false, message: '关联数据不存在，请检查门店、商品或顾客信息' }
    }
    if (pgErrorCode(err) === '23502') {
      console.error('[createConversionOrder] not_null_violation:', err)
      return { success: false, message: '订单字段缺失，请联系管理员' }
    }
    if (pgErrorCode(err) === '23505') return { success: false, message: '订单号冲突，请稍后重试' }
    console.error('[createConversionOrder] unexpected error:', err)
    return { success: false, message: '转换单创建失败，请稍后重试' }
  }

  await logOperation(session, 'order.create_conversion', 'sale_order', result.saleOrderId, {
    storeId: data.storeId,
    saleOrderId: result.saleOrderId,
    convertOutSaleItemIds: data.convertOutSaleItemIds,
    totalIn: result.totalIn,
    totalOut: result.totalOut,
    priceDiff: result.priceDiff,
    prepaidCardCredit: result.prepaidCardCredit,
    prepaidCardAmount: result.prepaidCardAmount,
  })

  revalidatePath('/orders')
  
  const remainingPayable = Math.max(0, Math.round((result.priceDiff - result.prepaidCardAmount) * 100) / 100)
  return {
    success: true,
    message:
      result.priceDiff > 0
        ? remainingPayable > 0
          ? `转换单已创建，储值卡抵扣 ¥${result.prepaidCardAmount.toFixed(2)}，请收款 ¥${remainingPayable.toFixed(2)}`
          : `转换单已完成，储值卡全额抵扣 ¥${result.prepaidCardAmount.toFixed(2)}`
        : result.priceDiff < 0
          ? `转换单已完成，差额 ¥${result.prepaidCardCredit.toFixed(2)} 已充入储值卡`
          : '转换单已完成',
    saleOrderId: result.saleOrderId,
    totalIn: result.totalIn,
    totalOut: result.totalOut,
    priceDiff: result.priceDiff,
    prepaidCardCredit: result.prepaidCardCredit,
    prepaidCardAmount: result.prepaidCardAmount,
  }
  },
)




export const createDepositOrder = withPermission(
  'sale_order:create',
  async (
    session,
    data: {
      storeId: string
      marketName: string
      clientUserId: string
      preferredEmployeeId?: string
      remark?: string | null
      items: Array<{
        skuId: string
        quantity: number
        
        
        
        received?: number
      }>
    },
  ): Promise<{ success: boolean; message: string; saleOrderId?: string; itemCount?: number }> => {
    if (!isInScope(session, data.storeId)) {
      return { success: false, message: '无权在该门店创建订单' }
    }
    if (!data.clientUserId) {
      return { success: false, message: '寄存单必须指定顾客' }
    }
    if (!Array.isArray(data.items) || data.items.length === 0) {
      return { success: false, message: '寄存单至少需要 1 个商品' }
    }
    for (const it of data.items) {
      if (!it || !it.skuId) return { success: false, message: 'items 缺少 skuId' }
      if (!Number.isFinite(it.quantity) || it.quantity <= 0) {
        return { success: false, message: 'items.quantity 必须为正' }
      }
      if (it.received != null && (!Number.isFinite(it.received) || it.received < 0)) {
        return { success: false, message: 'items.received 必须为非负数' }
      }
    }

    
    const [client] = await db
      .select({
        userId: clientWechatUsers.userId,
        phone: clientWechatUsers.phone,
        name: clientWechatUsers.name,
        boundStoreId: clientWechatUsers.boundStoreId,
      })
      .from(clientWechatUsers)
      .where(eq(clientWechatUsers.userId, data.clientUserId))
      .limit(1)
    if (!client) {
      return { success: false, message: '顾客不存在' }
    }
    if (!client.boundStoreId) {
      return { success: false, message: '顾客未绑定门店' }
    }

    
    const skuIds = data.items.map(i => i.skuId)
    const skuRows = await db
      .select({
        skuId: productSkus.skuId,
        productType: productSkus.productType,
        specName: productSkus.specName,
        price: productSkus.price,
        specialPrice: productSkus.specialPrice,
        sessionCount: productSkus.sessionCount,
        isShengmei: productSkus.isShengmei,
        isExperience: productSkus.isExperience,
        salesCategory: productCategories.salesCategory,
        productKind: productCategories.productKind,
      })
      .from(productSkus)
      .innerJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
      .where(and(inArray(productSkus.skuId, skuIds), isNull(productSkus.deletedAt)))
    if (skuRows.length !== skuIds.length) {
      return { success: false, message: '部分商品不存在或已下架' }
    }
    const skuMap = new Map(skuRows.map(s => [s.skuId, s]))

    
    let saleOrderId: string
    try {
      saleOrderId = await db.transaction(async (tx) => {
        const idRows = await tx.execute(sql`
          WITH lock AS (
            SELECT pg_advisory_xact_lock(hashtext('sale_order_id_gen'))
          )
          SELECT 'FY-XSD-WX-' || to_char(NOW(), 'YYMMDD') ||
            LPAD(
              (SELECT COALESCE(MAX(
                CAST(NULLIF(SUBSTRING(sale_order_id FROM '.{4}$'), '') AS INTEGER)
              ), 0) + 1
              FROM sale_orders
              WHERE sale_order_id LIKE 'FY-XSD-WX-' || to_char(NOW(), 'YYMMDD') || '%'
              )::TEXT, 4, '0'
            ) AS id
          FROM lock
        `)
        const id = (idRows as any[])[0]?.id as string
        if (!id) throw new ApiError('INVALID_STATE', '订单号生成失败')

        const now = new Date()
        await tx.insert(saleOrders).values({
          saleOrderId: id,
          status: '已支付',
          saleOrderType: '寄存单',
          documentType: '售后',
          marketName: data.marketName,
          storeId: data.storeId,
          storeName: sql<string>`(SELECT store_name FROM stores WHERE store_id = ${data.storeId})`,
          saleOrderDatetime: nowTs(),
          clientUserId: data.clientUserId,
          clientPhone: client.phone || null,
          customerName: client.name || null,
          totalAmount: '0',
          prepaidCardAmount: '0',
          payableAmount: '0',
          received: '0',
          paymentMethod: '无',
          openedBy: session.employeeId || null,
          preferredEmployeeId: data.preferredEmployeeId || null,
          couponId: null,
          couponDiscount: '0',
          remark: data.remark || null,
          paidAt: nowTs(),
          allocationStatus: '待分配',
        })

        
        const dateStr = shanghaiYmd(now)
        const maxRows = await tx.execute(sql`
          SELECT sale_item_id FROM sale_items
          WHERE sale_item_id LIKE ${`XSLSH-WX-${dateStr}%`}
          ORDER BY sale_item_id DESC LIMIT 1
        `)
        let seq = 1
        const lastRow = (maxRows as any[])[0]
        if (lastRow && lastRow.sale_item_id) {
          seq = parseInt(String(lastRow.sale_item_id).slice(-4)) + 1
        }

        
        const receiptRows: Array<{ saleItemId: string; received: number }> = []
        for (let i = 0; i < data.items.length; i++) {
          const item = data.items[i]
          const sku = skuMap.get(item.skuId)!
          const saleItemId = `XSLSH-WX-${dateStr}${String(seq + i).padStart(4, '0')}`
          const basePrice = Number(sku.specialPrice || sku.price)
          const quantity = item.quantity
          const itemReceived = Math.round((Number(item.received) || 0) * 100) / 100
          if (itemReceived > 0) receiptRows.push({ saleItemId, received: itemReceived })
          
          const sc = sku.productType === '家居产品'
            ? null
            : (sku.sessionCount != null ? Number(sku.sessionCount) * quantity : null)
          const depSaleAmount = (Math.round(basePrice * quantity * 100) / 100).toFixed(2)
          
          const depDenom = (sc != null && sc > 0) ? sc : quantity
          const depUnit = depDenom > 0 ? (Number(depSaleAmount) / depDenom).toFixed(2) : depSaleAmount

          await tx.insert(saleItems).values({
            saleItemId,
            saleOrderId: id,
            storeId: data.storeId,
            itemDirection: '购买',
            skuId: sku.skuId,
            productName: sku.specName,
            productType: sku.productType,
            sessionCount: sc,
            remainingSessions: sc,
            unitPrice: depUnit,
            quantity,
            unitRealPrice: depUnit,
            saleAmount: depSaleAmount,
            received: '0',
            salesCategory: sku.salesCategory ?? null,
            serviceFee: '0',
            isShengmei: sku.isShengmei ?? null,
            isExperience: sku.isExperience === true,
          })
        }

        
        
        
        
        if (receiptRows.length > 0) {
          for (const r of receiptRows) {
            await tx.insert(saleOrderPayments).values({
              saleOrderId: id,
              changeType: '回款',
              amount: r.received.toFixed(2),
              paymentMethod: '线下',
              externalTxnId: null,
              status: '已支付',
              sourceEnd: 'admin',
              paidAt: nowTs(),
              operatorEmployeeId: session.employeeId,
              refSaleItemId: r.saleItemId,
              note: DEPOSIT_RECEIPT_NOTE,
            })
          }
          const totalReceived = receiptRows.reduce((s, r) => s + r.received, 0)
          await tx
            .update(saleOrders)
            .set({ received: totalReceived.toFixed(2), updatedAt: nowTs() })
            .where(eq(saleOrders.saleOrderId, id))
        }

        
        
        await recalcPaidSessionsForOrder(tx, id)

        
        await recomputeDepositRealPrice(tx, id)

        return id
      })
    } catch (err: any) {
      if (err instanceof ApiError) {
        return { success: false, message: err.message }
      }
      return { success: false, message: err?.message || '寄存单创建失败' }
    }

    await logOperation(
      session,
      'order.createDeposit',
      'sale_order',
      saleOrderId,
      {
        _v: 1,
        clientUserId: data.clientUserId,
        itemCount: data.items.length,
        totalSessionCount: data.items.reduce((acc, it) => {
          const sku = skuMap.get(it.skuId)
          const sc = sku && sku.sessionCount != null
            ? Number(sku.sessionCount) * it.quantity
            : 0
          return acc + sc
        }, 0),
      },
    )

    revalidatePath('/orders')
    return {
      success: true,
      message: `寄存单已创建（${data.items.length} 项）`,
      saleOrderId,
      itemCount: data.items.length,
    }
  },
)




export const createPrepaidInflow = withPermission(
  'sale_order:create',
  async (
    session,
    data: {
      clientUserId: string
      storeId: string
      amount: number
      remark?: string | null
      requestId?: string 
    },
  ): Promise<{ success: boolean; message: string; saleOrderId?: string }> => {
    if (!data.clientUserId) return { success: false, message: '请选择顾客' }
    if (!data.storeId) return { success: false, message: '请选择入账门店' }
    const amt = Number(data.amount)
    if (!Number.isFinite(amt) || amt <= 0) return { success: false, message: '转入金额无效' }
    
    if (Math.abs(Math.round(amt * 100) - amt * 100) > 1e-6) {
      return { success: false, message: '转入金额最多保留 2 位小数' }
    }
    if (amt > 99999999.99) return { success: false, message: '转入金额超出上限' } 
    if (!isInScope(session, data.storeId)) return { success: false, message: '无权在该门店转入' }

    
    const [client] = await db
      .select({
        userId: clientWechatUsers.userId,
        name: clientWechatUsers.name,
        phone: clientWechatUsers.phone,
        customerType: clientWechatUsers.customerType,
      })
      .from(clientWechatUsers)
      .where(eq(clientWechatUsers.userId, data.clientUserId))
      .limit(1)
    if (!client) return { success: false, message: '顾客不存在' }
    const documentType: '售前' | '售后' = client.customerType === '会员客' ? '售后' : '售前'

    
    const storeRows = (await db.execute(sql`
      SELECT s.store_id, pm.name AS market_name
      FROM stores s
      LEFT JOIN org_nodes sn ON s.org_node_id = sn.id
      LEFT JOIN org_nodes pm ON sn.parent_id = pm.id
      WHERE s.store_id = ${data.storeId}
      LIMIT 1
    `)) as unknown as Array<{ store_id: string; market_name: string | null }>
    if (storeRows.length === 0) return { success: false, message: '入账门店不存在' }
    const marketName = storeRows[0].market_name || ''
    const note = data.remark ? `${LEGACY_INFLOW_NOTE}｜${data.remark}` : LEGACY_INFLOW_NOTE
    
    const inflowRef = data.requestId ? `card-inflow-${data.requestId}` : null

    let saleOrderId: string
    try {
      saleOrderId = await db.transaction(async (tx) => {
        
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'card_inflow:' + data.clientUserId}))`)
        
        if (inflowRef) {
          const dupRows = (await tx.execute(sql`
            SELECT ref_order_id FROM card_transactions WHERE external_ref = ${inflowRef} LIMIT 1
          `)) as unknown as Array<{ ref_order_id: string }>
          if (dupRows.length > 0) return dupRows[0].ref_order_id as string
        }
        const idRows = await tx.execute(sql`
          WITH lock AS (
            SELECT pg_advisory_xact_lock(hashtext('sale_order_id_gen'))
          )
          SELECT 'FY-XSD-WX-' || to_char(NOW(), 'YYMMDD') ||
            LPAD(
              (SELECT COALESCE(MAX(
                CAST(NULLIF(SUBSTRING(sale_order_id FROM '.{4}$'), '') AS INTEGER)
              ), 0) + 1
              FROM sale_orders
              WHERE sale_order_id LIKE 'FY-XSD-WX-' || to_char(NOW(), 'YYMMDD') || '%'
              )::TEXT, 4, '0'
            ) AS id
          FROM lock
        `)
        const id = (idRows as unknown as Array<{ id: string }>)[0]?.id
        if (!id) throw new ApiError('INVALID_STATE', '订单号生成失败')

        
        
        await tx.insert(saleOrders).values({
          saleOrderId: id,
          status: '已支付',
          saleOrderType: '充值单',
          documentType,
          marketName,
          storeId: data.storeId,
          storeName: sql<string>`(SELECT store_name FROM stores WHERE store_id = ${data.storeId})`,
          saleOrderDatetime: nowTs(),
          clientUserId: data.clientUserId,
          clientPhone: client.phone || '',
          customerName: client.name || '',
          totalAmount: amt.toFixed(2),
          prepaidCardAmount: '0',
          payableAmount: amt.toFixed(2),
          received: amt.toFixed(2),
          firstPaymentAmount: null,
          couponId: null,
          couponDiscount: '0',
          paymentMethod: '线下',
          openedBy: session.employeeId,
          preferredEmployeeId: null,
          allocationStatus: '待分配',
          remark: note,
          paidAt: nowTs(),
        })

        
        await tx.insert(saleOrderPayments).values({
          saleOrderId: id,
          changeType: '首次支付',
          amount: amt.toFixed(2),
          paymentMethod: '线下',
          externalTxnId: null,
          status: '已支付',
          sourceEnd: 'admin',
          operatorEmployeeId: session.employeeId,
          note,
          paidAt: nowTs(),
        })

        
        
        await applyRechargeOnOrderPaid(tx, id, inflowRef ?? undefined)

        return id
      })
    } catch (err: any) {
      const msg = err?.message || '转入失败'
      return { success: false, message: msg.replace(/^[A-Z_]+:\s*/, '') }
    }

    await logOperation(session, 'sale_order.prepaid_inflow', 'sale_order', saleOrderId, {
      clientUserId: data.clientUserId,
      storeId: data.storeId,
      amount: amt,
      legacy: true,
    })

    revalidatePath('/orders')
    revalidatePath(`/customers/${data.clientUserId}`)

    return { success: true, message: '转入成功', saleOrderId }
  },
)








export const getRepayable = withPermission(
  'sale_order:record_payment',
  async (
    session,
    saleOrderId: string,
  ): Promise<{
    items: Array<{ saleItemId: string; productName: string; saleAmount: string; received: string; remaining: string }>
    remainingPayable: number
    cardBalance: number | null
    clientUserId: string | null
  }> => {
    const [order] = await db
      .select({
        storeId: saleOrders.storeId,
        status: saleOrders.status,
        totalAmount: saleOrders.totalAmount,
        prepaidCardAmount: saleOrders.prepaidCardAmount,
        payableAmount: saleOrders.payableAmount,
        received: saleOrders.received,
        clientUserId: saleOrders.clientUserId,
      })
      .from(saleOrders)
      .where(and(eq(saleOrders.saleOrderId, saleOrderId), scopeCondition(session, saleOrders.storeId)))
      .limit(1)
    if (!order) throw new Error('NOT_FOUND: 订单不存在或无权访问')
    if (!['部分支付', '待支付'].includes(order.status)) {
      throw new Error(`INVALID_STATE: 当前状态"${order.status}"不允许回款`)
    }

    const rows = await db
      .select()
      .from(saleItems)
      .where(and(eq(saleItems.saleOrderId, saleOrderId), eq(saleItems.itemDirection, '购买')))
    const items = rows.map((r) => {
      const remaining = Math.round((Number(r.saleAmount) - Number(r.received)) * 100) / 100
      return {
        saleItemId: r.saleItemId,
        productName: r.productName || '-',
        saleAmount: r.saleAmount,
        received: r.received,
        remaining: Math.max(0, remaining).toFixed(2),
      }
    })

    
    
    const remainingPayable = Math.round((Number(order.totalAmount) - Number(order.received)) * 100) / 100

    let cardBalance: number | null = null
    if (order.clientUserId) {
      const [card] = await db
        .select({ balance: prepaidCards.balance })
        .from(prepaidCards)
        .where(eq(prepaidCards.userId, order.clientUserId))
        .limit(1)
      cardBalance = card ? Number(card.balance) : 0
    }

    return { items, remainingPayable, cardBalance, clientUserId: order.clientUserId ?? null }
  },
)

export const recordPayment = withPermission(
  'sale_order:record_payment',
  async (
    session,
    input: {
  saleOrderId: string
  repayAmount?: number
  paymentMethod: '线下' | '储值卡'
  externalTxnId?: string
  prepaidCardAmount?: number
  
  
  items?: Array<{ saleItemId: string; repayAmount?: number; prepaidCardAmount?: number }>
  note?: string
  
  idempotencyKey?: string
    },
  ): Promise<
    | { success: true; data: { repaymentOrderId: string; refStatus: OrderStatus; refPaidAmount: string; refPrepaidCardAmount: string; idempotent?: boolean } }
    | { success: false; error: { code: string; message: string } }
  > => {
  
  const saleOrderId = String(input.saleOrderId || '').trim()
  if (!saleOrderId) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: '订单号不能为空' } }
  }
  const paymentMethod = input.paymentMethod
  if (paymentMethod !== '线下' && paymentMethod !== '储值卡') {
    return { success: false, error: { code: 'INVALID_PARAMS', message: '支付方式仅支持 线下 / 储值卡' } }
  }

  
  const repayItems = Array.isArray(input.items) && input.items.length > 0
    ? input.items
        .map((it) => ({
          saleItemId: String(it.saleItemId || ''),
          repayAmount: Math.round(Number(it.repayAmount || 0) * 100) / 100,
          prepaidCardAmount: Math.round(Number(it.prepaidCardAmount || 0) * 100) / 100,
        }))
        .filter((it) => it.saleItemId && (it.repayAmount > 0 || it.prepaidCardAmount > 0))
    : null
  const hasItems = !!(repayItems && repayItems.length > 0)

  const repayAmount = hasItems
    ? Math.round(repayItems!.reduce((s, it) => s + it.repayAmount, 0) * 100) / 100
    : Math.round(Number(input.repayAmount || 0) * 100) / 100
  const prepaidCardAmount = hasItems
    ? Math.round(repayItems!.reduce((s, it) => s + it.prepaidCardAmount, 0) * 100) / 100
    : Math.round(Number(input.prepaidCardAmount || 0) * 100) / 100
  if (!Number.isFinite(repayAmount) || repayAmount < 0) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: '回款金额无效' } }
  }
  if (!Number.isFinite(prepaidCardAmount) || prepaidCardAmount < 0) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: '储值卡抵扣金额无效' } }
  }
  const totalThisTime = Math.round((repayAmount + prepaidCardAmount) * 100) / 100
  if (totalThisTime <= 0) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: '回款金额与储值卡抵扣不能都为 0' } }
  }

  
  if (paymentMethod === '储值卡' && repayAmount > 0) {
    return {
      success: false,
      error: {
        code: 'INVALID_PARAMS',
        message: '储值卡付款方式不应传回款金额（请通过储值卡抵扣字段传递）',
      },
    }
  }

  
  
  
  const externalTxnId = input.externalTxnId?.trim() || null

  
  
  
  const idempotencyKey = input.idempotencyKey?.trim() || null
  const repayIdempRef = idempotencyKey && prepaidCardAmount > 0
    ? `card-repay-${saleOrderId}-${idempotencyKey}`
    : null

  
  let result: { repaymentOrderId: string; refStatus: OrderStatus; refPaidAmount: string; refPrepaidCardAmount: string; idempotent?: boolean }
  try {
    result = await db.transaction(async (tx) => {
      
      const lockRes = await tx.execute(sql`
        SELECT * FROM sale_orders WHERE sale_order_id = ${saleOrderId} FOR UPDATE
      `)
      const lockedRows = lockRes as unknown as any[]
      if (lockedRows.length === 0) {
        throw new ApiError('NOT_FOUND', 'REF_ORDER_NOT_FOUND: 原订单不存在')
      }
      const locked = lockedRows[0]

      
      if (!isInScope(session, locked.store_id)) {
        throw new ApiError('PERMISSION_DENIED', 'OUT_OF_SCOPE: 该订单不在你的可见门店范围内')
      }

      
      if (locked.sale_order_type === '寄存单') {
        throw new ApiError('INVALID_STATE', '寄存单不支持回款')
      }
      if (locked.legacy_source === 'workfine') {
        throw new ApiError('INVALID_STATE', '历史订单不支持回款')
      }

      
      if (await hasPendingRefund(tx, saleOrderId)) {
        throw new ApiError('INVALID_STATE', 'REFUND_IN_PROGRESS: 该订单退款审批中，暂不可回款')
      }

      if (!['部分支付', '待支付'].includes(locked.status)) {
        throw new Error(`INVALID_STATE:${locked.status}`)
      }

      if (!locked.client_user_id && prepaidCardAmount > 0) {
        throw new ApiError('CLIENT_NOT_REGISTERED', '顾客未注册小程序，无法使用储值卡抵扣')
      }

      
      
      
      if (repayIdempRef) {
        const dupRes = await tx.execute(sql`
          SELECT 1 FROM card_transactions WHERE external_ref = ${repayIdempRef} LIMIT 1
        `)
        if ((dupRes as unknown as Array<unknown>).length > 0) {
          return {
            repaymentOrderId: '',
            refStatus: locked.status as OrderStatus,
            refPaidAmount: Number(locked.received || 0).toFixed(2),
            refPrepaidCardAmount: Number(locked.prepaid_card_amount || 0).toFixed(2),
            idempotent: true,
          }
        }
      }

      
      
      
      
      const origTotal = Number(locked.total_amount || 0)
      const origPaid = Number(locked.received || 0)
      const remainingPayable = Math.round((origTotal - origPaid) * 100) / 100

      
      if (totalThisTime > remainingPayable + 0.001) {
        throw new ApiError('CONFLICT', `OVERPAY:${remainingPayable.toFixed(2)}: 本次回款金额超过订单欠款`)
      }

      
      if (hasItems) {
        const itemRowsRes = await tx.execute(sql`
          SELECT sale_item_id, sale_amount::numeric AS sale_amount, received::numeric AS received
            FROM sale_items WHERE sale_order_id = ${saleOrderId} AND item_direction = '购买'
        `)
        const itemRows = itemRowsRes as unknown as any[]
        const itemMap = new Map(itemRows.map((r) => [r.sale_item_id, r]))
        for (const it of repayItems!) {
          const row = itemMap.get(it.saleItemId)
          if (!row) throw new ApiError('INVALID_PARAMS', `OVERPAY_ITEM:${it.saleItemId}:NOT_FOUND: 回款明细行不存在于该订单`)
          const itemRemaining = Math.round((Number(row.sale_amount) - Number(row.received)) * 100) / 100
          const itemThis = Math.round((it.repayAmount + it.prepaidCardAmount) * 100) / 100
          if (itemThis > itemRemaining + 0.001) {
            throw new ApiError('CONFLICT', `OVERPAY_ITEM:${it.saleItemId}:${itemRemaining.toFixed(2)}: 该明细行回款金额超过可回款额`)
          }
        }
      }

      
      const idRows = await tx.execute(sql`
        WITH lock AS (
          SELECT pg_advisory_xact_lock(hashtext('sale_order_id_gen'))
        )
        SELECT 'FY-HKD-WX-' || to_char(NOW(), 'YYMMDD') ||
          LPAD(
            (SELECT COALESCE(MAX(
              CAST(NULLIF(SUBSTRING(sale_order_id FROM '.{4}$'), '') AS INTEGER)
            ), 0) + 1
            FROM sale_orders
            WHERE sale_order_id LIKE 'FY-HKD-WX-' || to_char(NOW(), 'YYMMDD') || '%'
            )::TEXT, 4, '0'
          ) AS id
        FROM lock
      `)
      const repaymentOrderId = (idRows as unknown as any[])[0]?.id as string
      if (!repaymentOrderId) throw new ApiError('INVALID_STATE', 'ORDER_ID_GEN_FAILED: 回款单号生成失败')

      
      if (prepaidCardAmount > 0) {
        const balRes = await tx.execute(sql`
          SELECT card_id, balance FROM prepaid_cards
          WHERE user_id = ${locked.client_user_id} FOR UPDATE
        `)
        const balRows = balRes as unknown as any[]
        if (balRows.length === 0) {
          throw new Error('INSUFFICIENT_BALANCE:NO_CARD')
        }
        const currentBalance = Number(balRows[0].balance)
        if (currentBalance + 0.001 < prepaidCardAmount) {
          throw new Error(`INSUFFICIENT_BALANCE:${currentBalance.toFixed(2)}`)
        }
        const cardId = balRows[0].card_id as string
        await tx.execute(sql`
          UPDATE prepaid_cards
          SET balance = balance - ${prepaidCardAmount.toFixed(2)}::numeric,
              updated_at = NOW()
          WHERE card_id = ${cardId}
        `)
        
        
        
        
        await tx.insert(cardTransactions).values({
          cardId,
          type: '扣款',
          amount: (-prepaidCardAmount).toFixed(2),
          refOrderId: saleOrderId,
          externalRef: repayIdempRef ?? `card-repay-${repaymentOrderId}`,
        })
      }

      
      
      
      

      
      
      
      
      
      
      let cashPaymentId: number | string | null = null
      let cardPaymentId: number | string | null = null
      if (repayAmount > 0) {
        const cashIns = await tx.insert(saleOrderPayments).values({
          saleOrderId,
          changeType: '回款',
          amount: repayAmount.toFixed(2),
          paymentMethod,
          externalTxnId,
          status: '已支付',
          sourceEnd: 'admin',
          paidAt: nowTs(),
          operatorEmployeeId: session.employeeId,
          note: input.note?.trim() || '管理后台录入回款',
        }).returning({ id: saleOrderPayments.id })
        cashPaymentId = cashIns[0]?.id ?? null
      }
      if (prepaidCardAmount > 0) {
        const cardIns = await tx.insert(saleOrderPayments).values({
          saleOrderId,
          changeType: '储值卡抵扣',
          amount: prepaidCardAmount.toFixed(2),
          paymentMethod: '储值卡',
          externalTxnId: null,
          status: '已支付',
          sourceEnd: 'admin',
          paidAt: nowTs(),
          operatorEmployeeId: session.employeeId,
          note: '管理后台录入回款-储值卡抵扣',
        }).returning({ id: saleOrderPayments.id })
        cardPaymentId = cardIns[0]?.id ?? null
      }
      
      const primaryPaymentId = cashPaymentId || cardPaymentId

      
      
      
      
      if (hasItems) {
        const repayValues = sql.join(
          repayItems!.map(
            (it) =>
              sql`(${it.saleItemId}::varchar, ${(Math.round((it.repayAmount + it.prepaidCardAmount) * 100) / 100).toFixed(2)}::numeric)`,
          ),
          sql`, `,
        )
        await tx.execute(sql`
          WITH repay (sale_item_id, delta) AS (VALUES ${repayValues})
          UPDATE sale_items si
          SET pending_received = COALESCE(rp.delta, 0),
              updated_at = NOW()
          FROM (SELECT sale_item_id FROM sale_items WHERE sale_order_id = ${saleOrderId} AND item_direction = '购买') ai
          LEFT JOIN repay rp ON rp.sale_item_id = ai.sale_item_id
          WHERE si.sale_item_id = ai.sale_item_id
        `)
      }

      
      
      
      
      
      
      
      const sumRes = await tx.execute(sql`
        SELECT
          COALESCE(SUM(CASE WHEN status = '已支付' AND change_type IN ('首次支付','回款','储值卡抵扣')
                            THEN amount::numeric ELSE 0 END), 0) AS new_received,
          COALESCE(SUM(CASE WHEN status = '已支付' AND change_type = '储值卡抵扣'
                            THEN amount::numeric ELSE 0 END), 0) AS new_prepaid,
          COALESCE(-SUM(CASE WHEN status = '已支付' AND change_type = '退款'
                            THEN amount::numeric ELSE 0 END), 0) AS new_refunded
        FROM sale_order_payments
        WHERE sale_order_id = ${saleOrderId}
      `)
      const sumRow = (sumRes as unknown as any[])[0]
      const newReceived = Math.round(Number(sumRow.new_received) * 100) / 100
      const newPrepaid = Math.round(Number(sumRow.new_prepaid) * 100) / 100
      const newRefunded = Math.round(Number(sumRow.new_refunded) * 100) / 100
      const settled = newReceived
      
      
      
      
      const settleTarget = Math.round(origTotal * 100) / 100
      const targetStatus: OrderStatus = settled + 0.001 >= settleTarget ? '已支付' : '部分支付'
      
      
      const paidAtExpr = targetStatus === '已支付' ? nowTs() : sql`paid_at`

      const updRes = await tx.execute(sql`
        UPDATE sale_orders
        SET status = ${targetStatus},
            received = ${newReceived.toFixed(2)}::numeric,
            refunded_amount = ${newRefunded.toFixed(2)}::numeric,
            prepaid_card_amount = ${newPrepaid.toFixed(2)}::numeric,
            paid_at = ${paidAtExpr},
            updated_at = NOW()
        WHERE sale_order_id = ${saleOrderId} AND status = ${locked.status}
      `)
      if (rowsAffected(updRes) === 0) {
        throw new ApiError('CONFLICT', 'CONCURRENT_CHANGED: 订单状态已变更，请刷新后重试')
      }

      
      
      
      if (targetStatus === '已支付' && locked.client_user_id) {
        await recalcCustomerType(tx, locked.client_user_id)
      }

      
      
      
      await settlePointsSafe(tx, saleOrderId, 'admin.recordPayment')

      
      
      
      const directedForCapture = repayItems
        ? repayItems.map((it) => ({
            saleItemId: it.saleItemId,
            amount: Math.round((it.repayAmount + it.prepaidCardAmount) * 100) / 100,
          }))
        : null
      await capturePaymentAllocatables(tx, {
        salePaymentId: primaryPaymentId,
        saleOrderId,
        eventAmount: totalThisTime,
        directedItems: directedForCapture,
      })
      await refreshOrderAllocationRollup(tx, saleOrderId)

      
      
      await recalcPaidSessionsForOrder(tx, saleOrderId)

      return {
        repaymentOrderId,
        refStatus: targetStatus,
        refPaidAmount: newReceived.toFixed(2),
        refPrepaidCardAmount: newPrepaid.toFixed(2),
      }
    })
  } catch (err: any) {
    const msg = err?.message as string | undefined
    if (msg?.includes('REF_ORDER_NOT_FOUND')) {
      return { success: false, error: { code: 'REF_ORDER_NOT_FOUND', message: '原订单不存在' } }
    }
    
    if (msg?.startsWith('INVALID_STATE:') && !msg.includes('ORDER_ID_GEN_FAILED')) {
      const status = msg.split(':')[1] || ''
      return {
        success: false,
        error: { code: 'INVALID_STATE', message: `订单当前状态"${status}"不允许回款` },
      }
    }
    if (msg?.includes('CLIENT_NOT_REGISTERED')) {
      return { success: false, error: { code: 'CLIENT_NOT_REGISTERED', message: '顾客未注册小程序，无法使用储值卡抵扣' } }
    }
    const overpayItemMatch = msg?.match(/OVERPAY_ITEM:([^:]+):(.+)/)
    if (overpayItemMatch) {
      const itemId = overpayItemMatch[1]
      const detail = overpayItemMatch[2]
      return {
        success: false,
        error: detail === 'NOT_FOUND'
          ? { code: 'INVALID_PARAMS', message: `子项 ${itemId} 不属于本订单` }
          : { code: 'OVERPAY', message: `子项 ${itemId} 回款额超过该行可回款额（剩余 ¥${detail}）` },
      }
    }
    const overpayMatch = msg?.match(/OVERPAY:([\d.]+)/)
    if (overpayMatch) {
      const remaining = overpayMatch[1] || '0.00'
      return {
        success: false,
        error: { code: 'OVERPAY', message: `本次回款金额超过订单欠款（剩余 ¥${remaining}）` },
      }
    }
    if (msg?.includes('INSUFFICIENT_BALANCE:NO_CARD')) {
      return { success: false, error: { code: 'INSUFFICIENT_BALANCE', message: '顾客无储值卡账户' } }
    }
    if (msg?.startsWith('INSUFFICIENT_BALANCE:')) {
      const balance = msg.split(':')[1] || '0.00'
      return {
        success: false,
        error: { code: 'INSUFFICIENT_BALANCE', message: `储值卡余额不足（当前 ¥${balance}）` },
      }
    }
    if (msg?.includes('CONCURRENT_CHANGED')) {
      return { success: false, error: { code: 'CONCURRENT_CHANGED', message: '订单状态已变更，请刷新后重试' } }
    }
    if (msg?.includes('ORDER_ID_GEN_FAILED')) {
      return { success: false, error: { code: 'ORDER_ID_GEN_FAILED', message: '回款单号生成失败，请稍后重试' } }
    }
    if (pgErrorCode(err) === '23505') {
      
      
      return {
        success: false,
        error: {
          code: 'CONFLICT',
          message: pgErrorConstraint(err) === 'uq_sop_txn'
            ? '该交易号已在本订单录入过，请勿对同一笔款重复使用同一流水号'
            : '数据冲突，请刷新后重试',
        },
      }
    }
    console.error('[recordPayment] unexpected error:', err)
    
    
    if (pgErrorCode(err)) {
      return { success: false, error: { code: 'UNKNOWN', message: '录入回款失败：数据冲突或约束校验未通过，请刷新后重试' } }
    }
    return { success: false, error: { code: 'UNKNOWN', message: `录入回款失败：${err?.message || String(err)}` } }
  }

  
  
  if (result.idempotent) {
    return { success: true, data: result }
  }

  await logOperation(session, 'order.record_payment', 'sale_order', saleOrderId, {
    repaymentOrderId: result.repaymentOrderId,
    repayAmount: repayAmount.toFixed(2),
    paymentMethod,
    externalTxnId,
    prepaidCardAmount: prepaidCardAmount.toFixed(2),
    refStatus: result.refStatus,
    note: input.note?.trim() || null,
  })

  revalidatePath('/orders')
  revalidatePath(`/orders/${saleOrderId}`)
  return { success: true, data: result }
  },
)



const WX_CLIENT_APPID = process.env.WX_CLIENT_APPID || 'wx811eb4ded3dfba3f'
const WX_CLIENT_SECRET = process.env.WX_CLIENT_SECRET
const WXACODE_ENV_VERSION = process.env.WXACODE_ENV_VERSION || 'release'

let cachedToken: string | null = null
let tokenExpiresAt = 0

async function getClientAccessToken(forceRefresh = false): Promise<string> {
  if (!WX_CLIENT_SECRET) {
    throw new ApiError('INVALID_STATE', '未配置 WX_CLIENT_SECRET 环境变量')
  }
  if (!forceRefresh && cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken
  }
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${WX_CLIENT_APPID}&secret=${WX_CLIENT_SECRET}`
  const res = await fetch(url)
  const data = await res.json()
  if (data.errcode) {
    throw new ApiError('INVALID_STATE', `获取微信 access_token 失败: ${data.errcode} ${data.errmsg}`)
  }
  cachedToken = data.access_token
  tokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000
  return cachedToken!
}


export const generateOrderWxacode = withPermission(
  'sale_order:list',
  async (_session, saleOrderId: string): Promise<{ success: boolean; dataUrl?: string; message?: string }> => {
  if (!WX_CLIENT_SECRET) {
    return { success: false, message: '未配置小程序密钥' }
  }

  try {
    let token = await getClientAccessToken()
    let buffer = await requestWxacode(token, saleOrderId, 'pagesOrder/scan-pay/scan-pay')

    
    if (buffer.byteLength < 1000) {
      const text = new TextDecoder().decode(buffer)
      try {
        const errData = JSON.parse(text)
        if (errData.errcode === 42001 || errData.errcode === 40001) {
          token = await getClientAccessToken(true)
          buffer = await requestWxacode(token, saleOrderId, 'pagesOrder/scan-pay/scan-pay')
          if (buffer.byteLength < 1000) {
            const retryErr = JSON.parse(new TextDecoder().decode(buffer))
            return { success: false, message: `生成失败: ${retryErr.errcode} ${retryErr.errmsg}` }
          }
        } else if (errData.errcode) {
          return { success: false, message: `生成失败: ${errData.errcode} ${errData.errmsg}` }
        }
      } catch {
        
      }
    }

    const base64 = Buffer.from(buffer).toString('base64')
    return { success: true, dataUrl: `data:image/png;base64,${base64}` }
  } catch (err: any) {
    return { success: false, message: err.message || '生成小程序码失败' }
  }
  },
)

async function requestWxacode(token: string, scene: string, page: string): Promise<ArrayBuffer> {
  const url = `https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${token}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scene,
      page,
      check_path: false,
      env_version: WXACODE_ENV_VERSION,
      width: 430,
      auto_color: false,
      line_color: { r: 212, g: 167, b: 106 },
    }),
  })
  return res.arrayBuffer()
}
