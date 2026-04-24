'use server'

import { db } from '@/db'
import { saleOrders, saleItems, saleOrderPayments } from '@db/order'
import { stores } from '@db/org'
import { staffWechatUsers } from '@db/user'
import { and, desc, asc, eq, inArray, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { revalidatePath } from 'next/cache'
import { getSession } from '@/lib/auth'
import { requirePermission, scopeCondition, isInScope } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'
import {
  buildRefundDetails,
  calculateUnusedQuantity,
  resolveRefundPaymentMethod,
  splitRefundByOriginalPayment,
  type RefundSourceItem,
} from '@/lib/refund'
import type {
  OrderStatus,
  PaymentMethod,
  ProductType,
  SaleItem,
  SaleOrder,
  SaleOrderPayment,
  SalesCategory,
} from '@/lib/types'

const opener = alias(staffWechatUsers, 'refund_opener')
const approver = alias(staffWechatUsers, 'refund_approver')

// ─────────────────────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────────────────────

export interface RefundableItem {
  saleItemId: string
  productName: string
  skuSpecName: string
  productType: ProductType | null
  unitRealPrice: number
  unusedQuantity: number
  refundableAmount: number
  quantity: number
  sessionCount: number | null
  remainingSessions: number | null
  pickedUpQuantity: number | null
}

export interface GetRefundableResult {
  items: RefundableItem[]
  origTotalAmount: number
  origPrepaidCardAmount: number
  origPaymentMethod: PaymentMethod
}

export type CreateRefundResult =
  | {
      success: true
      data: { refundOrderId: string; refundByCard: number; refundByOrigin: number; finalRefundAmount: number }
    }
  | { success: false; error: { code: string; message: string } }

export type ApproveRefundResult =
  | { success: true; data: { refundByCard: number; refundByOrigin: number } }
  | { success: false; error: { code: string; message: string } }

export type RejectRefundResult =
  | { success: true }
  | { success: false; error: { code: string; message: string } }

export interface RefundListItem {
  saleOrderId: string
  refSaleOrderId: string | null
  status: OrderStatus
  marketName: string
  storeId: string
  storeName: string | null
  customerName: string | null
  clientPhone: string | null
  totalAmount: string
  refundReason: string | null
  handlingFee: string | null
  rejectedReason: string | null
  openedBy: string | null
  openedByName: string | null
  approvedBy: string | null
  approvedByName: string | null
  approvedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface RefundListFilters {
  status?: '待审批' | '已支付' | '已关闭'
  page?: number
  pageSize?: number
}

export interface RefundListResult {
  refunds: RefundListItem[]
  total: number
  page: number
  pageSize: number
}

export interface RefundDetailResult {
  refund: RefundListItem & { items: SaleItem[] }
  origOrder: SaleOrder | null
  payments: SaleOrderPayment[]
}

// ─────────────────────────────────────────────────────────────────────────────
// getRefundable：查询原单可退明细
// ─────────────────────────────────────────────────────────────────────────────

export async function getRefundable(saleOrderId: string): Promise<GetRefundableResult> {
  const session = await getSession()
  requirePermission(session, 'sale_order:refund')

  const [order] = await db
    .select({
      storeId: saleOrders.storeId,
      status: saleOrders.status,
      saleOrderType: saleOrders.saleOrderType,
      totalAmount: saleOrders.totalAmount,
      prepaidCardAmount: saleOrders.prepaidCardAmount,
      paymentMethod: saleOrders.paymentMethod,
    })
    .from(saleOrders)
    .where(and(eq(saleOrders.saleOrderId, saleOrderId), scopeCondition(session, saleOrders.storeId)))
    .limit(1)

  if (!order) {
    throw new Error('INVALID_PARAMS: 原订单不存在或无权访问')
  }
  if (order.saleOrderType !== '销售单') {
    throw new Error('INVALID_STATE: 仅销售单支持退款')
  }
  if (!['已支付', '已完成', '部分支付'].includes(order.status)) {
    throw new Error(`INVALID_STATE: 当前状态"${order.status}"不允许退款`)
  }

  const rows = await db
    .select()
    .from(saleItems)
    .where(and(eq(saleItems.saleOrderId, saleOrderId), eq(saleItems.itemDirection, '购买')))

  const items: RefundableItem[] = rows.map((r) => {
    const src: RefundSourceItem = {
      sale_item_id: r.saleItemId,
      sku_id: r.skuId,
      product_name: r.productName,
      sku_spec_name: r.skuSpecName,
      product_type: r.productType as ProductType | null,
      session_count: r.sessionCount,
      remaining_sessions: r.remainingSessions,
      unit_price: r.unitPrice,
      quantity: r.quantity,
      unit_real_price: r.unitRealPrice,
      picked_up_quantity: r.pickedUpQuantity,
      sales_category: r.salesCategory as SalesCategory | null,
      service_fee: r.serviceFee,
    }
    const unused = calculateUnusedQuantity(src)
    const unitRealPrice = Number(r.unitRealPrice)
    const refundableAmount = Math.round(unitRealPrice * unused * 100) / 100

    return {
      saleItemId: r.saleItemId,
      productName: r.productName || '-',
      skuSpecName: r.skuSpecName || '',
      productType: r.productType as ProductType | null,
      unitRealPrice,
      unusedQuantity: unused,
      refundableAmount,
      quantity: r.quantity,
      sessionCount: r.sessionCount,
      remainingSessions: r.remainingSessions,
      pickedUpQuantity: r.pickedUpQuantity,
    }
  })

  return {
    items,
    origTotalAmount: Number(order.totalAmount),
    origPrepaidCardAmount: Number(order.prepaidCardAmount),
    origPaymentMethod: order.paymentMethod as PaymentMethod,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// createRefundOrder：创建退款单（凭证单 FY-TKD）
// ─────────────────────────────────────────────────────────────────────────────

export async function createRefundOrder(input: {
  refSaleOrderId: string
  items: Array<{ saleItemId: string; refundQuantity: number }>
  refundReason: string
  handlingFee?: number
}): Promise<CreateRefundResult> {
  const session = await getSession()
  requirePermission(session, 'sale_order:refund')

  const refSaleOrderId = String(input.refSaleOrderId || '').trim()
  if (!refSaleOrderId) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: '缺少原销售单号' } }
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: '退款明细不能为空' } }
  }
  const refundReason = String(input.refundReason || '').trim()
  if (!refundReason) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: '退款原因不能为空' } }
  }

  // 查原单 + scope 校验
  const [origOrder] = await db
    .select()
    .from(saleOrders)
    .where(and(eq(saleOrders.saleOrderId, refSaleOrderId), scopeCondition(session, saleOrders.storeId)))
    .limit(1)

  if (!origOrder) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: '原订单不存在或无权访问' } }
  }
  if (origOrder.saleOrderType !== '销售单') {
    return { success: false, error: { code: 'INVALID_STATE', message: '仅销售单支持退款' } }
  }
  if (!['已支付', '已完成', '部分支付'].includes(origOrder.status)) {
    return {
      success: false,
      error: { code: 'INVALID_STATE', message: `原订单状态"${origOrder.status}"不允许退款` },
    }
  }
  if (!isInScope(session, origOrder.storeId)) {
    return { success: false, error: { code: 'PERMISSION_DENIED', message: '无权操作该门店订单' } }
  }

  // in-flight 唯一性：同一原单仅允许一笔 '待审批' FY-TKD
  const inflight = await db
    .select({ saleOrderId: saleOrders.saleOrderId })
    .from(saleOrders)
    .where(
      and(
        eq(saleOrders.refSaleOrderId, refSaleOrderId),
        eq(saleOrders.saleOrderType, '退款单'),
        eq(saleOrders.status, '待审批'),
      ),
    )
    .limit(1)
  if (inflight.length > 0) {
    return { success: false, error: { code: 'CONFLICT', message: '存在未完结退款单，请先处理' } }
  }

  // 查原单明细
  const origRows = await db
    .select()
    .from(saleItems)
    .where(and(eq(saleItems.saleOrderId, refSaleOrderId), eq(saleItems.itemDirection, '购买')))

  const sourceItems: RefundSourceItem[] = origRows.map((r) => ({
    sale_item_id: r.saleItemId,
    sku_id: r.skuId,
    product_name: r.productName,
    sku_spec_name: r.skuSpecName,
    product_type: r.productType as ProductType | null,
    session_count: r.sessionCount,
    remaining_sessions: r.remainingSessions,
    unit_price: r.unitPrice,
    quantity: r.quantity,
    unit_real_price: r.unitRealPrice,
    picked_up_quantity: r.pickedUpQuantity,
    sales_category: r.salesCategory as SalesCategory | null,
    service_fee: r.serviceFee,
  }))

  let refundDetails: ReturnType<typeof buildRefundDetails>['refundDetails']
  let totalRefund: number
  try {
    const built = buildRefundDetails(sourceItems, input.items)
    refundDetails = built.refundDetails
    totalRefund = built.totalRefund
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.startsWith('INVALID_PARAMS:')) {
      return { success: false, error: { code: 'INVALID_PARAMS', message: msg.replace(/^INVALID_PARAMS:\s*/, '') } }
    }
    if (msg.startsWith('INVALID_STATE:')) {
      return { success: false, error: { code: 'INVALID_STATE', message: msg.replace(/^INVALID_STATE:\s*/, '') } }
    }
    return { success: false, error: { code: 'UNKNOWN', message: msg } }
  }

  const fee = Math.max(0, Number(input.handlingFee) || 0)
  const finalRefundAmount = Math.max(0, Math.round((totalRefund - fee) * 100) / 100)
  if (finalRefundAmount <= 0) {
    return { success: false, error: { code: 'INVALID_STATE', message: '无可退项' } }
  }

  const totalAmount = -finalRefundAmount

  const origPrepaidCardAmount = Number(origOrder.prepaidCardAmount || 0)
  const origTotalAmount = Number(origOrder.totalAmount || 0)
  const { refundByCard, refundByOrigin } = splitRefundByOriginalPayment(
    finalRefundAmount,
    origPrepaidCardAmount,
    origTotalAmount,
  )

  const refundPaymentMethod = resolveRefundPaymentMethod(origOrder.paymentMethod)

  let refundOrderId: string
  try {
    refundOrderId = await db.transaction(async (tx) => {
      // 生成 FY-TKD 订单号（advisory lock + 当日序号）
      const idRows = await tx.execute(sql`
        WITH lock AS (
          SELECT pg_advisory_xact_lock(hashtext('sale_order_id_gen'))
        )
        SELECT 'FY-TKD-WX-' || to_char(NOW(), 'YYMMDD') ||
          LPAD(
            (SELECT COALESCE(MAX(
              CAST(NULLIF(SUBSTRING(sale_order_id FROM '.{4}$'), '') AS INTEGER)
            ), 0) + 1
            FROM sale_orders
            WHERE sale_order_id LIKE 'FY-TKD-WX-' || to_char(NOW(), 'YYMMDD') || '%'
            )::TEXT, 4, '0'
          ) AS id
        FROM lock
      `)
      const id = (idRows as unknown as Array<{ id: string }>)[0]?.id
      if (!id) throw new Error('ORDER_ID_GEN_FAILED')

      const now = new Date()

      // 插入 FY-TKD 凭证单
      await tx.insert(saleOrders).values({
        saleOrderId: id,
        status: '待审批',
        saleOrderType: '退款单',
        documentType: origOrder.documentType as typeof saleOrders.$inferInsert['documentType'],
        refSaleOrderId: refSaleOrderId,
        marketName: origOrder.marketName,
        storeId: origOrder.storeId,
        saleOrderDatetime: now,
        clientUserId: origOrder.clientUserId,
        clientPhone: origOrder.clientPhone,
        customerName: origOrder.customerName,
        totalAmount: totalAmount.toFixed(2),
        prepaidCardAmount: '0',
        payableAmount: '0',
        paidAmount: '0',
        paymentMethod: origOrder.paymentMethod,
        openedBy: session.employeeId,
        refundReason,
        handlingFee: fee > 0 ? fee.toFixed(2) : null,
      })

      // 生成退款明细行 ID（与 staff 格式保持一致：XSLSH-WX-YYMMDDnnnn）
      const dateStr = formatYYMMDD(now)
      const maxRows = await tx.execute(sql`
        SELECT sale_item_id FROM sale_items
        WHERE sale_item_id LIKE ${'XSLSH-WX-' + dateStr + '%'}
        ORDER BY sale_item_id DESC LIMIT 1
      `)
      let seq = 1
      const maxArr = maxRows as unknown as Array<{ sale_item_id: string }>
      if (maxArr.length > 0) {
        seq = parseInt(maxArr[0].sale_item_id.slice(-4), 10) + 1
      }

      for (let i = 0; i < refundDetails.length; i++) {
        const d = refundDetails[i]
        const saleItemId = `XSLSH-WX-${dateStr}${String(seq + i).padStart(4, '0')}`
        await tx.insert(saleItems).values({
          saleItemId,
          saleOrderId: id,
          storeId: origOrder.storeId,
          itemDirection: '退出',
          refSaleItemId: d.refSaleItemId,
          skuId: d.skuId,
          productName: d.productName,
          skuSpecName: d.skuSpecName,
          productType: d.productType,
          sessionCount: d.sessionCount,
          unitPrice: d.unitPrice.toFixed(2),
          quantity: d.quantity,
          unitRealPrice: d.unitRealPrice.toFixed(2),
          saleAmount: (-d.refundAmount).toFixed(2),
          received: (-d.refundAmount).toFixed(2),
          salesCategory: d.salesCategory,
          serviceFee: (d.serviceFee || 0).toFixed(2),
        })
      }

      // 写 payments 退款行（挂在原销售单上，status='待支付' 待 approve 翻 '已支付'）
      const feeNote = fee > 0 ? `; fee=${fee}` : ''
      const paymentNote = `FY-TKD=${id}; reason=${refundReason}${feeNote}`

      if (refundByCard > 0) {
        await tx.insert(saleOrderPayments).values({
          saleOrderId: refSaleOrderId,
          changeType: '退款',
          amount: (-refundByCard).toFixed(2),
          paymentMethod: '储值卡',
          externalTxnId: null,
          status: '待支付',
          sourceEnd: 'admin',
          operatorEmployeeId: session.employeeId,
          note: paymentNote,
        })
      }
      if (refundByOrigin > 0) {
        await tx.insert(saleOrderPayments).values({
          saleOrderId: refSaleOrderId,
          changeType: '退款',
          amount: (-refundByOrigin).toFixed(2),
          paymentMethod: refundPaymentMethod,
          externalTxnId: null,
          status: '待支付',
          sourceEnd: 'admin',
          operatorEmployeeId: session.employeeId,
          note: paymentNote,
        })
      }

      return id
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg === 'ORDER_ID_GEN_FAILED') {
      return { success: false, error: { code: 'ORDER_ID_GEN_FAILED', message: '退款单号生成失败' } }
    }
    if ((err as { code?: string })?.code === '23505') {
      return { success: false, error: { code: 'ORDER_ID_CONFLICT', message: '订单号冲突，请稍后重试' } }
    }
    console.error('[createRefundOrder] unexpected error:', err)
    return { success: false, error: { code: 'UNKNOWN', message: '创建退款单失败，请稍后重试' } }
  }

  await logOperation(session, 'refund.create', 'sale_order', refundOrderId, {
    refSaleOrderId,
    finalRefundAmount: finalRefundAmount.toFixed(2),
    refundByCard: refundByCard.toFixed(2),
    refundByOrigin: refundByOrigin.toFixed(2),
    handlingFee: fee.toFixed(2),
    refundReason,
  })

  revalidatePath('/refunds')
  revalidatePath(`/orders/${refSaleOrderId}`)
  return {
    success: true,
    data: { refundOrderId, refundByCard, refundByOrigin, finalRefundAmount },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// approveRefund：审批退款单（幂等 + 扣减 + 储值卡回冲 + 翻 payments + 重算原单）
// ─────────────────────────────────────────────────────────────────────────────

export async function approveRefund(saleOrderId: string): Promise<ApproveRefundResult> {
  const session = await getSession()
  requirePermission(session, 'sale_order:refund')

  const id = String(saleOrderId || '').trim()
  if (!id) return { success: false, error: { code: 'INVALID_PARAMS', message: '缺少 saleOrderId' } }

  // 查询退款单
  const [refundOrder] = await db
    .select()
    .from(saleOrders)
    .where(
      and(
        eq(saleOrders.saleOrderId, id),
        eq(saleOrders.saleOrderType, '退款单'),
        eq(saleOrders.status, '待审批'),
        scopeCondition(session, saleOrders.storeId),
      ),
    )
    .limit(1)

  if (!refundOrder) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: '退款单不存在或状态不允许审批' } }
  }

  const refSaleOrderId = refundOrder.refSaleOrderId
  const now = new Date()

  // 读被退原单金额
  let origPrepaidCardAmount = 0
  let origTotalAmount = 0
  if (refSaleOrderId) {
    const [origRow] = await db
      .select({
        prepaidCardAmount: saleOrders.prepaidCardAmount,
        totalAmount: saleOrders.totalAmount,
      })
      .from(saleOrders)
      .where(eq(saleOrders.saleOrderId, refSaleOrderId))
      .limit(1)
    if (origRow) {
      origPrepaidCardAmount = Number(origRow.prepaidCardAmount || 0)
      origTotalAmount = Number(origRow.totalAmount || 0)
    }
  }

  const refundAmount = Math.abs(Number(refundOrder.totalAmount || 0))
  const { refundByCard, refundByOrigin } = splitRefundByOriginalPayment(
    refundAmount,
    origPrepaidCardAmount,
    origTotalAmount,
  )

  try {
    await db.transaction(async (tx) => {
      // 幂等哨兵：先翻转 FY-TKD 状态；rowCount=0 说明并发已处理
      const updRes = await tx.execute(sql`
        UPDATE sale_orders
           SET status = '已支付', paid_at = ${now}, approved_by = ${session.employeeId},
               approved_at = ${now}, allocation_status = '待分配',
               prepaid_card_amount = ${(-refundByCard).toFixed(2)}::numeric,
               paid_amount = ${(-refundByOrigin).toFixed(2)}::numeric,
               updated_at = ${now}
         WHERE sale_order_id = ${id} AND status = '待审批'
      `)
      if ((updRes as { rowCount?: number }).rowCount === 0) {
        throw new Error('CONCURRENT_CHANGED')
      }

      // 扣减原购买行 remaining_sessions（疗程卡）
      const refundItemRows = await tx.execute(sql`
        SELECT sale_item_id, ref_sale_item_id, quantity, session_count
        FROM sale_items
        WHERE sale_order_id = ${id} AND item_direction = '退出'
      `)
      const refundItemArr = refundItemRows as unknown as Array<{
        sale_item_id: string
        ref_sale_item_id: string | null
        quantity: number
        session_count: number | null
      }>
      for (const ri of refundItemArr) {
        if (ri.ref_sale_item_id && ri.session_count) {
          const sessRes = await tx.execute(sql`
            UPDATE sale_items
               SET remaining_sessions = remaining_sessions - ${ri.quantity},
                   updated_at = ${now}
             WHERE sale_item_id = ${ri.ref_sale_item_id}
               AND remaining_sessions >= ${ri.quantity}
          `)
          if ((sessRes as { rowCount?: number }).rowCount === 0) {
            throw new Error('INSUFFICIENT_SESSIONS')
          }
        }
      }

      // 储值卡部分：回冲余额 + INSERT card_transactions '充值'
      // 幂等守卫：ref_order_id=退款单ID + type='充值' 去重
      if (refundByCard > 0 && refundOrder.clientUserId) {
        const dupRes = await tx.execute(sql`
          SELECT 1 FROM card_transactions
          WHERE ref_order_id = ${id} AND type = '充值' LIMIT 1
        `)
        if ((dupRes as unknown as unknown[]).length === 0) {
          const newCardId = `FY-CARD-${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`
          const upsertRes = await tx.execute(sql`
            INSERT INTO prepaid_cards (card_id, user_id, balance, created_at, updated_at)
            VALUES (${newCardId}, ${refundOrder.clientUserId}, ${refundByCard.toFixed(2)}::numeric, NOW(), NOW())
            ON CONFLICT (user_id) DO UPDATE
              SET balance = prepaid_cards.balance + EXCLUDED.balance, updated_at = NOW()
            RETURNING card_id
          `)
          const cardId = (upsertRes as unknown as Array<{ card_id: string }>)[0]?.card_id
          if (!cardId) throw new Error('CARD_UPSERT_FAILED')

          await tx.execute(sql`
            INSERT INTO card_transactions (card_id, type, amount, ref_order_id, created_at)
            VALUES (${cardId}, '充值', ${refundByCard.toFixed(2)}::numeric, ${id}, NOW())
          `)
        }
      }

      // 翻转原销售单上的 payments 退款行 '待支付' → '已支付'
      if (refSaleOrderId) {
        await tx.execute(sql`
          UPDATE sale_order_payments
             SET status = '已支付', paid_at = ${now}
           WHERE sale_order_id = ${refSaleOrderId}
             AND change_type = '退款' AND status = '待支付'
             AND note LIKE ${'FY-TKD=' + id + '%'}
        `)

        // 重算原单 paid_amount / prepaid_card_amount
        const sumRes = await tx.execute(sql`
          SELECT
            COALESCE(SUM(CASE WHEN status = '已支付' AND change_type IN ('首次支付','回款','退款')
                              THEN amount::numeric ELSE 0 END), 0) AS new_paid,
            COALESCE(SUM(CASE WHEN status = '已支付' AND change_type = '储值卡抵扣'
                              THEN amount::numeric ELSE 0 END), 0) AS new_prepaid
          FROM sale_order_payments
          WHERE sale_order_id = ${refSaleOrderId}
        `)
        const sumRow = (sumRes as unknown as Array<{ new_paid: string | number; new_prepaid: string | number }>)[0]
        const newPaid = Math.round(Number(sumRow?.new_paid || 0) * 100) / 100
        const newPrepaid = Math.round(Number(sumRow?.new_prepaid || 0) * 100) / 100
        await tx.execute(sql`
          UPDATE sale_orders
             SET paid_amount = ${newPaid.toFixed(2)}::numeric,
                 prepaid_card_amount = ${newPrepaid.toFixed(2)}::numeric,
                 updated_at = ${now}
           WHERE sale_order_id = ${refSaleOrderId}
        `)
      }

      // 重算顾客历史消费档位 + 类型（与 staff 对齐，退款减少累计消费）
      if (refundOrder.clientUserId) {
        await refreshSpendingTierTx(tx, refundOrder.clientUserId)
      }
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg === 'CONCURRENT_CHANGED') {
      return {
        success: false,
        error: { code: 'CONCURRENT_CHANGED', message: '退款单状态已变更，请刷新后重试' },
      }
    }
    if (msg === 'INSUFFICIENT_SESSIONS') {
      return { success: false, error: { code: 'INSUFFICIENT_SESSIONS', message: '剩余次数不足，无法退款' } }
    }
    if (msg === 'CARD_UPSERT_FAILED') {
      return { success: false, error: { code: 'CARD_UPSERT_FAILED', message: '储值卡回冲失败' } }
    }
    console.error('[approveRefund] unexpected error:', err)
    return { success: false, error: { code: 'UNKNOWN', message: '审批退款失败，请稍后重试' } }
  }

  await logOperation(session, 'refund.approve', 'sale_order', id, {
    refSaleOrderId,
    refundByCard: refundByCard.toFixed(2),
    refundByOrigin: refundByOrigin.toFixed(2),
  })

  revalidatePath('/refunds')
  revalidatePath(`/refunds/${id}`)
  if (refSaleOrderId) revalidatePath(`/orders/${refSaleOrderId}`)
  return { success: true, data: { refundByCard, refundByOrigin } }
}

// ─────────────────────────────────────────────────────────────────────────────
// rejectRefund：驳回退款单
// ─────────────────────────────────────────────────────────────────────────────

export async function rejectRefund(
  saleOrderId: string,
  rejectedReason: string,
): Promise<RejectRefundResult> {
  const session = await getSession()
  requirePermission(session, 'sale_order:refund')

  const id = String(saleOrderId || '').trim()
  const reason = String(rejectedReason || '').trim()
  if (!id) return { success: false, error: { code: 'INVALID_PARAMS', message: '缺少 saleOrderId' } }
  if (!reason) return { success: false, error: { code: 'INVALID_PARAMS', message: '驳回原因不能为空' } }

  // 查询退款单 + scope
  const [refundRow] = await db
    .select({
      saleOrderId: saleOrders.saleOrderId,
      refSaleOrderId: saleOrders.refSaleOrderId,
    })
    .from(saleOrders)
    .where(
      and(
        eq(saleOrders.saleOrderId, id),
        eq(saleOrders.saleOrderType, '退款单'),
        eq(saleOrders.status, '待审批'),
        scopeCondition(session, saleOrders.storeId),
      ),
    )
    .limit(1)

  if (!refundRow) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: '退款单不存在或状态不允许驳回' } }
  }
  const refSaleOrderId = refundRow.refSaleOrderId

  try {
    await db.transaction(async (tx) => {
      const now = new Date()
      const updRes = await tx.execute(sql`
        UPDATE sale_orders
           SET status = '已关闭',
               rejected_reason = ${reason},
               approved_by = ${session.employeeId},
               approved_at = ${now},
               updated_at = ${now}
         WHERE sale_order_id = ${id}
           AND sale_order_type = '退款单'
           AND status = '待审批'
      `)
      if ((updRes as { rowCount?: number }).rowCount === 0) {
        throw new Error('CONCURRENT_CHANGED')
      }

      // 作废原单上的 payments 退款行
      if (refSaleOrderId) {
        await tx.execute(sql`
          UPDATE sale_order_payments
             SET status = '已作废'
           WHERE sale_order_id = ${refSaleOrderId}
             AND change_type = '退款' AND status = '待支付'
             AND note LIKE ${'FY-TKD=' + id + '%'}
        `)
      }
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg === 'CONCURRENT_CHANGED') {
      return {
        success: false,
        error: { code: 'CONCURRENT_CHANGED', message: '退款单状态已变更，请刷新后重试' },
      }
    }
    console.error('[rejectRefund] unexpected error:', err)
    return { success: false, error: { code: 'UNKNOWN', message: '驳回失败，请稍后重试' } }
  }

  await logOperation(session, 'refund.reject', 'sale_order', id, {
    refSaleOrderId,
    rejectedReason: reason,
  })

  revalidatePath('/refunds')
  revalidatePath(`/refunds/${id}`)
  if (refSaleOrderId) revalidatePath(`/orders/${refSaleOrderId}`)
  return { success: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// listRefunds：退款单列表（带状态筛选 + 分页）
// ─────────────────────────────────────────────────────────────────────────────

export async function listRefunds(filters: RefundListFilters = {}): Promise<RefundListResult> {
  const session = await getSession()
  requirePermission(session, 'sale_order:refund')

  const page = Math.max(1, filters.page || 1)
  const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? (filters.pageSize as number) : 20
  const offset = (page - 1) * pageSize

  const conditions: (SQL | undefined)[] = [
    eq(saleOrders.saleOrderType, '退款单'),
    scopeCondition(session, saleOrders.storeId),
  ]
  if (filters.status) {
    conditions.push(eq(saleOrders.status, filters.status))
  }
  const whereClause = and(...conditions)

  const [countRow] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(saleOrders)
    .where(whereClause)
  const total = countRow?.count ?? 0

  const rows = await db
    .select({
      refund: saleOrders,
      storeName: stores.storeName,
      openedByName: opener.name,
      approvedByName: approver.name,
    })
    .from(saleOrders)
    .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
    .leftJoin(opener, eq(saleOrders.openedBy, opener.employeeId))
    .leftJoin(approver, eq(saleOrders.approvedBy, approver.employeeId))
    .where(whereClause)
    // 默认排序：最近修改/审批的退款单浮顶（admin.sys.spec.md §5）
    .orderBy(desc(saleOrders.updatedAt), desc(saleOrders.createdAt))
    .limit(pageSize)
    .offset(offset)

  const refunds: RefundListItem[] = rows.map((r) => mapRefundRow(r))

  return { refunds, total, page, pageSize }
}

// ─────────────────────────────────────────────────────────────────────────────
// getRefundById：退款单详情
// ─────────────────────────────────────────────────────────────────────────────

export async function getRefundById(saleOrderId: string): Promise<RefundDetailResult | null> {
  const session = await getSession()
  requirePermission(session, 'sale_order:refund')

  const id = String(saleOrderId || '').trim()
  if (!id) return null

  const rows = await db
    .select({
      refund: saleOrders,
      storeName: stores.storeName,
      openedByName: opener.name,
      approvedByName: approver.name,
    })
    .from(saleOrders)
    .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
    .leftJoin(opener, eq(saleOrders.openedBy, opener.employeeId))
    .leftJoin(approver, eq(saleOrders.approvedBy, approver.employeeId))
    .where(
      and(
        eq(saleOrders.saleOrderId, id),
        eq(saleOrders.saleOrderType, '退款单'),
        scopeCondition(session, saleOrders.storeId),
      ),
    )
    .limit(1)

  if (rows.length === 0) return null
  const base = mapRefundRow(rows[0])

  // 退款明细行（item_direction='退出'）
  const itemRows = await db
    .select()
    .from(saleItems)
    .where(eq(saleItems.saleOrderId, id))

  const items: SaleItem[] = itemRows.map((ir) => ({
    saleItemId: ir.saleItemId,
    saleOrderId: ir.saleOrderId,
    itemDirection: ir.itemDirection as SaleItem['itemDirection'],
    refSaleItemId: ir.refSaleItemId,
    skuId: ir.skuId,
    sessionCount: ir.sessionCount,
    remainingSessions: ir.remainingSessions,
    unitPrice: ir.unitPrice,
    quantity: ir.quantity,
    unitRealPrice: ir.unitRealPrice,
    saleAmount: ir.saleAmount,
    received: ir.received,
    expireDate: ir.expireDate,
    remark: ir.remark,
    salesCategory: ir.salesCategory as SalesCategory | null,
    createdAt: ir.createdAt.toISOString(),
    updatedAt: ir.updatedAt.toISOString(),
    productName: ir.productName ?? undefined,
  }))

  // 原销售单（只读展示）
  let origOrder: SaleOrder | null = null
  if (base.refSaleOrderId) {
    const [origRow] = await db
      .select({
        order: saleOrders,
        storeName: stores.storeName,
      })
      .from(saleOrders)
      .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
      .where(eq(saleOrders.saleOrderId, base.refSaleOrderId))
      .limit(1)
    if (origRow) {
      const o = origRow.order
      origOrder = {
        saleOrderId: o.saleOrderId,
        status: o.status as OrderStatus,
        saleOrderType: o.saleOrderType as SaleOrder['saleOrderType'],
        documentType: o.documentType as SaleOrder['documentType'],
        refSaleOrderId: o.refSaleOrderId,
        marketName: o.marketName,
        storeId: o.storeId,
        saleOrderDatetime: o.saleOrderDatetime.toISOString(),
        clientUserId: o.clientUserId,
        clientPhone: o.clientPhone,
        customerName: o.customerName,
        totalAmount: o.totalAmount,
        prepaidCardAmount: o.prepaidCardAmount ?? '0',
        paidAmount: o.paidAmount ?? '0',
        paymentMethod: o.paymentMethod as PaymentMethod,
        openedBy: o.openedBy,
        preferredEmployeeId: o.preferredEmployeeId,
        paidAt: o.paidAt?.toISOString() ?? null,
        allocationStatus: o.allocationStatus as SaleOrder['allocationStatus'],
        couponId: o.couponId,
        couponDiscount: o.couponDiscount,
        remark: o.remark,
        createdAt: o.createdAt.toISOString(),
        updatedAt: o.updatedAt.toISOString(),
        storeName: origRow.storeName ?? undefined,
      }
    }
  }

  // 本次退款涉及的 payments 流水（挂在原销售单上，note LIKE FY-TKD=id%）
  let payments: SaleOrderPayment[] = []
  if (base.refSaleOrderId) {
    const payRows = await db
      .select({
        payment: saleOrderPayments,
        operatorName: staffWechatUsers.name,
      })
      .from(saleOrderPayments)
      .leftJoin(staffWechatUsers, eq(saleOrderPayments.operatorEmployeeId, staffWechatUsers.employeeId))
      .where(
        and(
          eq(saleOrderPayments.saleOrderId, base.refSaleOrderId),
          eq(saleOrderPayments.changeType, '退款'),
          sql`${saleOrderPayments.note} LIKE ${'FY-TKD=' + id + '%'}`,
        ),
      )
      // 例外：详情页支付流水按创建时间正序（按先后顺序阅读）
      .orderBy(asc(saleOrderPayments.createdAt))

    payments = payRows.map((r) => ({
      id: r.payment.id,
      saleOrderId: r.payment.saleOrderId,
      changeType: r.payment.changeType as SaleOrderPayment['changeType'],
      amount: r.payment.amount,
      paymentMethod: r.payment.paymentMethod as SaleOrderPayment['paymentMethod'],
      externalTxnId: r.payment.externalTxnId,
      status: r.payment.status as SaleOrderPayment['status'],
      sourceEnd: r.payment.sourceEnd as SaleOrderPayment['sourceEnd'],
      operatorEmployeeId: r.payment.operatorEmployeeId,
      note: r.payment.note,
      createdAt: r.payment.createdAt.toISOString(),
      paidAt: r.payment.paidAt?.toISOString() ?? null,
      operatorName: r.operatorName ?? null,
    }))
  }

  return {
    refund: { ...base, items },
    origOrder,
    payments,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部工具
// ─────────────────────────────────────────────────────────────────────────────

function mapRefundRow(r: {
  refund: typeof saleOrders.$inferSelect
  storeName: string | null
  openedByName: string | null
  approvedByName: string | null
}): RefundListItem {
  return {
    saleOrderId: r.refund.saleOrderId,
    refSaleOrderId: r.refund.refSaleOrderId,
    status: r.refund.status as OrderStatus,
    marketName: r.refund.marketName,
    storeId: r.refund.storeId,
    storeName: r.storeName,
    customerName: r.refund.customerName,
    clientPhone: r.refund.clientPhone,
    totalAmount: r.refund.totalAmount,
    refundReason: r.refund.refundReason,
    handlingFee: r.refund.handlingFee,
    rejectedReason: r.refund.rejectedReason,
    openedBy: r.refund.openedBy,
    openedByName: r.openedByName,
    approvedBy: r.refund.approvedBy,
    approvedByName: r.approvedByName,
    approvedAt: r.refund.approvedAt?.toISOString() ?? null,
    createdAt: r.refund.createdAt.toISOString(),
    updatedAt: r.refund.updatedAt.toISOString(),
  }
}

function formatYYMMDD(d: Date): string {
  const yy = String(d.getFullYear() % 100).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yy}${mm}${dd}`
}

/**
 * 重算顾客历史消费档位（事务内调用，退款会减少累计消费）
 *
 * 与 staff refreshSpendingTier 对齐；'1990-1W' 下界走 system_configs.new_member_threshold。
 * 若读取配置失败则 fallback 到 1990 固定值（降级策略）。
 */
async function refreshSpendingTierTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  clientUserId: string,
): Promise<void> {
  if (!clientUserId) return

  // 从 system_configs 读取 new_member_threshold（保持与 staff/admin 其他路径一致）
  let threshold = 1990
  try {
    const cfgRows = await tx.execute(sql`
      SELECT value FROM system_configs WHERE key = 'new_member_threshold' LIMIT 1
    `)
    const first = (cfgRows as unknown as Array<{ value: string | number }>)[0]
    if (first?.value != null) {
      const v = Number(first.value)
      if (Number.isFinite(v) && v > 0) threshold = v
    }
  } catch {
    // 配置读取失败时使用默认值
  }

  await tx.execute(sql`
    UPDATE client_wechat_users
       SET spending_tier = CASE
         WHEN t.total >= 100000 THEN '10W+'
         WHEN t.total >= 60000  THEN '6-10W'
         WHEN t.total >= 30000  THEN '3-6W'
         WHEN t.total >= 10000  THEN '1-3W'
         WHEN t.total >= ${threshold} THEN '1990-1W'
         ELSE '<1990'
       END::spending_tier,
       updated_at = NOW()
       FROM (
         SELECT COALESCE(SUM(total_amount), 0) AS total
         FROM sale_orders
         WHERE client_user_id = ${clientUserId}
           AND status IN ('已支付', '已完成')
       ) t
     WHERE user_id = ${clientUserId}
  `)
}

// ─────────────────────────────────────────────────────────────────────────────
// 避免未使用类型警告
// ─────────────────────────────────────────────────────────────────────────────
void inArray
