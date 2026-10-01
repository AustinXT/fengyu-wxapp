-- #480 财务可在管理后台调整冻结前后的销售分配和服务提成；超级管理员保持同权。
-- 同时补齐 allocation:save 的页面/读取依赖，兼容历史上被撤掉读取动作的角色定义。
UPDATE permission_role_definitions
   SET actions = ARRAY(
         SELECT DISTINCT action
           FROM unnest(actions || ARRAY[
             'allocation:save', 'allocation:list', 'employee:list',
             'sale_order:list', 'service:list', 'store:list'
           ]::text[]) AS granted(action)
          ORDER BY action
       ),
       updated_at = NOW(),
       updated_by = 'migration:0056_allocation_finance_save'
 WHERE (role_key = 'finance' OR is_super_admin)
   AND NOT (actions @> ARRAY[
     'allocation:save', 'allocation:list', 'employee:list',
     'sale_order:list', 'service:list', 'store:list'
   ]::text[]);
--> statement-breakpoint
-- 与后台角色编辑器同锁序刷新旧矩阵镜像。
SELECT pg_advisory_xact_lock(hashtext('permission_matrix:mirror')::bigint);
INSERT INTO system_configs (key, value, updated_at)
SELECT 'permission_matrix', jsonb_object_agg(role_key, to_jsonb(actions))::text, NOW()
  FROM permission_role_definitions
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      updated_at = EXCLUDED.updated_at;
