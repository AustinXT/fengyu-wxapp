ALTER TABLE "stores" ADD COLUMN "lakala_merchant_no" text;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "lakala_term_no" text;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "lakala_sub_appid" text;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "lakala_enabled" boolean DEFAULT false NOT NULL;