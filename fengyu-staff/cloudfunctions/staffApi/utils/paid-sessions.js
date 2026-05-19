/**
 * paid_sessions 计算与重算 — 单源四端字节同义（ticket 2026-05-19-sale-items-paid-sessions）
 *
 * 语义：净已支付金额按比例可换到的次数，行级 floor。
 * 公式：paid_sessions = floor( min(1, settled / total_amount) × session_count )
 *   - settled = max(0, received - refunded_amount)
 *   - sale_orders.received 不变量已含 '储值卡抵扣' change_type 行（见 staff/order.js L1991-1994），不能重复加 prepaid_card_amount
 *   - total_amount <= 0  → paid_sessions = session_count（免单/寄存兜底全付）
 *   - session_count IS NULL → paid_sessions = NULL（非次数卡）
 *
 * D3=A 退款扣减：refunded_amount 增加 → settled 下降 → paid_sessions 自动倒退；
 * 若新 paid_sessions < 已消费次数(session_count - remaining_sessions)，
 * recalcPaidSessionsForOrder 抛 CONFLICT 阻止退款，保护"已消费次数不可撤销"不变量。
 *
 * 同时维护两个出口：
 *   1) computePaidSessionsForItem(...) — JS 纯函数，order.create 写入新行时使用
 *   2) PAID_SESSIONS_RECALC_SQL — SQL 模板，confirmOffline/回款/退款/微信回调后重算同订单全部行
 *
 * 跨端字节同义守护：__tests__/routes/cross-end-sql-snapshot.test.js
 */

/**
 * @param {object} args
 * @param {number|string} args.saleOrderReceived  - sale_orders.received（已含储值卡抵扣已支付部分）
 * @param {number|string} [args.saleOrderRefunded] - sale_orders.refunded_amount
 * @param {number|string} args.saleOrderTotal
 * @param {number|null} args.itemSessionCount
 * @returns {number|null}
 */
function computePaidSessionsForItem({ saleOrderReceived, saleOrderRefunded, saleOrderTotal, itemSessionCount }) {
  if (itemSessionCount == null) return null
  const total = Number(saleOrderTotal) || 0
  if (total <= 0) return Number(itemSessionCount)
  const settled = Math.max(0, (Number(saleOrderReceived) || 0) - (Number(saleOrderRefunded) || 0))
  const ratio = Math.min(1, settled / total)
  const v = Math.floor(ratio * Number(itemSessionCount))
  return Math.max(0, Math.min(Number(itemSessionCount), v))
}

/**
 * SQL 模板（pg 风格 $1 占位符 = saleOrderId）。
 * 调用方在事务内执行，紧随 sale_orders.received/prepaid_card_amount 变更后。
 *
 * 实现策略：FROM 子句把订单级聚合提到外面，sale_items 行内只做 LEAST/FLOOR；
 * 各行 floor 独立（D8=A 各行独立 floor，尾差最多每行 1 次）。
 */
const PAID_SESSIONS_RECALC_SQL = `UPDATE sale_items
SET paid_sessions = CASE
  WHEN sale_items.session_count IS NULL THEN NULL
  WHEN op.total_amount <= 0 THEN sale_items.session_count
  ELSE LEAST(sale_items.session_count, FLOOR(LEAST(1, op.settled::numeric / op.total_amount) * sale_items.session_count)::integer)
END,
updated_at = NOW()
FROM (SELECT total_amount, GREATEST(0, received - COALESCE(refunded_amount, 0)) AS settled FROM sale_orders WHERE sale_order_id = $1) op
WHERE sale_items.sale_order_id = $1`

/**
 * 在 pg 事务 client 内重算指定订单的所有 sale_items.paid_sessions。
 * D3=A 退款守护：若重算后 (session_count - remaining_sessions) > paid_sessions（已消费 > 已支付次数），
 * 抛 CONFLICT，提示调用方先取消已生成的服务单。
 *
 * @param {object} client - pg 事务 client
 * @param {string} saleOrderId
 */
async function recalcPaidSessionsForOrder(client, saleOrderId) {
  await client.query(PAID_SESSIONS_RECALC_SQL, [saleOrderId])
  const violation = await client.query(
    `SELECT sale_item_id, session_count, remaining_sessions, paid_sessions
       FROM sale_items
      WHERE sale_order_id = $1
        AND session_count IS NOT NULL
        AND paid_sessions IS NOT NULL
        AND (session_count - remaining_sessions) > paid_sessions
      LIMIT 1`,
    [saleOrderId],
  )
  const violationRows = (violation && violation.rows) || []
  if (violationRows.length > 0) {
    const r = violationRows[0]
    throw new Error(
      `CONFLICT: PAID_SESSIONS_UNDERFLOW: 订单行 ${r.sale_item_id} 退款后已支付次数(${r.paid_sessions})低于已消费次数(${r.session_count - r.remaining_sessions})，请先取消相关服务单回滚消费再退款`,
    )
  }
}

module.exports = {
  computePaidSessionsForItem,
  PAID_SESSIONS_RECALC_SQL,
  recalcPaidSessionsForOrder,
}
