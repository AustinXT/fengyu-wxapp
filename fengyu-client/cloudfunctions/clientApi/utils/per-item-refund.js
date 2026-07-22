/**
 * 行级退款额聚合 + 退款感知定向分摊 — 顾客端独立副本
 *
 * 跨端约定（no-shared-cloudfunctions）：clientApi / payNotify / staffApi / admin 各保留
 * 同语义独立副本，由 cross-end-sql-snapshot.test.js 守护字面同义（与 paid-sessions.js
 * 的 RECEIVED_REFUNDED_DEDUCT_SQL 同源 CTE）。
 *
 * 背景：sale_items 表无 refunded_amount 列（admin orders.ts:563 注释"库内无行级字段"），
 * 行级退款金额权威源 = sale_order_payments.note.items[].refundAmount（change_type='退款'
 * AND status='已支付'）。ref_sale_item_id 列多项退款时为 null，不可靠，故必须从 note JSON 聚合。
 *
 * 用途：
 *   1) 前端"继续支付/回款"行级判定 —— 已退行可回款额=0，未退行=sale_amount-received（净）
 *   2) capturePaymentAllocatables 的 directedItems —— 有退款时只把回款定向到未退行，
 *      避免非定向瀑布流把回款误充到已退行（received/paid_sessions 复活）。
 *      无退款时返回 null，调用方走原瀑布流，首次支付/正常回款零变化。
 */

// 单订单行级退款聚合 SQL（pg 风格 $1 = saleOrderId）
// 复用 paid-sessions.js RECEIVED_REFUNDED_DEDUCT_SQL 的 refund_items CTE（三重 note→jsonb 防线照搬），
// 但改为 SELECT 聚合并显式排除 OVERPAY 哨兵行（refSaleItemId='OVERPAY' 为多收余数哨兵，非真实行）。
const PER_ITEM_REFUNDED_SQL = `WITH refund_items AS (
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
      WHERE sop.sale_order_id = $1
        AND sop.change_type = '退款'
        AND sop.status = '已支付'
        AND elem ->> 'refSaleItemId' IS NOT NULL
        AND elem ->> 'refSaleItemId' <> 'OVERPAY'
    )
    SELECT sale_item_id, SUM(refund_amount) AS refunded
    FROM refund_items
    GROUP BY sale_item_id`

// 批量行级退款聚合 SQL（pg 风格 $1 = saleOrderId[] text[]），供 order.list 避免逐单 N+1
const PER_ITEM_REFUNDED_BATCH_SQL = `WITH refund_items AS (
      SELECT sop.sale_order_id,
             elem ->> 'refSaleItemId' AS sale_item_id,
             COALESCE((elem ->> 'refundAmount')::numeric, 0) AS refund_amount
      FROM sale_order_payments sop
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN sop.note LIKE '{%'
             THEN CASE WHEN jsonb_typeof((sop.note)::jsonb -> 'items') = 'array'
                       THEN (sop.note)::jsonb -> 'items'
                       ELSE '[]'::jsonb END
             ELSE '[]'::jsonb END
      ) AS elem
      WHERE sop.sale_order_id = ANY($1::text[])
        AND sop.change_type = '退款'
        AND sop.status = '已支付'
        AND elem ->> 'refSaleItemId' IS NOT NULL
        AND elem ->> 'refSaleItemId' <> 'OVERPAY'
    )
    SELECT sale_order_id, sale_item_id, SUM(refund_amount) AS refunded
    FROM refund_items
    GROUP BY sale_order_id, sale_item_id`

/**
 * 单订单行级退款 Map（事务内 / 池查询均可，传入对应 client 或 pg）。
 * @returns Map<saleItemId, refundedNumber>（仅含退过的行；未退行不在 map 中）
 */
async function getPerItemRefundedMap(dbClient, saleOrderId) {
  const res = await dbClient.query(PER_ITEM_REFUNDED_SQL, [saleOrderId])
  // 兼容两种返回：clientApi db/pg.js 的 query 直接返回 rows 数组；原生 Pool/Client 事务返回 {rows}
  const rows = Array.isArray(res) ? res : ((res && res.rows) || [])
  const m = new Map()
  for (const r of rows) {
    m.set(r.sale_item_id, Number(r.refunded || 0))
  }
  return m
}

/**
 * 批量行级退款 Map（池查询，order.list 用）。
 * @param pg 连接池（不是事务 client）
 * @param saleOrderIds string[]
 * @returns Map<saleOrderId, Map<saleItemId, refundedNumber>>
 */
async function getPerItemRefundedMapBatch(pg, saleOrderIds) {
  if (!Array.isArray(saleOrderIds) || saleOrderIds.length === 0) return new Map()
  const res = await pg.query(PER_ITEM_REFUNDED_BATCH_SQL, [saleOrderIds])
  const rows = Array.isArray(res) ? res : ((res && res.rows) || [])
  const outer = new Map()
  for (const r of rows) {
    if (!outer.has(r.sale_order_id)) outer.set(r.sale_order_id, new Map())
    outer.get(r.sale_order_id).set(r.sale_item_id, Number(r.refunded || 0))
  }
  return outer
}

/**
 * 退款感知定向分摊项：有退款时只把回款定向到「未退且未付清」行；无退款返回 null。
 *
 * @param items Array<{ sale_item_id, sale_amount, received }>（received 须为净额，sale_items.received 已是）
 * @param refundMap Map<saleItemId, refundedNumber>（getPerItemRefundedMap 返回值）
 * @returns null | Array<{ saleItemId, amount }>（供 capturePaymentAllocatables.directedItems）
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

/**
 * 行级可回款额（前端 outstanding / 后端 remaining 的行级口径，四端统一）：
 *   已退行 → 0；未退行 → max(0, sale_amount - received净)
 * 订单可回款 = Σ 各行可回款。
 */
function itemRepayableAmount(item, refundedNumberOfItem) {
  if (Number(refundedNumberOfItem || 0) > 0) return 0
  return Math.max(0, Math.round((Number(item.sale_amount) - Number(item.received)) * 100) / 100)
}

module.exports = {
  PER_ITEM_REFUNDED_SQL,
  PER_ITEM_REFUNDED_BATCH_SQL,
  getPerItemRefundedMap,
  getPerItemRefundedMapBatch,
  computeRefundAwareDirectedItems,
  itemRepayableAmount,
}
