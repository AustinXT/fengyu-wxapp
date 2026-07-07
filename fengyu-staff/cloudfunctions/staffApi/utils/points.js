


const ORDER_TYPES_EARN_POINTS = new Set(['销售单'])




async function settlePointsForOrder(client, originalSaleOrderId) {
  if (!originalSaleOrderId) {
    return { delta: 0, expected: 0, granted: 0, skipped: 'no-original-id' }
  }

  
  const origRes = await client.query(
    `SELECT client_user_id, sale_order_type
       FROM sale_orders
      WHERE sale_order_id = $1
      FOR UPDATE`,
    [originalSaleOrderId],
  )
  if (origRes.rows.length === 0) {
    return { delta: 0, expected: 0, granted: 0, skipped: 'order-not-found' }
  }
  const { client_user_id: userId, sale_order_type: saleOrderType } = origRes.rows[0]
  if (!userId) {
    return { delta: 0, expected: 0, granted: 0, skipped: 'anonymous-order' }
  }
  if (!ORDER_TYPES_EARN_POINTS.has(saleOrderType)) {
    return { delta: 0, expected: 0, granted: 0, skipped: `order-type-${saleOrderType}` }
  }

  
  
  
  const sumRes = await client.query(
    `SELECT COALESCE(SUM(COALESCE(received,0) - COALESCE(refunded_amount,0)), 0)::numeric AS net_settled
       FROM sale_orders
      WHERE sale_order_id = $1
         OR ref_sale_order_id = $1`,
    [originalSaleOrderId],
  )
  const netSettled = Number(sumRes.rows[0]?.net_settled || 0)

  
  const expected = Math.floor(Math.max(0, netSettled) / 100)

  
  const grantedRes = await client.query(
    `SELECT COALESCE(SUM(amount), 0)::int AS granted
       FROM point_transactions
      WHERE ref_order_id = $1`,
    [originalSaleOrderId],
  )
  const granted = Number(grantedRes.rows[0]?.granted || 0)

  
  const delta = expected - granted
  if (delta === 0) {
    return { delta: 0, expected, granted }
  }

  const type = delta > 0 ? '消费赠送' : '消费冲销'
  
  
  
  await client.query(
    `INSERT INTO point_transactions (user_id, type, amount, ref_order_id, created_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id, ref_order_id, type)
       WHERE ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销')
     DO UPDATE SET amount = point_transactions.amount + EXCLUDED.amount,
                   created_at = NOW()`,
    [userId, type, delta, originalSaleOrderId],
  )
  await client.query(
    `UPDATE client_wechat_users
        SET points_balance    = COALESCE(points_balance, 0) + $1,
            points_updated_at = NOW()
      WHERE user_id = $2`,
    [delta, userId],
  )

  return { delta, expected, granted }
}


async function settlePointsSafe(client, originalSaleOrderId, triggerSource) {
  if (process.env.POINTS_ACCRUAL_ENABLED === 'false') {
    return { skipped: 'feature-flag-disabled' }
  }
  
  
  await client.query('SAVEPOINT sp_settle_points')
  try {
    const result = await settlePointsForOrder(client, originalSaleOrderId)
    await client.query('RELEASE SAVEPOINT sp_settle_points')
    return result
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT sp_settle_points')
    try {
      await client.query(
        `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
         VALUES ('points.settleFailed', 'sale_order', $1, $2::jsonb, $3, NOW())`,
        [
          originalSaleOrderId,
          JSON.stringify({ error: err.message, triggerSource }),
          triggerSource || 'staffApi',
        ],
      )
    } catch (_) {  }
    return { error: err.message, skipped: 'settle-failed' }
  }
}

module.exports = {
  settlePointsForOrder,
  settlePointsSafe,
  ORDER_TYPES_EARN_POINTS,
}
