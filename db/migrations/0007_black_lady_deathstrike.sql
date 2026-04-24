ALTER TABLE "client_wechat_users" ADD COLUMN "inviter_user_id" text;--> statement-breakpoint
ALTER TABLE "client_wechat_users" ADD COLUMN "invited_at" timestamp;--> statement-breakpoint
ALTER TABLE "user_coupons" ADD COLUMN "face_value_override" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "client_wechat_users" ADD CONSTRAINT "client_wechat_users_inviter_user_id_client_wechat_users_user_id_fk" FOREIGN KEY ("inviter_user_id") REFERENCES "public"."client_wechat_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_client_users_inviter" ON "client_wechat_users" USING btree ("inviter_user_id") WHERE inviter_user_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "client_wechat_users" ADD CONSTRAINT "chk_inviter_not_self" CHECK ("client_wechat_users"."inviter_user_id" IS NULL OR "client_wechat_users"."inviter_user_id" <> "client_wechat_users"."user_id");