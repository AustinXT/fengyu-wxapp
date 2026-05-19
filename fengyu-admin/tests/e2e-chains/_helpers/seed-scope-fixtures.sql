-- ============================================================================
-- e2e-chains/_helpers/seed-scope-fixtures.sql
--
-- 一次性 seed：为 link-32~44 准备 scope/cross-market/cron 测试数据。
--
-- 拓扑（已存在）：
--   总部 16d1184b46db099a
--   └─ 南昌市场 6707cc8b88579108        (FY-TEST-MKT 的 scope)
--      ├─ 南昌旗舰店 org-store-nc01     (store_id=store-nc01, FY-TEST-MGR 的 scope)
--      └─ 青山湖店   org-store-nc02     (store_id=store-nc02, 用于 link-32 跨店反例)
--   └─ 南昌市场2 ec9ca0f5c96be174       (用于 link-33 跨市场反例)
--      └─ 南昌龙珠店 (b79a82e33d6cf4f3)  (store-other-market)
--
-- 新增内容：
--   1. FY-TEST-MGR2          —— store-nc02 的店长（手机号 13900139007）
--   2. FY-TEST-CLIENT-NC02   —— 绑定 store-nc02 的顾客
--   3. FY-TEST-CLIENT-OM     —— 绑定其他市场门店的顾客（other market）
--   4. cron 批量顾客 FY-TEST-CRON-01..05  —— 生日同日 + 待升级
--   5. seed 期间不创建订单/预约/服务单/退款（每条 link 自己开单+清理）
--
-- 幂等性：全部 ON CONFLICT DO NOTHING；可重复执行。
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. 第二个店长 FY-TEST-MGR2（store-nc02 的 manager）
--    密码 = fengyu2026（admin_passwords 用 bcrypt，复用 FY-TEST-MGR 的同口令哈希）
-- ----------------------------------------------------------------------------
INSERT INTO staff_wechat_users (employee_id, name, phone, store_id, gender, is_resigned, created_at, updated_at)
VALUES
  ('FY-TEST-MGR2', '测试店长2', '13900139007', 'store-nc02', '男', false, NOW(), NOW())
ON CONFLICT (employee_id) DO UPDATE SET store_id='store-nc02', phone='13900139007', is_resigned=false;

-- 同步 admin 密码：复用 FY-TEST-MGR 当前 password_hash + must_change=false
INSERT INTO admin_passwords (employee_id, password_hash, must_change, created_at, updated_at)
SELECT 'FY-TEST-MGR2', password_hash, false, NOW(), NOW()
FROM admin_passwords WHERE employee_id='FY-TEST-MGR' LIMIT 1
ON CONFLICT (employee_id) DO UPDATE SET password_hash=EXCLUDED.password_hash, must_change=false;

-- 权限角色：manager scope = org-store-nc02
INSERT INTO permission_roles (employee_id, role, scope_id, created_at)
VALUES ('FY-TEST-MGR2', 'manager', 'org-store-nc02', NOW())
ON CONFLICT (employee_id, role, scope_id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 2. 顾客 FY-TEST-CLIENT-NC02 —— 绑定 store-nc02（用于 link-32 跨店反例）
-- ----------------------------------------------------------------------------
INSERT INTO client_wechat_users (
  user_id, name, phone, bound_store_id, customer_type, customer_status, gender, member_level, created_at, updated_at
)
VALUES (
  'FY-TEST-CLIENT-NC02', 'NC02测试客', '13800138002', 'store-nc02', '会员客', '保有会员-稳定', '女', NULL, NOW(), NOW()
)
ON CONFLICT (user_id) DO UPDATE SET bound_store_id='store-nc02', phone='13800138002';

-- ----------------------------------------------------------------------------
-- 3. 顾客 FY-TEST-CLIENT-OM —— 绑定其他市场门店 b79a82e33d6cf4f3
-- ----------------------------------------------------------------------------
INSERT INTO client_wechat_users (
  user_id, name, phone, bound_store_id, customer_type, customer_status, gender, member_level, created_at, updated_at
)
VALUES (
  'FY-TEST-CLIENT-OM', 'OM测试客', '13800138003', 'b79a82e33d6cf4f3', '会员客', '保有会员-稳定', '女', NULL, NOW(), NOW()
)
ON CONFLICT (user_id) DO UPDATE SET bound_store_id='b79a82e33d6cf4f3', phone='13800138003';

-- ----------------------------------------------------------------------------
-- 4. cron 批量顾客 FY-TEST-CRON-01..05
--    - 生日：均为今天（CURRENT_DATE 的 month/day）
--    - member_level=NULL（cron STEP 2 升级到初钻）
--    - 历史消费 ≥ threshold（让 cron 升级生效，需 fixtures 配合 sale_orders；本次仅准备人，订单由 link-44 spec 自管理）
-- ----------------------------------------------------------------------------
INSERT INTO client_wechat_users (user_id, name, phone, bound_store_id, customer_type, customer_status, gender, member_level, birthday, created_at, updated_at)
VALUES
  ('FY-TEST-CRON-01', 'CRON顾客1', '13800138011', 'store-nc01', '会员客', '保有会员-稳定', '女', NULL,
   TO_CHAR(NOW() AT TIME ZONE 'Asia/Shanghai', '1990-MM-DD')::date, NOW(), NOW()),
  ('FY-TEST-CRON-02', 'CRON顾客2', '13800138012', 'store-nc01', '会员客', '保有会员-稳定', '女', NULL,
   TO_CHAR(NOW() AT TIME ZONE 'Asia/Shanghai', '1990-MM-DD')::date, NOW(), NOW()),
  ('FY-TEST-CRON-03', 'CRON顾客3', '13800138013', 'store-nc01', '会员客', '保有会员-稳定', '女', NULL,
   TO_CHAR(NOW() AT TIME ZONE 'Asia/Shanghai', '1990-MM-DD')::date, NOW(), NOW()),
  ('FY-TEST-CRON-04', 'CRON顾客4', '13800138014', 'store-nc01', '会员客', '保有会员-稳定', '女', NULL,
   TO_CHAR(NOW() AT TIME ZONE 'Asia/Shanghai', '1990-MM-DD')::date, NOW(), NOW()),
  ('FY-TEST-CRON-05', 'CRON顾客5', '13800138015', 'store-nc01', '会员客', '保有会员-稳定', '女', NULL,
   TO_CHAR(NOW() AT TIME ZONE 'Asia/Shanghai', '1990-MM-DD')::date, NOW(), NOW())
ON CONFLICT (user_id) DO UPDATE
  SET birthday = TO_CHAR(NOW() AT TIME ZONE 'Asia/Shanghai', '1990-MM-DD')::date,
      member_level = NULL,
      member_level_upgraded_at = NULL;

COMMIT;

-- 验证
SELECT 'staff_wechat_users.FY-TEST-MGR2' AS check, employee_id, store_id FROM staff_wechat_users WHERE employee_id='FY-TEST-MGR2';
SELECT 'permission_roles.FY-TEST-MGR2' AS check, employee_id, role, scope_id FROM permission_roles WHERE employee_id='FY-TEST-MGR2';
SELECT 'client_wechat_users.scope_test' AS check, user_id, bound_store_id FROM client_wechat_users WHERE user_id LIKE 'FY-TEST-CLIENT-%';
SELECT 'client_wechat_users.cron_test' AS check, user_id, birthday FROM client_wechat_users WHERE user_id LIKE 'FY-TEST-CRON-%' ORDER BY user_id;
