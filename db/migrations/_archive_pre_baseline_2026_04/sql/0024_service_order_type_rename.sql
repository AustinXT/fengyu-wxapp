-- 将 service_order_type 枚举从 (普通, 体验) 改为 (售前, 售后)
-- 逻辑：售前 = 顾客 customer_type 非会员客，售后 = 顾客 customer_type 为会员客

-- 1. 添加新值
ALTER TYPE service_order_type ADD VALUE IF NOT EXISTS '售前';
ALTER TYPE service_order_type ADD VALUE IF NOT EXISTS '售后';

-- 需要 COMMIT 后新值才能使用，所以分两步
-- 2. 在独立事务中更新数据 + 重建枚举
-- 先更新现有数据（基于顾客 customer_type 判定）
UPDATE service_orders so
SET service_order_type = CASE
  WHEN EXISTS (
    SELECT 1 FROM client_wechat_users c
    WHERE c.user_id = so.client_user_id
      AND c.customer_type = '会员客'
  ) THEN '售后'::service_order_type
  ELSE '售前'::service_order_type
END
WHERE service_order_type IN ('普通', '体验');

-- 3. 更新列默认值
ALTER TABLE service_orders ALTER COLUMN service_order_type SET DEFAULT '售前';
