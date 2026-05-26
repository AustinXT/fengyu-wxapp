-- 0007: staff_wechat_users 合并 user_id + employee_id → 单一 employee_id PK
--
-- 前置检查（手动执行）：
--   SELECT COUNT(*) FROM staff_wechat_users WHERE employee_id IS NULL;
--   如果有行，说明存在未关联员工的微信登录行，迁移会删除它们。

-- 1. DROP operation_logs FK（引用 staff_wechat_users.user_id）
ALTER TABLE "operation_logs" DROP CONSTRAINT IF EXISTS "operation_logs_operator_user_id_staff_wechat_users_user_id_fk";

-- 2. 删除没有 employee_id 的孤行（仅微信登录但未绑定员工档案的行）
DELETE FROM staff_wechat_users WHERE employee_id IS NULL;

-- 3. 切换 PK：user_id → employee_id
ALTER TABLE "staff_wechat_users" DROP CONSTRAINT "staff_wechat_users_pkey";
ALTER TABLE "staff_wechat_users" DROP CONSTRAINT IF EXISTS "staff_wechat_users_employee_id_unique";
ALTER TABLE "staff_wechat_users" ADD CONSTRAINT "staff_wechat_users_pkey" PRIMARY KEY ("employee_id");

-- 4. DROP user_id 列
ALTER TABLE "staff_wechat_users" DROP COLUMN "user_id";

-- 5. operation_logs: 重命名列 + 重建 FK
ALTER TABLE "operation_logs" RENAME COLUMN "operator_user_id" TO "operator_employee_id";
ALTER TABLE "operation_logs" ALTER COLUMN "operator_employee_id" SET DATA TYPE varchar(30);
ALTER TABLE "operation_logs"
  ADD CONSTRAINT "operation_logs_operator_employee_id_staff_wechat_users_employee_id_fk"
  FOREIGN KEY ("operator_employee_id") REFERENCES "staff_wechat_users"("employee_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
