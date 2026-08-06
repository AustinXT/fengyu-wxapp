-- ============================================================================
-- 0028_fine_maelstrom.sql
-- L0 schema CHECK 收尾（5 条 CHECK + 2 列 bigint 升级）+ PG timezone 锁定
-- ticket: notes/tickets/2026-05-17-l0-schema-checks-and-timezone.md
-- dry-run: notes/dry-runs/2026-05-17-l0-schema-checks-dryrun.md
--
-- ★ 本文件包含 2 处对 drizzle-kit 默认输出的人工调整（db/CLAUDE.md "只能追加"
--   规则的合理例外，因 phone CHECK 落非空表必须先清洗，否则 migration 不可重放）：
--   1. 在 chk_*_phone_format 前插入 UPDATE phone = NULL 清洗 211 行违例
--      （备份见 docs/migrations/2026-05-17-phone-cleanup-backup.csv）
--   2. 末尾追加 ALTER DATABASE fengyu SET timezone（schema-as-code 防漂移；
--      drizzle-kit 不生成此条；5433 冷备库需另起 psql 单独 ALTER fengyu_wxapp）
-- ============================================================================

ALTER TABLE "client_wechat_users" ALTER COLUMN "points_balance" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "point_transactions" ALTER COLUMN "amount" SET DATA TYPE bigint;--> statement-breakpoint

-- 数据清洗：phone CHECK 落地前置（211 行 WorkFine 脏数据 → NULL，等用户重新 bindPhone）
UPDATE "client_wechat_users" SET "phone" = NULL WHERE "phone" IS NOT NULL AND "phone" !~ '^1[3-9][0-9]{9}$';--> statement-breakpoint
UPDATE "staff_wechat_users" SET "phone" = NULL WHERE "phone" IS NOT NULL AND "phone" !~ '^1[3-9][0-9]{9}$';--> statement-breakpoint

ALTER TABLE "client_wechat_users" ADD CONSTRAINT "chk_cwu_phone_format" CHECK ("client_wechat_users"."phone" IS NULL OR "client_wechat_users"."phone" ~ '^1[3-9][0-9]{9}$');--> statement-breakpoint
ALTER TABLE "staff_wechat_users" ADD CONSTRAINT "chk_swu_phone_format" CHECK ("staff_wechat_users"."phone" IS NULL OR "staff_wechat_users"."phone" ~ '^1[3-9][0-9]{9}$');--> statement-breakpoint
ALTER TABLE "point_transactions" ADD CONSTRAINT "chk_pt_amount_sign" CHECK (("point_transactions"."amount" < 0 AND "point_transactions"."type" = '消费冲销') OR "point_transactions"."amount" > 0);--> statement-breakpoint
ALTER TABLE "card_transactions" ADD CONSTRAINT "chk_card_tx_amount_sign" CHECK (("card_transactions"."type" = '充值' AND "card_transactions"."amount" > 0) OR ("card_transactions"."type" = '扣款' AND "card_transactions"."amount" < 0));--> statement-breakpoint
ALTER TABLE "prepaid_cards" ADD CONSTRAINT "chk_prepaid_balance_nonneg" CHECK ("prepaid_cards"."balance" >= 0);--> statement-breakpoint

-- ====================================================================
-- 手写追加段（drizzle-kit 不生成；schema-as-code 锁定 PG timezone 防漂移）
-- 当前 5434 timezone 已是 'Asia/Shanghai'（dry-run 0a 实证），本条退化为防漂移声明，零业务影响。
-- 5433 冷备库（datname=fengyu_wxapp）由 Phase 7 单独 psql ALTER fengyu_wxapp SET timezone=...
-- ====================================================================
ALTER DATABASE fengyu SET timezone = 'Asia/Shanghai';
