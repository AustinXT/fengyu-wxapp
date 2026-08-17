ALTER TABLE "sale_items" ADD COLUMN "prepaid_card_received" numeric(10, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "cash_received" numeric(10, 2) GENERATED ALWAYS AS (received - prepaid_card_received) STORED;--> statement-breakpoint
ALTER TABLE "sale_orders" ADD COLUMN "pending_prepaid_card_amount" numeric(10, 2) DEFAULT '0' NOT NULL;

-- Backfill actual/pending 储值卡语义：旧 prepaid_card_amount 同时包含已结算与预选值。
WITH payment_totals AS (
  SELECT so.sale_order_id,
         so.prepaid_card_amount::numeric AS old_prepaid,
         GREATEST(0, COALESCE(SUM(sop.amount::numeric) FILTER (
           WHERE sop.status = '已支付'
             AND (sop.change_type = '储值卡抵扣'
                  OR (sop.change_type = '退款' AND sop.payment_method = '储值卡'))
         ), 0))::numeric(10, 2) AS settled_prepaid,
         GREATEST(0, COALESCE(SUM(sop.amount::numeric) FILTER (
           WHERE sop.status = '待支付' AND sop.change_type = '储值卡抵扣'
         ), 0))::numeric(10, 2) AS pending_payment
  FROM sale_orders so
  LEFT JOIN sale_order_payments sop ON sop.sale_order_id = so.sale_order_id
  GROUP BY so.sale_order_id, so.prepaid_card_amount
),
resolved AS (
  SELECT pt.sale_order_id,
         pt.settled_prepaid,
         CASE WHEN so.status IN ('待支付','部分支付','支付失败')
                THEN GREATEST(0, pt.old_prepaid - pt.settled_prepaid) + pt.pending_payment
              ELSE 0
         END::numeric(10, 2) AS pending_prepaid
  FROM payment_totals pt
  JOIN sale_orders so ON so.sale_order_id = pt.sale_order_id
)
UPDATE sale_orders so
SET prepaid_card_amount = resolved.settled_prepaid,
    pending_prepaid_card_amount = resolved.pending_prepaid,
    payable_amount = CASE
      WHEN so.sale_order_type IN ('销售单','内部单','转换单')
        THEN GREATEST(0, so.total_amount::numeric - resolved.settled_prepaid - resolved.pending_prepaid)
      ELSE so.payable_amount
    END,
    updated_at = NOW()
FROM resolved
WHERE so.sale_order_id = resolved.sale_order_id;

-- 按 sale_items.received 有符号净额回填储值卡实付分摊；最后一个非零项用减法吸收尾差。
WITH ranked AS (
  SELECT si.sale_item_id,
         si.sale_order_id,
         si.received::numeric AS item_received,
         so.prepaid_card_amount::numeric AS prepaid_total,
         SUM(si.received::numeric) OVER (PARTITION BY si.sale_order_id) AS received_total,
         ROW_NUMBER() OVER (PARTITION BY si.sale_order_id ORDER BY si.sale_item_id) AS rn,
         COUNT(*) OVER (PARTITION BY si.sale_order_id) AS item_count
  FROM sale_items si
  JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
  WHERE si.received::numeric <> 0
),
rounded AS (
  SELECT ranked.*,
         ROUND(prepaid_total * item_received / received_total, 2) AS provisional
  FROM ranked
  WHERE received_total <> 0 AND prepaid_total <> 0
),
allocated AS (
  SELECT sale_item_id,
         CASE WHEN rn = item_count
                THEN prepaid_total - COALESCE(
                  SUM(provisional) FILTER (WHERE rn < item_count) OVER (PARTITION BY sale_order_id),
                  0
                )
              ELSE provisional
         END::numeric(10, 2) AS prepaid_share
  FROM rounded
),
targets AS (
  SELECT si.sale_item_id, COALESCE(allocated.prepaid_share, 0)::numeric(10, 2) AS prepaid_share
  FROM sale_items si
  LEFT JOIN allocated ON allocated.sale_item_id = si.sale_item_id
)
UPDATE sale_items si
SET prepaid_card_received = targets.prepaid_share,
    updated_at = NOW()
FROM targets
WHERE si.sale_item_id = targets.sale_item_id;
