-- ============================================================================
-- migrate-fixtures-5433-to-5434.sql
--
-- 目的：把 5433/fengyu_wxapp 上的 e2e-chains 测试 fixture 迁到 5434/fengyu。
--      源数据来自 fengyu-admin/tests/e2e-chains/test-fixtures.json + README §0.2。
--
-- 对应 ticket：notes/tickets/2026-05-18-e2e-chains-test-db-mismatch.md（决策 B）
--
-- 设计原则：
--   1. 全部 INSERT ... ON CONFLICT DO NOTHING（幂等，可重复执行）
--   2. 只迁 FY-TEST-* / FY-FIX-* 命名空间下的"夹具主体行"，
--      不迁运行时残留（sale_orders / sale_items / appointments / point_transactions
--      / card_transactions）—— 这些应由 spec 自己开单 + 清理。
--   3. 5434 上"宿主基础数据"（org_nodes / stores / product_categories /
--      mall_categories / commission_rate_matrix / system_configs）已经齐全且更丰富，
--      本脚本不动它们，依赖它们存在。
--   4. 不删 5433 任何数据。
--   5. password_hash 直接复用 5433 上 fengyu2026 的 bcrypt 哈希字面值。
--
-- 执行方式（用户确认后再跑）：
--   PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5434 -U fengyu -d fengyu \
--     -f db/scripts/migrate-fixtures-5433-to-5434.sql
--
-- 跑前的 5434 冲突盘点（2026-05-19 抽样）：
--   FY-TEST-* staff           → 0 行
--   FY-TEST-* permission_roles→ 0 行
--   FY-TEST-* admin_passwords → 0 行
--   FY-FIX-* / FY-TEST-CLIENT-* / FY-TEST-CRON-* clients → 0 行
--   FY-FIX-* prepaid_cards    → 0 行
--   FY-FIX-* coupon_templates → 0 行
--   FY-FIX-* user_coupons     → 0 行
--   FY-FIX-* products         → 0 行
--   FY-FIX-* product_skus     → 0 行
--   FY-FIX-* mall_product_skus→ 0 行
--   → 零冲突；ON CONFLICT DO NOTHING 仅作幂等护栏。
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. 前置校验：依赖的宿主行必须在 5434 上存在
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM org_nodes WHERE id='org-store-nc01')
  OR NOT EXISTS (SELECT 1 FROM org_nodes WHERE id='org-store-nc02')
  OR NOT EXISTS (SELECT 1 FROM org_nodes WHERE id='16d1184b46db099a')
  OR NOT EXISTS (SELECT 1 FROM org_nodes WHERE id='6707cc8b88579108') THEN
    RAISE EXCEPTION 'org_nodes 宿主行缺失，无法迁移 fixture';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM stores WHERE store_id='store-nc01')
  OR NOT EXISTS (SELECT 1 FROM stores WHERE store_id='store-nc02')
  OR NOT EXISTS (SELECT 1 FROM stores WHERE store_id='b79a82e33d6cf4f3') THEN
    RAISE EXCEPTION 'stores 宿主行缺失，无法迁移 fixture';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM product_categories WHERE category_id='d303ac8871eafd97')
  OR NOT EXISTS (SELECT 1 FROM product_categories WHERE category_id='5f7e231c3218b26e')
  OR NOT EXISTS (SELECT 1 FROM product_categories WHERE category_id='b8299c9a-42d9-4933-a2ab-629902fff514') THEN
    RAISE EXCEPTION 'product_categories 宿主行缺失，无法迁移 fixture';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM mall_categories WHERE category_id='mall-2aca5df619b4cfc6') THEN
    RAISE EXCEPTION 'mall_categories 宿主行缺失，无法迁移 fixture';
  END IF;
END$$;

-- ============================================================================
-- 1. 测试员工账号 FY-TEST-* (8 个：ADM / MKT / MGR / MGR2 / FIN / HR / PRD / CSM)
-- ============================================================================
INSERT INTO staff_wechat_users
  (employee_id, name, phone, store_id, org_node_id, position_name, gender, is_resigned, created_at, updated_at)
VALUES
  ('FY-TEST-ADM',  '测试管理员', '13900139000', NULL,         '16d1184b46db099a', '系统管理员', NULL,  false, NOW(), NOW()),
  ('FY-TEST-MKT',  '测试市场总', '13900139006', NULL,         '6707cc8b88579108', '市场总监',   NULL,  false, NOW(), NOW()),
  ('FY-TEST-MGR',  '测试店长',   '13900139001', 'store-nc01', 'org-store-nc01',   '店长',       NULL,  false, NOW(), NOW()),
  ('FY-TEST-MGR2', '测试店长2',  '13900139007', 'store-nc02', NULL,               NULL,         '男',  false, NOW(), NOW()),
  ('FY-TEST-FIN',  '测试财务',   '13900139002', 'store-nc01', 'org-store-nc01',   '财务',       NULL,  false, NOW(), NOW()),
  ('FY-TEST-HR',   '测试人事',   '13900139003', 'store-nc01', 'org-store-nc01',   '人事',       NULL,  false, NOW(), NOW()),
  ('FY-TEST-PRD',  '测试品项',   '13900139004', 'store-nc01', 'org-store-nc01',   '品项专员',   NULL,  false, NOW(), NOW()),
  ('FY-TEST-CSM',  '测试客服',   '13900139005', 'store-nc01', 'org-store-nc01',   '客服专员',   NULL,  false, NOW(), NOW())
ON CONFLICT (employee_id) DO NOTHING;

-- ============================================================================
-- 2. 测试员工密码（统一 fengyu2026 / bcrypt cost 10），must_change=false
--    hash 字面量来自 5433 上的现有行（同源同口令）
-- ============================================================================
INSERT INTO admin_passwords
  (employee_id, password_hash, must_change, last_changed_at, created_at, updated_at)
VALUES
  ('FY-TEST-ADM',  '$2b$10$6ha/k14r/Pno8llq.hWT9uA.a.brgke7uN1QJ1Bmf9wN2ph6hIe0.', false, NOW(), NOW(), NOW()),
  ('FY-TEST-MKT',  '$2b$10$6ha/k14r/Pno8llq.hWT9uA.a.brgke7uN1QJ1Bmf9wN2ph6hIe0.', false, NOW(), NOW(), NOW()),
  ('FY-TEST-MGR',  '$2b$10$6ha/k14r/Pno8llq.hWT9uA.a.brgke7uN1QJ1Bmf9wN2ph6hIe0.', false, NOW(), NOW(), NOW()),
  ('FY-TEST-MGR2', '$2b$10$6ha/k14r/Pno8llq.hWT9uA.a.brgke7uN1QJ1Bmf9wN2ph6hIe0.', false, NOW(), NOW(), NOW()),
  ('FY-TEST-FIN',  '$2b$10$6ha/k14r/Pno8llq.hWT9uA.a.brgke7uN1QJ1Bmf9wN2ph6hIe0.', false, NOW(), NOW(), NOW()),
  ('FY-TEST-HR',   '$2b$10$6ha/k14r/Pno8llq.hWT9uA.a.brgke7uN1QJ1Bmf9wN2ph6hIe0.', false, NOW(), NOW(), NOW()),
  ('FY-TEST-PRD',  '$2b$10$6ha/k14r/Pno8llq.hWT9uA.a.brgke7uN1QJ1Bmf9wN2ph6hIe0.', false, NOW(), NOW(), NOW()),
  ('FY-TEST-CSM',  '$2b$10$6ha/k14r/Pno8llq.hWT9uA.a.brgke7uN1QJ1Bmf9wN2ph6hIe0.', false, NOW(), NOW(), NOW())
ON CONFLICT (employee_id) DO NOTHING;

-- ============================================================================
-- 3. 权限角色 FY-TEST-* x role x scope_id (8 条)
-- ============================================================================
INSERT INTO permission_roles (employee_id, role, scope_id, created_at, updated_at)
VALUES
  ('FY-TEST-ADM',  'admin',        '16d1184b46db099a', NOW(), NOW()),
  ('FY-TEST-MKT',  'manager',      '6707cc8b88579108', NOW(), NOW()),
  ('FY-TEST-MGR',  'manager',      'org-store-nc01',   NOW(), NOW()),
  ('FY-TEST-MGR2', 'manager',      'org-store-nc02',   NOW(), NOW()),
  ('FY-TEST-FIN',  'finance',      '16d1184b46db099a', NOW(), NOW()),
  ('FY-TEST-HR',   'hr',           '16d1184b46db099a', NOW(), NOW()),
  ('FY-TEST-PRD',  'product',      '16d1184b46db099a', NOW(), NOW()),
  ('FY-TEST-CSM',  'customer_mgr', '16d1184b46db099a', NOW(), NOW())
ON CONFLICT (employee_id, role, scope_id) DO NOTHING;

-- ============================================================================
-- 4. 顾客 fixture
--    FY-FIX-CLIENT-01    —— 主测试客（test-fixtures.json customer）
--    FY-TEST-CLIENT-NC02 —— scope 反例顾客（绑 store-nc02）
--    FY-TEST-CLIENT-OM   —— 跨市场反例顾客（绑 b79a82e33d6cf4f3）
--    FY-TEST-CRON-01..05 —— cron 批量幂等测试用，生日同日
--
--    静息态：member_level=NULL, points_balance=0, member_level_upgraded_at=NULL
-- ============================================================================
INSERT INTO client_wechat_users (
  user_id, customer_id, name, phone, bound_store_id, gender,
  member_level, customer_type, customer_status, spending_tier,
  points_balance, birthday,
  created_at, updated_at
)
VALUES
  ('FY-FIX-CLIENT-01',    'WF-FIX-001', 'Fixture测试客', '13800138000', 'store-nc01',       '女', NULL, '会员客', '保有会员-稳定', '<1990', 0, NULL,
    NOW(), NOW()),
  ('FY-TEST-CLIENT-NC02', NULL,         'NC02测试客',    '13800138002', 'store-nc02',       '女', NULL, '会员客', '保有会员-稳定', '<1990', 0, NULL,
    NOW(), NOW()),
  ('FY-TEST-CLIENT-OM',   NULL,         'OM测试客',      '13800138003', 'b79a82e33d6cf4f3', '女', NULL, '会员客', '保有会员-稳定', '<1990', 0, NULL,
    NOW(), NOW()),
  ('FY-TEST-CRON-01', NULL, 'CRON顾客1', '13800138011', 'store-nc01', '女', NULL, '会员客', '保有会员-稳定', '<1990', 0,
    TO_CHAR(NOW() AT TIME ZONE 'Asia/Shanghai', '1990-MM-DD')::date, NOW(), NOW()),
  ('FY-TEST-CRON-02', NULL, 'CRON顾客2', '13800138012', 'store-nc01', '女', NULL, '会员客', '保有会员-稳定', '<1990', 0,
    TO_CHAR(NOW() AT TIME ZONE 'Asia/Shanghai', '1990-MM-DD')::date, NOW(), NOW()),
  ('FY-TEST-CRON-03', NULL, 'CRON顾客3', '13800138013', 'store-nc01', '女', NULL, '会员客', '保有会员-稳定', '<1990', 0,
    TO_CHAR(NOW() AT TIME ZONE 'Asia/Shanghai', '1990-MM-DD')::date, NOW(), NOW()),
  ('FY-TEST-CRON-04', NULL, 'CRON顾客4', '13800138014', 'store-nc01', '女', NULL, '会员客', '保有会员-稳定', '<1990', 0,
    TO_CHAR(NOW() AT TIME ZONE 'Asia/Shanghai', '1990-MM-DD')::date, NOW(), NOW()),
  ('FY-TEST-CRON-05', NULL, 'CRON顾客5', '13800138015', 'store-nc01', '女', NULL, '会员客', '保有会员-稳定', '<1990', 0,
    TO_CHAR(NOW() AT TIME ZONE 'Asia/Shanghai', '1990-MM-DD')::date, NOW(), NOW())
ON CONFLICT (user_id) DO NOTHING;

-- ============================================================================
-- 5. 储值卡 FY-FIX-CARD-01 + 充值流水（test-fixtures.json prepaid_card）
--    静息态 balance=1000.00（fixture _note 注明初始 1000，有一条 +1000 流水）
-- ============================================================================
INSERT INTO prepaid_cards (card_id, user_id, balance, created_at, updated_at)
VALUES ('FY-FIX-CARD-01', 'FY-FIX-CLIENT-01', 1000.00, NOW(), NOW())
ON CONFLICT (card_id) DO NOTHING;

-- card_transactions 的 external_ref 唯一约束是 partial unique index
-- (WHERE external_ref IS NOT NULL)，ON CONFLICT 推断必须带同样的 WHERE 谓词。
INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref, created_at)
VALUES ('FY-FIX-CARD-01', '充值', 1000.00, NULL, 'FY-FIX-CARD-01-SEED', NOW())
ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING;

-- ============================================================================
-- 6. 优惠券模板 FY-FIX-CT-* (5 个)
-- ============================================================================
INSERT INTO coupon_templates
  (template_id, name, coupon_type, discount_value, min_spend, max_discount,
   applicable_category_ids, validity_mode, valid_from, valid_to, valid_days,
   description, is_active, created_at, updated_at)
VALUES
  ('FY-FIX-CT-01',       'Fixture-满200减30',        '现金券',  30.00, 200.00, NULL,                       NULL,                'fixed',   NULL, NULL, NULL,
    'Fixture: 链路 11 现金券',                          true, NOW(), NOW()),
  ('FY-FIX-CT-DISCOUNT', 'Fixture 8 折券 (上限¥50)', '折扣券',   0.80, 200.00, 50.00,                      NULL,                'days',    NULL, NULL, 90,
    'Fixture: 链路 28 折扣券 + max_discount 封顶',     true, NOW(), NOW()),
  ('FY-FIX-CT-ITEM',     'Fixture 缦之羽专属 ¥30',   '品项券',  30.00,   0.00, NULL,
    ARRAY['d303ac8871eafd97']::text[], 'days',  NULL, NULL, 90,
    'Fixture: 链路 29 品项券',                          true, NOW(), NOW()),
  ('FY-FIX-CT-MINSPEND', 'Fixture 满500减50',        '现金券',  50.00, 500.00, NULL,                       NULL,                'days',    NULL, NULL, 90,
    'Fixture: 链路 30 反例 A 凑单不足',                 true, NOW(), NOW()),
  ('FY-FIX-CT-EXPIRED',  'Fixture 已过期 ¥20',       '现金券',  20.00,   0.00, NULL,                       NULL,                'fixed',   NULL, '2026-01-01 00:00:00'::timestamp, NULL,
    'Fixture: 链路 30 反例 B 已过期',                   true, NOW(), NOW())
ON CONFLICT (template_id) DO NOTHING;

-- ============================================================================
-- 7. 用户券 FY-FIX-CPN-* / FY-FIX-COUPON-01 (5 张，全部归属 FY-FIX-CLIENT-01，status='未使用')
-- ============================================================================
INSERT INTO user_coupons
  (coupon_id, template_id, user_id, status, expire_at, external_ref, created_at, updated_at)
VALUES
  ('FY-FIX-COUPON-01',    'FY-FIX-CT-01',       'FY-FIX-CLIENT-01', '未使用',
    NOW() + interval '30 days',                          'FY-FIX-COUPON-01-SEED',    NOW(), NOW()),
  ('FY-FIX-CPN-DISCOUNT', 'FY-FIX-CT-DISCOUNT', 'FY-FIX-CLIENT-01', '未使用',
    NOW() + interval '90 days',                          'FY-FIX-CPN-DISCOUNT-SEED', NOW(), NOW()),
  ('FY-FIX-CPN-ITEM',     'FY-FIX-CT-ITEM',     'FY-FIX-CLIENT-01', '未使用',
    NOW() + interval '90 days',                          'FY-FIX-CPN-ITEM-SEED',     NOW(), NOW()),
  ('FY-FIX-CPN-MINSPEND', 'FY-FIX-CT-MINSPEND', 'FY-FIX-CLIENT-01', '未使用',
    NOW() + interval '90 days',                          'FY-FIX-CPN-MINSPEND-SEED', NOW(), NOW()),
  ('FY-FIX-CPN-EXPIRED',  'FY-FIX-CT-EXPIRED',  'FY-FIX-CLIENT-01', '未使用',
    '2026-01-01 00:00:00'::timestamp,                    'FY-FIX-CPN-EXPIRED-SEED',  NOW(), NOW())
ON CONFLICT (coupon_id) DO NOTHING;

-- ============================================================================
-- 8. 体验卡 SKU + 套餐子 SKU (3 个 product_skus 行)
--    FY-FIX-SKU-TRIAL     ¥99 1次 体验卡（is_experience=true）
--    FY-FIX-SKU-BUNDLE-A  ¥100 1次 缦之羽
--    FY-FIX-SKU-BUNDLE-B  ¥100 1次 美卿
-- ============================================================================
INSERT INTO product_skus
  (sku_id, product_type, spec_name, price, special_price, session_count, sort_order, service_fee,
   category_id, is_shengmei, market_scope, is_enabled, is_experience, is_recharge_card,
   created_at, updated_at)
VALUES
  ('FY-FIX-SKU-TRIAL',    '疗程卡', 'Fixture 体验卡 ¥99 1次',     99.00, NULL, 1, 0, 0,
    'b8299c9a-42d9-4933-a2ab-629902fff514', NULL, NULL, true, true,  false, NOW(), NOW()),
  ('FY-FIX-SKU-BUNDLE-A', '疗程卡','Fixture 套餐子 SKU A ¥100', 100.00, NULL, 1, 0, 0,
    'd303ac8871eafd97',                     NULL, NULL, true, false, false, NOW(), NOW()),
  ('FY-FIX-SKU-BUNDLE-B', '疗程卡','Fixture 套餐子 SKU B ¥100', 100.00, NULL, 1, 0, 0,
    '5f7e231c3218b26e',                     NULL, NULL, true, false, false, NOW(), NOW())
ON CONFLICT (sku_id) DO NOTHING;

-- ============================================================================
-- 9. 组合套餐 product + bundle 链接 (link-27 套餐下单)
--    FY-FIX-BUNDLE-01: 价格 200，特价 180，挂在 mall-2aca5df619b4cfc6 (综合福利)
--    挂两个子 SKU：FY-FIX-SKU-BUNDLE-A / B，bundle_price 各 90
-- ============================================================================
INSERT INTO products
  (product_id, category_id, name, is_bundle, price, special_price, sort_order, is_visible,
   created_at, updated_at)
VALUES
  ('FY-FIX-BUNDLE-01', 'mall-2aca5df619b4cfc6', 'Fixture 套餐 ¥180 (洗+假性皱纹)',
    true, 200.00, 180.00, 0, true, NOW(), NOW())
ON CONFLICT (product_id) DO NOTHING;

INSERT INTO mall_product_skus
  (product_id, sku_id, bundle_price, sort_order, created_at)
VALUES
  ('FY-FIX-BUNDLE-01', 'FY-FIX-SKU-BUNDLE-A', 90.00, 0, NOW()),
  ('FY-FIX-BUNDLE-01', 'FY-FIX-SKU-BUNDLE-B', 90.00, 1, NOW())
ON CONFLICT (product_id, sku_id) DO NOTHING;

COMMIT;

-- ============================================================================
-- 跑后验证（应输出非零行数）
-- ============================================================================
SELECT 'staff_wechat_users.FY-TEST-*' AS check, count(*) AS n
  FROM staff_wechat_users WHERE employee_id LIKE 'FY-TEST-%';
SELECT 'admin_passwords.FY-TEST-*' AS check, count(*) AS n
  FROM admin_passwords WHERE employee_id LIKE 'FY-TEST-%';
SELECT 'permission_roles.FY-TEST-*' AS check, count(*) AS n
  FROM permission_roles WHERE employee_id LIKE 'FY-TEST-%';
SELECT 'client_wechat_users fixtures' AS check, count(*) AS n
  FROM client_wechat_users
  WHERE user_id LIKE 'FY-FIX-%' OR user_id LIKE 'FY-TEST-CLIENT-%' OR user_id LIKE 'FY-TEST-CRON-%';
SELECT 'prepaid_cards.FY-FIX-*' AS check, count(*) AS n FROM prepaid_cards WHERE card_id LIKE 'FY-FIX-%';
SELECT 'card_transactions.FY-FIX-*' AS check, count(*) AS n FROM card_transactions WHERE card_id LIKE 'FY-FIX-%';
SELECT 'coupon_templates.FY-FIX-*' AS check, count(*) AS n FROM coupon_templates WHERE template_id LIKE 'FY-FIX-%';
SELECT 'user_coupons.FY-FIX-*' AS check, count(*) AS n FROM user_coupons WHERE coupon_id LIKE 'FY-FIX-%';
SELECT 'product_skus.FY-FIX-*' AS check, count(*) AS n FROM product_skus WHERE sku_id LIKE 'FY-FIX-%';
SELECT 'products.FY-FIX-*' AS check, count(*) AS n FROM products WHERE product_id LIKE 'FY-FIX-%';
SELECT 'mall_product_skus.FY-FIX-*' AS check, count(*) AS n FROM mall_product_skus WHERE product_id LIKE 'FY-FIX-%';
