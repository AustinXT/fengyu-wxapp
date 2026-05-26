-- 0007: Schema ↔ 远程 PG 同步修复
-- 此迁移仅包含远程 DB 尚未应用的变更。
-- 0006 之后的变更（PK 迁移、列新增等）已通过手动迁移 0007-0010 应用，
-- 原始文件保留在 migrations/manual-applied/ 目录供参考。

-- 1. 新增 system_configs 表（远程已存在，使用 IF NOT EXISTS 保证幂等）
CREATE TABLE IF NOT EXISTS "system_configs" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

-- 2. 冗余 UNIQUE 约束（employee_id 已是 PK）
-- staff_wechat_users_employee_id_unique 无法删除：15 个 FK 引用了该索引而非 PK 索引。
-- 保留无害，仅冗余存储。如需清理，需先 DROP + RECREATE 所有引用 FK。
-- ALTER TABLE "staff_wechat_users" DROP CONSTRAINT IF EXISTS "staff_wechat_users_employee_id_unique";
--> statement-breakpoint

-- 3. 修复 CHECK 约束名称（远程为 pickup_records_pickup_quantity_check，Schema 定义为 chk_pickup_quantity）
ALTER TABLE "pickup_records" DROP CONSTRAINT IF EXISTS "pickup_records_pickup_quantity_check";--> statement-breakpoint
ALTER TABLE "pickup_records" ADD CONSTRAINT "chk_pickup_quantity" CHECK ("pickup_records"."pickup_quantity" > 0);
