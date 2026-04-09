-- 种子数据：从 staff_wechat_users 现有 position_name 迁移职位
-- 按 sync-workfine.js 权限推导逻辑分类 scope

INSERT INTO positions (id, name, scope, sort_order, is_valid)
SELECT
  'pos-seed-' || row_number() OVER (ORDER BY scope_val, position_name),
  position_name,
  scope_val::position_scope,
  row_number() OVER (PARTITION BY scope_val ORDER BY position_name),
  true
FROM (
  SELECT DISTINCT
    position_name,
    CASE
      WHEN position_name IN ('市场总监', '片区经理') THEN 'market'
      WHEN position_name IN ('门店经理', '美容师', '高级美容师', '资深美容师', '美容顾问', '美容学徒') THEN 'store'
      ELSE 'headquarters'
    END AS scope_val
  FROM staff_wechat_users
  WHERE position_name IS NOT NULL AND TRIM(position_name) != ''
) sub
ON CONFLICT DO NOTHING;

-- 种子数据：默认技能标签
INSERT INTO skill_tags (id, name, sort_order, is_valid) VALUES
  ('stag-1', '美容师', 1, true),
  ('stag-2', '养生师', 2, true),
  ('stag-3', '推广师', 3, true)
ON CONFLICT DO NOTHING;
