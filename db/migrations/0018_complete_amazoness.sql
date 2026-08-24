ALTER TABLE "inventory_doc_items" ADD COLUMN "promotion_plan_id" text;--> statement-breakpoint
ALTER TABLE "inventory_doc_items" ADD COLUMN "promotion_plan_no_snapshot" text;--> statement-breakpoint
ALTER TABLE "inventory_doc_items" ADD COLUMN "promotion_plan_name_snapshot" text;--> statement-breakpoint
ALTER TABLE "inventory_doc_items" ADD COLUMN "promotion_rule_type_snapshot" text;--> statement-breakpoint
ALTER TABLE "inventory_doc_items" ADD COLUMN "promotion_selection_mode" text;--> statement-breakpoint
ALTER TABLE "inventory_doc_items" ADD CONSTRAINT "inventory_doc_items_promotion_plan_id_inventory_promotion_plans_id_fk" FOREIGN KEY ("promotion_plan_id") REFERENCES "public"."inventory_promotion_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_inventory_doc_items_promotion" ON "inventory_doc_items" USING btree ("promotion_plan_id");--> statement-breakpoint
ALTER TABLE "inventory_doc_items" ADD CONSTRAINT "chk_inventory_doc_items_promotion_rule_type" CHECK ("inventory_doc_items"."promotion_rule_type_snapshot" IS NULL OR "inventory_doc_items"."promotion_rule_type_snapshot" IN ('单品阶梯','组合'));--> statement-breakpoint
ALTER TABLE "inventory_doc_items" ADD CONSTRAINT "chk_inventory_doc_items_promotion_selection_mode" CHECK ("inventory_doc_items"."promotion_selection_mode" IS NULL OR "inventory_doc_items"."promotion_selection_mode" IN ('系统推荐','人工选择'));