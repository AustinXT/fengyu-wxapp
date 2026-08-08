ALTER TABLE "product_skus" ADD COLUMN "unit" text DEFAULT '次' NOT NULL;--> statement-breakpoint
UPDATE "product_skus" SET "unit" = '盒' WHERE "product_type" = '家居产品';
