-- 0008: client_wechat_users 新增 gender + notes 字段
ALTER TABLE "client_wechat_users" ADD COLUMN "gender" varchar(10);
ALTER TABLE "client_wechat_users" ADD COLUMN "notes" text;
