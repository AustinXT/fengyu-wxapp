

import { sql } from 'drizzle-orm'
import type { db } from '@/db'
import { rowsAffected } from '@/lib/pg-rows'

export type TransactionLike = Parameters<Parameters<typeof db.transaction>[0]>[0]


type SqlExecutor = Pick<typeof db, 'execute'> | TransactionLike


export async function hasPendingRefund(executor: SqlExecutor, saleOrderId: string): Promise<boolean> {
  if (!saleOrderId) return false
  const r = await executor.execute(sql`
    SELECT 1 FROM sale_order_payments
    WHERE sale_order_id = ${saleOrderId} AND change_type = '退款' AND status = '待审批' LIMIT 1
  `)
  return (r as unknown as unknown[]).length > 0
}


export async function hasSettledRefund(executor: SqlExecutor, saleOrderId: string): Promise<boolean> {
  if (!saleOrderId) return false
  const r = await executor.execute(sql`
    SELECT 1 FROM sale_order_payments
    WHERE sale_order_id = ${saleOrderId} AND change_type = '退款' AND status = '已支付' LIMIT 1
  `)
  return (r as unknown as unknown[]).length > 0
}


export async function hasSettledRefundForPayment(
  executor: SqlExecutor,
  salePaymentId: number | string,
): Promise<boolean> {
  if (!salePaymentId) return false
  const r = await executor.execute(sql`
    SELECT 1
    FROM sale_allocations sa
    JOIN sale_order_payments rsop ON rsop.id = sa.sale_payment_id
    WHERE sa.is_void = false
      AND sa.total_amount < 0
      AND rsop.change_type = '退款' AND rsop.status = '已支付'
      AND sa.sale_item_id IN (
        SELECT sale_item_id FROM sale_payment_allocatable_items WHERE sale_payment_id = ${salePaymentId}
      )
    LIMIT 1
  `)
  return (r as unknown as unknown[]).length > 0
}


export async function hasPendingRefundByServiceOrder(
  executor: SqlExecutor,
  serviceOrderId: string,
): Promise<boolean> {
  if (!serviceOrderId) return false
  const r = await executor.execute(sql`
    SELECT 1 FROM service_items sit
      JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
      JOIN sale_order_payments sop ON sop.sale_order_id = si.sale_order_id
     WHERE sit.service_order_id = ${serviceOrderId} AND sop.change_type = '退款' AND sop.status = '待审批' LIMIT 1
  `)
  return (r as unknown as unknown[]).length > 0
}


export async function notifyRefundCreated(
  executor: SqlExecutor,
  p: { paymentId: number; saleOrderId: string; storeId: string | null; operatorId: string | null; amount: number; customerName: string | null },
): Promise<void> {
  if (!p.storeId) return
  const mgrs = await executor.execute(sql`
    SELECT DISTINCT pr.employee_id FROM permission_roles pr
      JOIN stores s ON s.org_node_id = pr.scope_id
     WHERE pr.role = 'manager' AND s.store_id = ${p.storeId}
  `)
  for (const m of mgrs as unknown as Array<{ employee_id: string }>) {
    if (m.employee_id === p.operatorId) continue
    await executor.execute(sql`
      INSERT INTO messages (recipient_type, recipient_id, title, body, message_type, idempotency_key, ref_entity_type, ref_entity_id, created_at)
      VALUES ('员工', ${m.employee_id}, '退款待审批', ${`${p.customerName || '顾客'}的订单 ${p.saleOrderId} 发起退款 ¥${p.amount}，请及时审批`}, 'order', ${`refund-created-${p.paymentId}-${m.employee_id}`}, 'sale_order_payment', ${String(p.paymentId)}, NOW())
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    `)
  }
}


export async function notifyRefundResult(
  executor: SqlExecutor,
  p: { paymentId: number; saleOrderId: string; recipientEmployeeId: string | null; approved: boolean; reason?: string; amount: number },
): Promise<void> {
  if (!p.recipientEmployeeId) return
  const title = p.approved ? '退款已通过' : '退款已驳回'
  const body = p.approved
    ? `订单 ${p.saleOrderId} 退款 ¥${p.amount} 已审批通过`
    : `订单 ${p.saleOrderId} 退款申请被驳回${p.reason ? '：' + p.reason : ''}`
  const key = p.approved ? `refund-approved-${p.paymentId}` : `refund-rejected-${p.paymentId}`
  await executor.execute(sql`
    INSERT INTO messages (recipient_type, recipient_id, title, body, message_type, idempotency_key, ref_entity_type, ref_entity_id, created_at)
    VALUES ('员工', ${p.recipientEmployeeId}, ${title}, ${body}, 'order', ${key}, 'sale_order_payment', ${String(p.paymentId)}, NOW())
    ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
  `)
}

export interface CascadeRefundItem {
  saleItemId: string
  
  sessionCount: number | null
  
  refundAmount: number | null
  
  isFullItemRefund: boolean
}

export interface CascadeRefundParams {
  
  saleOrderId: string
  
  refundPaymentId: number
  
  items: CascadeRefundItem[]
  
  isWholeOrderRefund: boolean
  
  refundReason: string
}

export interface CascadeRefundResult {
  voidedAllocations: number
  voidedCommissions: number
  refundedCoupons: number
  reversedPoints: number
  rolledBackPickups: number
}

export async function cascadeRefund(
  tx: TransactionLike,
  params: CascadeRefundParams,
): Promise<CascadeRefundResult> {
  const { saleOrderId, refundPaymentId, items, isWholeOrderRefund, refundReason } = params
  const reason = `退款审批通过：${refundReason ?? ''}`.slice(0, 500)

  
  let effItems = Array.isArray(items) ? items.filter((it) => it && it.saleItemId) : []
  let wholeOrder = !!isWholeOrderRefund
  if (effItems.length === 0) {
    const r = await tx.execute(sql`
      SELECT sale_item_id FROM sale_items WHERE sale_order_id = ${saleOrderId} AND item_direction = '购买'
    `)
    const rows = (r as unknown as Array<{ sale_item_id: string }>) ?? []
    effItems = rows.map((x) => ({ saleItemId: x.sale_item_id, sessionCount: null, refundAmount: null, isFullItemRefund: true }))
    wholeOrder = true
  }

  
  const fullItemIds = effItems.filter((it) => it.isFullItemRefund).map((it) => it.saleItemId)

  
  
  
  
  
  let voidedAllocations = 0
  for (const it of effItems) {
    const refundAmt = Number(it.refundAmount || 0)
    if (refundAmt <= 0) continue
    const allocRows = (await tx.execute(sql`
      SELECT employee_id, role_type,
             MAX(allocation_ratio) AS ratio,
             MAX(department_name) AS dept,
             SUM(total_amount::numeric) AS sum_total,
             MAX(commission_rate) AS rate,
             COALESCE(SUM(commission_amount::numeric), 0) AS sum_comm
      FROM sale_allocations
      WHERE sale_item_id = ${it.saleItemId} AND is_void = false AND total_amount > 0
      GROUP BY employee_id, role_type
    `)) as unknown as Array<{
      employee_id: string; role_type: string; ratio: string
      dept: string | null; sum_total: string; rate: string | null; sum_comm: string
    }>
    if (allocRows.length === 0) continue
    const baseCents = allocRows.reduce((s, r) => s + Math.round(Number(r.sum_total) * 100), 0)
    if (baseCents <= 0) continue
    const targetCents = Math.min(Math.round(refundAmt * 100), baseCents)
    
    const parts = allocRows.map((r) => {
      const wCents = Math.round(Number(r.sum_total) * 100)
      const exact = (targetCents * wCents) / baseCents
      const floorC = Math.floor(exact)
      return { r, cents: floorC, frac: exact - floorC }
    })
    const rem = targetCents - parts.reduce((s, p) => s + p.cents, 0)
    parts.sort((a, b) => b.frac - a.frac)
    for (let i = 0; i < rem; i++) parts[i].cents += 1
    for (const p of parts) {
      if (p.cents <= 0) continue
      const voidTotal = p.cents / 100
      const sumTotal = Number(p.r.sum_total)
      const sumComm = Number(p.r.sum_comm || 0)
      
      const voidComm = sumTotal > 0 ? Math.round((sumComm * voidTotal) / sumTotal * 100) / 100 : 0
      await tx.execute(sql`
        INSERT INTO sale_allocations
          (sale_item_id, employee_id, role_type, department_name, allocation_ratio,
           total_amount, commission_rate, commission_amount, sale_payment_id, is_void, created_at, updated_at)
        VALUES (${it.saleItemId}, ${p.r.employee_id}, ${p.r.role_type}, ${p.r.dept ?? null}, ${p.r.ratio},
                ${(-voidTotal).toFixed(2)}, ${p.r.rate ?? null}, ${(-voidComm).toFixed(2)}, ${refundPaymentId}, false, NOW(), NOW())
        ON CONFLICT (sale_item_id, employee_id, role_type, sale_payment_id) WHERE is_void = false DO NOTHING
      `)
      voidedAllocations += 1
    }
  }

  
  let voidedCommissions = 0
  if (fullItemIds.length > 0) {
    const res = await tx.execute(sql`
      UPDATE service_commissions
         SET voided_at = NOW(),
             voided_reason = ${reason},
             is_void = true,
             updated_at = NOW()
       WHERE service_item_id IN (
               SELECT si.service_item_id
               FROM service_items si
               WHERE si.sale_item_id IN (${sql.join(fullItemIds.map((id) => sql`${id}`), sql`, `)})
             )
         AND voided_at IS NULL
    `)
    voidedCommissions = rowsAffected(res)
  }

  
  let refundedCoupons = 0
  if (wholeOrder) {
    const res = await tx.execute(sql`
      UPDATE user_coupons
         SET status = '未使用',
             used_at = NULL,
             used_sale_order_id = NULL,
             updated_at = NOW()
       WHERE used_sale_order_id = ${saleOrderId}
         AND status = '已使用'
         AND (expire_at IS NULL OR expire_at > NOW())
    `)
    refundedCoupons = rowsAffected(res)
  }

  
  let reversedPoints = 0
  {
    const giftRes = await tx.execute(sql`
      SELECT COALESCE(SUM(amount), 0) AS g, MIN(user_id) AS user_id
      FROM point_transactions
      WHERE ref_order_id = ${saleOrderId}
        AND type IN ('消费赠送', '回款赠送', '获取')
        AND amount > 0
    `)
    const giftRow = (giftRes as unknown as Array<{ g: unknown; user_id: unknown }>)[0]
    const grantedTotal = Number(giftRow?.g ?? 0)
    const pointUserId = giftRow?.user_id != null ? String(giftRow.user_id) : null

    if (grantedTotal > 0 && pointUserId) {
      const orderRes = await tx.execute(sql`
        SELECT received, COALESCE(refunded_amount, 0) AS refunded
        FROM sale_orders
        WHERE sale_order_id = ${saleOrderId}
      `)
      const orderRow = (orderRes as unknown as Array<{ received: unknown; refunded: unknown }>)[0]
      const received = Number(orderRow?.received ?? 0)
      const refunded = Number(orderRow?.refunded ?? 0)
      const target = received > 0 ? Math.round((grantedTotal * refunded) / received) : grantedTotal
      await tx.execute(sql`
        INSERT INTO point_transactions (
          user_id, ref_order_id, type, amount, created_at
        )
        VALUES (${pointUserId}, ${saleOrderId}, '消费冲销', ${-target}, NOW())
        ON CONFLICT (user_id, ref_order_id, type)
          WHERE ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销')
        DO UPDATE SET amount = EXCLUDED.amount
      `)
      reversedPoints = target
      await tx.execute(sql`
        UPDATE client_wechat_users c
           SET points_balance = COALESCE((
                 SELECT SUM(pt.amount) FROM point_transactions pt WHERE pt.user_id = c.user_id
               ), 0),
               points_updated_at = NOW(),
               updated_at = NOW()
         WHERE c.user_id = ${pointUserId}
      `)
    }
  }

  
  
  
  
  
  
  
  let rolledBackPickups = 0
  for (const it of effItems) {
    const qty = it.sessionCount && Number(it.sessionCount) > 0 ? Number(it.sessionCount) : null
    if (!qty) continue
    const res = await tx.execute(sql`
      UPDATE sale_items
         SET picked_up_quantity = LEAST(quantity, COALESCE(picked_up_quantity, 0) + ${qty}),
             updated_at = NOW()
       WHERE sale_item_id = ${it.saleItemId}
         AND product_type = '家居产品'
    `)
    rolledBackPickups += rowsAffected(res)
  }

  return {
    voidedAllocations,
    voidedCommissions,
    refundedCoupons,
    reversedPoints,
    rolledBackPickups,
  }
}
