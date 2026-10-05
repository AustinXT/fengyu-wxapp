/**
 * 在线渠道下单前的入会预演：复用实际 receipt 分摊与 #524 分类 SQL。
 * 只在本地 SAVEPOINT 临时更新订单/行级实收，finally 回滚；不写款项、卡、券、积分或渠道意图。
 * 成功支付回调不使用此守护，既有渠道意图优先复用。
 */
const { previewPaymentAllocatables } = require('./payment-allocatable')
const { SALE_ITEMS_RECEIVED_ALLOC_SQL, RECEIVED_REFUNDED_DEDUCT_SQL } = require('./paid-sessions')
const { getPerItemRefundedMap, computeRefundAwareDirectedItems } = require('./per-item-refund')
const { assertMembershipBinding } = require('./membership-binding')

async function assertOnlineMembershipBinding(client, { saleOrderId, clientUserId, cashAmount, cardAmount, payableAmount, threshold, customerTypeCte }) {
  const orderResult = await client.query(
    'SELECT sale_order_type, legacy_source FROM sale_orders WHERE sale_order_id = $1', [saleOrderId],
  )
  const orderType = orderResult.rows[0]?.sale_order_type
  if (!['销售单', '转换单'].includes(orderType)) return
  const paid = await client.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE status = '已支付' AND change_type IN ('首次支付','回款','退款')), 0) AS cash_paid,
            COALESCE(SUM(amount) FILTER (WHERE status = '已支付' AND change_type IN ('首次支付','回款','储值卡抵扣')), 0) AS received
       FROM sale_order_payments WHERE sale_order_id = $1`, [saleOrderId],
  )
  const fullyPaid = Number(paid.rows[0]?.cash_paid || 0) + cashAmount + 0.001 >= payableAmount
  const eventAmount = Math.round((cashAmount + cardAmount) * 100) / 100
  const newReceived = Math.round((Number(paid.rows[0]?.received || 0) + eventAmount) * 100) / 100
  // 与 payNotify 对齐：仅全额分支使用退款后的定向分摊，部分支付用普通 capture。
  const items = await client.query(
    `SELECT sale_item_id, sale_amount::numeric AS sale_amount, received::numeric AS received
       FROM sale_items WHERE sale_order_id = $1 AND item_direction = '购买'`, [saleOrderId],
  )
  const refundMap = await getPerItemRefundedMap(client, saleOrderId)
  const directedItems = fullyPaid ? computeRefundAwareDirectedItems(items.rows, refundMap) : null
  let qualifies = false
  await client.query('SAVEPOINT membership_payment_preview')
  try {
    const update = await client.query(
      `UPDATE sale_orders SET status = $4::order_status, received = $2, client_user_id = $3 WHERE sale_order_id = $1 AND status IN ('待支付','部分支付')`,
      [saleOrderId, newReceived, clientUserId, fullyPaid ? '已支付' : '部分支付'],
    )
    if (update.rowCount !== 1) throw new Error('CONFLICT: 订单状态已变化，请刷新后重试')
    // 转换分摊读取入账后的订单 received，必须在临时 UPDATE 之后预演。
    const planned = await previewPaymentAllocatables(client, { saleOrderId, eventAmount, directedItems })
    const coverage = await client.query(
      `SELECT COALESCE(SUM(spir.amount::numeric), 0) AS positive
         FROM sale_payment_item_receipts spir JOIN sale_order_payments sop ON sop.id = spir.sale_payment_id
        WHERE spir.sale_order_id = $1 AND sop.status = '已支付'
          AND sop.change_type IN ('首次支付','回款','储值卡抵扣')`, [saleOrderId],
    )
    const positive = Number(coverage.rows[0]?.positive || 0) + planned.reduce((sum, item) => sum + item.amount, 0)
    if (orderType === '销售单' && positive > 0 && positive >= newReceived - 0.01) {
      await client.query(
        `UPDATE sale_items si SET received = GREATEST(0,
           COALESCE((SELECT SUM(spir.amount::numeric) FROM sale_payment_item_receipts spir
                     JOIN sale_order_payments sop ON sop.id = spir.sale_payment_id
                    WHERE spir.sale_order_id = $1 AND spir.sale_item_id = si.sale_item_id
                      AND sop.status = '已支付' AND sop.change_type IN ('首次支付','回款','储值卡抵扣','退款')), 0)
           + COALESCE((SELECT SUM(p.amount) FROM jsonb_to_recordset($2::jsonb) AS p("saleItemId" text, amount numeric)
                       WHERE p."saleItemId" = si.sale_item_id), 0))
         WHERE si.sale_order_id = $1 AND si.item_direction = '购买'`,
        [saleOrderId, JSON.stringify(planned)],
      )
    } else if (orderType === '销售单') {
      // 历史 receipt 不完整时，沿实际结算的原始瀑布与逐项退款扣减。
      await client.query(SALE_ITEMS_RECEIVED_ALLOC_SQL, [saleOrderId])
      await client.query(RECEIVED_REFUNDED_DEDUCT_SQL, [saleOrderId])
    }
    // 只在 SELECT 中加入虚拟本次 receipt，不 INSERT 款项、不消耗序列、不留下支付意图。
    const marker = '/* membership-receipt-preview */'
    if (!customerTypeCte.includes(marker)) throw new Error('INVALID_STATE: 入会预演规则不可用')
    const previewCte = customerTypeCte.replace(marker, `UNION ALL
      SELECT $3::varchar, 9223372036854775807::bigint, NOW(), p."saleItemId"::varchar, p.amount
      FROM jsonb_to_recordset($4::jsonb) AS p("saleItemId" text, amount numeric)`)
    const result = await client.query(
      `${previewCte} SELECT EXISTS (SELECT 1 FROM order_amounts WHERE non_trial >= $2 AND sale_order_id = $3) AS qualifies`,
      [clientUserId, threshold, saleOrderId, JSON.stringify(planned)],
    )
    qualifies = result.rows[0]?.qualifies === true
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT membership_payment_preview')
    await client.query('RELEASE SAVEPOINT membership_payment_preview')
  }
  if (qualifies) await assertMembershipBinding(client, clientUserId)
}

module.exports = { assertOnlineMembershipBinding }
