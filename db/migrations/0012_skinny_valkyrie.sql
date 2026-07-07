ALTER TABLE "stores" ADD COLUMN "closed_at" date;--> statement-breakpoint
ALTER TABLE "staff_wechat_users" ADD COLUMN "hired_at" date;--> statement-breakpoint
ALTER TABLE "staff_wechat_users" ADD COLUMN "resigned_at" date;
--> statement-breakpoint








UPDATE staff_wechat_users
   SET hired_at = created_at::date
 WHERE hired_at IS NULL;
--> statement-breakpoint


UPDATE staff_wechat_users
   SET resigned_at = updated_at::date
 WHERE is_resigned = TRUE
   AND resigned_at IS NULL;
--> statement-breakpoint


UPDATE stores
   SET closed_at = updated_at::date
 WHERE is_closed = TRUE
   AND closed_at IS NULL;
--> statement-breakpoint


UPDATE stores
   SET opening_date = created_at::date
 WHERE opening_date IS NULL;