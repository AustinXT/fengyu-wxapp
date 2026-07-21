/**
 * 行级退款额聚合 + 退款感知定向分摊 — staffApi 独立副本
 *
 * 跨端约定（no-shared-cloudfunctions）：clientApi / payNotify / staffApi / admin 各保留
 * 同语义独立副本，由 cross-end-sql-snapshot.test.js 守护字面同义（与 paid-sessions.js
 * 的 RECEIVED_REFUNDED_DEDUCT_SQL 同源 CTE）。
 *
 * 背景：sale_items 表无 refunded_amount 列，行级退款金额权威源 =
 * sale_order_payments.note.items[].refundAmount（change_type='退款' AND status='已支付'）。
 *
 * 用途：staff createRepayment 校验已退行不可回款；capture 定向到未退行。
 */

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

async function getPerItemRefundedMap(dbClient, saleOrderId) {
  const res = await dbClient.query(PER_ITEM_REFUNDED_SQL, [saleOrderId])
  const rows = Array.isArray(res) ? res : ((res && res.rows) || [])
  const m = new Map()
  for (const r of rows) {
    m.set(r.sale_item_id, Number(r.refunded || 0))
  }
  return m
}

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

function computeRefundAwareDirectedItems(items, refundMap) {
  if (!refundMap || refundMap.size === 0) return null
  const hasRefund = [...refundMap.values()].some((v) => Number(v) > 0)
  if (!hasRefund) return null
  const out = []
  for (const i of items) {
    const refunded = Number(refundMap.get(i.sale_item_id)) || 0
    if (refunded > 0) continue
    const amount = Math.max(0, Math.round((Number(i.sale_amount) - Number(i.received)) * 100) / 100)
    if (amount > 0) out.push({ saleItemId: String(i.sale_item_id), amount })
  }
  return out.length > 0 ? out : null
}

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
