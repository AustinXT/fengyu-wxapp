CREATE TABLE "inventory_cutover_states" (
	"cutover_key" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT '待初始化' NOT NULL,
	"as_of_date" date,
	"source_row_count" integer,
	"source_quantity" numeric(14, 2),
	"imported_doc_count" integer,
	"imported_item_count" integer,
	"initialized_by" varchar(30),
	"initialized_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_inventory_cutover_states_status" CHECK ("inventory_cutover_states"."status" IN ('待初始化','待核验','已初始化'))
);
--> statement-breakpoint
ALTER TABLE "inventory_promotion_plans" ADD COLUMN "rule_type" text DEFAULT '单品阶梯' NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_cutover_states" ADD CONSTRAINT "inventory_cutover_states_initialized_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("initialized_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_inventory_promotion_rule_type" ON "inventory_promotion_plans" USING btree ("rule_type");--> statement-breakpoint
ALTER TABLE "inventory_promotion_plans" ADD CONSTRAINT "chk_inventory_promotion_rule_type" CHECK ("inventory_promotion_plans"."rule_type" IN ('单品阶梯','组合'));