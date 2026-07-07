




ALTER TABLE "sale_order_payments" ADD COLUMN "operator_employee_id" varchar(30);--> statement-breakpoint
ALTER TABLE "sale_order_payments" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "sale_order_payments" ADD COLUMN "refund_reason" text;--> statement-breakpoint
ALTER TABLE "sale_order_payments" ADD COLUMN "ref_sale_item_id" varchar(30);--> statement-breakpoint
ALTER TABLE "sale_order_payments" ADD COLUMN "session_count" integer;--> statement-breakpoint
ALTER TABLE "sale_order_payments" ADD COLUMN "audit_employee_id" varchar(30);--> statement-breakpoint
ALTER TABLE "sale_order_payments" ADD COLUMN "audit_at" timestamp;--> statement-breakpoint
ALTER TABLE "sale_order_payments" ADD COLUMN "audit_remark" text;--> statement-breakpoint


DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'sale_order_payment_details') THEN
    UPDATE sale_order_payments sop
    SET
      operator_employee_id = sopd.operator_employee_id,
      note                 = sopd.note,
      refund_reason        = sopd.refund_reason,
      ref_sale_item_id     = sopd.ref_sale_item_id,
      session_count        = sopd.session_count,
      audit_employee_id    = sopd.audit_employee_id,
      audit_at             = sopd.audit_at,
      audit_remark         = sopd.audit_remark
    FROM sale_order_payment_details sopd
    WHERE sopd.payment_id = sop.id;
  END IF;
END $$;
--> statement-breakpoint


ALTER TABLE "sale_order_payments" ADD CONSTRAINT "sale_order_payments_operator_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("operator_employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_order_payments" ADD CONSTRAINT "sale_order_payments_ref_sale_item_id_sale_items_sale_item_id_fk" FOREIGN KEY ("ref_sale_item_id") REFERENCES "public"."sale_items"("sale_item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_order_payments" ADD CONSTRAINT "sale_order_payments_audit_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("audit_employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint


DROP TABLE IF EXISTS "sale_order_payment_details" CASCADE;--> statement-breakpoint


ALTER TABLE "sale_allocations" ADD CONSTRAINT "chk_sale_alloc_ratio" CHECK ("sale_allocations"."allocation_ratio" IN (0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 1.00));--> statement-breakpoint
ALTER TABLE "service_commissions" ADD CONSTRAINT "chk_svc_comm_commission_amount" CHECK ("service_commissions"."commission_amount" >= 0);--> statement-breakpoint
ALTER TABLE "service_commissions" ADD CONSTRAINT "chk_svc_comm_commission_rate" CHECK ("service_commissions"."commission_rate" >= 0 AND "service_commissions"."commission_rate" <= 1);--> statement-breakpoint
ALTER TABLE "service_commissions" ADD CONSTRAINT "chk_svc_comm_alloc_ratio" CHECK ("service_commissions"."allocation_ratio" IS NULL OR "service_commissions"."allocation_ratio" IN (0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 1.00));
