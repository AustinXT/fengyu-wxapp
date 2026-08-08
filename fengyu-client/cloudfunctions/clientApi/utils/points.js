/**
 * 积分发放工具 — 订单链净额差值法（ticket 2026-04-24 points-accrual-on-sale-order）
 *
 * 语义：对"原销售单"维度调用 settlePointsForOrder，把整条链
 * （销售单 + 全部回款/退款/转换派生单）的净到账金额换算为目标积分，
 * 与已发放流水求差值，写入 delta 条流水 + 更新余额缓存。
 *
 * 逻辑副本：与 fengyu-staff/cloudfunctions/staffApi/utils/points.js 保持完全一致；
 * 云函数独立部署单元不能跨目录 require，只能复制一份。
 * 两端任一处修改后必须同步另一端。
 */

// 参与积分发放的订单类型（决策 D1：内部单不发）
const ORDER_TYPES_EARN_POINTS = new Set(['销售单'])

async function grantPointBatch(client, { userId, pointTransactionId, type, amount, refOrderId }) {
  if (!pointTransactionId || !amount || amount <= 0) return
  await client.query(
    `INSERT INTO point_batches (
       user_id, source_transaction_id, source_type, ref_order_id,
       original_amount, remaining_amount, earned_at, expire_at, created_at, updated_at
     )
     SELECT $1, $2, $3, $4, $5, $5, pt.created_at,
            pt.created_at + INTERVAL '365 days', NOW(), NOW()
       FROM point_transactions pt
      WHERE pt.id = $2`,
    [userId, pointTransactionId, type, refOrderId || null, amount],
  )
}

async function consumePointBatches(client, { userId, amount, refOrderId }) {
  const consumeAmount = Math.abs(amount)
  if (!consumeAmount) return
  await client.query(
    `WITH locked_batches AS (
       SELECT id, ref_order_id, expire_at, remaining_amount
         FROM point_batches
        WHERE user_id = $1
          AND remaining_amount > 0
          AND expire_at > NOW()
        ORDER BY CASE WHEN $3::text IS NOT NULL AND ref_order_id = $3 THEN 0 ELSE 1 END,
                 expire_at, id
        FOR UPDATE
     ),
     prioritized AS (
       SELECT id,
              remaining_amount,
              SUM(remaining_amount) OVER (
                ORDER BY CASE WHEN $3::text IS NOT NULL AND ref_order_id = $3 THEN 0 ELSE 1 END,
                         expire_at, id
              ) AS running
         FROM locked_batches
     ),
     allocation AS (
       SELECT id,
              LEAST(remaining_amount, GREATEST(0, $2 - (running - remaining_amount))) AS consume_amount
         FROM prioritized
        WHERE running - remaining_amount < $2
     )
     UPDATE point_batches pb
        SET remaining_amount = pb.remaining_amount - allocation.consume_amount,
            updated_at = NOW()
       FROM allocation
      WHERE pb.id = allocation.id
        AND allocation.consume_amount > 0`,
    [userId, consumeAmount, refOrderId || null],
  )
}

/**
 * 结算某条订单链的积分
 *
 * @param {object} client - pg 事务 client（调用方必须在 pg.transaction 内调用）
 * @param {string} originalSaleOrderId - 原销售单 ID；若当前业务触发点是派生单
 *                                        （回款/退款/转换），传 ref_sale_order_id
 */
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

  // 2026-04-26 sale-order-domain-refactor：
  //   - paid_amount 列已 DROP；改用 received - refunded_amount（净到账）
  //   - 回款单/退款单已迁出 sale_orders → 通过原单的 received / refunded_amount 即可表达整条链净额
  //   - 转换单（仍存在于 sale_orders）通过 ref_sale_order_id 关联，保留 OR 关系兼容
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
      WHERE ref_order_id = $1
        AND type IN ('消费赠送','消费冲销')`,
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
  const inserted = await client.query(
    `INSERT INTO point_transactions (user_id, type, amount, ref_order_id, created_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id, ref_order_id, type)
       WHERE ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销')
     DO UPDATE SET amount = point_transactions.amount + EXCLUDED.amount,
                   created_at = NOW()
     RETURNING id`,
    [userId, type, delta, originalSaleOrderId],
  )
  const pointTransactionId = Number(inserted.rows?.[0]?.id || 0)
  if (delta > 0 && pointTransactionId) {
    await grantPointBatch(client, {
      userId,
      pointTransactionId,
      type,
      amount: delta,
      refOrderId: originalSaleOrderId,
    })
  } else if (delta < 0) {
    await consumePointBatches(client, {
      userId,
      amount: delta,
      refOrderId: originalSaleOrderId,
    })
  }
  await client.query(
    `UPDATE client_wechat_users c
        SET points_balance    = COALESCE((
              SELECT SUM(pb.remaining_amount)
                FROM point_batches pb
               WHERE pb.user_id = c.user_id
                 AND pb.expire_at > NOW()
            ), 0),
            points_updated_at = NOW()
      WHERE c.user_id = $1`,
    [userId],
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
          triggerSource || 'clientApi',
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
  grantPointBatch,
  consumePointBatches,
}
