-- ============================================================================
-- e2e-chains/_helpers/seed-e2e-fixtures.sql
--
-- 一次性 seed：补齐 README §0.2 + scope-helpers.TOPOLOGY 期望的拓扑 + 8 个测试账号。
--
-- 当前 5434 现状：
--   - 实际生产 org 拓扑挂在 'ORG-HQ' / 'org-市场-1779327286268'（南昌市场）下，与 README 不同
--   - scope-helpers.ts 硬编码的 id 均不存在（16d1184b46db099a / 6707cc8b88579108 等）
--
-- 本脚本建立独立 e2e 拓扑（id 完全对齐 scope-helpers），不影响生产数据：
--   总部 16d1184b46db099a (type='总部')
--   ├─ 南昌市场 6707cc8b88579108 (type='市场')
--   │   ├─ 南昌旗舰店 org-store-nc01 → store-nc01
--   │   └─ 青山湖店  org-store-nc02 → store-nc02
--   └─ 南昌市场2 ec9ca0f5c96be174 (type='市场')
--       └─ 南昌龙珠店 org-store-other → b79a82e33d6cf4f3
--
-- 然后 seed 8 个 FY-TEST-* 账号 + admin_passwords (bcrypt fengyu2026) + permission_roles。
--
-- 幂等：全部 ON CONFLICT DO NOTHING / DO UPDATE，可重复执行。
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. org_nodes：总部 → 2 市场 → 3 门店节点
-- ----------------------------------------------------------------------------
INSERT INTO org_nodes (id, name, type, parent_id, sort_order, is_active) VALUES
  ('16d1184b46db099a', 'E2E 测试总部', '总部', NULL, 999, true),
  ('6707cc8b88579108', '南昌市场（E2E）', '市场', '16d1184b46db099a', 1, true),
  ('ec9ca0f5c96be174', '南昌市场2（E2E）', '市场', '16d1184b46db099a', 2, true),
  ('org-store-nc01', '南昌旗舰店（E2E）', '门店', '6707cc8b88579108', 1, true),
  ('org-store-nc02', '青山湖店（E2E）', '门店', '6707cc8b88579108', 2, true),
  ('org-store-other', '南昌龙珠店（E2E）', '门店', 'ec9ca0f5c96be174', 1, true)
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 2. stores：3 个测试门店
--    org_node_id 一对一 FK；存在 stores_org_node_id_unique 唯一索引
-- ----------------------------------------------------------------------------
-- 商户模块化后 stores 收款字段迁出，仅留 lakala_merchant_id 外键（默认 NULL）；不再有 lakala_enabled 快照列。
INSERT INTO stores (store_id, store_name, org_node_id, is_closed) VALUES
  ('store-nc01', '南昌旗舰店（E2E）', 'org-store-nc01', false),
  ('store-nc02', '青山湖店（E2E）', 'org-store-nc02', false),
  ('b79a82e33d6cf4f3', '南昌龙珠店（E2E）', 'org-store-other', false)
ON CONFLICT (store_id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 3. staff_wechat_users：8 个测试账号
--    密码统一 fengyu2026（bcrypt $2b$12 hash 在下面 admin_passwords 里）
-- ----------------------------------------------------------------------------
INSERT INTO staff_wechat_users (employee_id, name, phone, store_id, org_node_id, gender, is_resigned) VALUES
  ('FY-TEST-ADM',  '测试管理员',  '13900139000', NULL,             '16d1184b46db099a', '女', false),
  ('FY-TEST-MGR',  '测试店长',    '13900139001', 'store-nc01',     'org-store-nc01',   '女', false),
  ('FY-TEST-FIN',  '测试财务',    '13900139002', NULL,             '16d1184b46db099a', '女', false),
  ('FY-TEST-HR',   '测试人事',    '13900139003', NULL,             '16d1184b46db099a', '女', false),
  ('FY-TEST-PRD',  '测试品项',    '13900139004', NULL,             '16d1184b46db099a', '女', false),
  ('FY-TEST-CSM',  '测试客服',    '13900139005', NULL,             '16d1184b46db099a', '女', false),
  ('FY-TEST-MKT',  '测试市场总',  '13900139006', NULL,             '6707cc8b88579108', '女', false),
  ('FY-TEST-MGR2', '测试店长 2',  '13900139007', 'store-nc02',     'org-store-nc02',   '女', false)
ON CONFLICT (employee_id) DO UPDATE SET
  phone = EXCLUDED.phone, store_id = EXCLUDED.store_id, org_node_id = EXCLUDED.org_node_id,
  is_resigned = EXCLUDED.is_resigned, updated_at = NOW();

-- ----------------------------------------------------------------------------
-- 4. admin_passwords：密码 fengyu2026 的 bcrypt $2b$12 hash，must_change=false
-- ----------------------------------------------------------------------------
INSERT INTO admin_passwords (employee_id, password_hash, must_change, last_changed_at) VALUES
  ('FY-TEST-ADM',  '$2b$12$vjNm4.QFF0bzVUQZYJ09S.jLxWQm/tc5hliGcXwwmEpbzr.80KG9K', false, NOW()),
  ('FY-TEST-MGR',  '$2b$12$vjNm4.QFF0bzVUQZYJ09S.jLxWQm/tc5hliGcXwwmEpbzr.80KG9K', false, NOW()),
  ('FY-TEST-FIN',  '$2b$12$vjNm4.QFF0bzVUQZYJ09S.jLxWQm/tc5hliGcXwwmEpbzr.80KG9K', false, NOW()),
  ('FY-TEST-HR',   '$2b$12$vjNm4.QFF0bzVUQZYJ09S.jLxWQm/tc5hliGcXwwmEpbzr.80KG9K', false, NOW()),
  ('FY-TEST-PRD',  '$2b$12$vjNm4.QFF0bzVUQZYJ09S.jLxWQm/tc5hliGcXwwmEpbzr.80KG9K', false, NOW()),
  ('FY-TEST-CSM',  '$2b$12$vjNm4.QFF0bzVUQZYJ09S.jLxWQm/tc5hliGcXwwmEpbzr.80KG9K', false, NOW()),
  ('FY-TEST-MKT',  '$2b$12$vjNm4.QFF0bzVUQZYJ09S.jLxWQm/tc5hliGcXwwmEpbzr.80KG9K', false, NOW()),
  ('FY-TEST-MGR2', '$2b$12$vjNm4.QFF0bzVUQZYJ09S.jLxWQm/tc5hliGcXwwmEpbzr.80KG9K', false, NOW())
ON CONFLICT (employee_id) DO UPDATE SET
  password_hash = EXCLUDED.password_hash, must_change = false, last_changed_at = NOW(), updated_at = NOW();

-- ----------------------------------------------------------------------------
-- 5. permission_roles：每账号一条 role + scope_id
--    scope 类型对齐 README §0.2 矩阵
-- ----------------------------------------------------------------------------
INSERT INTO permission_roles (employee_id, role, scope_id) VALUES
  ('FY-TEST-ADM',  'admin',        '16d1184b46db099a'),
  ('FY-TEST-MGR',  'manager',      'org-store-nc01'),
  ('FY-TEST-FIN',  'finance',      '16d1184b46db099a'),
  ('FY-TEST-HR',   'hr',           '16d1184b46db099a'),
  ('FY-TEST-PRD',  'product',      '16d1184b46db099a'),
  ('FY-TEST-CSM',  'customer_mgr', '16d1184b46db099a'),
  ('FY-TEST-MKT',  'manager',      '6707cc8b88579108'),
  ('FY-TEST-MGR2', 'manager',      'org-store-nc02')
ON CONFLICT (employee_id, role, scope_id) DO NOTHING;

COMMIT;

-- ----------------------------------------------------------------------------
-- 验证查询
-- ----------------------------------------------------------------------------
SELECT 'staff' AS table_name, employee_id, name, phone, store_id FROM staff_wechat_users
  WHERE employee_id LIKE 'FY-TEST-%' ORDER BY phone;

SELECT 'role' AS table_name, employee_id, role, scope_id FROM permission_roles
  WHERE employee_id LIKE 'FY-TEST-%' ORDER BY employee_id;

SELECT 'store' AS table_name, store_id, store_name, org_node_id FROM stores
  WHERE store_id IN ('store-nc01', 'store-nc02', 'b79a82e33d6cf4f3');
