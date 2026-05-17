CREATE TABLE "project_series_lookup" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_valid" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_series_lookup_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "product_skus" ADD COLUMN "project_series_id" bigint;--> statement-breakpoint
ALTER TABLE "product_skus" ADD CONSTRAINT "product_skus_project_series_id_project_series_lookup_id_fk" FOREIGN KEY ("project_series_id") REFERENCES "public"."project_series_lookup"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_categories" DROP COLUMN "is_card_kind";
--> statement-breakpoint
-- 数据回填：项目系列字典初始 4 个种子值
INSERT INTO "project_series_lookup" ("name", "sort_order", "is_valid") VALUES
  ('美学类(面部)', 1, true),
  ('美学类(身体)', 2, true),
  ('健康类(面部)', 3, true),
  ('健康类(身体)', 4, true)
ON CONFLICT ("name") DO NOTHING;