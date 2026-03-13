CREATE TYPE "public"."service_order_type" AS ENUM('普通', '体验');--> statement-breakpoint
ALTER TABLE "appointments" RENAME COLUMN "customer_name" TO "client_name";--> statement-breakpoint
ALTER TABLE "service_orders" ADD COLUMN "service_order_type" "service_order_type" DEFAULT '普通' NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" DROP COLUMN "market_name";