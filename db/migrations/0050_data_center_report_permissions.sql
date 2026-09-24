-- #367 数据中心经营明细报表新增两个权限点（UI 依赖均为 data_center:dashboard）：
--   data_center:customer_detail   顾客明细类（顾客频率表、顾客剩余卡项清单）
--   data_center:staff_commission  员工提成类（员工提成日报、提成明细）
--
-- 运行时权限读 permission_role_definitions，超级管理员角色不会因后台权限目录新增而自动获得新 key，
-- 不追加的话上线后连系统管理员都进不了新页面。
--
-- 授予范围按 issue #367 待答 1 的默认值：超级管理员 + 内置 manager / finance。
-- hr 与自定义角色（如 prod 的「数据」）不在本迁移授予，甲方拍板后在角色编辑器勾选即可（依赖自动补齐）。
-- 非超管角色只在已持有 data_center:dashboard 时追加，不制造「有子权限、缺前置权限」的定义。
UPDATE permission_role_definitions
   SET actions = ARRAY(
         SELECT DISTINCT action
           FROM unnest(actions || ARRAY['data_center:customer_detail', 'data_center:staff_commission']::text[]) AS granted(action)
          ORDER BY action
       ),
       updated_at = NOW(),
       updated_by = 'migration:0050_data_center_report_permissions'
 WHERE (
         is_super_admin
         OR (role_key IN ('manager', 'finance') AND actions @> ARRAY['data_center:dashboard']::text[])
       )
   AND NOT (actions @> ARRAY['data_center:customer_detail', 'data_center:staff_commission']::text[]);
--> statement-breakpoint

-- 兼容镜像（staffApi 读取）。与后台 writeCompatibilityMirror 取同一把事务级锁（锁序 ④，放在行写之后），
-- 避免与并发的角色编辑交错写出旧矩阵。
SELECT pg_advisory_xact_lock(hashtext('permission_matrix:mirror')::bigint);
--> statement-breakpoint

INSERT INTO system_configs (key, value, updated_at)
SELECT 'permission_matrix', jsonb_object_agg(role_key, to_jsonb(actions))::text, NOW()
  FROM permission_role_definitions
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      updated_at = EXCLUDED.updated_at;
