













ALTER TABLE "client_wechat_users" ALTER COLUMN "points_balance" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "point_transactions" ALTER COLUMN "amount" SET DATA TYPE bigint;--> statement-breakpoint


UPDATE "client_wechat_users" SET "phone" = NULL WHERE "phone" IS NOT NULL AND "phone" !~ '^1[3-9][0-9]{9}$';--> statement-breakpoint
UPDATE "staff_wechat_users" SET "phone" = NULL WHERE "phone" IS NOT NULL AND "phone" !~ '^1[3-9][0-9]{9}$';--> statement-breakpoint

ALTER TABLE "client_wechat_users" ADD CONSTRAINT "chk_cwu_phone_format" CHECK ("client_wechat_users"."phone" IS NULL OR "client_wechat_users"."phone" ~ '^1[3-9][0-9]{9}$');--> statement-breakpoint
ALTER TABLE "staff_wechat_users" ADD CONSTRAINT "chk_swu_phone_format" CHECK ("staff_wechat_users"."phone" IS NULL OR "staff_wechat_users"."phone" ~ '^1[3-9][0-9]{9}$');--> statement-breakpoint
ALTER TABLE "point_transactions" ADD CONSTRAINT "chk_pt_amount_sign" CHECK (("point_transactions"."amount" < 0 AND "point_transactions"."type" = '消费冲销') OR "point_transactions"."amount" > 0);--> statement-breakpoint
ALTER TABLE "card_transactions" ADD CONSTRAINT "chk_card_tx_amount_sign" CHECK (("card_transactions"."type" = '充值' AND "card_transactions"."amount" > 0) OR ("card_transactions"."type" = '扣款' AND "card_transactions"."amount" < 0));--> statement-breakpoint
ALTER TABLE "prepaid_cards" ADD CONSTRAINT "chk_prepaid_balance_nonneg" CHECK ("prepaid_cards"."balance" >= 0);--> statement-breakpoint






ALTER DATABASE fengyu SET timezone = 'Asia/Shanghai';
