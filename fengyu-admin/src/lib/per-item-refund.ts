/**
 * 行级退款额聚合 — admin 独立副本
 *
 * 跨端约定（no-shared-cloudfunctions）：clientApi / payNotify / staffApi / admin 各保留
 * 同语义独立副本，由 cross-end-sql-snapshot.test.js 守护字面同义（与 paid-sessions.ts
 * 的 RECEIVED_REFUNDED_DEDUCT_SQL 同源 CTE）。
 *
 * 背景：sale_items 表无 refunded_amount 列，行级退款金额权威源 =
 * sale_order_payments.note.items[].refundAmount（change_type='退款' AND status='已支付'）。
 *
 * 用途：getRepayable 行级可回款额（已退行=0）、recordPayment 校验已退行不可回款。
 */
import { sql } from 'drizzle-orm'
import { db } from '@/db'

/**
 * 单订单行级退款 Map（db.execute 读用）。
 * @returns Map<saleItemId, refundedNumber>（仅含退过的行；未退行不在 map 中）
 */
export async function getPerItemRefundedMap(saleOrderId: string): Promise<Map<string, number>> {
  // db.execute 走 drizzle-orm/postgres-js，返回 postgres.js RowList（array-like，无 .rows）
  const res = await db.execute(sql`
    WITH refund_items AS (
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
      WHERE sop.sale_order_id = ${saleOrderId}
        AND sop.change_type = '退款'
        AND sop.status = '已支付'
        AND elem ->> 'refSaleItemId' IS NOT NULL
        AND elem ->> 'refSaleItemId' <> 'OVERPAY'
    )
    SELECT sale_item_id, SUM(refund_amount) AS refunded
    FROM refund_items GROUP BY sale_item_id
  `)
  const rows = (res as unknown) as Array<{ sale_item_id: string; refunded: string | number }>
  const m = new Map<string, number>()
  for (const r of rows) {
    m.set(r.sale_item_id, Number(r.refunded || 0))
  }
  return m
}
