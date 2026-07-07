


function calculateUnusedQuantity(item) {
  if (!item) return 0
  if (item.product_type === '疗程卡') {
    
    
    
    
    const remaining = Number(item.remaining_sessions || 0)
    if (item.paid_sessions == null) return remaining
    const consumed = Number(item.session_count || 0) - remaining
    return Math.max(0, Math.min(remaining, Number(item.paid_sessions) - consumed))
  }
  const quantity = Number(item.quantity || 0)
  const pickedUp = Number(item.picked_up_quantity || 0)
  return Math.max(0, quantity - pickedUp)
}


function buildRefundDetails(origItems, requestItems) {
  const itemMap = {}
  for (const i of origItems) itemMap[i.sale_item_id] = i

  const refundDetails = []
  let totalRefund = 0

  for (const req of requestItems) {
    const orig = itemMap[req.saleItemId]
    if (!orig) throw new Error(`INVALID_PARAMS: 明细 ${req.saleItemId} 不存在`)

    const maxUnused = calculateUnusedQuantity(orig)
    
    
    const requested =
      orig.product_type === '疗程卡' ? maxUnused : (Number(req.refundQuantity) || maxUnused)

    if (requested <= 0) {
      throw new Error(`INVALID_PARAMS: 明细 ${req.saleItemId} 退款数量必须大于 0`)
    }
    if (requested > maxUnused) {
      throw new Error(
        `INVALID_STATE: 明细 ${req.saleItemId} 可退数量 ${maxUnused} 不足 ${requested}`,
      )
    }

    const unitRealPrice = Number(orig.unit_real_price)
    const refundAmount = Math.round(unitRealPrice * requested * 100) / 100
    totalRefund += refundAmount

    
    const origServiceFee = Number(orig.service_fee || 0)
    const origQty = Number(orig.quantity) || 1
    const refundServiceFee = -Math.round((origServiceFee * requested / origQty) * 100) / 100

    
    
    
    const consumedQty = orig.product_type === '疗程卡'
      ? Number(orig.session_count || 0) - Number(orig.remaining_sessions || 0)
      : Number(orig.picked_up_quantity || 0)

    refundDetails.push({
      refSaleItemId: req.saleItemId,
      skuId: orig.sku_id,
      productName: orig.product_name,
      productType: orig.product_type,
      sessionCount: orig.session_count,
      unitPrice: Number(orig.unit_price),
      quantity: requested,
      unitRealPrice,
      refundAmount,
      salesCategory: orig.sales_category,
      serviceFee: refundServiceFee,
      isShengmei: orig.is_shengmei ?? null,
      isFullItemRefund: requested >= maxUnused && consumedQty <= 0,
    })
  }

  return {
    refundDetails,
    totalRefund: Math.round(totalRefund * 100) / 100,
  }
}


function capRefundAmounts(refundDetails, originalTotal, targetGross) {
  if (originalTotal <= 0 || targetGross >= originalTotal || refundDetails.length === 0) {
    return originalTotal
  }
  const ratio = targetGross / originalTotal
  let allocated = 0
  for (const d of refundDetails) {
    const v = Math.floor(d.refundAmount * ratio * 100) / 100
    d.refundAmount = v
    allocated += v
  }
  const remainder = Math.round((targetGross - allocated) * 100) / 100
  if (remainder !== 0) {
    let maxIdx = 0
    for (let i = 1; i < refundDetails.length; i += 1) {
      if (refundDetails[i].refundAmount > refundDetails[maxIdx].refundAmount) maxIdx = i
    }
    refundDetails[maxIdx].refundAmount = Math.round((refundDetails[maxIdx].refundAmount + remainder) * 100) / 100
  }
  return Math.round(targetGross * 100) / 100
}



function splitRefundByOriginalPayment(refundAmount, _origPrepaidCardAmount, _origTotalAmount) {
  return {
    refundByCard: 0,
    refundByOrigin: Math.round(refundAmount * 100) / 100,
  }
}


function resolveRefundPaymentMethod(_origPaymentMethod) {
  return '线下'
}


async function assertNoPendingRefund(client, saleOrderId) {
  if (!saleOrderId) return
  const r = await client.query(
    `SELECT 1 FROM sale_order_payments
      WHERE sale_order_id = $1 AND change_type = '退款' AND status = '待审批' LIMIT 1`,
    [saleOrderId],
  )
  const rows = r && r.rows ? r.rows : r
  if (rows && rows.length > 0) {
    throw new Error('INVALID_STATE: REFUND_IN_PROGRESS: 该订单退款审批中，暂不可操作')
  }
}


async function assertNoSettledRefund(client, saleOrderId) {
  if (!saleOrderId) return
  const r = await client.query(
    `SELECT 1 FROM sale_order_payments
      WHERE sale_order_id = $1 AND change_type = '退款' AND status = '已支付' LIMIT 1`,
    [saleOrderId],
  )
  const rows = r && r.rows ? r.rows : r
  if (rows && rows.length > 0) {
    throw new Error('INVALID_STATE: REFUND_SETTLED: 该订单已退款，营业额分配已锁定，不可再修改')
  }
}


async function assertNoSettledRefundForPayment(client, salePaymentId) {
  if (!salePaymentId) return
  const r = await client.query(
    `SELECT 1
       FROM sale_allocations sa
       JOIN sale_order_payments rsop ON rsop.id = sa.sale_payment_id
      WHERE sa.is_void = false
        AND sa.total_amount < 0
        AND rsop.change_type = '退款' AND rsop.status = '已支付'
        AND sa.sale_item_id IN (
          SELECT sale_item_id FROM sale_payment_allocatable_items WHERE sale_payment_id = $1
        )
      LIMIT 1`,
    [salePaymentId],
  )
  const rows = r && r.rows ? r.rows : r
  if (rows && rows.length > 0) {
    throw new Error('INVALID_STATE: REFUND_SETTLED: 该订单已退款，营业额分配已锁定，不可再修改')
  }
}


async function assertNoPendingRefundByServiceOrder(client, serviceOrderId) {
  if (!serviceOrderId) return
  const r = await client.query(
    `SELECT 1 FROM service_items sit
       JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
       JOIN sale_order_payments sop ON sop.sale_order_id = si.sale_order_id
      WHERE sit.service_order_id = $1 AND sop.change_type = '退款' AND sop.status = '待审批' LIMIT 1`,
    [serviceOrderId],
  )
  const rows = r && r.rows ? r.rows : r
  if (rows && rows.length > 0) {
    throw new Error('INVALID_STATE: REFUND_IN_PROGRESS: 关联订单退款审批中，暂不可确认')
  }
}


async function notifyRefundCreated(client, { paymentId, saleOrderId, storeId, operatorId, amount, customerName }) {
  if (!storeId) return
  const mgrs = await client.query(
    `SELECT DISTINCT pr.employee_id FROM permission_roles pr
       JOIN stores s ON s.org_node_id = pr.scope_id
      WHERE pr.role = 'manager' AND s.store_id = $1`,
    [storeId],
  )
  const rows = mgrs && mgrs.rows ? mgrs.rows : mgrs
  for (const m of rows || []) {
    if (m.employee_id === operatorId) continue 
    await client.query(
      `INSERT INTO messages (recipient_type, recipient_id, title, body, message_type, idempotency_key, ref_entity_type, ref_entity_id, created_at)
       VALUES ('员工', $1, $2, $3, 'order', $4, 'sale_order_payment', $5, NOW())
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
      [m.employee_id, '退款待审批', `${customerName || '顾客'}的订单 ${saleOrderId} 发起退款 ¥${amount}，请及时审批`, `refund-created-${paymentId}-${m.employee_id}`, String(paymentId)],
    )
  }
}


async function notifyRefundResult(client, { paymentId, saleOrderId, recipientEmployeeId, approved, reason, amount }) {
  if (!recipientEmployeeId) return
  const title = approved ? '退款已通过' : '退款已驳回'
  const body = approved
    ? `订单 ${saleOrderId} 退款 ¥${amount} 已审批通过`
    : `订单 ${saleOrderId} 退款申请被驳回${reason ? '：' + reason : ''}`
  const key = approved ? `refund-approved-${paymentId}` : `refund-rejected-${paymentId}`
  await client.query(
    `INSERT INTO messages (recipient_type, recipient_id, title, body, message_type, idempotency_key, ref_entity_type, ref_entity_id, created_at)
     VALUES ('员工', $1, $2, $3, 'order', $4, 'sale_order_payment', $5, NOW())
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
    [recipientEmployeeId, title, body, key, String(paymentId)],
  )
}

module.exports = {
  calculateUnusedQuantity,
  buildRefundDetails,
  capRefundAmounts,
  splitRefundByOriginalPayment,
  resolveRefundPaymentMethod,
  assertNoPendingRefund,
  assertNoSettledRefund,
  assertNoSettledRefundForPayment,
  assertNoPendingRefundByServiceOrder,
  notifyRefundCreated,
  notifyRefundResult,
}
