ALTER TABLE "client_wechat_users" ADD COLUMN "became_member_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "service_items" DROP COLUMN "is_presale";