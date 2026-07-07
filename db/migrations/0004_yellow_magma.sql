CREATE TYPE "public"."payment_change_type" AS ENUM('首次支付', '回款', '退款', '储值卡抵扣');--> statement-breakpoint
CREATE TYPE "public"."payment_flow_status" AS ENUM('待支付', '已支付', '已作废', '已退款');--> statement-breakpoint
CREATE TYPE "public"."payment_source_end" AS ENUM('client', 'staff', 'admin', 'notify');--> statement-breakpoint
ALTER TYPE "public"."order_status" ADD VALUE '部分支付';--> statement-breakpoint
ALTER TYPE "public"."payment_method" ADD VALUE '储值卡';--> statement-breakpoint
CREATE TABLE "sale_order_payments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sale_order_id" varchar(30) NOT NULL,
	"change_type" "payment_change_type" NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"external_txn_id" text,
	"status" "payment_flow_status" NOT NULL,
	"source_end" "payment_source_end" NOT NULL,
	"operator_employee_id" varchar(32),
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"paid_at" timestamp,
	CONSTRAINT "chk_sop_amount_sign" CHECK (("sale_order_payments"."change_type" IN ('首次支付','回款','储值卡抵扣') AND "sale_order_payments"."amount" > 0)
          OR ("sale_order_payments"."change_type" = '退款' AND "sale_order_payments"."amount" < 0)),
	CONSTRAINT "chk_sop_method_txn" CHECK ("sale_order_payments"."payment_method" NOT IN ('微信','支付宝') OR "sale_order_payments"."external_txn_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "sale_orders" ADD COLUMN "payable_amount" numeric(10, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_order_payments" ADD CONSTRAINT "sale_order_payments_sale_order_id_sale_orders_sale_order_id_fk" FOREIGN KEY ("sale_order_id") REFERENCES "public"."sale_orders"("sale_order_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_order_payments" ADD CONSTRAINT "sale_order_payments_operator_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("operator_employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_sop_order" ON "sale_order_payments" USING btree ("sale_order_id");--> statement-breakpoint
CREATE INDEX "idx_sop_status_created" ON "sale_order_payments" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sop_txn" ON "sale_order_payments" USING btree ("sale_order_id","payment_method","external_txn_id") WHERE external_txn_id IS NOT NULL;--> statement-breakpoint






ALTER TABLE "sale_orders" DROP CONSTRAINT IF EXISTS "chk_prepaid_paid_sum";--> statement-breakpoint

UPDATE "sale_orders" SET "payable_amount" = "total_amount" - "prepaid_card_amount";--> statement-breakpoint


INSERT INTO "sale_order_payments" (
  "sale_order_id", "change_type", "amount", "payment_method",
  "external_txn_id", "status", "source_end", "operator_employee_id",
  "note", "created_at", "paid_at"
)
SELECT
  "sale_order_id",
  '首次支付',
  "paid_amount",
  "payment_method",
  COALESCE("wechat_transaction_id", "alipay_transaction_id"),
  '已支付'::"payment_flow_status",
  CASE WHEN "opened_by" IS NOT NULL THEN 'staff'::"payment_source_end" ELSE 'client'::"payment_source_end" END,
  "opened_by",
  '系统迁移回填',
  "created_at",
  COALESCE("paid_at", "created_at")
FROM "sale_orders"
WHERE "sale_order_type" = '销售单'
  AND "status" IN ('已支付', '已完成')
  AND "paid_amount" > 0
  AND ("payment_method" NOT IN ('微信','支付宝') OR COALESCE("wechat_transaction_id","alipay_transaction_id") IS NOT NULL);--> statement-breakpoint

INSERT INTO "sale_order_payments" (
  "sale_order_id", "change_type", "amount", "payment_method",
  "external_txn_id", "status", "source_end", "operator_employee_id",
  "note", "created_at", "paid_at"
)
SELECT
  "ref_sale_order_id",
  '回款',
  "paid_amount",
  "payment_method",
  COALESCE("wechat_transaction_id", "alipay_transaction_id"),
  '已支付'::"payment_flow_status",
  CASE WHEN "opened_by" IS NOT NULL THEN 'staff'::"payment_source_end" ELSE 'client'::"payment_source_end" END,
  "opened_by",
  '系统迁移回填（回款凭证）',
  "created_at",
  COALESCE("paid_at", "created_at")
FROM "sale_orders"
WHERE "sale_order_type" = '回款单'
  AND "ref_sale_order_id" IS NOT NULL
  AND "status" IN ('已支付', '已完成')
  AND "paid_amount" > 0
  AND ("payment_method" NOT IN ('微信','支付宝') OR COALESCE("wechat_transaction_id","alipay_transaction_id") IS NOT NULL);--> statement-breakpoint

INSERT INTO "sale_order_payments" (
  "sale_order_id", "change_type", "amount", "payment_method",
  "external_txn_id", "status", "source_end", "operator_employee_id",
  "note", "created_at", "paid_at"
)
SELECT
  "ref_sale_order_id",
  '退款',
  "paid_amount",
  "payment_method",
  COALESCE("wechat_transaction_id", "alipay_transaction_id"),
  '已支付'::"payment_flow_status",
  CASE WHEN "opened_by" IS NOT NULL THEN 'staff'::"payment_source_end" ELSE 'client'::"payment_source_end" END,
  "opened_by",
  '系统迁移回填（退款凭证）',
  "created_at",
  COALESCE("paid_at", "created_at")
FROM "sale_orders"
WHERE "sale_order_type" = '退款单'
  AND "ref_sale_order_id" IS NOT NULL
  AND "status" IN ('已支付', '已完成')
  AND "paid_amount" < 0
  AND ("payment_method" NOT IN ('微信','支付宝') OR COALESCE("wechat_transaction_id","alipay_transaction_id") IS NOT NULL);