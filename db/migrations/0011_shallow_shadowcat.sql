ALTER TYPE "public"."payment_method" ADD VALUE 'alipay' BEFORE 'offline';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "alipay_transaction_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_alipay_transaction_id_unique" UNIQUE("alipay_transaction_id");