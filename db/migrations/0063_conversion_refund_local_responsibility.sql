CREATE TABLE "conversion_point_transfers" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"from_order_id" varchar(30) NOT NULL,
	"to_order_id" varchar(30) NOT NULL,
	"from_sale_item_id" varchar(30) NOT NULL,
	"excluded_basis_cents" bigint NOT NULL,
	"transferred_points" bigint NOT NULL,
	"batch_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_conversion_point_transfer_nonnegative" CHECK ("conversion_point_transfers"."excluded_basis_cents" >= 0 AND "conversion_point_transfers"."transferred_points" >= 0),
	CONSTRAINT "chk_conversion_point_transfer_different_orders" CHECK ("conversion_point_transfers"."from_order_id" <> "conversion_point_transfers"."to_order_id")
);
--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "conversion_value_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "conversion_point_transfers" ADD CONSTRAINT "conversion_point_transfers_user_id_client_wechat_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."client_wechat_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_point_transfers" ADD CONSTRAINT "conversion_point_transfers_from_order_id_sale_orders_sale_order_id_fk" FOREIGN KEY ("from_order_id") REFERENCES "public"."sale_orders"("sale_order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_point_transfers" ADD CONSTRAINT "conversion_point_transfers_to_order_id_sale_orders_sale_order_id_fk" FOREIGN KEY ("to_order_id") REFERENCES "public"."sale_orders"("sale_order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_point_transfers" ADD CONSTRAINT "conversion_point_transfers_from_sale_item_id_sale_items_sale_item_id_fk" FOREIGN KEY ("from_sale_item_id") REFERENCES "public"."sale_items"("sale_item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conversion_point_transfer_item" ON "conversion_point_transfers" USING btree ("to_order_id","from_sale_item_id");--> statement-breakpoint
CREATE INDEX "idx_conversion_point_transfer_from" ON "conversion_point_transfers" USING btree ("from_order_id");--> statement-breakpoint
CREATE INDEX "idx_conversion_point_transfer_to" ON "conversion_point_transfers" USING btree ("to_order_id");