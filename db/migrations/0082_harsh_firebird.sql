CREATE TABLE "sale_payment_item_receipts" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "sale_payment_id" bigint NOT NULL,
  "sale_order_id" varchar(30) NOT NULL,
  "sale_item_id" varchar(30) NOT NULL,
  "amount" numeric(10, 2) NOT NULL,
  "sales_category" "sales_category",
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sale_payment_item_allocations" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "sale_payment_item_receipt_id" bigint NOT NULL,
  "employee_id" varchar(30) NOT NULL,
  "role_type" varchar(20) NOT NULL,
  "department_name" varchar(100),
  "allocation_ratio" numeric(5, 3) NOT NULL,
  "allocated_amount" numeric(10, 2) NOT NULL,
  "commission_rate" numeric(5, 4),
  "commission_amount" numeric(10, 2),
  "is_void" boolean DEFAULT false NOT NULL,
  "voided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "chk_spia_ratio" CHECK ("sale_payment_item_allocations"."allocation_ratio" > 0 AND "sale_payment_item_allocations"."allocation_ratio" <= 1)
);
--> statement-breakpoint
ALTER TABLE "sale_payment_item_receipts" ADD CONSTRAINT "sale_payment_item_receipts_sale_payment_id_sale_order_payments_id_fk" FOREIGN KEY ("sale_payment_id") REFERENCES "public"."sale_order_payments"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sale_payment_item_receipts" ADD CONSTRAINT "sale_payment_item_receipts_sale_order_id_sale_orders_sale_order_id_fk" FOREIGN KEY ("sale_order_id") REFERENCES "public"."sale_orders"("sale_order_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sale_payment_item_receipts" ADD CONSTRAINT "sale_payment_item_receipts_sale_item_id_sale_items_sale_item_id_fk" FOREIGN KEY ("sale_item_id") REFERENCES "public"."sale_items"("sale_item_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sale_payment_item_allocations" ADD CONSTRAINT "sale_payment_item_allocations_sale_payment_item_receipt_id_sale_payment_item_receipts_id_fk" FOREIGN KEY ("sale_payment_item_receipt_id") REFERENCES "public"."sale_payment_item_receipts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sale_payment_item_allocations" ADD CONSTRAINT "sale_payment_item_allocations_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_spir_payment_item" ON "sale_payment_item_receipts" USING btree ("sale_payment_id","sale_item_id");
--> statement-breakpoint
CREATE INDEX "idx_spir_payment" ON "sale_payment_item_receipts" USING btree ("sale_payment_id");
--> statement-breakpoint
CREATE INDEX "idx_spir_order" ON "sale_payment_item_receipts" USING btree ("sale_order_id");
--> statement-breakpoint
CREATE INDEX "idx_spir_order_item" ON "sale_payment_item_receipts" USING btree ("sale_order_id","sale_item_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_spia_receipt_emp_role" ON "sale_payment_item_allocations" USING btree ("sale_payment_item_receipt_id","employee_id","role_type") WHERE is_void = false;
--> statement-breakpoint
CREATE INDEX "idx_spia_receipt" ON "sale_payment_item_allocations" USING btree ("sale_payment_item_receipt_id");
--> statement-breakpoint
CREATE INDEX "idx_spia_employee" ON "sale_payment_item_allocations" USING btree ("employee_id");
--> statement-breakpoint
INSERT INTO sale_payment_item_receipts
  (sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at)
SELECT spai.sale_payment_id,
       spai.sale_order_id,
       spai.sale_item_id,
       CASE
         WHEN si.item_direction = '转出' THEN -ABS(spai.amount::numeric)
         ELSE spai.amount::numeric
       END AS amount,
       spai.sales_category,
       spai.created_at
  FROM sale_payment_allocatable_items spai
  JOIN sale_order_payments sop ON sop.id = spai.sale_payment_id
  JOIN sale_items si ON si.sale_item_id = spai.sale_item_id
 WHERE sop.change_type IN ('首次支付','回款','储值卡抵扣')
ON CONFLICT (sale_payment_id, sale_item_id)
DO UPDATE SET amount = EXCLUDED.amount, sales_category = EXCLUDED.sales_category;
--> statement-breakpoint
WITH explicit_alloc_receipts AS (
  SELECT sa.sale_payment_id,
         si.sale_order_id,
         sa.sale_item_id,
         CASE
           WHEN si.item_direction = '转出' THEN -ABS(MAX(ABS(sa.total_amount::numeric / NULLIF(sa.allocation_ratio::numeric, 0))))
           ELSE MAX(ABS(sa.total_amount::numeric / NULLIF(sa.allocation_ratio::numeric, 0)))
         END AS amount,
         si.sales_category,
         MIN(sa.created_at) AS created_at
    FROM sale_allocations sa
    JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
    JOIN sale_order_payments sop ON sop.id = sa.sale_payment_id
   WHERE sa.sale_payment_id IS NOT NULL
     AND sa.allocation_ratio::numeric > 0
     AND sop.change_type IN ('首次支付','回款','储值卡抵扣')
   GROUP BY sa.sale_payment_id, si.sale_order_id, sa.sale_item_id, si.sales_category, sop.change_type, si.item_direction
)
INSERT INTO sale_payment_item_receipts
  (sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at)
SELECT sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at
  FROM explicit_alloc_receipts
 WHERE amount IS NOT NULL
ON CONFLICT (sale_payment_id, sale_item_id) DO NOTHING;
--> statement-breakpoint
WITH note_refund_items AS (
  SELECT sop.id AS sale_payment_id,
         sop.sale_order_id,
         elem ->> 'refSaleItemId' AS sale_item_id,
         COALESCE((elem ->> 'refundAmount')::numeric, 0) AS refund_amount,
         COALESCE(sop.paid_at, sop.created_at, NOW()) AS created_at
    FROM sale_order_payments sop
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN sop.note LIKE '{%'
           THEN CASE WHEN jsonb_typeof((sop.note)::jsonb -> 'items') = 'array'
                     THEN (sop.note)::jsonb -> 'items'
                     ELSE '[]'::jsonb END
           ELSE '[]'::jsonb END
    ) AS elem
   WHERE sop.change_type = '退款'
     AND sop.status = '已支付'
     AND elem ->> 'refSaleItemId' IS NOT NULL
     AND elem ->> 'refSaleItemId' <> 'OVERPAY'
),
legacy_single_refund_items AS (
  SELECT sop.id AS sale_payment_id,
         sop.sale_order_id,
         sop.ref_sale_item_id AS sale_item_id,
         ABS(sop.amount::numeric) AS refund_amount,
         COALESCE(sop.paid_at, sop.created_at, NOW()) AS created_at
    FROM sale_order_payments sop
   WHERE sop.change_type = '退款'
     AND sop.status = '已支付'
     AND sop.ref_sale_item_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM note_refund_items nri WHERE nri.sale_payment_id = sop.id
     )
),
refund_receipts AS (
  SELECT ri.sale_payment_id,
         ri.sale_order_id,
         ri.sale_item_id,
         -ABS(SUM(ri.refund_amount)) AS amount,
         si.sales_category,
         MIN(ri.created_at) AS created_at
    FROM (
      SELECT * FROM note_refund_items
      UNION ALL
      SELECT * FROM legacy_single_refund_items
    ) ri
    JOIN sale_items si
      ON si.sale_order_id = ri.sale_order_id
     AND si.sale_item_id = ri.sale_item_id
     AND si.item_direction = '购买'
   WHERE ri.refund_amount > 0
   GROUP BY ri.sale_payment_id, ri.sale_order_id, ri.sale_item_id, si.sales_category
)
INSERT INTO sale_payment_item_receipts
  (sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at)
SELECT sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at
  FROM refund_receipts
 WHERE amount IS NOT NULL
ON CONFLICT (sale_payment_id, sale_item_id)
DO UPDATE SET amount = EXCLUDED.amount, sales_category = EXCLUDED.sales_category;
--> statement-breakpoint
WITH first_paid_payment AS (
  SELECT DISTINCT ON (sale_order_id)
         sale_order_id,
         id AS sale_payment_id
    FROM sale_order_payments
   WHERE status = '已支付'
     AND change_type IN ('首次支付','回款','储值卡抵扣')
   ORDER BY sale_order_id, paid_at NULLS LAST, id
),
legacy_order_receipts AS (
  SELECT fpp.sale_payment_id,
         si.sale_order_id,
         sa.sale_item_id,
         CASE
           WHEN si.item_direction = '转出' THEN -ABS(MAX(ABS(sa.total_amount::numeric / NULLIF(sa.allocation_ratio::numeric, 0))))
           ELSE MAX(ABS(sa.total_amount::numeric / NULLIF(sa.allocation_ratio::numeric, 0)))
         END AS amount,
         si.sales_category,
         MIN(sa.created_at) AS created_at
    FROM sale_allocations sa
    JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
    JOIN first_paid_payment fpp ON fpp.sale_order_id = si.sale_order_id
   WHERE sa.sale_payment_id IS NULL
     AND sa.allocation_ratio::numeric > 0
   GROUP BY fpp.sale_payment_id, si.sale_order_id, sa.sale_item_id, si.sales_category, si.item_direction
)
INSERT INTO sale_payment_item_receipts
  (sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at)
SELECT sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at
  FROM legacy_order_receipts
 WHERE amount IS NOT NULL
ON CONFLICT (sale_payment_id, sale_item_id) DO NOTHING;
--> statement-breakpoint
WITH first_paid_payment AS (
  SELECT DISTINCT ON (sale_order_id)
         sale_order_id,
         id AS sale_payment_id
    FROM sale_order_payments
   WHERE status = '已支付'
     AND change_type IN ('首次支付','回款','储值卡抵扣')
   ORDER BY sale_order_id, paid_at NULLS LAST, id
),
legacy_allocs AS (
  SELECT sa.*,
         si.sale_order_id,
         COALESCE(sa.sale_payment_id, fpp.sale_payment_id) AS target_sale_payment_id
    FROM sale_allocations sa
    JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
    LEFT JOIN first_paid_payment fpp ON fpp.sale_order_id = si.sale_order_id
)
INSERT INTO sale_payment_item_allocations
  (sale_payment_item_receipt_id, employee_id, role_type, department_name, allocation_ratio,
   allocated_amount, commission_rate, commission_amount, is_void, voided_at, created_at, updated_at)
SELECT spir.id,
       la.employee_id,
       COALESCE(NULLIF(la.role_type, ''), '美容师') AS role_type,
       la.department_name,
       la.allocation_ratio,
       la.total_amount,
       la.commission_rate,
       la.commission_amount,
       la.is_void,
       la.voided_at,
       la.created_at,
       la.updated_at
  FROM legacy_allocs la
  JOIN sale_payment_item_receipts spir
    ON spir.sale_payment_id = la.target_sale_payment_id
   AND spir.sale_item_id = la.sale_item_id
 WHERE la.target_sale_payment_id IS NOT NULL
ON CONFLICT (sale_payment_item_receipt_id, employee_id, role_type) WHERE is_void = false DO NOTHING;
