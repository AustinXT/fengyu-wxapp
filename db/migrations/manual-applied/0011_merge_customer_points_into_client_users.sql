-- 迁移：将 customer_points 积分余额合并至 client_wechat_users
-- 权威源：point_transactions（保留）
-- 目标：删除 customer_points 表，在 client_wechat_users 增加 points_balance + points_updated_at

-- 1. 新增积分余额字段
ALTER TABLE "client_wechat_users"
  ADD COLUMN "points_balance" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "points_updated_at" TIMESTAMP;

-- 2. 将 customer_points 余额迁移至 client_wechat_users
UPDATE "client_wechat_users" cwu
SET
  points_balance    = cp.balance,
  points_updated_at = cp.updated_at
FROM "customer_points" cp
WHERE cwu.user_id = cp.user_id;

-- 3. 删除 customer_points 表（level_id FK 随之消失；member_level 仍由 client_wechat_users.member_level 维护）
DROP TABLE "customer_points";
