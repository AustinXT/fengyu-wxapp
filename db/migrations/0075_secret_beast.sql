DROP INDEX "uq_sale_orders_client_pending";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sale_orders_client_pending" ON "sale_orders" USING btree ("client_user_id") WHERE status = '待支付' AND client_user_id IS NOT NULL AND opened_by IS NULL;
