/**
 * 积分发放工具 — 订单链净额差值法（ticket 2026-04-24 points-accrual-on-sale-order）
 *
 * 逻辑副本：与 clientApi/utils/points.js、staffApi/utils/points.js 保持完全一致；
 * payNotify 是独立云函数（扁平结构，无 utils/ 子目录），故平铺在根目录。
 * 三端任一处修改后必须同步其它两份。
 */

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

  // 2026-04-26 sale-order-domain-refactor: paid_amount 已 DROP，改用 received - refunded_amount
  // 退款单 refunded_amount 为正，回款单 received 为正；累加得链净额
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
  // partial unique uq_point_txn_order_user_type (user_id, ref_order_id, type) WHERE ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销')
  // 分次回款/退款累加：同 (user,order,type) 已有行时把增量 delta 累加进唯一行（granted=SUM 口径不变），
  // 避免裸 INSERT 撞唯一索引导致整事务回滚。四端字面同义，由 cross-end-sql-snapshot 守护。
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
  // SAVEPOINT 真隔离：积分发放报错只回滚子事务，外层资金事务不受影响
  // （决策：资金正确优先，积分失败仅告警，由 cronTask 兜底重算）。
  let savepointCreated = false
  try {
    await client.query('SAVEPOINT sp_settle_points')
    savepointCreated = true
    const result = await settlePointsForOrder(client, originalSaleOrderId)
    await client.query('RELEASE SAVEPOINT sp_settle_points')
    return result
  } catch (err) {
    if (savepointCreated) {
      try { await client.query('ROLLBACK TO SAVEPOINT sp_settle_points') } catch (_) { /* noop */ }
    }
    try {
      await client.query(
        `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
         VALUES ('points.settleFailed', 'sale_order', $1, $2::jsonb, $3, NOW())`,
        [
          originalSaleOrderId,
          JSON.stringify({ error: err.message, triggerSource }),
          triggerSource || 'payNotify',
        ],
      )
    } catch (_) { /* noop */ }
    return { error: err.message, skipped: 'settle-failed' }
  }
}

module.exports = {
  settlePointsForOrder,
  settlePointsSafe,
  ORDER_TYPES_EARN_POINTS,
}
