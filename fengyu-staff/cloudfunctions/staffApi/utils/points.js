/**
 * 积分发放工具 — 订单链净额差值法（ticket 2026-04-24 points-accrual-on-sale-order）
 *
 * 语义：对"原销售单"维度调用 settlePointsForOrder，把整条链
 * （销售单 + 全部回款/退款/转换派生单）的净到账金额换算为目标积分，
 * 与已发放流水求差值，写入 delta 条流水 + 更新余额缓存。
 *
 * 反例说明：按 sale_order_payments 逐笔 floor(amount/100) 会出现累积舍入误差；
 * 采用"链净额 - 已发"的 delta 差值法天然幂等，重复调用无副作用。
 */

// 参与积分发放的订单类型（决策 D1：内部单不发）
const ORDER_TYPES_EARN_POINTS = new Set(['销售单'])
// 内部单不发；回款/转换/退款单不是"原始"发放点，它们引用的原销售单才发
// 这些派生单通过 ref_sale_order_id 传递给 settle

/**
 * 结算某条订单链的积分
 *
 * @param {object} client - pg 事务 client（调用方必须在 pg.transaction 内调用）
 * @param {string} originalSaleOrderId - 原销售单 ID；若当前业务触发点是派生单
 *                                        （回款/退款/转换），传 ref_sale_order_id
 * @returns {Promise<{delta:number, expected:number, granted:number, skipped?:string}>}
 *   - delta=0 表示无需写入（天然幂等）
 *   - skipped 非空表示整条链被跳过（内部单 / 匿名单 / 原单不存在），无流水写入
 */
async function settlePointsForOrder(client, originalSaleOrderId) {
  if (!originalSaleOrderId) {
    return { delta: 0, expected: 0, granted: 0, skipped: 'no-original-id' }
  }

  // 1. 取原单顾客归属 + 类型；FOR UPDATE 串行化并发回款/退款
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

  // 2. 汇总整条订单链的已到账净额（原单 + 全部派生单）
  //    2026-04-26 sale-order-domain-refactor: paid_amount 已 DROP，改用 received - refunded_amount
  //    退款单 refunded_amount 为正，回款单 received 为正；累加得链净额
  const sumRes = await client.query(
    `SELECT COALESCE(SUM(COALESCE(received,0) - COALESCE(refunded_amount,0)), 0)::numeric AS net_settled
       FROM sale_orders
      WHERE sale_order_id = $1
         OR ref_sale_order_id = $1`,
    [originalSaleOrderId],
  )
  const netSettled = Number(sumRes.rows[0]?.net_settled || 0)

  // 3. 目标积分（决策 D3：不允许负余额，expected 下界为 0）
  const expected = Math.floor(Math.max(0, netSettled) / 100)

  // 4. 已发积分合计（按 ref_order_id 聚合，等级升级/兑换等非本链流水自然排除）
  const grantedRes = await client.query(
    `SELECT COALESCE(SUM(amount), 0)::bigint AS granted
       FROM point_transactions
      WHERE ref_order_id = $1`,
    [originalSaleOrderId],
  )
  const granted = Number(grantedRes.rows[0]?.granted || 0)

  // 5. 差值判断 — delta=0 天然幂等
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

/**
 * 触发点安全封装：把 settle 失败隔离成 operation_logs 告警
 * 资金状态已写入不应被积分失败回滚（决策：资金正确优先，由 cronTask 兜底重算）
 *
 * @param {object} client - pg 事务 client
 * @param {string} originalSaleOrderId - 原销售单 id
 * @param {string} triggerSource - 调用方标识，写入日志便于定位
 */
async function settlePointsSafe(client, originalSaleOrderId, triggerSource) {
  if (process.env.POINTS_ACCRUAL_ENABLED === 'false') {
    return { skipped: 'feature-flag-disabled' }
  }
  // SAVEPOINT 真隔离：积分发放报错只回滚子事务，外层资金事务不受影响
  // （决策：资金正确优先，积分失败仅告警，由 cronTask 兜底重算）。
  // SAVEPOINT 必须在 try 内创建（外层事务已 abort 时 SAVEPOINT 自身会失败），
  // catch 里用 savepointCreated 守卫避免 ROLLBACK 不存在的 savepoint 把 op_log 写入也带崩。
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
          triggerSource || 'staffApi',
        ],
      )
    } catch (_) { /* log 写入失败不影响主事务 */ }
    return { error: err.message, skipped: 'settle-failed' }
  }
}

module.exports = {
  settlePointsForOrder,
  settlePointsSafe,
  ORDER_TYPES_EARN_POINTS,
}
