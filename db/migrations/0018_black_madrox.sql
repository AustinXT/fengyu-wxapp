ALTER TYPE "public"."payment_flow_status" ADD VALUE '待审批' BEFORE '已支付';--> statement-breakpoint
CREATE TABLE "sale_order_payment_details" (
	"payment_id" bigint PRIMARY KEY NOT NULL,
	"operator_employee_id" varchar(32),
	"note" text,
	"refund_reason" text,
	"ref_sale_item_id" varchar(30),
	"session_count" integer,
	"audit_employee_id" varchar(32),
	"audit_at" timestamp,
	"audit_remark" text,
	"raw_payload" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sale_orders" DROP CONSTRAINT "sale_orders_wechat_transaction_id_unique";--> statement-breakpoint
ALTER TABLE "sale_orders" DROP CONSTRAINT "sale_orders_alipay_transaction_id_unique";--> statement-breakpoint
ALTER TABLE "sale_order_payments" DROP CONSTRAINT "sale_order_payments_operator_employee_id_staff_wechat_users_employee_id_fk";
--> statement-breakpoint
ALTER TABLE "sale_orders" ADD COLUMN "received" numeric(10, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_orders" ADD COLUMN "refunded_amount" numeric(10, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "service_commissions" ADD COLUMN "voided_at" timestamp;--> statement-breakpoint
ALTER TABLE "service_commissions" ADD COLUMN "voided_reason" text;--> statement-breakpoint
ALTER TABLE "sale_order_payment_details" ADD CONSTRAINT "sale_order_payment_details_payment_id_sale_order_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."sale_order_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_order_payment_details" ADD CONSTRAINT "sale_order_payment_details_operator_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("operator_employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_order_payment_details" ADD CONSTRAINT "sale_order_payment_details_ref_sale_item_id_sale_items_sale_item_id_fk" FOREIGN KEY ("ref_sale_item_id") REFERENCES "public"."sale_items"("sale_item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_order_payment_details" ADD CONSTRAINT "sale_order_payment_details_audit_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("audit_employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_sopd_operator" ON "sale_order_payment_details" USING btree ("operator_employee_id");--> statement-breakpoint
CREATE INDEX "idx_sopd_audit_employee" ON "sale_order_payment_details" USING btree ("audit_employee_id");--> statement-breakpoint
CREATE INDEX "idx_sopd_ref_sale_item" ON "sale_order_payment_details" USING btree ("ref_sale_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sop_status_audit" ON "sale_order_payments" USING btree ("sale_order_id","change_type") WHERE change_type = '退款' AND status = '待审批';--> statement-breakpoint
CREATE INDEX "idx_sc_voided_at" ON "service_commissions" USING btree ("voided_at") WHERE voided_at IS NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_order_payments" DROP COLUMN "operator_employee_id";--> statement-breakpoint
ALTER TABLE "sale_order_payments" DROP COLUMN "note";--> statement-breakpoint
ALTER TABLE "sale_orders" DROP COLUMN "paid_amount";--> statement-breakpoint
ALTER TABLE "sale_orders" DROP COLUMN "wechat_transaction_id";--> statement-breakpoint
ALTER TABLE "sale_orders" DROP COLUMN "alipay_transaction_id";--> statement-breakpoint
ALTER TABLE "public"."sale_orders" ALTER COLUMN "sale_order_type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."sale_order_type";--> statement-breakpoint
CREATE TYPE "public"."sale_order_type" AS ENUM('销售单', '内部单', '转换单');--> statement-breakpoint
ALTER TABLE "public"."sale_orders" ALTER COLUMN "sale_order_type" SET DATA TYPE "public"."sale_order_type" USING "sale_order_type"::"public"."sale_order_type";