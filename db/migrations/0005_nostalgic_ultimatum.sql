CREATE TABLE "permission_role_definitions" (
	"role_key" varchar(64) PRIMARY KEY NOT NULL,
	"name" varchar(30) NOT NULL,
	"description" varchar(200),
	"actions" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"can_access_admin" boolean DEFAULT true NOT NULL,
	"is_super_admin" boolean DEFAULT false NOT NULL,
	"is_store_manager" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_permission_role_definitions_name" ON "permission_role_definitions" USING btree ("name");

-- 承接现有角色与当前生效权限矩阵；permission_roles 行本身不重写。
DO $$
DECLARE
  matrix jsonb;
BEGIN
  BEGIN
    SELECT value::jsonb
      INTO matrix
      FROM system_configs
     WHERE key = 'permission_matrix'
     LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    matrix := NULL;
  END;

  IF matrix IS NULL OR jsonb_typeof(matrix) <> 'object' THEN
    matrix := '{"admin":["dashboard:view","org:list","org:create","org:update","org:delete","store:list","store:create","store:update","employee:list","employee:create","employee:update","employee:delete","product:list","product:create","product:update","commission:list","commission:create","commission:update","commission:delete","coupon:list","coupon:create","coupon:update","sale_order:list","sale_order:create","sale_order:update","sale_order:record_payment","sale_order:deposit_approve","sale_order:delete","sale_item:list","allocation:list","allocation:save","service:list","service:create","service:update","service:delete","appointment:list","appointment:confirm","appointment:checkin","appointment:delete","customer:list","customer:create","customer:update","customer:delete","pickup_record:list","pickup_record:create","pickup_record:delete","data_center:dashboard","store_unbind:list","store_unbind:approve","store_unbind:reject","store_unbind:delete","permission:list","permission:assign","permission:revoke","permission:assign_admin","operation_log:list","operation_log:delete","point_transaction:list","card_transaction:list","message:list","message:delete","message:send","system:config","admin:reset_password","sale_order:refund_create","sale_order:refund_approve","legacy_order:list","legacy_order:approve","legacy_order:reject","legacy_order:update_phone","legacy_order:update_amount","legacy_order:pull","inventory:list","inventory:create","inventory:delete","inventory:stock_list","inventory:export","store:lakala_config","merchant:list","merchant:create","merchant:update","merchant:delete"],"manager":["allocation:list","allocation:save","appointment:checkin","appointment:confirm","appointment:list","card_transaction:list","coupon:list","customer:create","customer:list","customer:update","dashboard:view","data_center:dashboard","employee:create","employee:list","employee:update","inventory:create","inventory:list","inventory:stock_list","legacy_order:approve","legacy_order:list","legacy_order:pull","legacy_order:reject","legacy_order:update_amount","legacy_order:update_phone","merchant:list","message:list","message:send","operation_log:list","org:list","pickup_record:create","pickup_record:list","point_transaction:list","product:list","sale_item:list","sale_order:create","sale_order:deposit_approve","sale_order:list","sale_order:record_payment","sale_order:refund_approve","sale_order:refund_create","sale_order:update","service:create","service:list","service:update","store:list","store_unbind:approve","store_unbind:list","store_unbind:reject"],"finance":["allocation:list","card_transaction:list","commission:create","commission:list","commission:update","coupon:list","customer:list","dashboard:view","data_center:dashboard","employee:list","inventory:export","inventory:list","inventory:stock_list","legacy_order:approve","legacy_order:list","legacy_order:pull","legacy_order:reject","legacy_order:update_amount","legacy_order:update_phone","merchant:create","merchant:list","merchant:update","operation_log:list","org:list","pickup_record:list","point_transaction:list","product:list","sale_item:list","sale_order:deposit_approve","sale_order:list","sale_order:record_payment","sale_order:refund_create","service:list","store:list"],"hr":["dashboard:view","employee:create","employee:list","employee:update","message:list","message:send","operation_log:list","org:create","org:list","org:update","permission:assign","permission:list","permission:revoke","product:list","sale_order:list","sale_order:refund_create","service:list","store:create","store:list","store:update"],"product":["coupon:create","coupon:list","coupon:update","dashboard:view","inventory:create","inventory:export","inventory:list","inventory:stock_list","operation_log:list","org:list","product:create","product:list","product:update","sale_order:list","sale_order:refund_create","store:list"],"customer_mgr":["appointment:checkin","appointment:confirm","appointment:list","customer:create","customer:list","customer:update","dashboard:view","employee:list","inventory:list","inventory:stock_list","legacy_order:approve","legacy_order:list","legacy_order:pull","legacy_order:reject","legacy_order:update_amount","legacy_order:update_phone","operation_log:list","org:list","pickup_record:list","product:list","sale_item:list","sale_order:refund_create","store:list"],"staff":[]}'::jsonb;
  END IF;

  WITH role_keys(role_key) AS (
    VALUES ('admin'), ('manager'), ('finance'), ('hr'), ('product'), ('customer_mgr'), ('staff')
    UNION
    SELECT DISTINCT role FROM permission_roles
    UNION
    SELECT jsonb_object_keys(matrix)
  )
  INSERT INTO permission_role_definitions (
    role_key, name, description, actions,
    can_access_admin, is_super_admin, is_store_manager,
    created_by, updated_by
  )
  SELECT
    role_key,
    CASE role_key
      WHEN 'admin' THEN '系统管理员'
      WHEN 'manager' THEN '店长'
      WHEN 'finance' THEN '财务'
      WHEN 'hr' THEN '人事'
      WHEN 'product' THEN '商品管理员'
      WHEN 'customer_mgr' THEN '顾客管理员'
      WHEN 'staff' THEN '员工'
      ELSE left(role_key, 30)
    END,
    CASE WHEN role_key IN ('admin','manager','finance','hr','product','customer_mgr','staff')
      THEN '系统原有角色（迁移保留）' ELSE '存量自定义角色（迁移承接）' END,
    CASE WHEN jsonb_typeof(matrix -> role_key) = 'array'
      THEN ARRAY(SELECT jsonb_array_elements_text(matrix -> role_key))
      ELSE ARRAY[]::text[] END,
    role_key <> 'staff',
    role_key = 'admin',
    role_key = 'manager',
    'migration',
    'migration'
  FROM role_keys
  ON CONFLICT (role_key) DO NOTHING;
END $$;
