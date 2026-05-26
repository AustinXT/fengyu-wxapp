-- 1. 废弃 member_levels 死表（B 体系）
--    会员等级（钻石等级）由 client_wechat_users.member_level 字段单独维护，与积分系统解耦
ALTER TABLE "customer_points" DROP CONSTRAINT IF EXISTS "customer_points_level_id_member_levels_level_id_fk";
ALTER TABLE "customer_points" DROP COLUMN IF EXISTS "level_id";
DROP TABLE IF EXISTS "member_levels";

-- 2. 放宽 operation_logs 约束以支持系统级日志
--    cronTask、payNotify webhook 等无操作人场景需要写入 operation_logs
ALTER TABLE "operation_logs" ALTER COLUMN "operator_employee_id" DROP NOT NULL;
ALTER TABLE "operation_logs" ALTER COLUMN "operator_name" DROP NOT NULL;
