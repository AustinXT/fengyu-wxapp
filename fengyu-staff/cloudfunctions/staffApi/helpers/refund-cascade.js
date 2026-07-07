
async function cascadeRefund(client, params) {
  const { saleOrderId, refundPaymentId, items, isWholeOrderRefund, refundReason } = params || {}
  if (!saleOrderId) {
    throw new Error('INVALID_PARAMS: cascadeRefund 缺少 saleOrderId')
  }

  const voidedReason = refundReason
    ? `退款审批通过：${String(refundReason).slice(0, 200)}`
    : '退款审批通过'
  const now = new Date()

  
  let effItems = Array.isArray(items) ? items.filter((it) => it && it.saleItemId) : []
  let wholeOrder = !!isWholeOrderRefund
  if (effItems.length === 0) {
    const r = await client.query(
      `SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1 AND item_direction = '购买'`,
      [saleOrderId],
    )
    effItems = r.rows.map((x) => ({ saleItemId: x.sale_item_id, sessionCount: null, refundAmount: null, isFullItemRefund: true }))
    wholeOrder = true
  }

  
  const fullItemIds = effItems.filter((it) => it.isFullItemRefund).map((it) => it.saleItemId)

  
  
  
  
  
  let voidedAllocations = 0
  for (const it of effItems) {
    const refundAmt = Number(it.refundAmount || 0)
    if (refundAmt <= 0) continue
    const allocRows = (await client.query(
      `SELECT employee_id, role_type,
              MAX(allocation_ratio) AS ratio,
              MAX(department_name) AS dept,
              SUM(total_amount::numeric) AS sum_total,
              MAX(commission_rate) AS rate,
              COALESCE(SUM(commission_amount::numeric), 0) AS sum_comm
         FROM sale_allocations
        WHERE sale_item_id = $1 AND is_void = false AND total_amount > 0
        GROUP BY employee_id, role_type`,
      [it.saleItemId],
    )).rows
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
      await client.query(
        `INSERT INTO sale_allocations
           (sale_item_id, employee_id, role_type, department_name, allocation_ratio,
            total_amount, commission_rate, commission_amount, sale_payment_id, is_void, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, $10, $10)
         ON CONFLICT (sale_item_id, employee_id, role_type, sale_payment_id) WHERE is_void = false DO NOTHING`,
        [it.saleItemId, p.r.employee_id, p.r.role_type, p.r.dept, p.r.ratio,
         (-voidTotal).toFixed(2), p.r.rate, (-voidComm).toFixed(2), refundPaymentId, now],
      )
      voidedAllocations += 1
    }
  }

  
  let voidedCommissions = 0
  if (fullItemIds.length > 0) {
    const commRes = await client.query(
      `UPDATE service_commissions sc
          SET is_void = true, voided_at = $1, voided_reason = $2, updated_at = $1
         FROM service_items sit
        WHERE sc.service_item_id = sit.service_item_id
          AND sit.sale_item_id = ANY($3)
          AND sc.is_void = false`,
      [now, voidedReason, fullItemIds],
    )
    voidedCommissions = commRes.rowCount || 0
  }

  
  let refundedCoupons = 0
  if (wholeOrder) {
    const couponRes = await client.query(
      `UPDATE user_coupons
          SET status = '未使用', used_at = NULL, used_sale_order_id = NULL
        WHERE used_sale_order_id = $1
          AND status = '已使用'
          AND (expire_at IS NULL OR expire_at > NOW())`,
      [saleOrderId],
    )
    refundedCoupons = couponRes.rowCount || 0
  }

  
  let reversedPoints = 0
  let pointsBalanceUpdated = false
  const giftRes = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS g, MIN(user_id) AS user_id
       FROM point_transactions
      WHERE ref_order_id = $1
        AND type IN ('消费赠送', '回款赠送', '获取')
        AND amount > 0`,
    [saleOrderId],
  )
  const grantedTotal = Number(giftRes.rows[0]?.g || 0)
  const pointUserId = giftRes.rows[0]?.user_id || null
  if (grantedTotal > 0 && pointUserId) {
    const orderRes = await client.query(
      `SELECT received, COALESCE(refunded_amount, 0) AS refunded
         FROM sale_orders
        WHERE sale_order_id = $1`,
      [saleOrderId],
    )
    const received = Number(orderRes.rows[0]?.received || 0)
    const refunded = Number(orderRes.rows[0]?.refunded || 0)
    const target = received > 0 ? Math.round((grantedTotal * refunded) / received) : grantedTotal
    await client.query(
      `INSERT INTO point_transactions
         (user_id, ref_order_id, type, amount, created_at)
       VALUES ($1, $2, '消费冲销', $3, $4)
       ON CONFLICT (user_id, ref_order_id, type)
         WHERE ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销')
       DO UPDATE SET amount = EXCLUDED.amount`,
      [pointUserId, saleOrderId, -target, now],
    )
    reversedPoints = target
    await client.query(
      `UPDATE client_wechat_users
          SET points_balance = COALESCE((
                SELECT SUM(amount) FROM point_transactions WHERE user_id = $1
              ), 0),
              points_updated_at = $2,
              updated_at = $2
        WHERE user_id = $1`,
      [pointUserId, now],
    )
    pointsBalanceUpdated = true
  }

  
  
  
  
  
  
  
  let rolledBackPickups = 0
  for (const it of effItems) {
    const qty = it.sessionCount && Number(it.sessionCount) > 0 ? Number(it.sessionCount) : null
    if (!qty) continue
    const pickupRes = await client.query(
      `UPDATE sale_items
          SET picked_up_quantity = LEAST(quantity, COALESCE(picked_up_quantity, 0) + $1),
              updated_at = $2
        WHERE sale_item_id = $3
          AND product_type = '家居产品'`,
      [qty, now, it.saleItemId],
    )
    rolledBackPickups += pickupRes.rowCount || 0
  }

  return {
    voidedAllocations,
    voidedCommissions,
    refundedCoupons,
    reversedPoints,
    pointsBalanceUpdated,
    rolledBackPickups,
  }
}

module.exports = { cascadeRefund }
