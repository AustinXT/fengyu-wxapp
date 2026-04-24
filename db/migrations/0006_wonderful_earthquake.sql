ALTER TABLE "client_wechat_users" ADD COLUMN "member_level_locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "client_wechat_users" ADD COLUMN "member_level_upgraded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sale_orders" ADD COLUMN "overdraft_deduction" numeric(10, 2) DEFAULT '0';--> statement-breakpoint
ALTER TABLE "sale_orders" ADD COLUMN "overdraft_deduction_detail" jsonb;--> statement-breakpoint
ALTER TABLE "point_transactions" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_point_txns_external_ref" ON "point_transactions" USING btree ("external_ref") WHERE external_ref IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_messages_idempotency_key" ON "messages" USING btree ("idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
INSERT INTO "system_configs" ("key", "value") VALUES ('points_to_yuan_rate', '0.01') ON CONFLICT ("key") DO NOTHING;