const { getPointAccount, refreshConversionSources, recordConversionInheritedReversal, lockConversionPointBatches } = require('./conversion-sources')
// 销售单按自身净额扣除永久移出的计分基数；转换单按本单责任快照结算。
// 转换交接不新增赠点，补款归本单，退款仅消耗本单批次。
const ORDER_TYPES_EARN_POINTS = new Set(['销售单', '转换单'])

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

async function consumePointBatches(client, { userId, amount, refOrderId, onlyOrder = false, pointClass = null }) {
  const consumeAmount = Math.abs(amount)
  if (!consumeAmount) return
  await client.query(
    `WITH locked_batches AS (
       SELECT id, ref_order_id, expire_at, remaining_amount
         FROM point_batches
        WHERE user_id = $1
          AND remaining_amount > 0
          AND expire_at > NOW()
          AND ($4::boolean = false OR ref_order_id = $3)
          AND ($5::text IS NULL OR (source_type='消费赠送' AND
            ((source_transaction_id IN (SELECT id FROM point_transactions WHERE ref_order_id=$3 AND type='消费赠送')) OR id IN (SELECT public.try_numeric(b->>'toBatchId')::bigint FROM conversion_point_transfers t CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.batch_snapshot->'batches','[]'::jsonb)) b WHERE t.to_order_id=$3 AND b->>'ownCash'='true')) = ($5::text='cash')))
        ORDER BY expire_at, id
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
    [userId, consumeAmount, refOrderId || null, onlyOrder, pointClass],
  )
}

/**
 * 结算某条订单链的积分
 *
 * @param {object} client - pg 事务 client（调用方必须在 pg.transaction 内调用）
 * @param {string} originalSaleOrderId - 当前责任账户 ID（销售单或转换单）；若当前业务触发点是派生单
 *                                        （回款/退款），传对应销售单或转换单 ID
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
  const query = async (text, params) => (await client.query(text, params)).rows
  if (saleOrderType === '转换单') await refreshConversionSources(query, originalSaleOrderId)
  const account = await getPointAccount(query, originalSaleOrderId, saleOrderType)
  const { expected, granted } = account

  const conversion = saleOrderType === '转换单'
  const inheritedReversal = conversion ? Math.max(0,account.inheritedOwned-account.inheritedPoints) : 0
  const ownDelta = conversion ? (expected-account.inheritedPoints-account.ownGranted) : expected-granted
  const delta = ownDelta-inheritedReversal
  const changes=[{delta:ownDelta,pointClass:conversion ? 'cash' : null},{delta:-inheritedReversal,pointClass:'inherited'}].filter(c=>c.delta!==0)
  if (!changes.length) return {delta:0,expected,granted}
  if (conversion) await lockConversionPointBatches(query,userId,originalSaleOrderId)
  for (const change of changes) {
    const delta=change.delta
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
      onlyOrder: saleOrderType === '转换单',
      pointClass: change.pointClass,
    })
  }
  }
  if (inheritedReversal) await recordConversionInheritedReversal(query,originalSaleOrderId,inheritedReversal)
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

  return conversion ? {delta,expected,granted,reversed:inheritedReversal+Math.max(0,-ownDelta)} : {delta,expected,granted}
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
