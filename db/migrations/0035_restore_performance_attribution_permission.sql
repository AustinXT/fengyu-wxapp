-- 0016_inventory_permission_catalog 的硬编码目录遗漏了业绩归属日期动作，
-- 导致 0009 已授予的权限被后续目录清理再次剥除。恢复内置授权并刷新兼容镜像。
UPDATE permission_role_definitions
SET actions = ARRAY(
      SELECT DISTINCT action
      FROM unnest(actions || ARRAY['sale_order:performance_attribution_update']::text[]) AS granted(action)
      ORDER BY action
    ),
    updated_at = NOW(),
    updated_by = 'migration:0034_restore_performance_attribution_permission'
WHERE (is_super_admin = true OR is_store_manager = true OR role_key = 'finance')
  AND NOT (actions @> ARRAY['sale_order:performance_attribution_update']::text[]);

INSERT INTO system_configs (key, value, updated_at)
SELECT 'permission_matrix', jsonb_object_agg(role_key, to_jsonb(actions))::text, NOW()
FROM permission_role_definitions
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value,
    updated_at = EXCLUDED.updated_at;
