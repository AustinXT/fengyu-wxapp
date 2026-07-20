-- ============================================================================
-- e2e-chains/_helpers/seed-e2e-fixtures.sql
--
-- 一次性 seed：补齐 README §0.2 + scope-helpers.TOPOLOGY 期望的拓扑 + 8 个测试账号。
--
-- 当前 5433 现状：
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
-- 3b. 员工列表填充行（2026-06-24）
--   /employees「筛选器完整」「在职状态筛选有 3 项」断言依赖 ≥2 个原生 <select>：1 个是顶部「在职状态」筛选，
--   另 1 个是 Pagination 的「页大小」<select>——但 Pagination 仅当 total > 默认页大小 20 时才渲染该 <select>
--   （组织筛选是自定义按钮下拉、非原生 select）。fengyu_wxapp 员工过少（< 20）时只剩 1 个 select → 断言挂。
--   这里补 14 行（13 在职 + 1 离职，phone 走 1370000000x 专属段不与既有账号撞 uq_staff_users_phone），
--   单本 seed 即保证 8 个 FY-TEST + 14 行 ≥ 21 > 20，跨页 → 页大小 select 必现。仅档案行，无需 role/password。
--   FK：org_node_id → org_nodes（HQ/门店节点，前面已建）；store_id → stores。
INSERT INTO staff_wechat_users (employee_id, name, phone, store_id, org_node_id, gender, is_resigned) VALUES
  ('FY-TEST-LIST-01', 'E2E 列表员工01', '13700000001', 'store-nc01', 'org-store-nc01',   '女', false),
  ('FY-TEST-LIST-02', 'E2E 列表员工02', '13700000002', 'store-nc01', 'org-store-nc01',   '男', false),
  ('FY-TEST-LIST-03', 'E2E 列表员工03', '13700000003', 'store-nc02', 'org-store-nc02',   '女', false),
  ('FY-TEST-LIST-04', 'E2E 列表员工04', '13700000004', 'store-nc02', 'org-store-nc02',   '男', false),
  ('FY-TEST-LIST-05', 'E2E 列表员工05', '13700000005', NULL,         '16d1184b46db099a', '女', false),
  ('FY-TEST-LIST-06', 'E2E 列表员工06', '13700000006', NULL,         '16d1184b46db099a', '男', false),
  ('FY-TEST-LIST-07', 'E2E 列表员工07', '13700000007', 'store-nc01', 'org-store-nc01',   '女', false),
  ('FY-TEST-LIST-08', 'E2E 列表员工08', '13700000008', 'store-nc01', 'org-store-nc01',   '男', false),
  ('FY-TEST-LIST-09', 'E2E 列表员工09', '13700000009', 'store-nc02', 'org-store-nc02',   '女', false),
  ('FY-TEST-LIST-10', 'E2E 列表员工10', '13700000010', 'store-nc02', 'org-store-nc02',   '男', false),
  ('FY-TEST-LIST-11', 'E2E 列表员工11', '13700000011', NULL,         '16d1184b46db099a', '女', false),
  ('FY-TEST-LIST-12', 'E2E 列表员工12', '13700000012', NULL,         '16d1184b46db099a', '男', false),
  ('FY-TEST-LIST-13', 'E2E 列表员工13', '13700000013', 'store-nc01', 'org-store-nc01',   '女', false),
  ('FY-TEST-LIST-14', 'E2E 列表员工14', '13700000014', 'store-nc02', 'org-store-nc02',   '男', true)
ON CONFLICT (employee_id) DO NOTHING;

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
