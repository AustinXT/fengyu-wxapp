ALTER TABLE "user_coupons" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "card_transactions" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "pickup_records" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sop_first_payment" ON "sale_order_payments" USING btree ("sale_order_id") WHERE change_type = '首次支付' AND status = '已支付';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_appt_sale_item_active" ON "appointments" USING btree ("sale_item_id") WHERE sale_item_id IS NOT NULL AND status IN ('待确认','已确认');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_so_appointment" ON "service_orders" USING btree ("appointment_id") WHERE appointment_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_so_client_active" ON "service_orders" USING btree ("client_user_id") WHERE status IN ('待服务','服务中');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_store_unbind_pending" ON "store_unbind_requests" USING btree ("user_id") WHERE status = '待处理';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_coupons_external_ref" ON "user_coupons" USING btree ("external_ref") WHERE external_ref IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_point_txn_order_user_type" ON "point_transactions" USING btree ("user_id","ref_order_id","type") WHERE ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_card_txn_external_ref" ON "card_transactions" USING btree ("external_ref") WHERE external_ref IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pickup_idempotency" ON "pickup_records" USING btree ("sale_item_id","idempotency_key") WHERE idempotency_key IS NOT NULL;