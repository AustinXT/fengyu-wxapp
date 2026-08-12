-- 角色定义表是运行时权限源。本迁移将历史矩阵收敛到后台唯一权限目录：
-- 1) 超级管理员自动拥有目录中的全部权限；
-- 2) 清除已下线/未知权限及非超级管理员误配的管理员专属权限；
-- 3) 为保留的权限递归补齐页面 SSR 与多接口操作所需依赖；
-- 4) 回写 system_configs 兼容镜像，供旧读取方与人工核验使用。
WITH RECURSIVE
catalog(action, admin_only) AS (
  VALUES
    ('admin:reset_password', true),
    ('allocation:list', false), ('allocation:save', false),
    ('appointment:checkin', false), ('appointment:confirm', false), ('appointment:delete', true), ('appointment:list', false),
    ('card_transaction:list', false),
    ('commission:create', false), ('commission:delete', true), ('commission:list', false), ('commission:update', false),
    ('coupon:create', false), ('coupon:list', false), ('coupon:update', false),
    ('customer:create', false), ('customer:delete', true), ('customer:list', false), ('customer:update', false),
    ('dashboard:view', false), ('data_center:dashboard', false),
    ('employee:create', false), ('employee:delete', true), ('employee:list', false), ('employee:update', false),
    ('inventory:approve', false), ('inventory:create', false), ('inventory:create_doc', false), ('inventory:delete', true),
    ('inventory:export', false), ('inventory:list', false), ('inventory:market_sku_manage', false),
    ('inventory:price_view', false), ('inventory:self_purchase_receive', false),
    ('inventory:shipment_cancel_approve', false), ('inventory:shipment_cancel_request', false),
    ('inventory:stock_list', false), ('inventory:update', false),
    ('legacy_order:approve', false), ('legacy_order:list', false), ('legacy_order:pull', false), ('legacy_order:reject', false),
    ('legacy_order:update_amount', false), ('legacy_order:update_phone', false),
    ('merchant:create', false), ('merchant:delete', true), ('merchant:list', false), ('merchant:update', false),
    ('message:delete', true), ('message:list', false), ('message:send', false),
    ('operation_log:delete', true), ('operation_log:list', false),
    ('org:create', false), ('org:delete', true), ('org:list', false), ('org:update', false),
    ('permission:assign', false), ('permission:assign_admin', true), ('permission:list', false), ('permission:revoke', false),
    ('pickup_record:create', false), ('pickup_record:delete', true), ('pickup_record:list', false),
    ('point_transaction:list', false),
    ('product:create', false), ('product:list', false), ('product:update', false),
    ('sale_item:list', false),
    ('sale_order:create', false), ('sale_order:delete', true), ('sale_order:deposit_approve', false), ('sale_order:list', false),
    ('sale_order:record_payment', false), ('sale_order:refund_approve', false), ('sale_order:refund_create', false), ('sale_order:update', false),
    ('service:create', false), ('service:delete', true), ('service:list', false), ('service:update', false),
    ('store:create', false), ('store:lakala_config', true), ('store:list', false), ('store:update', false),
    ('store_unbind:approve', false), ('store_unbind:delete', true), ('store_unbind:list', false), ('store_unbind:reject', false),
    ('system:config', false)
),
dependencies(action, dependency) AS (
  VALUES
    ('org:create', 'org:list'), ('org:update', 'org:list'), ('org:delete', 'org:list'),
    ('store:update', 'store:list'),
    ('employee:create', 'employee:list'), ('employee:create', 'org:list'), ('employee:create', 'store:list'),
    ('employee:update', 'employee:list'), ('employee:update', 'org:list'), ('employee:update', 'store:list'),
    ('employee:delete', 'employee:list'),
    ('product:create', 'product:list'), ('product:update', 'product:list'),
    ('commission:create', 'commission:list'), ('commission:create', 'employee:list'),
    ('commission:update', 'commission:list'), ('commission:update', 'employee:list'),
    ('commission:delete', 'commission:list'), ('commission:delete', 'employee:list'),
    ('coupon:create', 'coupon:list'), ('coupon:update', 'coupon:list'),
    ('sale_order:create', 'employee:list'), ('sale_order:create', 'store:list'),
    ('sale_order:update', 'sale_order:list'), ('sale_order:record_payment', 'sale_order:list'),
    ('sale_order:deposit_approve', 'sale_order:list'), ('sale_order:delete', 'sale_order:list'),
    ('allocation:save', 'allocation:list'), ('allocation:save', 'employee:list'), ('allocation:save', 'sale_order:list'),
    ('allocation:save', 'service:list'), ('allocation:save', 'store:list'),
    ('service:create', 'employee:list'), ('service:create', 'service:list'), ('service:create', 'store:list'),
    ('service:update', 'service:list'), ('service:delete', 'service:list'),
    ('appointment:confirm', 'appointment:list'), ('appointment:checkin', 'appointment:list'), ('appointment:delete', 'appointment:list'),
    ('customer:create', 'customer:list'), ('customer:update', 'customer:list'), ('customer:delete', 'customer:list'),
    ('pickup_record:create', 'pickup_record:list'), ('pickup_record:create', 'store:list'), ('pickup_record:delete', 'pickup_record:list'),
    ('store_unbind:approve', 'store_unbind:list'), ('store_unbind:reject', 'store_unbind:list'), ('store_unbind:delete', 'store_unbind:list'),
    ('permission:assign', 'employee:list'), ('permission:assign', 'org:list'), ('permission:assign', 'permission:list'),
    ('permission:revoke', 'employee:list'), ('permission:revoke', 'org:list'), ('permission:revoke', 'permission:list'),
    ('permission:assign_admin', 'employee:list'), ('permission:assign_admin', 'org:list'), ('permission:assign_admin', 'permission:list'),
    ('operation_log:delete', 'operation_log:list'), ('message:send', 'message:list'), ('message:delete', 'message:list'),
    ('admin:reset_password', 'employee:list'),
    ('legacy_order:approve', 'legacy_order:list'), ('legacy_order:approve', 'store:list'),
    ('legacy_order:reject', 'legacy_order:list'), ('legacy_order:reject', 'store:list'),
    ('legacy_order:update_phone', 'legacy_order:list'), ('legacy_order:update_phone', 'store:list'),
    ('legacy_order:update_amount', 'legacy_order:list'), ('legacy_order:update_amount', 'store:list'),
    ('legacy_order:pull', 'legacy_order:list'), ('legacy_order:pull', 'store:list'),
    ('inventory:create', 'inventory:list'), ('inventory:create', 'inventory:stock_list'), ('inventory:create', 'store:list'),
    ('inventory:update', 'inventory:stock_list'), ('inventory:delete', 'inventory:list'), ('inventory:export', 'inventory:stock_list'),
    ('inventory:create_doc', 'inventory:list'), ('inventory:create_doc', 'inventory:stock_list'),
    ('inventory:approve', 'inventory:list'), ('inventory:approve', 'inventory:stock_list'),
    ('inventory:price_view', 'inventory:list'), ('inventory:price_view', 'inventory:stock_list'),
    ('inventory:market_sku_manage', 'inventory:create'), ('inventory:market_sku_manage', 'inventory:update'),
    ('inventory:market_sku_manage', 'inventory:price_view'),
    ('inventory:self_purchase_receive', 'inventory:create_doc'), ('inventory:self_purchase_receive', 'inventory:price_view'),
    ('inventory:shipment_cancel_request', 'inventory:create_doc'),
    ('inventory:shipment_cancel_approve', 'inventory:approve'),
    ('merchant:create', 'merchant:list'), ('merchant:update', 'merchant:list'), ('merchant:delete', 'merchant:list')
),
cleaned(role_key, actions) AS (
  SELECT definitions.role_key,
    CASE
      WHEN definitions.is_super_admin THEN ARRAY(SELECT action FROM catalog ORDER BY action)
      ELSE ARRAY(
        SELECT DISTINCT known.action
          FROM unnest(definitions.actions) AS existing(action)
          JOIN catalog AS known ON known.action = existing.action
         WHERE NOT known.admin_only
         ORDER BY known.action
      )
    END
  FROM permission_role_definitions AS definitions
),
resolved(role_key, action) AS (
  SELECT cleaned.role_key, granted.action
    FROM cleaned
    CROSS JOIN LATERAL unnest(cleaned.actions) AS granted(action)
  UNION
  SELECT resolved.role_key, dependencies.dependency
    FROM resolved
    JOIN dependencies ON dependencies.action = resolved.action
),
normalized(role_key, actions) AS (
  SELECT definitions.role_key,
    ARRAY(SELECT action FROM resolved WHERE resolved.role_key = definitions.role_key ORDER BY action)
  FROM permission_role_definitions AS definitions
)
UPDATE permission_role_definitions AS definitions
   SET actions = normalized.actions,
       updated_at = NOW()
  FROM normalized
 WHERE definitions.role_key = normalized.role_key
   AND definitions.actions IS DISTINCT FROM normalized.actions;

INSERT INTO system_configs (key, value, updated_at)
SELECT 'permission_matrix', jsonb_object_agg(role_key, to_jsonb(actions))::text, NOW()
  FROM permission_role_definitions
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      updated_at = EXCLUDED.updated_at;
