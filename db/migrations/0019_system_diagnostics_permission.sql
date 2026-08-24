-- 系统自检包含远程依赖探测和数据库备份，只允许超级管理员角色持有。
UPDATE permission_role_definitions
   SET actions = CASE
     WHEN is_super_admin THEN ARRAY(
       SELECT DISTINCT action
         FROM unnest(actions || ARRAY['system:diagnostics']::text[]) AS granted(action)
        ORDER BY action
     )
     ELSE ARRAY(
       SELECT action
         FROM unnest(actions) AS granted(action)
        WHERE action <> 'system:diagnostics'
        ORDER BY action
     )
   END,
       updated_at = NOW()
 WHERE (is_super_admin AND NOT actions @> ARRAY['system:diagnostics']::text[])
    OR (NOT is_super_admin AND actions @> ARRAY['system:diagnostics']::text[]);

INSERT INTO system_configs (key, value, updated_at)
SELECT 'permission_matrix', jsonb_object_agg(role_key, to_jsonb(actions))::text, NOW()
  FROM permission_role_definitions
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      updated_at = EXCLUDED.updated_at;
