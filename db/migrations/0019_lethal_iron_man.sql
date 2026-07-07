ALTER TYPE "public"."sale_order_type" ADD VALUE '回款单' BEFORE '转换单';--> statement-breakpoint
ALTER TYPE "public"."sale_order_type" ADD VALUE '退款单';--> statement-breakpoint
ALTER TABLE "product_skus" ADD COLUMN "is_recharge_card" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "is_recharge_card" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_order_payments" ADD COLUMN "operator_employee_id" varchar(30);--> statement-breakpoint
ALTER TABLE "sale_order_payments" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "sale_order_payments" ADD CONSTRAINT "sale_order_payments_operator_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("operator_employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_product_skus_is_recharge_card" ON "product_skus" USING btree ("is_recharge_card") WHERE "product_skus"."is_recharge_card" = true;--> statement-breakpoint
ALTER TABLE "product_skus" ADD CONSTRAINT "chk_sku_not_both_capabilities" CHECK (NOT ("product_skus"."is_experience" AND "product_skus"."is_recharge_card"));



UPDATE "product_skus" ps
SET "is_recharge_card" = true
WHERE EXISTS (
  SELECT 1 FROM "product_categories" pc
  WHERE pc."category_id" = ps."category_id"
    AND pc."product_kind" = '充值卡'
);



UPDATE "sale_items" si
SET "is_recharge_card" = true
WHERE EXISTS (
  SELECT 1 FROM "product_skus" ps
  WHERE ps."sku_id" = si."sku_id"
    AND ps."is_recharge_card" = true
);