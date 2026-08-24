-- 销售订单阶段按顾客达标消费次数冻结。
-- 达标单：已结清的销售单，或已结清且现付净额达阈值的转换单。
-- 内部单、寄存单、充值单只读取历史次数，自身不增加次数。

CREATE TYPE "public"."document_type_v2" AS ENUM ('售前一次', '售前二次', '售后');
ALTER TABLE sale_orders
  ALTER COLUMN document_type TYPE "public"."document_type_v2"
  USING (CASE document_type::text
    WHEN '售后' THEN '售后'
    ELSE '售前一次'
  END)::"public"."document_type_v2";
DROP TYPE "public"."document_type";
ALTER TYPE "public"."document_type_v2" RENAME TO "document_type";

-- 存量回填：按顾客支付时间顺序计算截至当前订单的达标次数。
WITH cfg AS (
  SELECT COALESCE(
    (SELECT CASE
       WHEN value ~ '^\s*[0-9]+(\.[0-9]+)?\s*$' AND value::numeric > 0 THEN value::numeric
       ELSE 1980::numeric
     END FROM system_configs WHERE key = 'new_member_threshold' LIMIT 1),
    1980::numeric
  ) AS threshold
), base AS (
  SELECT o.sale_order_id, o.client_user_id,
         COALESCE(o.paid_at, o.sale_order_datetime, o.created_at) AS order_at,
         CASE
           WHEN o.status IN ('部分支付', '已支付', '已完成')
            AND ((o.sale_order_type = '销售单'
                  AND GREATEST(o.received::numeric - o.refunded_amount::numeric, 0) >= cfg.threshold)
                 OR (o.sale_order_type = '转换单'
                  AND GREATEST(COALESCE((
                    SELECT SUM(CASE
                      WHEN sop.change_type IN ('首次支付', '回款') THEN sop.amount
                      WHEN sop.change_type = '退款' AND sop.payment_method <> '储值卡' THEN sop.amount
                      ELSE 0 END)
                    FROM sale_order_payments sop
                    WHERE sop.sale_order_id = o.sale_order_id AND sop.status = '已支付'
                  ), 0), 0) >= cfg.threshold))
           THEN 1 ELSE 0 END AS is_hit
    FROM sale_orders o CROSS JOIN cfg
   WHERE o.client_user_id IS NOT NULL
), ranked AS (
  SELECT sale_order_id,
         1 + COALESCE(SUM(is_hit) OVER (
           PARTITION BY client_user_id
           ORDER BY order_at, sale_order_id
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
         ), 0) AS stage_index
    FROM base
)
UPDATE sale_orders o
   SET document_type = CASE
     WHEN ranked.stage_index <= 1 THEN '售前一次'::document_type
     WHEN ranked.stage_index = 2 THEN '售前二次'::document_type
     ELSE '售后'::document_type
   END
  FROM ranked
 WHERE ranked.sale_order_id = o.sale_order_id;

UPDATE sale_orders
   SET document_type = '售前一次'::document_type
 WHERE client_user_id IS NULL OR document_type IS NULL;
