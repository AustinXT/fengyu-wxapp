/**
 * paid_sessions 计算与重算 — 单源四端字节同义（ticket 2026-05-19-sale-items-paid-sessions）
 *
 * 语义：行级**净实收**按比例可换到的次数，**行级**比例 floor。
 * 公式：paid_sessions = min( session_count, floor( item.received × session_count / item.sale_amount ) )
 *   先乘后除（D9=A 整数精度）：避免先除产生 0.13333…×15=1.9999… 被 FLOOR 误舍成 1（应为 2）；封顶交给外层 LEAST(session_count)
 *   - item.received 已是**净额**：新 receipt 覆盖订单优先按 sale_payment_item_receipts 有符号金额重建；
 *     旧数据无完整 receipt 时回退瀑布 + note.items[].refundAmount 扣减。
 *   - sale_items.received 已含 '储值卡抵扣' change_type 行（跨端同义），不重复计 prepaid_card_amount
 *   - sale_items.sale_amount <= 0  → paid_sessions = session_count（免单/寄存兜底全付）；若退款 note 标记该 0 元 item 全退，后置覆盖为 0
 *   - session_count IS NULL → paid_sessions = NULL（非次数卡）
 *
 * D3=A 退款扣减：退款审批通过 → STEP 1.5 把该行 received 扣减（净额下降）→ paid_sessions 自动倒退；
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
 * STEP 1 received 重建（pg 风格 $1 = saleOrderId）。两路分流：
 *   A. 正向 receipt 覆盖订单毛实收 → received = Σ 有符号 sale_payment_item_receipts.amount per item
 *   B. 无完整 receipt（历史/修复）→ 回退瀑布 SALE_ITEMS_RECEIVED_ALLOC_SQL + 退款 note 扣减，零回归
 * recalcPaidSessionsForOrder() 先查 receipt 是否完整覆盖，再选 A 或 B。
 * 必须在 PAID_SESSIONS_RECALC_SQL 之前执行（公式以 sale_items.received 为分子）。
 * 与 admin paid-sessions.ts STEP 1 跨端字节同义（normalize 后），cross-end-sql-snapshot 守护。
 */
/**
 * 分支 A：received = Σ receipt.amount per item（包含退款负数）
 */
const SALE_ITEMS_RECEIVED_FROM_RECEIPTS_SQL = `UPDATE sale_items si
    SET received = COALESCE(GREATEST(0, (
      SELECT SUM(spir.amount::numeric) FROM sale_payment_item_receipts spir
      JOIN sale_order_payments sop ON sop.id = spir.sale_payment_id
       WHERE spir.sale_order_id = $1 AND spir.sale_item_id = si.sale_item_id
         AND sop.status = '已支付'
         AND sop.change_type IN ('首次支付','回款','储值卡抵扣','退款')
    )), 0),
    updated_at = NOW()
    WHERE si.sale_order_id = $1 AND si.item_direction = '购买'`

/**
 * 分支 B（回退）：旧「定向 + 两段式瀑布」（无完整 receipt 的历史/异常单，零回归）
 *   targeted_i = Σ(已支付 payments WHERE ref_sale_item_id=i AND change_type∈首次支付/回款/储值卡抵扣)（退款排除）；
 *   untargeted = order.received - Σtargeted；
 *   pend_cap_i = pending_received_i - targeted_i（第一段产能：朝逐行实付草稿铺）；
 *   sale_cap_i = sale_amount_i - max(pending_received_i, targeted_i)（第二段产能：实付→应付余量）；
 *   received_i = targeted_i + [untargeted 先按 pend_cap 比例铺满 Σpend_cap，溢出再按 sale_cap 比例铺开]，单次 ROUND 2 位。
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

/**
 * STEP 1.5 逐项退款净额 SQL（2026-06-08 退款侧 $1 = saleOrderId）：从毛额 received 扣减
 * 已支付退款流水 note.items[].refundAmount（按 refSaleItemId 聚合到行）→ received 变「净额」
 * （毛实收 − 该行被退）。效果：被退项详情自动减少、SUM(received)=净实收、paid_sessions 按项扣减。
 * note→jsonb 三重防线根除 22P02/25P02：① WHERE 仅 退款+已支付（reject='已作废'自动排除→自愈）；
 * ② 外层 note LIKE '{%' 纯文本守门；③ 嵌套 CASE 保证 ::jsonb cast 只在守门通过时求值，jsonb_typeof 兜 items 非数组。
 * 仅 item_direction='购买' 行（与 STEP1 一致，不碰 convert_out/refund_out 负数行）；GREATEST(0) clamp。
 * 幂等：每次 recalc 先跑 STEP1 把 received 重置为毛额，本 STEP 再扣 → 多次结果一致。
 * 必须在 SALE_ITEMS_RECEIVED_ALLOC_SQL 之后、PAID_SESSIONS_RECALC_SQL 之前执行。
 * 与 admin paid-sessions.ts 跨端字节同义（normalize 后），cross-end-sql-snapshot 守护。
 */
const RECEIVED_REFUNDED_DEDUCT_SQL = `WITH refund_items AS (
      SELECT elem ->> 'refSaleItemId' AS sale_item_id,
             COALESCE((elem ->> 'refundAmount')::numeric, 0) AS refund_amount
      FROM sale_order_payments sop
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN sop.note LIKE '{%'
             THEN CASE WHEN jsonb_typeof((sop.note)::jsonb -> 'items') = 'array'
                       THEN (sop.note)::jsonb -> 'items'
                       ELSE '[]'::jsonb END
             ELSE '[]'::jsonb END
      ) AS elem
      WHERE sop.sale_order_id = $1 AND sop.change_type = '退款' AND sop.status = '已支付'
    ),
    agg AS (
      SELECT sale_item_id, SUM(refund_amount) AS refunded
      FROM refund_items WHERE sale_item_id IS NOT NULL GROUP BY sale_item_id
    )
    UPDATE sale_items si
    SET received = GREATEST(0, si.received::numeric - COALESCE(agg.refunded, 0)),
        updated_at = NOW()
    FROM (SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1 AND item_direction = '购买') ai
    LEFT JOIN agg ON agg.sale_item_id = ai.sale_item_id
    WHERE si.sale_item_id = ai.sale_item_id`

const PAID_SESSIONS_RECALC_SQL = `UPDATE sale_items
SET paid_sessions = CASE
  WHEN sale_items.session_count IS NULL THEN NULL
  WHEN op.total_amount <= 0 THEN sale_items.session_count
  WHEN sale_items.sale_amount <= 0 THEN sale_items.session_count
  ELSE LEAST(sale_items.session_count, FLOOR(sale_items.received::numeric * sale_items.session_count / sale_items.sale_amount::numeric)::integer)
END,
updated_at = NOW()
FROM (SELECT total_amount FROM sale_orders WHERE sale_order_id = $1) op
WHERE sale_items.sale_order_id = $1`

/**
 * STEP 2.5 0 元卡项全退覆盖（pg 风格 $1 = saleOrderId）：0 元赠送/寄存 item 的公式兜底会给满 paid_sessions；
 * 若退款 note.items[] 明确标记该 item isFullItemRefund=true，则覆盖 paid_sessions=0，使卡包按 paid_sessions 口径消失。
 */
const FULL_REFUND_ZERO_AMOUNT_PAID_SESSIONS_SQL = `WITH full_refund_zero_items AS (
      SELECT elem ->> 'refSaleItemId' AS sale_item_id
      FROM sale_order_payments sop
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN sop.note LIKE '{%'
             THEN CASE WHEN jsonb_typeof((sop.note)::jsonb -> 'items') = 'array'
                       THEN (sop.note)::jsonb -> 'items'
                       ELSE '[]'::jsonb END
             ELSE '[]'::jsonb END
      ) AS elem
      WHERE sop.sale_order_id = $1 AND sop.change_type = '退款' AND sop.status = '已支付'
        AND LOWER(COALESCE(elem ->> 'isFullItemRefund', 'false')) = 'true'
    )
    UPDATE sale_items si
    SET paid_sessions = 0,
        updated_at = NOW()
    WHERE si.sale_order_id = $1
      AND si.item_direction = '购买'
      AND si.session_count IS NOT NULL
      AND si.sale_amount <= 0
      AND EXISTS (
        SELECT 1 FROM full_refund_zero_items fri WHERE fri.sale_item_id = si.sale_item_id
      )`

/**
 * 在 pg 事务 client 内重算指定订单的所有 sale_items.paid_sessions。
 * D3=A 退款守护：若重算后 (session_count - remaining_sessions) > paid_sessions（已消费 > 已支付次数），
 * 抛 CONFLICT，提示调用方先取消已生成的服务单。
 *
 * @param {object} client - pg 事务 client
 * @param {string} saleOrderId
 */
async function recalcPaidSessionsForOrder(client, saleOrderId) {
  // STEP 1：两路分流
  //   A. 正向 receipt 覆盖订单毛实收 → received = Σ 有符号 receipt.amount per item（退款为负数）
  //   B. receipt 不完整或无 → 回退瀑布 + note.items[].refundAmount 扣减（保护历史部分支付订单）
  const covRes = await client.query(
    `SELECT COALESCE((
              SELECT SUM(cov_spir.amount::numeric)
                FROM sale_payment_item_receipts cov_spir
                JOIN sale_order_payments sop ON sop.id = cov_spir.sale_payment_id
               WHERE cov_spir.sale_order_id = $1
                 AND sop.status = '已支付'
                 AND sop.change_type IN ('首次支付','回款','储值卡抵扣')
            ), 0) AS receipt_positive_total,
            (SELECT received::numeric FROM sale_orders WHERE sale_order_id = $1) AS order_received`,
    [saleOrderId],
  )
  const covRow = (covRes && covRes.rows && covRes.rows[0]) || {}
  const receiptPositiveTotal = Number(covRow.receipt_positive_total || 0)
  const orderReceived = Number(covRow.order_received || 0)
  // 仅正向 receipt 总额 >= order_received（容差 0.01 处理浮点）→ receipt 完整覆盖，Branch A 安全
  if (receiptPositiveTotal > 0 && receiptPositiveTotal >= orderReceived - 0.01) {
    await client.query(SALE_ITEMS_RECEIVED_FROM_RECEIPTS_SQL, [saleOrderId])
  } else {
    await client.query(SALE_ITEMS_RECEIVED_ALLOC_SQL, [saleOrderId])
    // STEP 1.5：回退分支没有完整正向 receipt 覆盖，须按 note.items[].refundAmount 扣减。
    // 分支 A 已由负数 receipt 得到净额，故不在 A 中执行本扣减。
    await client.query(RECEIVED_REFUNDED_DEDUCT_SQL, [saleOrderId])
  }
  // STEP 2：行级公式重算 paid_sessions（received 已净额，不再下分订单级退款）
  await client.query(PAID_SESSIONS_RECALC_SQL, [saleOrderId])
  // STEP 2.5：0 元 item 若已随退款全退，覆盖 paid_sessions=0（否则 sale_amount<=0 兜底会保留满次数）
  await client.query(FULL_REFUND_ZERO_AMOUNT_PAID_SESSIONS_SQL, [saleOrderId])
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
  SALE_ITEMS_RECEIVED_FROM_RECEIPTS_SQL,
  RECEIVED_REFUNDED_DEDUCT_SQL,
  PAID_SESSIONS_RECALC_SQL,
  FULL_REFUND_ZERO_AMOUNT_PAID_SESSIONS_SQL,
  recalcPaidSessionsForOrder,
}
