/**
 * paid_sessions 计算与重算 — 单源四端字节同义（ticket 2026-05-19-sale-items-paid-sessions）
 *
 * 语义：净已支付金额按比例可换到的次数，**行级**比例 floor。
 * 公式：paid_sessions = min( session_count, floor( (item.received - item_refund_share) × session_count / item.sale_amount ) )
 *   先乘后除（D9=A 整数精度）：避免先除产生 0.13333…×15=1.9999… 被 FLOOR 误舍成 1（应为 2）；封顶交给外层 LEAST(session_count)
 *   - item_refund_share = order.refunded × item.sale_amount / order.total （订单级退款按 sale_amount 按比例下分到行）
 *     之所以按订单级而非行级是因为目前没有行级退款追踪
 *   - sale_items.received 已含 '储值卡抵扣' change_type 行（见 staff/order.js L1991-1994 跨端同义），不重复计 prepaid_card_amount
 *   - sale_items.sale_amount <= 0  → paid_sessions = session_count（免单/寄存兜底全付）
 *   - session_count IS NULL → paid_sessions = NULL（非次数卡）
 *
 * D3=A 退款扣减：order.refunded 增加 → 行下分 refund_share 增加 → item_settled 下降 → paid_sessions 自动倒退；
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
 * @param {number|string} args.itemReceived       - sale_items.received（已含储值卡抵扣已支付部分）
 * @param {number|string} args.itemSaleAmount     - sale_items.sale_amount（行小计，折扣后）
 * @param {number|null} args.itemSessionCount
 * @param {number|string} args.orderTotal         - sale_orders.total_amount（用于下分订单级退款）
 * @param {number|string} [args.orderRefunded]    - sale_orders.refunded_amount（订单级累计退款）
 * @returns {number|null}
 */
function computePaidSessionsForItem({ itemReceived, itemSaleAmount, itemSessionCount, orderTotal, orderRefunded }) {
  if (itemSessionCount == null) return null
  const sa = Number(itemSaleAmount) || 0
  if (sa <= 0) return Number(itemSessionCount)
  const tot = Number(orderTotal) || 0
  if (tot <= 0) return Number(itemSessionCount)
  const itemRefundShare = tot > 0 ? (Number(orderRefunded) || 0) * sa / tot : 0
  const itemSettled = Math.max(0, (Number(itemReceived) || 0) - itemRefundShare)
  // 先乘后除保整数精度；封顶 session_count（过付/越界兜底）
  return Math.max(0, Math.min(Number(itemSessionCount), Math.floor(itemSettled * Number(itemSessionCount) / sa)))
}

/**
 * SQL 模板（pg 风格 $1 占位符 = saleOrderId）。
 * 调用方在事务内执行，紧随 sale_orders.received/prepaid_card_amount/refunded_amount 或 sale_items.received 变更后。
 *
 * 实现策略：FROM 子句把订单级（total_amount/refunded_amount）拉出来，sale_items 行内按 sale_amount 比例下分订单级 refund；
 * 各行 floor 独立（D8=A 各行独立 floor，尾差最多每行 1 次）。
 */
/**
 * STEP 1 分摊 SQL（pg 风格 $1 = saleOrderId）：把 sale_orders.received 摊到各 sale_items.received，
 * 保证 Σ sale_items.received = sale_orders.received。
 * 「定向 + 两段式瀑布」混合（2026-06-08 组合套餐按逐行实付 pending_received 累加分摊）：
 *   targeted_i = Σ(已支付 payments WHERE ref_sale_item_id=i AND change_type∈首次支付/回款/储值卡抵扣)（退款排除）；
 *   untargeted = order.received - Σtargeted；
 *   pend_cap_i = pending_received_i - targeted_i（第一段产能：朝逐行实付草稿铺）；
 *   sale_cap_i = sale_amount_i - max(pending_received_i, targeted_i)（第二段产能：实付→应付余量）；
 *   received_i = targeted_i + [untargeted 先按 pend_cap 比例铺满 Σpend_cap，溢出再按 sale_cap 比例铺开]，单次 ROUND 2 位。
 * 定向行精确拿到 targeted；无定向额（首付/无 items 回款）先填逐行实付草稿、补到全款后回升到应付（不冻结、可全核销）。
 * pending_received=0（转换/寄存/充值单）或 =sale_amount（顾客端/默认单）时两段式数学上退化为旧「按 sale_amount 比例」，零回归。
 * 必须在 PAID_SESSIONS_RECALC_SQL 之前执行（公式以 sale_items.received 为分子）。
 * 与 admin paid-sessions.ts STEP 1 跨端字节同义（normalize 后），cross-end-sql-snapshot 守护。
 */
const SALE_ITEMS_RECEIVED_ALLOC_SQL = `WITH tg AS (
      SELECT ref_sale_item_id, SUM(amount) AS targeted
      FROM sale_order_payments
      WHERE sale_order_id = $1 AND status = '已支付'
        AND change_type IN ('首次支付','回款','储值卡抵扣') AND ref_sale_item_id IS NOT NULL
      GROUP BY ref_sale_item_id
    ),
    caps AS (
      SELECT si.sale_item_id,
             COALESCE(tg.targeted, 0)::numeric AS targeted,
             GREATEST(0, si.pending_received::numeric - COALESCE(tg.targeted, 0)::numeric) AS pend_cap,
             GREATEST(0, si.sale_amount::numeric - GREATEST(si.pending_received::numeric, COALESCE(tg.targeted, 0)::numeric)) AS sale_cap
      FROM sale_items si
      LEFT JOIN tg ON tg.ref_sale_item_id = si.sale_item_id
      WHERE si.sale_order_id = $1 AND si.item_direction = '购买'
    ),
    agg AS (
      SELECT GREATEST(0, (SELECT received FROM sale_orders WHERE sale_order_id = $1)::numeric - COALESCE((SELECT SUM(targeted) FROM tg), 0)::numeric) AS untargeted,
             COALESCE(SUM(pend_cap), 0)::numeric AS pend_cap_total,
             COALESCE(SUM(sale_cap), 0)::numeric AS sale_cap_total
      FROM caps
    )
    UPDATE sale_items si
    SET received = CASE
          WHEN agg.pend_cap_total > 0 OR agg.sale_cap_total > 0
            THEN caps.targeted
              + ROUND(
                  (CASE WHEN agg.pend_cap_total > 0
                        THEN LEAST(agg.untargeted, agg.pend_cap_total) * caps.pend_cap / agg.pend_cap_total
                        ELSE 0 END)
                + (CASE WHEN agg.sale_cap_total > 0 AND agg.untargeted > agg.pend_cap_total
                        THEN (agg.untargeted - agg.pend_cap_total) * caps.sale_cap / agg.sale_cap_total
                        ELSE 0 END), 2)
          ELSE caps.targeted
        END,
        updated_at = NOW()
    FROM caps, agg
    WHERE si.sale_item_id = caps.sale_item_id`

const PAID_SESSIONS_RECALC_SQL = `UPDATE sale_items
SET paid_sessions = CASE
  WHEN sale_items.session_count IS NULL THEN NULL
  WHEN op.total_amount <= 0 THEN sale_items.session_count
  WHEN sale_items.sale_amount <= 0 THEN sale_items.session_count
  ELSE LEAST(sale_items.session_count, FLOOR(GREATEST(0, sale_items.received::numeric - (op.refunded_amount::numeric * sale_items.sale_amount::numeric / NULLIF(op.total_amount::numeric, 0))) * sale_items.session_count / sale_items.sale_amount::numeric)::integer)
END,
updated_at = NOW()
FROM (SELECT total_amount, COALESCE(refunded_amount, 0) AS refunded_amount FROM sale_orders WHERE sale_order_id = $1) op
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
  // STEP 1：定向回款落到指定行 + 其余按剩余产能比例摊到 sale_items.received
  // （paid_sessions 公式以 sale_items.received 为分子；不同步会让回款后 paid_sessions 停在建单快照）
  await client.query(SALE_ITEMS_RECEIVED_ALLOC_SQL, [saleOrderId])
  // STEP 2：行级公式重算 paid_sessions
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
  SALE_ITEMS_RECEIVED_ALLOC_SQL,
  PAID_SESSIONS_RECALC_SQL,
  recalcPaidSessionsForOrder,
}
