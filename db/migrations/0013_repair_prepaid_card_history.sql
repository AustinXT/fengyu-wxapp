-- 坏版 0011 曾按旧 prepaid_card_amount 与卡支付净流水的差额补正向抵扣。
-- 已发生储值卡退款时，该差额其实是退款，不是缺失扣款。保留原行用于审计，
-- 仅把完全匹配迁移指纹的污染行作废；重复执行时已作废行不会再次变化。
UPDATE sale_order_payments
SET status = '已作废'::payment_flow_status
WHERE status = '已支付'
  AND change_type = '储值卡抵扣'
  AND payment_method = '储值卡'
  AND source_end = 'admin'
  AND operator_employee_id IS NULL
  AND external_txn_id IS NULL
  AND ref_sale_item_id IS NULL
  AND allocation_status IS NULL
  AND note = '系统迁移补齐历史储值卡实付';--> statement-breakpoint

-- 作废旧合成行后，以 card_transactions 有符号净额为扣卡事实，补齐仍真实缺失的部分。
-- 保留 0012 已正确补出的流水；v2 marker + 差额算法让本段重复执行也不会重复插入。
WITH card_evidence AS (
  SELECT ct.ref_order_id AS sale_order_id,
         GREATEST(0, ROUND(-SUM(ct.amount::numeric), 2))::numeric(10, 2) AS evidenced_prepaid,
         MIN(ct.created_at) AS first_card_at
  FROM card_transactions ct
  JOIN sale_orders so ON so.sale_order_id = ct.ref_order_id
  WHERE ct.ref_order_id IS NOT NULL
    AND so.sale_order_type IN ('销售单', '内部单', '转换单')
  GROUP BY ct.ref_order_id
),
settled_after_void AS (
  SELECT so.sale_order_id,
         COALESCE(SUM(sop.amount::numeric) FILTER (
           WHERE sop.status = '已支付'
             AND (sop.change_type = '储值卡抵扣'
                  OR (sop.change_type = '退款' AND sop.payment_method = '储值卡'))
         ), 0)::numeric AS settled_prepaid
  FROM sale_orders so
  LEFT JOIN sale_order_payments sop ON sop.sale_order_id = so.sale_order_id
  WHERE so.sale_order_type IN ('销售单', '内部单', '转换单')
  GROUP BY so.sale_order_id
),
missing_card_payments AS (
  SELECT ce.sale_order_id,
         ROUND(ce.evidenced_prepaid - sav.settled_prepaid, 2)::numeric(10, 2) AS missing_prepaid,
         ce.first_card_at
  FROM card_evidence ce
  JOIN settled_after_void sav ON sav.sale_order_id = ce.sale_order_id
  WHERE ROUND(ce.evidenced_prepaid - sav.settled_prepaid, 2) > 0
)
INSERT INTO sale_order_payments (
  sale_order_id, change_type, amount, payment_method, external_txn_id,
  status, source_end, operator_employee_id, note, created_at, paid_at
)
SELECT mcp.sale_order_id,
       '储值卡抵扣'::payment_change_type,
       mcp.missing_prepaid,
       '储值卡'::payment_method,
       NULL,
       '已支付'::payment_flow_status,
       'admin'::payment_source_end,
       NULL,
       'migration:0013:card-transaction-recovery-v2',
       COALESCE(mcp.first_card_at, so.paid_at, so.sale_order_datetime, so.created_at),
       COALESCE(mcp.first_card_at, so.paid_at, so.sale_order_datetime, so.created_at)
FROM missing_card_payments mcp
JOIN sale_orders so ON so.sale_order_id = mcp.sale_order_id
WHERE NOT EXISTS (
  SELECT 1
  FROM sale_order_payments repaired
  WHERE repaired.sale_order_id = mcp.sale_order_id
    AND repaired.status = '已支付'
    AND repaired.note = 'migration:0013:card-transaction-recovery-v2'
);--> statement-breakpoint

-- 仅重建受坏版 0011 或本次 v2 补流水影响的订单快照。
-- received/refunded_amount 与储值卡余额不在本修复范围内，保持原值。
WITH repair_orders AS (
  SELECT DISTINCT sale_order_id
  FROM sale_order_payments
  WHERE note IN (
    '系统迁移补齐历史储值卡实付',
    'migration:0013:card-transaction-recovery-v2'
  )
),
card_totals AS (
  SELECT ro.sale_order_id,
         GREATEST(0, COALESCE(SUM(sop.amount::numeric) FILTER (
           WHERE sop.status = '已支付'
             AND (sop.change_type = '储值卡抵扣'
                  OR (sop.change_type = '退款' AND sop.payment_method = '储值卡'))
         ), 0))::numeric(10, 2) AS settled_prepaid
  FROM repair_orders ro
  LEFT JOIN sale_order_payments sop ON sop.sale_order_id = ro.sale_order_id
  GROUP BY ro.sale_order_id
),
order_targets AS (
  SELECT so.sale_order_id,
         ct.settled_prepaid,
         GREATEST(
           0,
           so.total_amount::numeric - ct.settled_prepaid - so.pending_prepaid_card_amount::numeric
         )::numeric(10, 2) AS payable
  FROM sale_orders so
  JOIN card_totals ct ON ct.sale_order_id = so.sale_order_id
  WHERE so.sale_order_type IN ('销售单', '内部单', '转换单')
)
UPDATE sale_orders so
SET prepaid_card_amount = ot.settled_prepaid,
    payable_amount = ot.payable,
    updated_at = NOW()
FROM order_targets ot
WHERE so.sale_order_id = ot.sale_order_id
  AND (so.prepaid_card_amount IS DISTINCT FROM ot.settled_prepaid
       OR so.payable_amount IS DISTINCT FROM ot.payable);--> statement-breakpoint

-- 全局重建行级支付通道快照：用累计边界相减替代“前 N-1 行逐行四舍五入、末行吸差”。
-- 正向行的累计边界单调，故不会出现负尾差；有符号转换行仍按 received 原符号分摊。
WITH ranked AS (
  SELECT si.sale_item_id,
         si.sale_order_id,
         si.received::numeric AS item_received,
         so.prepaid_card_amount::numeric AS prepaid_total,
         SUM(si.received::numeric) OVER (PARTITION BY si.sale_order_id) AS received_total,
         SUM(si.received::numeric) OVER (
           PARTITION BY si.sale_order_id
           ORDER BY si.sale_item_id
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ) AS cumulative_received
  FROM sale_items si
  JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
  WHERE si.received::numeric <> 0
),
allocated AS (
  SELECT sale_item_id,
         (
           ROUND(prepaid_total * cumulative_received / received_total, 2)
           - ROUND(prepaid_total * (cumulative_received - item_received) / received_total, 2)
         )::numeric(10, 2) AS prepaid_share
  FROM ranked
  WHERE received_total <> 0 AND prepaid_total <> 0
),
targets AS (
  SELECT si.sale_item_id,
         COALESCE(a.prepaid_share, 0)::numeric(10, 2) AS prepaid_share
  FROM sale_items si
  LEFT JOIN allocated a ON a.sale_item_id = si.sale_item_id
)
UPDATE sale_items si
SET prepaid_card_received = targets.prepaid_share,
    updated_at = NOW()
FROM targets
WHERE si.sale_item_id = targets.sale_item_id
  AND si.prepaid_card_received IS DISTINCT FROM targets.prepaid_share;
