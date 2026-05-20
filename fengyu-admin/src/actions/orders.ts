'use server'

import { db } from '@/db'
import { saleOrders, saleItems, saleOrderPayments } from '@db/order'
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
import { scopeCondition, isInScope } from '@/lib/permissions'
import { withPermission, withAnyPermission } from '@/lib/with-permission'
import { logOperation, logTransition } from '@/lib/operation-log'
import { ApiError } from '@/lib/api-error'
import { calcCouponDiscount } from '@/lib/utils'
import { getMemberThreshold } from '@/lib/member-threshold'
// TODO: 后续若 admin 需自建充值订单入口，从 '@/lib/recharge' 引入 loadRechargeConfig + matchTier
import { settlePointsSafe } from '@/lib/points-settle'
import { recalcPaidSessionsForOrder } from '@/lib/paid-sessions'

const opener = alias(staffWechatUsers, 'opener')

/**
 * 充值卡订单入账（2026-05-20 重构：充值卡剥离 SKU 化）
 *
 * 在订单状态翻转到"已支付"的同事务内调用。识别 sale_orders.sale_order_type='充值单'，
 * 面值直接读 sale_orders.total_amount（不再扫 sale_items）。
 *
 * 幂等：card_transactions.external_ref 唯一约束 + ref_order_id 软查；
 * 与 staff order.confirmOffline + payNotify 同源（external_ref='card-topup-{saleOrderId}'）。
 */
async function applyRechargeOnOrderPaid(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  saleOrderId: string,
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

  // 非充值单 / 未实名订单 → 跳过
  if (!order || !order.clientUserId || order.saleOrderType !== '充值单') return

  const faceValue = Number(order.totalAmount)
  if (!(faceValue > 0)) return

  // 幂等：防重放
  const dup = await tx.execute(sql`
    SELECT 1 FROM card_transactions WHERE ref_order_id = ${saleOrderId} AND type = '充值' LIMIT 1
  `)
  if ((dup as unknown as any[]).length > 0) return

  const newCardId = `FY-CARD-${Date.now()}${Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, '0')}`

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
    VALUES (${cardId}, '充值', ${faceValue.toFixed(2)}, ${saleOrderId}, ${'card-topup-' + saleOrderId})
    ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING
  `)
}

/**
 * customer_type 跃迁（admin recordPayment 触发点）。
 *
 * 三端跃迁触发点之一（与 fengyu-staff/cloudfunctions/staffApi/routes/order.js
 * recalcCustomerType + fengyu-client/cloudfunctions/payNotify/index.js 镜像一致）。
 *
 * 业务口径（2026-04-26 体验卡 ticket Round 2）：
 *   - 会员客：销售单 total_amount >= memberThreshold
 *   - 小美客：销售单中存在非体验卡明细行（si.is_experience = false）
 *   - 体验客：销售单中存在体验卡明细行（si.is_experience = true）
 *   - 流量客：兜底
 *
 * 只升不降；跃迁为"会员客"时同步写入 became_member_at = NOW()。
 *
 * SQL 关键字段（is_experience capability 列、不再 JOIN product_categories）必须与
 * staffApi/routes/order.js + payNotify/index.js 字面一致 —— 守卫测试
 * recalc-customer-type-sql.test.js 跨三个文件比对。
 */
type AdminTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function recalcCustomerType(tx: AdminTx, clientUserId: string): Promise<void> {
  if (!clientUserId) return

  const curRes = await tx.execute(sql`
    SELECT customer_type FROM client_wechat_users WHERE user_id = ${clientUserId}
  `)
  const curRows = curRes as unknown as Array<{ customer_type: string }>
  if (curRows[0]?.customer_type === '会员客') return

  const threshold = await getMemberThreshold()

  // 三端 SQL 独立副本（admin actions/orders.ts + staffApi routes/order.js + payNotify index.js）
  // 修改时必须同步另外两端；一致性由 staffApi __tests__/routes/recalc-customer-type-sql.test.js
  // 与 cross-end-sql-snapshot.test.js 守护，任一端漂移立即触发测试失败。
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
  const updRowCount = (updRes as { rowCount?: number }).rowCount ?? 0
  const updRows = updRes as unknown as Array<{ customer_type: string }>
  if (updRowCount > 0 && updRows[0]?.customer_type === '会员客') {
    await tx.execute(sql`
      UPDATE client_wechat_users SET became_member_at = NOW() WHERE user_id = ${clientUserId}
    `)
  }
}

/**
 * 开单时即时扣储值卡（全额抵扣场景：payable==0、无需付现金）。
 *
 * 与 confirmOfflinePayment 的扣卡块字面对齐：锁余额 → 校验 → UPDATE prepaid_cards.balance
 * → card_transactions(type='扣款') → sale_order_payments(change_type='储值卡抵扣')。
 * 幂等键 external_ref='card-deduct-{saleOrderId}'；余额不足抛 INSUFFICIENT_BALANCE。
 *
 * 仅在订单全额由储值卡抵扣（payable_amount==0 且 prepaid>0）时于创建事务内调用，
 * 是对「先付款后记账」不变量的有意例外（用户 2026-05-21 拍板）：无现金可收，挂"待支付"
 * 反而会卡死（payment_method='无' 无法走 confirmOfflinePayment），故创建时直接扣卡 + 结清。
 *
 * 注意：此扣卡块需与 staff order.js deductPrepaidCardAtCreation + confirmOffline / payNotify
 * 字面对齐，跨端 snapshot 测试守护。
 */
async function deductPrepaidCardAtCreation(
  tx: AdminTx,
  args: { saleOrderId: string; clientUserId: string; amount: number; employeeId: string; note: string },
): Promise<void> {
  const { saleOrderId, clientUserId, amount, employeeId, note } = args
  if (!(amount > 0) || !clientUserId) return

  // 幂等：已扣过则跳过
  const dupRes = await tx.execute(sql`
    SELECT 1 FROM card_transactions
    WHERE ref_order_id = ${saleOrderId} AND type = '扣款' LIMIT 1
  `)
  if ((dupRes as unknown as any[]).length > 0) return

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
  await tx.execute(sql`
    INSERT INTO sale_order_payments (
      sale_order_id, change_type, payment_method, amount, status,
      paid_at, source_end, operator_employee_id, note, created_at
    ) VALUES (
      ${saleOrderId}, '储值卡抵扣', '储值卡', ${amount}::numeric, '已支付',
      NOW(), 'admin', ${employeeId}, ${note}, NOW()
    )
  `)
}

export const getOrders = withPermission(
  'sale_order:list',
  async (session): Promise<SaleOrder[]> => {
  const rows = await db
    .select({
      order: saleOrders,
      storeName: stores.storeName,
      openedByName: opener.name,
    })
    .from(saleOrders)
    .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
    .leftJoin(opener, eq(saleOrders.openedBy, opener.employeeId))
    .where(scopeCondition(session, saleOrders.storeId))
    // 例外：业务时间优先（订单日期比"最近编辑"更符合管理员直觉）
    .orderBy(desc(saleOrders.saleOrderDatetime))
    .limit(500)

  return rows.map((r) => ({
    saleOrderId: r.order.saleOrderId,
    status: r.order.status as SaleOrder['status'],
    saleOrderType: r.order.saleOrderType as SaleOrder['saleOrderType'],
    documentType: r.order.documentType as SaleOrder['documentType'],
    refSaleOrderId: r.order.refSaleOrderId,
    marketName: r.order.marketName,
    storeId: r.order.storeId,
    saleOrderDatetime: r.order.saleOrderDatetime.toISOString(),
    clientUserId: r.order.clientUserId,
    clientPhone: r.order.clientPhone,
    customerName: r.order.customerName,
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
    createdAt: r.order.createdAt.toISOString(),
    updatedAt: r.order.updatedAt.toISOString(),
    storeName: r.storeName ?? undefined,
    openedByName: r.openedByName ?? undefined,
  }))
  },
)

/** 订单列表筛选参数 */
export interface OrderFilters {
  status?: string
  type?: string
  storeId?: string
  dateFrom?: string
  dateTo?: string
  search?: string
  /** 支付方式筛选（含 `'无'` = 全额储值卡抵扣） */
  paymentMethod?: string
  /** 是否仅筛选"有储值卡抵扣"的订单（prepaid_card_amount > 0） */
  hasPrepaidDeduction?: boolean
  /** 分配状态筛选（'待分配' | '已分配'，用于营业额分配页） */
  allocationStatus?: string
  page?: number
  pageSize?: number
}

/** 分页结果 */
export interface PaginatedOrders {
  data: SaleOrder[]
  total: number
}

/**
 * 服务端分页订单列表 — DB 级过滤 + LIMIT/OFFSET
 *
 * 替代 getOrders() 的客户端过滤模式，支持大数据量下的高效分页。
 * 筛选条件通过 URL searchParams → Server Component → 此函数流转。
 */
export const getOrdersPaginated = withPermission(
  'sale_order:list',
  async (session, filters: OrderFilters = {}): Promise<PaginatedOrders> => {
  const page = Math.max(1, filters.page || 1)
  const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
  const offset = (page - 1) * pageSize

  // 构建 WHERE 条件（DB 级过滤）
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
    conditions.push(gte(saleOrders.saleOrderDatetime, new Date(filters.dateFrom)))
  }
  if (filters.dateTo) {
    conditions.push(lt(saleOrders.saleOrderDatetime, new Date(filters.dateTo + 'T23:59:59.999')))
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
  // 支付方式筛选（枚举已扩展为 4 值：微信/支付宝/线下/无）
  if (
    filters.paymentMethod === '微信' ||
    filters.paymentMethod === '支付宝' ||
    filters.paymentMethod === '线下' ||
    filters.paymentMethod === '无'
  ) {
    conditions.push(eq(saleOrders.paymentMethod, filters.paymentMethod))
  }
  // 有储值卡抵扣（prepaid_card_amount > 0）
  if (filters.hasPrepaidDeduction) {
    conditions.push(gt(saleOrders.prepaidCardAmount, '0'))
  }
  if (filters.allocationStatus === '待分配' || filters.allocationStatus === '已分配') {
    conditions.push(eq(saleOrders.allocationStatus, filters.allocationStatus))
  }

  const whereClause = and(...conditions)

  // COUNT 查询（与数据查询共用相同 WHERE）
  const [countRow] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(saleOrders)
    .where(whereClause)

  const total = countRow?.count ?? 0

  // 数据查询 — JOIN + ORDER + LIMIT/OFFSET
  const rows = await db
    .select({
      order: saleOrders,
      storeName: stores.storeName,
      openedByName: opener.name,
    })
    .from(saleOrders)
    .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
    .leftJoin(opener, eq(saleOrders.openedBy, opener.employeeId))
    .where(whereClause)
    // 例外：业务时间优先（订单日期比"最近编辑"更符合管理员直觉）
    .orderBy(desc(saleOrders.saleOrderDatetime))
    .limit(pageSize)
    .offset(offset)

  const data = rows.map((r) => ({
    saleOrderId: r.order.saleOrderId,
    status: r.order.status as SaleOrder['status'],
    saleOrderType: r.order.saleOrderType as SaleOrder['saleOrderType'],
    documentType: r.order.documentType as SaleOrder['documentType'],
    refSaleOrderId: r.order.refSaleOrderId,
    marketName: r.order.marketName,
    storeId: r.order.storeId,
    saleOrderDatetime: r.order.saleOrderDatetime.toISOString(),
    clientUserId: r.order.clientUserId,
    clientPhone: r.order.clientPhone,
    customerName: r.order.customerName,
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
    createdAt: r.order.createdAt.toISOString(),
    updatedAt: r.order.updatedAt.toISOString(),
    storeName: r.storeName ?? undefined,
    openedByName: r.openedByName ?? undefined,
  }))

  return { data, total }
  },
)

// 订单详情页可由订单查看者（sale_order:list）或退款相关角色
// （sale_order:refund_create 提单人 / sale_order:refund_approve 审批人）访问
export const getOrderById = withAnyPermission(
  ['sale_order:list', 'sale_order:refund_create', 'sale_order:refund_approve'],
  async (session, saleOrderId: string): Promise<SaleOrder | null> => {
  const rows = await db
    .select({
      order: saleOrders,
      storeName: stores.storeName,
      openedByName: opener.name,
    })
    .from(saleOrders)
    .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
    .leftJoin(opener, eq(saleOrders.openedBy, opener.employeeId))
    .where(and(eq(saleOrders.saleOrderId, saleOrderId), scopeCondition(session, saleOrders.storeId)))
    .limit(1)

  if (rows.length === 0) return null

  const r = rows[0]

  // Get items with SKU join (product_name from sale_items snapshot)
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
    expireDate: ir.item.expireDate,
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
    marketName: r.order.marketName,
    storeId: r.order.storeId,
    saleOrderDatetime: r.order.saleOrderDatetime.toISOString(),
    clientUserId: r.order.clientUserId,
    clientPhone: r.order.clientPhone,
    customerName: r.order.customerName,
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
    createdAt: r.order.createdAt.toISOString(),
    updatedAt: r.order.updatedAt.toISOString(),
    storeName: r.storeName ?? undefined,
    openedByName: r.openedByName ?? undefined,
    items,
  }
  },
)

/**
 * 查询订单款项流水（ticket 2026-04-24 PR-3 §3.3）
 *
 * 只读，按 created_at 升序返回；
 * - LEFT JOIN staff_wechat_users 带出操作人姓名
 * - 退款专属字段（refundReason / refSaleItemId / sessionCount / auditEmployeeId / auditAt / auditRemark）
 *   2026-05-03 起已合并到 sale_order_payments 主表，无需 JOIN。
 * 用于订单详情页展示款项流水表（首次支付 / 回款 / 退款 / 储值卡抵扣）。
 */
// 详情页支付流水：订单查看者或退款相关角色（提单人 / 审批人）均可读
export const getOrderPayments = withAnyPermission(
  ['sale_order:list', 'sale_order:refund_create', 'sale_order:refund_approve'],
  async (session, saleOrderId: string): Promise<import('@/lib/types').SaleOrderPayment[]> => {
  // scope 校验：只有订单所在门店在 scope 内才允许查看流水
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
    // 例外：详情页支付流水按创建时间正序（按先后顺序阅读）
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

/**
 * C4: 确认线下收款 — 仅匹配 status='待支付' AND payment_method='线下' + scope。
 *
 * 支持部分确认（confirmAmount，对齐员工端 staffApi confirmOffline）：
 *   - confirmAmount 缺省 = 剩余应付现金（payable_amount - received）；可下调做部分收款。
 *   - 写 1 行现金流水（首次/回款）+ 扣全额预选储值卡（写'储值卡抵扣'行）。
 *   - 重算 received 后：received ≥ total → '已支付'，否则 '部分支付'，剩余走「录入回款」补齐。
 * 并发：FOR UPDATE 锁原单 + 终态 UPDATE 仍带 WHERE status='待支付' 守卫 + 扣卡幂等键 card-deduct-${id}。
 * 因创建时不再写款项流水，首次确认恒写'首次支付'；双击/并发再次进入会因 status≠待支付 被拦下。
 */
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
      // 锁原单 + 校验状态/支付方式/scope
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

      // 本次确认现金金额：缺省 = 剩余应付现金；传入则校验 0 ≤ v ≤ remainingPayable
      let cashAmount: number
      if (confirmAmount === undefined || confirmAmount === null) {
        cashAmount = remainingPayable
      } else {
        cashAmount = Math.round(Number(confirmAmount) * 100) / 100
        if (!Number.isFinite(cashAmount) || cashAmount < 0) {
          throw new ApiError('INVALID_PARAMS', '本次确认金额必须为非负数')
        }
        if (cashAmount > remainingPayable + 0.005) {
          throw new ApiError('INVALID_PARAMS', '本次确认金额不能超过剩余应付金额')
        }
      }

      // 设置单品到期日（确认收款即视为卡生效，1 年有效期；部分确认也设置，避免后续补款无触发点）
      await tx.execute(sql`
        UPDATE sale_items
        SET expire_date = (NOW() + INTERVAL '1 year')::date,
            updated_at = NOW()
        WHERE sale_order_id = ${saleOrderId}
          AND expire_date IS NULL
      `)

      // ========== 储值卡抵扣扣款（ticket 2026-05-19）==========
      // 锁余额 → 扣减 → 写 card_transactions(type='扣款') + 写 sale_order_payments(change_type='储值卡抵扣')
      // 与 staff confirmOffline 字面对齐；幂等键 card-deduct-${id}。首次确认时扣全额预选卡。
      const clientUserId = locked.client_user_id as string | null
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
          await tx.execute(sql`
            INSERT INTO sale_order_payments (
              sale_order_id, change_type, payment_method, amount, status,
              paid_at, source_end, operator_employee_id, note, created_at
            ) VALUES (
              ${saleOrderId}, '储值卡抵扣', '储值卡', ${orderPrepaid}::numeric, '已支付',
              NOW(), 'admin', ${session.employeeId}, '管理后台确认线下收款-储值卡抵扣', NOW()
            )
          `)
        }
      }

      // 现金流水：confirmAmount > 0 时写 1 行（首次/回款）。
      // change_type：已存在非储值卡 payments → '回款'，否则 '首次支付'（正常路径恒为首次支付）。
      if (cashAmount > 0) {
        const existRes = await tx.execute(sql`
          SELECT 1 FROM sale_order_payments
          WHERE sale_order_id = ${saleOrderId} AND status = '已支付'
            AND change_type IN ('首次支付','回款','退款') LIMIT 1
        `)
        const existRows = existRes as unknown as any[]
        const cashChangeType = existRows.length > 0 ? '回款' : '首次支付'
        await tx.execute(sql`
          INSERT INTO sale_order_payments (
            sale_order_id, change_type, payment_method, amount, status,
            paid_at, source_end, operator_employee_id, note, created_at
          ) VALUES (
            ${saleOrderId}, ${cashChangeType}, '线下', ${cashAmount.toFixed(2)}::numeric, '已支付',
            NOW(), 'admin', ${session.employeeId}, '管理后台确认线下收款', NOW()
          )
        `)
      }

      // 重算 received / prepaid_card_amount（跨端字面对齐 staff confirmOffline / recordPayment）：
      //   received = Σ(amount WHERE status='已支付' AND change_type IN ('首次支付','回款','储值卡抵扣'))
      //   prepaid_card_amount = Σ(amount WHERE status='已支付' AND change_type='储值卡抵扣')
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

      // received（含储值卡抵扣）≥ total → '已支付'，否则 '部分支付'
      const targetStatus: OrderStatus = newReceived + 0.005 >= orderTotal ? '已支付' : '部分支付'
      const paidAtIso = targetStatus === '已支付' ? new Date().toISOString() : null
      const updRes = await tx.execute(sql`
        UPDATE sale_orders
        SET status = ${targetStatus}::order_status,
            received = ${newReceived.toFixed(2)}::numeric,
            prepaid_card_amount = ${newPrepaid.toFixed(2)}::numeric,
            paid_at = ${paidAtIso},
            offline_confirmed_by = ${session.employeeId},
            offline_confirmed_at = NOW(),
            updated_at = NOW()
        WHERE sale_order_id = ${saleOrderId} AND status = '待支付'
      `)
      if ((updRes as any).rowCount === 0) {
        // 并发：状态在本事务可见性内已变更
        return { matched: false as const }
      }

      // 充值卡入账 + 客户分类跃迁：仅订单结清（已支付）时触发
      if (targetStatus === '已支付') {
        await applyRechargeOnOrderPaid(tx, saleOrderId)
      }
      // 积分发放 + paid_sessions 重算：始终执行（净额/幂等；部分支付也要按比例推进 paid_sessions）
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
    // 透传 INSUFFICIENT_BALANCE（储值卡余额不足 / 无卡）
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

/** C4: 关闭订单 — 仅待支付/支付失败可关闭，同时作废关联的分配记录 */
export const closeOrder = withPermission(
  'sale_order:update',
  async (session, saleOrderId: string): Promise<{ success: boolean; message: string }> => {
  // 获取上下文用于日志
  const [orderCtx] = await db
    .select({ status: saleOrders.status, customerName: saleOrders.customerName, totalAmount: saleOrders.totalAmount })
    .from(saleOrders)
    .where(eq(saleOrders.saleOrderId, saleOrderId))
    .limit(1)

  // 事务：关闭订单 + 作废分配，原子提交
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

      // 作废关联的分配记录（规范：订单关闭时作废分配）
      await tx.execute(sql`
        UPDATE sale_allocations SET is_void = true, voided_at = NOW()
        WHERE sale_item_id IN (
          SELECT sale_item_id FROM sale_items WHERE sale_order_id = ${saleOrderId}
        ) AND is_void = false
      `)

      // 归还优惠券（订单关闭时释放已核销的券）
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

/** C4: 重置支付失败 → 待支付（仅店长） */
export const resetOrderFailed = withPermission(
  'sale_order:update',
  async (session, saleOrderId: string): Promise<{ success: boolean; message: string }> => {
  // 获取上下文用于日志
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

/** 管理后台开单 — source='admin' */
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
  // 2026-04-26 sale-order-domain-refactor：5→3 值
  // '回款单' 走 recordPayment（写 sop[change_type='回款']）；
  // '退款单' 走 createRefund（写 sop[change_type='退款']）；
  // 此处仅接受 3 个真实业务类型
  saleOrderType: '销售单' | '内部单' | '转换单'
  openedBy?: string
  preferredEmployeeId?: string
  remark?: string | null
  /** 可选：顾客选择使用的优惠券实例ID */
  couponId?: string | null
  /**
   * 本次收款金额（ticket §2.1 决策树 + 2026-05-20 partial-payment-online）
   * - 线下：
   *   - undefined → 全额（payable_amount）；线下走 confirmOffline 翻终态
   *   - 0 → 纯挂账 status='待支付'；不写 payments 流水
   *   - 0 < v < payable_amount → 部分支付 status='部分支付'；写 1 行首次支付
   *   - = payable_amount → 全额 status='待支付'（线下保持，由 confirmOffline 入账）；写 1 行首次支付
   * - 微信/支付宝：
   *   - undefined / 0 / = payable_amount → 全额 QR（status='待支付' 等 payNotify 回调）
   *   - 0 < v < payable_amount → 首付限额（写 sale_orders.first_payment_amount，QR 收限额，
   *     payNotify 入账后落 部分支付 + 清 first_payment_amount）
   * 校验：0 ≤ v ≤ payable_amount
   */
  receivedAmount?: number
  /** 储值卡抵扣金额（> 0 时额外写 1 行 change_type='储值卡抵扣' payments 流水） */
  prepaidCardAmount?: number
  items: Array<{
    skuId: string
    productName: string
    skuSpecName: string
    productType: '疗程卡' | '单品' | '家居产品'
    sessionCount: number | null
    unitPrice: string
    unitRealPrice: string
    quantity: number
    /** 手动应付金额（可选，覆盖 unitRealPrice * quantity） */
    saleAmount?: string
    /** 手动实付金额（可选，覆盖 saleAmount） */
    received?: string
    salesCategory?: '自销自耗' | '他销自耗' | '他销他耗' | '生态合作' | null
  }>
    },
  ): Promise<{
    success: boolean
    message: string
    saleOrderId?: string
    /** 订单初始 status，前端 Step 4 据此分支文案：'部分支付' / '待支付' / '已支付' */
    status?: '待支付' | '部分支付' | '已支付'
  }> => {
  // 2026-04-26 sale-order-domain-refactor: saleOrderType 5→3 运行时硬校验
  // 静态联合类型已限定在 createOrder data 入参；此处再做一次 runtime 兜底防绕过
  // （旧前端/外部调用可能传入 '回款单'/'退款单'，统一拒绝）
  const ALLOWED_SALE_ORDER_TYPES = ['销售单', '内部单', '转换单'] as const
  if (!ALLOWED_SALE_ORDER_TYPES.includes(data.saleOrderType as typeof ALLOWED_SALE_ORDER_TYPES[number])) {
    return {
      success: false,
      message: `INVALID_PARAMS: SALE_ORDER_TYPE_INVALID: 不允许的 saleOrderType: ${data.saleOrderType}（'回款单' 走 recordPayment；'退款单' 走 createRefund）`,
    }
  }

  // J3 (B9 ticket follow-up): 一张订单仅支持 1 张优惠券；schema 已用 z.string() 拒绝 array，
  // 此处再做 runtime 兜底防外部调用绕过 schema 校验
  if (Array.isArray(data.couponId)) {
    return {
      success: false,
      message: 'INVALID_PARAMS: MULTIPLE_COUPON_NOT_SUPPORTED: 一张订单仅支持 1 张优惠券',
    }
  }

  if (!data.clientUserId) {
    return { success: false, message: '顾客未注册小程序或未绑定门店' }
  }

  // 校验 storeId 在用户 scope 内
  if (!isInScope(session, data.storeId)) {
    return { success: false, message: '无权在该门店创建订单' }
  }

  // 充值卡剥离 SKU 化（2026-05-20）：充值订单走独立 createRechargeOrder action，
  // 不再走 createSaleOrder。这里删除原"isRechargeOrder 识别 + 字段强制覆盖"块。

  // 内部单自动半价：入口统一在事务前对 items 金额 ×0.5；unit_price（原价快照）保持不变。
  // 服务费 (service_fee) 不受半价影响，仍按 SKU 配置快照。
  if (data.saleOrderType === '内部单') {
    if (data.couponId) {
      return { success: false, message: '内部单不允许叠加优惠券' }
    }
    data = {
      ...data,
      items: data.items.map((item) => {
        const halve = (v: string) => (Number(v) / 2).toFixed(2)
        return {
          ...item,
          unitRealPrice: halve(item.unitRealPrice),
          saleAmount: item.saleAmount !== undefined ? halve(item.saleAmount) : undefined,
          received: item.received !== undefined ? halve(item.received) : undefined,
        }
      }),
    }
  }

  // 校验手动金额
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

  // ========== B2 拆行：疗程卡 quantity>1 → N 行 quantity=1 ==========
  // ticket: notes/tickets/archives/2026-05-18-single-session-card-quantity-not-split.md
  // 业务语义：每张卡（无论 sku.session_count 是 1 还是 N）都是独立可转换/核销的实体，
  // 应在 sale_items 写成 N 行（每行 quantity=1, session_count=sku.session_count）。
  // 家居产品（productType='家居产品'）继续合行（quantity 累加）。
  // 与 staff order.js 同步（见 cross-end-sql-snapshot 守护）。
  // saleAmount / received 按 N 等分，最后一行吸收尾差，确保 sum 守恒。
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
      const perReceivedCents = Math.round((totalReceived * 100) / n)
      const totalSaleCents = Math.round(totalSale * 100)
      const totalReceivedCents = Math.round(totalReceived * 100)
      const rows: typeof item[] = []
      for (let i = 0; i < n; i++) {
        const isLast = i === n - 1
        const saleCents = isLast
          ? totalSaleCents - perSaleCents * (n - 1)
          : perSaleCents
        const receivedCents = isLast
          ? totalReceivedCents - perReceivedCents * (n - 1)
          : perReceivedCents
        const saleStr = (saleCents / 100).toFixed(2)
        const receivedStr = (receivedCents / 100).toFixed(2)
        rows.push({
          ...item,
          quantity: 1,
          // unitRealPrice 重写为本行实付金额（每行 quantity=1）
          unitRealPrice: receivedStr,
          // saleAmount / received 仅在原入参显式提供时保留分行覆盖；
          // 否则保留原入参的 undefined（让后续按 unitRealPrice × 1 计算）
          saleAmount: item.saleAmount !== undefined ? saleStr : undefined,
          received: item.received !== undefined ? receivedStr : undefined,
        })
      }
      return rows
    }),
  }

  // 计算商品总金额（应付，基于 saleAmount/unitRealPrice，不依赖 item.received）
  // 与 sale_items.sale_amount 落库口径一致（L1286-1287），跨端与 staff order.js L523 /
  // client order.js L405-416 对齐。item.received（部分支付实收）不参与 total_amount。
  // 浮点 round 兜底（行级 + 累加后），见 notes/tickets/2026-05-17-client-order-no-coupon-rounding.md §5.2
  const rawTotal = Math.round(data.items.reduce((sum, item) => {
    const computed = Number(item.unitRealPrice) * item.quantity
    const itemAmount = item.saleAmount ? Number(item.saleAmount) : computed
    return sum + Math.round(itemAmount * 100) / 100
  }, 0) * 100) / 100

  // 提前校验优惠券（事务外查询，避免在事务内做复杂查询）
  // ticket B9：minSpend / 折扣基数已切换到 eligibleTotal（scope 内应付合计），不再使用全单合计
  let couponDiscount = 0
  if (data.couponId && data.clientUserId) {
    // 查询 SKU 的 categoryId 和 productId，用于优惠券范围校验
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

    // 范围校验：门店维度（NULL/空数组 = 不限制）
    if (coupon.applicableStoreIds && coupon.applicableStoreIds.length > 0) {
      if (!data.storeId || !coupon.applicableStoreIds.includes(data.storeId)) {
        return { success: false, message: '该优惠券不适用于当前门店' }
      }
    }

    // 范围校验：市场维度（NULL/空数组 = 不限制）
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

    // 范围校验：品类 + 商品维度（NULL/空数组 = 不限制；同时设置时取交集）
    // 计算 eligibleItems：满足 category AND product 双重限制
    // 与 client/staff order.create 对齐（fengyu-client/cloudfunctions/clientApi/routes/order.js L329-355
    // 和 fengyu-staff/cloudfunctions/staffApi/routes/order.js L390-410）
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

    // 满减门槛 / 折扣基数：必须基于 eligibleItems（scope 内）应付金额合计，而非全单
    // ticket B9：admin 此前用 saleAmountTotal 作为基数，与 client/staff 行为不一致；
    // 见 notes/tickets/2026-05-18-coupon-binding-restriction-not-enforced.md
    const eligibleTotalRaw = eligibleItems.reduce((sum, item) => {
      const itemSale = item.saleAmount ? Number(item.saleAmount) : Number(item.unitRealPrice) * item.quantity
      return sum + Math.round(itemSale * 100) / 100
    }, 0)
    const eligibleTotal = Math.round(eligibleTotalRaw * 100) / 100

    const minSpend = parseFloat(coupon.minSpend ?? '0')
    // +0.001 兜底 JS 浮点累计误差，与 client/staff coupon.available 保持一致
    if (eligibleTotal + 0.001 < minSpend) {
      return { success: false, message: `订单金额未满足优惠券最低消费 ¥${minSpend.toFixed(2)}` }
    }
    couponDiscount = calcCouponDiscount(coupon.couponType, String(coupon.discountValue), coupon.maxDiscount ?? null, eligibleTotal)
    couponDiscount = Math.round(couponDiscount * 100) / 100
  }

  const totalAmount = Math.round(Math.max(0, rawTotal - couponDiscount) * 100) / 100

  // ── 款项流水 / 部分支付基础（ticket 2026-04-24 PR-3） ─────────────
  // payable_amount = total_amount - prepaid_card_amount（冗余列，用于状态机决策和前端展示）
  const prepaidCardAmount = Math.max(0, data.prepaidCardAmount ?? 0)
  if (prepaidCardAmount > totalAmount + 0.005) {
    return { success: false, message: '储值卡抵扣金额不能超过订单总额' }
  }
  const payableAmount = Math.max(0, Math.round((totalAmount - prepaidCardAmount) * 100) / 100)

  // 本次收款校验：
  // - 线下：开单时一律不记款，effectiveReceived 恒为 0，**忽略入参 receivedAmount**
  //   （实际款项在「确认收款」时才写流水 + 扣储值卡）。这样既统一了"先付款后转态"不变量，
  //   也避免前端传未扣卡的应付合计在有储值卡抵扣时误触 receivedAmount > payable 的超额报错。
  // - 微信/支付宝：传 0 < v < payable → 线上首付（写 first_payment_amount，QR 收限额）；
  //   v = payable 或 undefined → 全额 QR（保持既有行为）；v = 0 显式表示挂账等扫码（与 undefined 等价处理）。
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

  // 线上 + receivedAmount < payable → 把"首付限额"写入 sale_orders.first_payment_amount
  // （线下场景该列保持 NULL）。
  const firstPaymentAmount: number | null =
    isOnlinePay && receivedAmount > 0 && receivedAmount + 0.005 < payableAmount
      ? Math.min(receivedAmount, payableAmount)
      : null

  // 全额储值卡抵扣（payable==0 且 prepaid>0）：无现金可收，挂"待支付"会卡死
  //   （payment_method='无' 走不了 confirmOfflinePayment），故创建事务内直接扣卡 + 结清。
  //   用户 2026-05-21 拍板：销售单/转换单全额抵扣均在提交订单时即时抵扣。
  const isFullCardCoverage = prepaidCardAmount > 0 && payableAmount === 0

  // 决策树（三端对齐"先付款、后转态记账"不变量）：
  //   - 全额储值卡抵扣：'已支付'（事务内即时扣卡 + 结算）
  //   - 微信/支付宝：'待支付'（等 payNotify 回调入账，无论首付与否）
  //   - 线下：'待支付'（开单不记款；现金 + 部分储值卡抵扣都在「确认收款」confirmOfflinePayment 入账翻态）
  // createOrder 仅全额抵扣场景产出 '已支付'，其余款项流水/状态机由确认收款 / 录入回款 / payNotify 驱动。
  const initialStatus: typeof saleOrders.$inferInsert['status'] = isFullCardCoverage ? '已支付' : '待支付'

  // 全额抵扣时 payment_method 落 '无'（现金通道无需使用，与 staff order.create 对齐）。
  const effectivePaymentMethod = isFullCardCoverage ? '无' : data.paymentMethod

  // received 创建时：全额抵扣 = prepaid（已结清）；其余一律 0（线上等 payNotify，线下等 confirmOfflinePayment）。
  // （2026-04-26 sale-order-domain-refactor：paid_amount 列已 DROP，统一用 received）
  const paidAmountSnapshot = isFullCardCoverage ? prepaidCardAmount : 0

  // 计算 document_type（售前/售后快照）
  let documentType: '售前' | '售后' = '售前'
  if (data.clientUserId) {
    const [client] = await db
      .select({ customerType: clientWechatUsers.customerType })
      .from(clientWechatUsers)
      .where(eq(clientWechatUsers.userId, data.clientUserId))
      .limit(1)
    if (client?.customerType === '会员客') {
      documentType = '售后'
    }
  }
  if (documentType === '售前') {
    const threshold = await getMemberThreshold()
    if (totalAmount >= threshold) {
      documentType = '售后'
    }
  }

  // 事务外批量查询本次涉及 sku 的 service_fee（固定手工费）、session_count（疗程卡次数）
  // 与 is_experience（capability 权威源）。
  // 用于 sale_items 快照：service_fee 供服务完成时参与提成计算，
  // session_count 对组合套餐路径做兜底（bundleSkuToProductSku 硬编码 null，前端传来不可信），
  // is_experience 拷贝用于客户分类跃迁（per-order SUM FILTER WHERE is_experience）。
  // 充值卡剥离 SKU 化（2026-05-20）后无需 is_recharge_card 字段。
  const skuIdList = data.items.map(i => i.skuId).filter((s): s is string => !!s)
  const skuFeeMap = new Map<string, string>()
  const skuSessionMap = new Map<string, number | null>()
  const skuExperienceMap = new Map<string, boolean>()
  if (skuIdList.length > 0) {
    const skuRows = await db
      .select({
        skuId: productSkus.skuId,
        serviceFee: productSkus.serviceFee,
        sessionCount: productSkus.sessionCount,
        isExperience: productSkus.isExperience,
      })
      .from(productSkus)
      .where(and(inArray(productSkus.skuId, skuIdList), isNull(productSkus.deletedAt)))
    for (const r of skuRows) {
      skuFeeMap.set(r.skuId, r.serviceFee)
      skuSessionMap.set(r.skuId, r.sessionCount)
      skuExperienceMap.set(r.skuId, r.isExperience === true)
    }
  }

  // 充值卡剥离 SKU 化（2026-05-20）后 D4 混单守卫已删除（充值订单走独立 createRechargeOrder 入口）。

  // 事务：ID 生成 + 优惠券核销 + 订单 + 明细，原子提交或全部回滚
  let saleOrderId: string
  try {
    saleOrderId = await db.transaction(async (tx) => {
      // advisory lock 在事务内持有，直到 commit 才释放
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

      // 检查该顾客是否已有待支付订单（partial unique index 保护）
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
        saleOrderDatetime: new Date(),
        clientUserId: data.clientUserId,
        clientPhone: data.clientPhone,
        customerName: data.customerName,
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
        paidAt: isFullCardCoverage ? new Date() : null,
      })

      // 开单时不写款项流水（统一"先付款、后记账"不变量）：
      //   - 线上（微信/支付宝）：由 payNotify 回调写入并翻态
      //   - 线下：由 confirmOfflinePayment「确认收款」写入现金/储值卡抵扣流水并翻态
      //   - prepaid_card_amount 仅作为订单上的"预选"金额，确认收款时才扣卡 + 写 '储值卡抵扣' 行

      // 原子核销优惠券：WHERE coupon_id = X AND status = '未使用' 防止重用
      // 必须在 insert sale_orders 之后，因为 used_sale_order_id 有外键约束
      if (data.couponId) {
        const voidResult = await tx
          .update(userCoupons)
          .set({ status: '已使用', usedSaleOrderId: id, usedAt: new Date() })
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
        const received = item.received ?? saleAmount

        // 固定手工费快照 = product_skus.service_fee × quantity
        const skuServiceFee = Number(skuFeeMap.get(item.skuId) || 0)
        const serviceFee = (skuServiceFee * item.quantity).toFixed(2)

        // sessionCount 以服务端 productSkus.session_count 为权威（对组合套餐疗程卡兜底）。
        // sale_items.session_count / remaining_sessions 是"行总次数"维度
        // （service.complete 按次扣减 remaining_sessions），应 = sku.session_count × quantity；
        // 漏乘 quantity 会导致剩余次数显示 1/1 而非 N/N，且核销超过 1 次即被扣减守护卡住。
        const skuSessionCount = skuSessionMap.get(item.skuId) ?? item.sessionCount
        const sessionCount = skuSessionCount != null ? skuSessionCount * item.quantity : null

        // per-session 派生：unit_real_price/unit_price 存单次价（sale_amount 为权威行总额）；
        //   卡 = 行总额 / 总次数；非卡 = 行总额 / 数量（per-unit 退化）。入参 unitPrice/unitRealPrice 是 per-card 表单值。
        const psDenom = (sessionCount != null && sessionCount > 0) ? sessionCount : item.quantity
        const listTotalRow = Number(item.unitPrice) * item.quantity
        const unitRealPrice = psDenom > 0 ? (Number(saleAmount) / psDenom).toFixed(2) : Number(saleAmount).toFixed(2)
        const unitPrice = psDenom > 0 ? (listTotalRow / psDenom).toFixed(2) : Number(item.unitPrice).toFixed(2)

        // is_experience 行级快照：以服务端 product_skus.is_experience 为权威。
        // 用于客户分类跃迁 SQL（SUM(received) FILTER WHERE si.is_experience）。
        const isExperience = skuExperienceMap.get(item.skuId) ?? false

        await tx.insert(saleItems).values({
          saleItemId,
          saleOrderId: id,
          storeId: data.storeId,
          itemDirection: '购买',
          skuId: item.skuId,
          productName: item.productName,
          skuSpecName: item.skuSpecName,
          productType: item.productType,
          sessionCount,
          remainingSessions: sessionCount,
          unitPrice,
          quantity: item.quantity,
          unitRealPrice,
          saleAmount,
          received,
          salesCategory: item.salesCategory || null,
          serviceFee,
          isExperience,
        })
      }

      // 充值卡剥离 SKU 化（2026-05-20）后 D4 事后兜底校验已删除（migration 0043 拆触发器）

      // 全额储值卡抵扣：事务内即时扣卡 + 写 '储值卡抵扣' 流水（与 confirmOfflinePayment 已支付分支对齐）
      if (isFullCardCoverage && data.clientUserId) {
        await deductPrepaidCardAtCreation(tx, {
          saleOrderId: id,
          clientUserId: data.clientUserId,
          amount: prepaidCardAmount,
          employeeId: session.employeeId,
          note: '管理后台开单-储值卡全额抵扣',
        })
      }

      // paid_sessions 初始写入（ticket 2026-05-19）：admin createOrder 通常 received=0 → paid_sessions=0；
      // 全额抵扣时 received=prepaid → paid_sessions 按已结清推进。
      await recalcPaidSessionsForOrder(tx, id)

      // 全额抵扣即结清：触发积分发放 + 客户分类跃迁（与 confirmOfflinePayment 已支付分支一致）。
      if (isFullCardCoverage) {
        await settlePointsSafe(tx, id, 'admin.createOrder')
        if (data.clientUserId) {
          await recalcCustomerType(tx, data.clientUserId)
        }
      }

      return id
    })
  } catch (err: any) {
    // 事务内业务异常 → 友好消息
    if (err?.message === '订单号生成失败') {
      return { success: false, message: '订单号生成失败，请稍后重试' }
    }
    // 全额储值卡抵扣扣卡失败（余额不足 / 无卡）
    if (typeof err?.message === 'string' && err.message.startsWith('INSUFFICIENT_BALANCE')) {
      const stripped = err.message.replace(/^INSUFFICIENT_BALANCE:?(NO_CARD)?:?\s*/, '')
      return { success: false, message: stripped || '顾客储值卡余额不足' }
    }
    if (err?.message?.startsWith('该顾客已有待支付订单')) {
      return { success: false, message: err.message }
    }
    if (err?.message === '优惠券已被使用，请刷新后重试') {
      return { success: false, message: err.message }
    }
    if (err?.message === 'INVALID_PARAMS: 充值卡商品不允许与普通商品混单') {
      return {
        success: false,
        message: '充值卡商品不允许与普通商品混单',
      }
    }
    // PG 外键违反（storeId / skuId / clientUserId 不存在）
    if (err?.code === '23503') {
      return { success: false, message: '关联数据不存在，请检查门店、商品或顾客信息' }
    }
    // PG NOT NULL 违反（字段缺失）
    if (err?.code === '23502') {
      console.error('[createOrder] not_null_violation:', err)
      return { success: false, message: '订单字段缺失，请联系管理员' }
    }
    // PG 唯一约束冲突（advisory lock 下极罕见）
    if (err?.code === '23505') {
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

/**
 * 转换单 — 顾客持卡折抵换购
 *
 * 业务流程：
 * 1. 锁住 convertOutSaleItemIds 对应 sale_items 行（FOR UPDATE），校验 store_id / item_direction / 状态
 * 2. 计算转出折抵金额 totalOut = sum(unit_real_price × 可折抵数量)
 *    - 疗程卡：remaining_sessions
 *    - 单品：quantity - COALESCE(picked_up_quantity, 0)
 * 3. 计算转入应付金额 totalIn = sum(sku.price × quantity)
 * 4. priceDiff = totalIn - totalOut
 *    - priceDiff > 0：补现（paymentMethod），sale_orders.total_amount = priceDiff，status='待支付'
 *    - priceDiff = 0：不收款，status='已支付'
 *    - priceDiff < 0：差额 UPSERT 到 prepaid_cards，INSERT card_transactions('充值')
 * 5. 原子标记转出行已耗尽：疗程卡 remaining_sessions=0；单品 picked_up_quantity=quantity
 * 6. INSERT 转出行（sale_amount/received 为负折抵，item_direction='转出'，ref_sale_item_id）
 * 7. INSERT 转入行（item_direction='转入'，sale_amount/received=转入金额）
 */
export const createConversionOrder = withPermission(
  'sale_order:create',
  async (
    session,
    data: {
  storeId: string
  marketName: string
  /** 转换单必须实名顾客（要挂储值卡），不允许 manualPhone */
  clientUserId: string
  paymentMethod: '微信' | '支付宝' | '线下'
  preferredEmployeeId?: string
  remark?: string | null
  /** 转出：整张卡（不带数量，全部折抵） */
  convertOutSaleItemIds: string[]
  /** 转入项目（来自 Step 2 的购物车） */
  convertInItems: Array<{
    skuId: string
    productName: string
    skuSpecName: string
    productType: '疗程卡' | '单品' | '家居产品'
    sessionCount: number | null
    unitPrice: string
    quantity: number
    salesCategory?: '自销自耗' | '他销自耗' | '他销他耗' | '生态合作' | null
  }>
  /** 储值卡抵扣金额（仅补差额 priceDiff > 0 时有效；clamp 到 [0, priceDiff]） */
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
  /** 本单实际充值卡抵扣额（priceDiff > 0 时 = clamp 后的抵扣额） */
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

  // 查顾客基本信息（姓名快照 + phone 快照）
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

  // 事务：锁转出行 + 校验 + 计算金额 + 插入订单 + 插入两段 items + 储值卡补差
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
      // 1. 锁住转出候选行（FOR UPDATE）并 JOIN product_categories 以识别"体验卡单品"
      const heldRows = await tx.execute(sql`
        SELECT
          si.sale_item_id,
          si.store_id,
          si.item_direction,
          si.sku_id,
          si.product_name,
          si.sku_spec_name,
          si.product_type,
          si.session_count,
          si.remaining_sessions,
          si.quantity,
          si.picked_up_quantity,
          si.unit_price,
          si.unit_real_price,
          si.sales_category,
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
        skuSpecName: string | null
        productType: '疗程卡' | '单品' | '家居产品' | null
        sessionCount: number | null
        unitPrice: string
        unitRealPrice: string
        quantity: number
        amount: number
        salesCategory: string | null
        serviceFee: number
        isExperience: boolean
      }
      const outItems: OutItem[] = []

      for (const row of held) {
        // 归属校验：store_id / client_user_id / direction / 状态
        if (row.store_id !== data.storeId) throw new ApiError('INVALID_STATE', 'CARD_STORE_MISMATCH: 所选卡不属于当前门店')
        if (row.client_user_id !== data.clientUserId) throw new ApiError('INVALID_STATE', 'CARD_OWNER_MISMATCH: 所选卡不属于该顾客')
        if (row.item_direction !== '购买') throw new ApiError('INVALID_STATE', 'CARD_DIRECTION_INVALID: 所选行非购买行，不可折抵')
        if (row.order_status !== '已支付' && row.order_status !== '已完成') {
          throw new ApiError('INVALID_STATE', 'CARD_ORDER_STATUS_INVALID: 原订单状态不允许转换')
        }

        const unit = Number(row.unit_real_price)
        const productType = row.product_type as string

        let qty = 0
        if (productType === '疗程卡') {
          const rem = Number(row.remaining_sessions ?? 0)
          if (rem <= 0) throw new ApiError('INVALID_STATE', 'CARD_EXHAUSTED: 所选卡已耗尽，无法折抵')
          qty = rem
        } else if (productType === '单品' && row.is_experience === true) {
          const remQty = Number(row.quantity) - Number(row.picked_up_quantity ?? 0)
          if (remQty <= 0) throw new ApiError('INVALID_STATE', 'CARD_EXHAUSTED: 所选卡已耗尽，无法折抵')
          qty = remQty
        } else {
          throw new ApiError('INVALID_PARAMS', 'CARD_TYPE_INVALID: 所选行类型不支持折抵')
        }

        const amount = Math.round(unit * qty * 100) / 100
        totalOut += amount
        // 按折抵数量比例扣减 service_fee（负值）
        const origServiceFee = Number(row.service_fee ?? 0)
        const origQty = Number(row.quantity) || 1
        const outServiceFee = -Math.round((origServiceFee * qty / origQty) * 100) / 100

        outItems.push({
          refSaleItemId: row.sale_item_id as string,
          skuId: (row.sku_id as string) ?? null,
          productName: (row.product_name as string) ?? null,
          skuSpecName: (row.sku_spec_name as string) ?? null,
          productType: productType as OutItem['productType'],
          sessionCount: row.session_count !== null ? Number(row.session_count) : null,
          unitPrice: String(row.unit_price),
          unitRealPrice: String(row.unit_real_price),
          quantity: qty,
          amount,
          salesCategory: (row.sales_category as string) ?? null,
          serviceFee: outServiceFee,
          isExperience: row.is_experience === true,
        })
      }

      // 2. 加载转入 SKU 详情（price / service_fee / session_count / sales_category / is_experience）
      const inSkuIds = data.convertInItems.map((i) => i.skuId)
      const skuRows = await tx
        .select({
          skuId: productSkus.skuId,
          price: productSkus.price,
          serviceFee: productSkus.serviceFee,
          sessionCount: productSkus.sessionCount,
          productType: productSkus.productType,
          isExperience: productSkus.isExperience,
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

      // 储值卡抵扣（仅补差额 priceDiff > 0 时有效）：clamp 到 [0, priceDiff]。
      // payable = priceDiff - card；全额抵扣（payable==0 且 card>0）则创建事务内即时扣卡 + 结清。
      const card = priceDiff > 0
        ? Math.min(Math.max(0, Math.round((data.prepaidCardAmount ?? 0) * 100) / 100), priceDiff)
        : 0
      const payable = Math.max(0, Math.round((Math.max(0, priceDiff) - card) * 100) / 100)
      const isFullCardCoverage = card > 0 && payable === 0

      // 3. 生成订单号（advisory lock + 当日序号）
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

      // 4. 计算 documentType（售前/售后）
      let documentType: '售前' | '售后' = client.customerType === '会员客' ? '售后' : '售前'
      if (documentType === '售前') {
        const threshold = await getMemberThreshold()
        if (totalIn >= threshold) documentType = '售后'
      }

      // 5. 插入订单主表
      // 顾客补现场景：priceDiff > 0 → total_amount=priceDiff，status 按抵扣后应付决定
      //   - payable > 0（仍需付现金）：'待支付'，扣卡延后到 confirmOffline / payNotify
      //   - payable == 0 且有抵扣（全额抵扣）：事务内即时扣卡 → '已支付'，payment_method='无'
      // 其他（priceDiff <= 0）：total_amount=0 & status='已支付'
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
        saleOrderDatetime: new Date(),
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
        paidAt: orderPaid ? new Date() : null,
      })

      // 6. 转出行 + 原子扣减原卡余量
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
          skuSpecName: out.skuSpecName,
          productType: out.productType,
          sessionCount: out.sessionCount,
          unitPrice: out.unitPrice,
          quantity: out.quantity,
          unitRealPrice: out.unitRealPrice,
          saleAmount: (-out.amount).toFixed(2),
          received: (-out.amount).toFixed(2),
          salesCategory: (out.salesCategory as typeof saleItems.$inferInsert['salesCategory']) ?? null,
          serviceFee: out.serviceFee.toFixed(2),
          // 转出行镜像原 sale_items.is_experience：负 received × is_experience=true 会冲销
          // 原订单的 trial_amount 累计，与跃迁 SQL 的"只升不降"语义一致。
          isExperience: out.isExperience,
        })

        // 原子标记耗尽：疗程卡 remaining_sessions=0；单品 picked_up_quantity=quantity
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
        } else if (out.productType === '单品') {
          const upd = await tx
            .update(saleItems)
            .set({ pickedUpQuantity: sql`${saleItems.quantity}` })
            .where(
              and(
                eq(saleItems.saleItemId, out.refSaleItemId),
                eq(saleItems.storeId, data.storeId),
                sql`${saleItems.quantity} - COALESCE(${saleItems.pickedUpQuantity}, 0) >= ${out.quantity}`,
              ),
            )
          if ((upd as any).count === 0) throw new ApiError('CONFLICT', 'CARD_CONCURRENT_CHANGED: 卡状态变化，请重试')
        }
      }

      // 7. 转入行
      for (const inRow of inItems) {
        const saleItemId = `${saleOrderId}-${String(seq).padStart(2, '0')}`
        seq++
        // sessionCount 以服务端查到的 productSkus.session_count 为权威，
        // 组合套餐前端 payload 里疗程卡会丢失该字段（bundleSkuToProductSku 硬编码 null），
        // 这里兜底保证 remaining_sessions 正确，否则卡永远无法核销。
        // 同 createOrder：sale_items.session_count 是行总次数维度，需 × quantity。
        const skuSessionCount = inRow.sku.sessionCount ?? inRow.item.sessionCount
        const sessionCount = skuSessionCount != null ? skuSessionCount * inRow.item.quantity : null
        // per-session 单价（转入无折扣：unit_price = unit_real_price = amount/总次数；非卡 = amount/qty）
        const inDenom = (sessionCount != null && sessionCount > 0) ? sessionCount : inRow.item.quantity
        const unitPrice = inDenom > 0 ? (inRow.amount / inDenom).toFixed(2) : Number(inRow.sku.price).toFixed(2)
        await tx.insert(saleItems).values({
          saleItemId,
          saleOrderId,
          storeId: data.storeId,
          itemDirection: '转入',
          skuId: inRow.item.skuId,
          productName: inRow.item.productName,
          skuSpecName: inRow.item.skuSpecName,
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
          // 转入行从 product_skus.is_experience 快照写入
          isExperience: inRow.sku.isExperience === true,
        })
      }

      // 8. 差额退余：priceDiff < 0 → UPSERT prepaid_cards + card_transactions
      let prepaidCardCredit = 0
      if (priceDiff < 0) {
        const creditAmount = Math.abs(priceDiff)
        prepaidCardCredit = creditAmount

        // UPSERT prepaid_cards（按 user_id 唯一；store_id 列已于 2026-04-24 DROP，卡跨店共享）
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

      // 8b. 补差额全额抵扣（priceDiff > 0 且 payable==0）：事务内即时扣卡 + 写 '储值卡抵扣' 流水。
      //     与 8（负差额充值）互斥（全额抵扣要求 priceDiff > 0）。
      if (isFullCardCoverage) {
        await deductPrepaidCardAtCreation(tx, {
          saleOrderId,
          clientUserId: data.clientUserId,
          amount: card,
          employeeId: session.employeeId,
          note: '管理后台转换单-储值卡全额抵扣',
        })
      }

      // paid_sessions 写入（ticket 2026-05-19）：转换单 total_amount=差额，可能=0 → 兜底全付
      await recalcPaidSessionsForOrder(tx, saleOrderId)

      // 全额抵扣即结清：触发积分发放 + 客户分类跃迁（与 confirmOfflinePayment 已支付分支一致）。
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
    // 全额抵扣即时扣卡失败（余额不足 / 无卡）
    if (m?.startsWith('INSUFFICIENT_BALANCE')) {
      const stripped = m.replace(/^INSUFFICIENT_BALANCE:?(NO_CARD)?:?\s*/, '')
      return { success: false, message: stripped || '顾客储值卡余额不足' }
    }
    if (m?.includes('SKU_NOT_FOUND:')) return { success: false, message: '转入商品不存在' }
    if (err?.code === '23503') {
      console.error('[createConversionOrder] fk_violation:', err)
      return { success: false, message: '关联数据不存在，请检查门店、商品或顾客信息' }
    }
    if (err?.code === '23502') {
      console.error('[createConversionOrder] not_null_violation:', err)
      return { success: false, message: '订单字段缺失，请联系管理员' }
    }
    if (err?.code === '23505') return { success: false, message: '订单号冲突，请稍后重试' }
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
  // 补差额抵扣后实际仍需付现金 = priceDiff - 抵扣额
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

// ========== B5: 寄存单（剩余次数初始化） ==========

/**
 * 管理后台开寄存单（admin）
 *
 * 与 staffApi.order.createDeposit 语义对齐：
 *   - 复用 sale_orders + sale_items，可生成 service_orders 核销
 *   - 不收钱：received=0 / payable=0 / total=0 / payment_method='无' / status='已支付'
 *   - 拒绝任何抵扣（优惠券 / 储值卡 / 行级 customPrice）
 *   - 所有金额维度统计排除（dashboard / 提成 / 客单价）
 *   - 次数维度统计纳入（mgmt-product.cardHolders 持卡人数）
 *   - 仅 manager 角色（沿用 'sale_order:create' 权限）
 *
 * 输入：
 *   storeId / marketName / clientUserId（必填）+ items[{skuId, quantity}] + remark
 */
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
    }

    // 查顾客（client_identity_rule：bound_store_id 即可，openid 可空）
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

    // 拉 SKU 信息（充值卡剥离 SKU 化后，寄存单输入只剩普通商品）
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

    // 在事务内生成订单号 + 写 sale_orders + sale_items
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
          saleOrderDatetime: now,
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
          paidAt: now,
          allocationStatus: '待分配',
        })

        // 生成 sale_item 流水号序列
        const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '')
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

        for (let i = 0; i < data.items.length; i++) {
          const item = data.items[i]
          const sku = skuMap.get(item.skuId)!
          const saleItemId = `XSLSH-WX-${dateStr}${String(seq + i).padStart(4, '0')}`
          const basePrice = Number(sku.specialPrice || sku.price)
          const quantity = item.quantity
          // 次数 × 数量；家居产品不带次数
          const sc = sku.productType === '家居产品'
            ? null
            : (sku.sessionCount != null ? Number(sku.sessionCount) * quantity : null)
          const depSaleAmount = (Math.round(basePrice * quantity * 100) / 100).toFixed(2)
          // per-session 单价：卡 = sale_amount/总次数；非卡 = sale_amount/quantity（per-unit 退化）
          const depDenom = (sc != null && sc > 0) ? sc : quantity
          const depUnit = depDenom > 0 ? (Number(depSaleAmount) / depDenom).toFixed(2) : depSaleAmount

          await tx.insert(saleItems).values({
            saleItemId,
            saleOrderId: id,
            storeId: data.storeId,
            itemDirection: '购买',
            skuId: sku.skuId,
            productName: sku.specName,
            skuSpecName: sku.specName,
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

        // paid_sessions 写入（ticket 2026-05-19）：寄存单 total_amount=0 → 兜底全付 = session_count
        await recalcPaidSessionsForOrder(tx, id)

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

// ========== 录入回款（ticket 2026-04-24 多次回款 PR-B） ==========

/**
 * 管理后台录入回款（admin 线下/储值卡回款）
 *
 * 设计对齐：staffApi.order.createRepayment（ticket-2 PR-A，staff 实现）
 *   - 双写：1 条 FY-HKD 凭证单 sale_orders 行 + 1~2 条 sale_order_payments 流水行
 *   - 线下：payments.change_type='回款' payment_method='线下' external_txn_id=银行回执 status='已支付' source_end='admin'
 *   - 储值卡：事务内锁 prepaid_cards.balance → 扣减 → INSERT card_transactions + payments.change_type='储值卡抵扣'
 *   - 基于 SUM(payments) 重算原单 paid_amount / prepaid_card_amount，付清翻 '已支付'
 *   - admin 端不接受线上支付（微信/支付宝），paymentMethod 限定 '线下' / '储值卡'
 *   - 幂等：本 ticket 简化，依赖前端防重复提交；'线下' external_txn_id 仅作审计凭证，不建唯一键
 *
 * 返回：{ success: true, data: { repaymentOrderId } } 或 { success: false, error: { code, message } }
 */
// 注：'use server' 文件不允许 export type/const 非函数（Next.js 限制）。
// 原 RecordPaymentResult 类型直接内联到 recordPayment 返回类型上。

export const recordPayment = withPermission(
  'sale_order:record_payment',
  async (
    session,
    input: {
  saleOrderId: string
  repayAmount: number
  paymentMethod: '线下' | '储值卡'
  externalTxnId?: string
  prepaidCardAmount?: number
  note?: string
    },
  ): Promise<
    | { success: true; data: { repaymentOrderId: string; refStatus: OrderStatus; refPaidAmount: string; refPrepaidCardAmount: string } }
    | { success: false; error: { code: string; message: string } }
  > => {
  // 入参归一 + 基本校验（Zod 在前端/Action 边界均可使用；此处做防御校验避免直接被调用时绕过）
  const saleOrderId = String(input.saleOrderId || '').trim()
  if (!saleOrderId) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: '订单号不能为空' } }
  }
  const paymentMethod = input.paymentMethod
  if (paymentMethod !== '线下' && paymentMethod !== '储值卡') {
    return { success: false, error: { code: 'INVALID_PARAMS', message: '支付方式仅支持 线下 / 储值卡' } }
  }

  const repayAmount = Math.round(Number(input.repayAmount || 0) * 100) / 100
  const prepaidCardAmount = Math.round(Number(input.prepaidCardAmount || 0) * 100) / 100
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

  // 储值卡付款方式下不应再传 repayAmount（语义是纯储值卡回款）
  if (paymentMethod === '储值卡' && repayAmount > 0) {
    return {
      success: false,
      error: {
        code: 'INVALID_PARAMS',
        message: '储值卡付款方式不应传回款金额（请通过储值卡抵扣字段传递）',
      },
    }
  }

  // 线下回款必须填 externalTxnId（作为审计凭证；银行回执号/扫码流水号）
  const externalTxnId = input.externalTxnId?.trim() || null
  if (paymentMethod === '线下' && repayAmount > 0 && !externalTxnId) {
    return {
      success: false,
      error: {
        code: 'INVALID_PARAMS',
        message: '线下回款必须填写外部交易号（银行回执号/流水号）',
      },
    }
  }

  // 事务：锁原单 + 校验 + 扣卡 + 插凭证单 + 插 payments + 重算原单
  let result: { repaymentOrderId: string; refStatus: OrderStatus; refPaidAmount: string; refPrepaidCardAmount: string }
  try {
    result = await db.transaction(async (tx) => {
      // 1) 锁原单 + 校验
      const lockRes = await tx.execute(sql`
        SELECT * FROM sale_orders WHERE sale_order_id = ${saleOrderId} FOR UPDATE
      `)
      const lockedRows = lockRes as unknown as any[]
      if (lockedRows.length === 0) {
        throw new ApiError('NOT_FOUND', 'REF_ORDER_NOT_FOUND: 原订单不存在')
      }
      const locked = lockedRows[0]

      // scope 保护：admin 跨门店免检；manager / finance 等 scoped 角色按 storeId 校验
      if (!isInScope(session, locked.store_id)) {
        throw new ApiError('PERMISSION_DENIED', 'OUT_OF_SCOPE: 该订单不在你的可见门店范围内')
      }

      if (!['部分支付', '待支付'].includes(locked.status)) {
        throw new Error(`INVALID_STATE:${locked.status}`)
      }

      if (!locked.client_user_id && prepaidCardAmount > 0) {
        throw new ApiError('CLIENT_NOT_REGISTERED', '顾客未注册小程序，无法使用储值卡抵扣')
      }

      // 2) 计算欠款：payable_amount - received（储值卡已抵扣部分不占欠款）
      // 2026-04-26 sale-order-domain-refactor：paid_amount 列已 DROP，改用 received
      const origTotal = Number(locked.total_amount || 0)
      const origPrepaidSnapshot = Number(locked.prepaid_card_amount || 0)
      const origPaid = Number(locked.received || 0)
      const origPayable = locked.payable_amount != null
        ? Number(locked.payable_amount)
        : Math.round((origTotal - origPrepaidSnapshot) * 100) / 100
      const remainingPayable = Math.round((origPayable - origPaid) * 100) / 100

      // 3) 超额校验
      if (totalThisTime > remainingPayable + 0.001) {
        throw new ApiError('CONFLICT', `OVERPAY:${remainingPayable.toFixed(2)}: 本次回款金额超过订单欠款`)
      }

      // 4) 生成 FY-HKD 凭证单号（advisory lock + 当日序号，前缀 FY-HKD-WX-YYMMDDNNNN）
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

      // 5) 储值卡抵扣：锁余额 + 扣减 + 写 card_transactions
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
        // ref_order_id 指向回款凭证单（避免幂等键冲突 — 原销售单上已有 create 时的扣卡引用）
        await tx.insert(cardTransactions).values({
          cardId,
          type: '扣款',
          amount: (-prepaidCardAmount).toFixed(2),
          refOrderId: repaymentOrderId,
        })
      }

      // 2026-04-26 sale-order-domain-refactor：
      //   不再 INSERT FY-HKD 回款单（saleOrderType='回款单' 已删除），
      //   "回款"语义完全由 sale_order_payments[change_type='回款'] 表达。
      //   repaymentOrderId 仍生成（FY-HKD 编号格式保留用作业务流水编号 / 操作日志主键）。
      const now = new Date()

      // 7) 向原销售单写 payments 流水
      //    - 线下现金/转账部分（repayAmount > 0）
      //    - 储值卡抵扣部分（prepaidCardAmount > 0）
      if (repayAmount > 0) {
        await tx.insert(saleOrderPayments).values({
          saleOrderId,
          changeType: '回款',
          amount: repayAmount.toFixed(2),
          paymentMethod,
          externalTxnId,
          status: '已支付',
          sourceEnd: 'admin',
          paidAt: now,
          operatorEmployeeId: session.employeeId,
          note: input.note?.trim() || '管理后台录入回款',
        })
      }
      if (prepaidCardAmount > 0) {
        await tx.insert(saleOrderPayments).values({
          saleOrderId,
          changeType: '储值卡抵扣',
          amount: prepaidCardAmount.toFixed(2),
          paymentMethod: '储值卡',
          externalTxnId: null,
          status: '已支付',
          sourceEnd: 'admin',
          paidAt: now,
          operatorEmployeeId: session.employeeId,
          note: '管理后台录入回款-储值卡抵扣',
        })
      }

      // 8) 重算原单 received / refunded_amount / prepaid_card_amount + status
      //    2026-04-26 sale-order-domain-refactor：paid_amount 列已 DROP，统一改用 received
      //    received            = Σ(amount WHERE status='已支付' AND change_type IN ('首次支付','回款','储值卡抵扣'))
      //                            ※ 与 staff confirmOffline / createRepayment 跨端字面对齐；
      //                              received 含储值卡抵扣，paid_sessions SQL settled = received - refunded 才能取到上限。
      //    refunded_amount     = -Σ(amount WHERE status='已支付' AND change_type='退款')
      //    prepaid_card_amount = Σ(amount WHERE status='已支付' AND change_type='储值卡抵扣')
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
      const targetStatus: OrderStatus = settled + 0.001 >= origTotal ? '已支付' : '部分支付'
      // paid_at 通过 sql 模板内插，必须传 ISO 字符串而非 Date — pg 对 Date 走 String() 会变成
      // "Sun May 17 2026 02:17:57 GMT+0800 (China Standard Time)" 这种 PG 不能解析的 locale 形式。
      const paidAtIso: string | null =
        targetStatus === '已支付'
          ? now.toISOString()
          : locked.paid_at
            ? typeof locked.paid_at === 'string'
              ? locked.paid_at
              : new Date(locked.paid_at).toISOString()
            : null
      const paidAtValue = paidAtIso

      const updRes = await tx.execute(sql`
        UPDATE sale_orders
        SET status = ${targetStatus},
            received = ${newReceived.toFixed(2)}::numeric,
            refunded_amount = ${newRefunded.toFixed(2)}::numeric,
            prepaid_card_amount = ${newPrepaid.toFixed(2)}::numeric,
            paid_at = ${paidAtValue},
            updated_at = NOW()
        WHERE sale_order_id = ${saleOrderId} AND status = ${locked.status}
      `)
      if ((updRes as any).rowCount === 0) {
        throw new ApiError('CONFLICT', 'CONCURRENT_CHANGED: 订单状态已变更，请刷新后重试')
      }

      // 9) customer_type 跃迁（仅在本次回款使订单结清，即翻为'已支付'时触发）
      // 与 staff confirmOffline / payNotify 三端对齐，保证 admin 财务补录回款
      // 也能驱动客户分类升级（修复 audit-15 P0-15-01 admin 三资金触发点跃迁缺失）。
      if (targetStatus === '已支付' && locked.client_user_id) {
        await recalcCustomerType(tx, locked.client_user_id)
      }

      // 10) 积分发放（修复 audit-15 P0-15-01：admin recordPayment 触发点缺失）
      //     无论本次是否结清都尝试 settle：链净额差值法天然幂等，
      //     可正确处理"分次回款只发增量积分"的场景
      await settlePointsSafe(tx, saleOrderId, 'admin.recordPayment')

      // 11) paid_sessions 重算（ticket 2026-05-19）：received 增长 → paid_sessions 单调上升
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
    // 状态机拒绝（保留原行为：行 1895 throw new Error(`INVALID_STATE:${locked.status}`) 仍生效）
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
    if (err?.code === '23505') {
      return { success: false, error: { code: 'ORDER_ID_CONFLICT', message: '订单号冲突，请稍后重试' } }
    }
    console.error('[recordPayment] unexpected error:', err)
    return { success: false, error: { code: 'UNKNOWN', message: `录入回款失败：${err?.message || String(err)}` } }
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

// ========== 小程序码生成 ==========

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

/** 生成客户端小程序码，返回 base64 data URL */
export const generateOrderWxacode = withPermission(
  'sale_order:list',
  async (_session, saleOrderId: string): Promise<{ success: boolean; dataUrl?: string; message?: string }> => {
  if (!WX_CLIENT_SECRET) {
    return { success: false, message: '未配置小程序密钥' }
  }

  try {
    let token = await getClientAccessToken()
    let buffer = await requestWxacode(token, saleOrderId, 'pagesOrder/scan-pay/scan-pay')

    // 响应小于 1000 字节可能是错误 JSON
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
        // 不是 JSON，当作正常图片
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
