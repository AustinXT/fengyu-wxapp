ALTER TABLE "product_categories" ADD COLUMN "is_card_kind" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "product_categories" ADD COLUMN "display_color" text;--> statement-breakpoint
ALTER TABLE "product_categories" ADD COLUMN "display_icon" text;--> statement-breakpoint
ALTER TABLE "product_categories" ADD COLUMN "requires_shengmei_flag" boolean DEFAULT false NOT NULL;--> statement-breakpoint


UPDATE "product_categories"
   SET "is_card_kind" = true
 WHERE "product_kind" IS NULL
   AND "category_name" IN ('充值卡', '体验卡');
--> statement-breakpoint

UPDATE "product_categories"
   SET "display_color" = CASE "category_name"
         WHEN '组合套餐' THEN '#C0322A'
         WHEN '护理项目' THEN '#1989FA'
         WHEN '家居产品' THEN '#5AACA5'
         WHEN '充值卡'   THEN '#D4820A'
         WHEN '体验卡'   THEN '#8B5CF6'
       END
 WHERE "product_kind" IS NULL
   AND "category_name" IN ('组合套餐', '护理项目', '家居产品', '充值卡', '体验卡');
--> statement-breakpoint

UPDATE "product_categories"
   SET "requires_shengmei_flag" = true
 WHERE "product_kind" IS NULL
   AND "category_name" = '护理项目';