ALTER TYPE "public"."order_type" ADD VALUE '促销方案';--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "promotion_scheme_id" text;