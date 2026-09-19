/**
 * 行级退款额聚合 + 退款感知定向分摊 — payNotify 独立副本
 *
 * 跨端约定（no-shared-cloudfunctions）：clientApi / payNotify / staffApi / admin 各保留
 * 同语义独立副本，由 cross-end-sql-snapshot.test.js 守护字面同义（与 paid-sessions.js
 * 的 RECEIVED_REFUNDED_DEDUCT_SQL 同源 CTE）。
 *
 * 背景：sale_items 表无 refunded_amount 列，行级退款金额权威源 =
 * sale_order_payments.note.items[].refundAmount（change_type='退款' AND status='已支付'）。
 *
 * 用途：payNotify 线上回款到账 capture 时，若订单存在已支付退款，只把回款定向到未退行，
 * 避免非定向瀑布流把回款误充到已退行（received/paid_sessions 复活）。
 * 无退款返回 null，调用方走原瀑布流，首次支付/正常回款零变化。
 */

// 单订单行级退款聚合 SQL（pg 风格 $1 = saleOrderId）
// 复用 paid-sessions.js RECEIVED_REFUNDED_DEDUCT_SQL 的 refund_items CTE（三重 note→jsonb 防线照搬），
// 但改为 SELECT 聚合并显式排除 OVERPAY 哨兵行（refSaleItemId='OVERPAY' 为多收余数哨兵，非真实行）。
const PER_ITEM_REFUNDED_SQL = `WITH refund_items AS (
      SELECT elem ->> 'refSaleItemId' AS sale_item_id,
             COALESCE(public.try_numeric(elem ->> 'refundAmount'), 0) AS refund_amount
      FROM sale_order_payments sop
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(public.try_jsonb(sop.note) -> 'items') = 'array'
             THEN public.try_jsonb(sop.note) -> 'items'
             ELSE '[]'::jsonb END
      ) AS elem
      WHERE sop.sale_order_id = $1
        AND sop.change_type = '退款'
        AND sop.status = '已支付'
        AND elem ->> 'refSaleItemId' IS NOT NULL
        AND elem ->> 'refSaleItemId' <> 'OVERPAY'
    )
    SELECT sale_item_id, SUM(refund_amount) AS refunded
    FROM refund_items
    GROUP BY sale_item_id`

/**
 * 单订单行级退款 Map（事务内 client）。
 * @returns Map<saleItemId, refundedNumber>（仅含退过的行；未退行不在 map 中）
 */
async function getPerItemRefundedMap(dbClient, saleOrderId) {
  const res = await dbClient.query(PER_ITEM_REFUNDED_SQL, [saleOrderId])
  // 兼容两种返回：payNotify 内 pg 池/事务 client；原生 {rows} 或裸数组
  const rows = Array.isArray(res) ? res : ((res && res.rows) || [])
  const m = new Map()
  for (const r of rows) {
    m.set(r.sale_item_id, Number(r.refunded || 0))
  }
  return m
}

/**
 * 退款感知定向分摊项：有退款时只把回款定向到「未退且未付清」行；无退款返回 null。
 *
 * @param items Array<{ sale_item_id, sale_amount, received }>（received 须为净额，sale_items.received 已是）
 * @param refundMap Map<saleItemId, refundedNumber>（getPerItemRefundedMap 返回值）
 * @returns null | Array<{ saleItemId, amount }>（供 capturePaymentAllocatables.directedItems）
 *
 * 注意：调用方须保证 eventAmount === Σ directedItems.amount（如 client.repay 强制全额、
 * payNotify 付清到账 fullEventAmount === remaining）。部分到账场景（金额 < 欠款）不适用，
 * 应保持 directedItems=null 走瀑布流。
 */
function computeRefundAwareDirectedItems(items, refundMap) {
  if (!refundMap || refundMap.size === 0) return null
  const hasRefund = [...refundMap.values()].some((v) => Number(v) > 0)
  if (!hasRefund) return null
  const out = []
  for (const i of items) {
    const refunded = Number(refundMap.get(i.sale_item_id)) || 0
    if (refunded > 0) continue // 已退行不可再付
    const amount = Math.max(0, Math.round((Number(i.sale_amount) - Number(i.received)) * 100) / 100)
    if (amount > 0) out.push({ saleItemId: String(i.sale_item_id), amount })
  }
  return out.length > 0 ? out : null
}

module.exports = {
  PER_ITEM_REFUNDED_SQL,
  getPerItemRefundedMap,
  computeRefundAwareDirectedItems,
}
