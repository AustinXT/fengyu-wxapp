CREATE TABLE "sale_payment_allocatable_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sale_payment_id" bigint NOT NULL,
	"sale_order_id" varchar(30) NOT NULL,
	"sale_item_id" varchar(30) NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"sales_category" "sales_category",
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "uq_sale_alloc_item_emp_role";--> statement-breakpoint
ALTER TABLE "sale_allocations" ADD COLUMN "sale_payment_id" bigint;--> statement-breakpoint
ALTER TABLE "sale_order_payments" ADD COLUMN "allocation_status" "allocation_status";--> statement-breakpoint
ALTER TABLE "sale_payment_allocatable_items" ADD CONSTRAINT "sale_payment_allocatable_items_sale_payment_id_sale_order_payments_id_fk" FOREIGN KEY ("sale_payment_id") REFERENCES "public"."sale_order_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_payment_allocatable_items" ADD CONSTRAINT "sale_payment_allocatable_items_sale_order_id_sale_orders_sale_order_id_fk" FOREIGN KEY ("sale_order_id") REFERENCES "public"."sale_orders"("sale_order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_payment_allocatable_items" ADD CONSTRAINT "sale_payment_allocatable_items_sale_item_id_sale_items_sale_item_id_fk" FOREIGN KEY ("sale_item_id") REFERENCES "public"."sale_items"("sale_item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_spai_payment_item" ON "sale_payment_allocatable_items" USING btree ("sale_payment_id","sale_item_id");--> statement-breakpoint
CREATE INDEX "idx_spai_order" ON "sale_payment_allocatable_items" USING btree ("sale_order_id");--> statement-breakpoint
ALTER TABLE "sale_allocations" ADD CONSTRAINT "sale_allocations_sale_payment_id_sale_order_payments_id_fk" FOREIGN KEY ("sale_payment_id") REFERENCES "public"."sale_order_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sale_alloc_item_emp_role_payment" ON "sale_allocations" USING btree ("sale_item_id","employee_id","role_type","sale_payment_id") WHERE is_void = false;--> statement-breakpoint
CREATE INDEX "idx_sale_alloc_payment" ON "sale_allocations" USING btree ("sale_payment_id");--> statement-breakpoint
CREATE INDEX "idx_sop_alloc_status" ON "sale_order_payments" USING btree ("allocation_status") WHERE allocation_status IS NOT NULL;