-- ============================================================================
-- seed-fyfix-products.sql — e2e 商品域 fixture（让开单类 link 能选到商品）
--
-- 背景（2026-06-09）：fengyu_e2e 独立库只有 schema + 账号 + 顾客/卡/券，无商品数据。
-- e2e-chains 开单类 link（link-1/7/9/25/27/28/29/31）硬编码了特定 SKU id / 商品名 /
-- 分类，本脚本建一套 id/名称/product_kind/价格 精确匹配 spec 假设的商品，使 admin
-- 开单页能渲染出对应 Tab→二级分类→SKU，且 spec 金额断言通过。
--
-- 开单页数据流（src/actions/products.ts getProductsByKind，已核实 2026-06-09）：
--   一级 Tab 硬编码 [组合套餐/普通商品/体验卡/充值卡]（不读 DB product_kind 值）
--   普通商品(__normal__)：product_skus(is_experience=false, is_enabled=true, deleted_at IS NULL)
--     INNER JOIN product_categories 二级(product_kind IS NOT NULL, is_valid=true)
--     INNER JOIN 一级(product_kind IS NULL AND category_name = 二级.product_kind, is_valid=true)
--   体验卡：product_skus(is_experience=true) 平铺按 category
--   组合套餐(__bundle__)：products(is_bundle=true, is_visible=true) + mall_product_skus(bundle_price)
--   充值卡：RechargePicker 读 src/lib/recharge-tier.ts 档位（不查 SKU；
--           sku-recharge-virtual / sku-007-01 仅为满足下单时 sale_items.sku_id 外键）
--
-- FK：product_skus.category_id → product_categories；products.category_id → mall_categories
-- 幂等：ON CONFLICT DO NOTHING。
-- ============================================================================
BEGIN;

-- 1. 一级分类（product_kind IS NULL；其 category_name 供二级 join 用）
INSERT INTO product_categories (category_id, category_name, product_kind, is_valid, sort_order, display_color, created_at, updated_at) VALUES
  ('cat-fyfix-l1-care',     '护理项目', NULL, true, 1, '#5E8BB3', NOW(), NOW()),
  ('cat-fyfix-l1-trial',    '体验卡',   NULL, true, 2, '#D4820A', NOW(), NOW()),
  ('cat-fyfix-l1-recharge', '充值卡',   NULL, true, 3, '#3D8A5A', NOW(), NOW())
ON CONFLICT (category_id) DO NOTHING;

-- 2. 二级分类（product_kind = 对应一级的 category_name）
INSERT INTO product_categories (category_id, category_name, product_kind, is_valid, sort_order, created_at, updated_at) VALUES
  ('d303ac8871eafd97',                     '缦之羽',   '护理项目', true, 10, NOW(), NOW()),  -- link-1/7/9/28/29 + 套餐子A + 品项券限定 category
  ('cat-fyfix-other',                      '其他',     '护理项目', true, 20, NOW(), NOW()),  -- link-1 第二件
  ('cat-fyfix-meiqing',                    '美卿',     '护理项目', true, 30, NOW(), NOW()),  -- 套餐子B
  ('b8299c9a-42d9-4933-a2ab-629902fff514', '68体验卡', '体验卡',   true, 10, NOW(), NOW()),  -- link-25
  ('cat-fyfix-recharge2',                  '储值卡',   '充值卡',   true, 10, NOW(), NOW())   -- 充值卡虚拟 SKU 容器
ON CONFLICT (category_id) DO NOTHING;

-- 3. SKU（product_type 枚举仅 家居产品/疗程卡；is_experience 仅体验卡为 true）
INSERT INTO product_skus (sku_id, category_id, spec_name, price, special_price, session_count, product_type, is_experience, is_enabled, is_manager_special, service_fee, sort_order, created_at, updated_at) VALUES
  ('c79157b29c9e974c',     'd303ac8871eafd97',                     '洗-无创纹身 疗程卡',           100.00,  NULL, 1, '疗程卡', false, true, false, 0, 1, NOW(), NOW()),
  ('2e388ba778334779',     'cat-fyfix-other',                      '假性皱纹管家（单部位） 疗程卡', 100.00,  NULL, 1, '疗程卡', false, true, false, 0, 1, NOW(), NOW()),
  ('FY-FIX-SKU-TRIAL',     'b8299c9a-42d9-4933-a2ab-629902fff514', 'Fixture 体验卡 ¥99 1次',       99.00,   NULL, 1, '疗程卡', true,  true, false, 0, 1, NOW(), NOW()),
  ('FY-FIX-SKU-BUNDLE-A',  'd303ac8871eafd97',                     'Fixture 套餐子 SKU A ¥100',    100.00,  NULL, 1, '疗程卡', false, true, false, 0, 2, NOW(), NOW()),
  ('FY-FIX-SKU-BUNDLE-B',  'cat-fyfix-meiqing',                    'Fixture 套餐子 SKU B ¥100',    100.00,  NULL, 1, '疗程卡', false, true, false, 0, 1, NOW(), NOW()),
  ('sku-recharge-virtual', 'cat-fyfix-recharge2',                  '预付充值卡（虚拟）',            0.00,    NULL, 1, '疗程卡', false, true, false, 0, 1, NOW(), NOW()),
  ('sku-007-01',           'cat-fyfix-recharge2',                  '金卡充值卡 金卡5000',          5000.00, NULL, 1, '疗程卡', false, true, false, 0, 2, NOW(), NOW())
ON CONFLICT (sku_id) DO NOTHING;

-- 4. 商城分类（套餐 products.category_id 指向这里）
INSERT INTO mall_categories (category_id, category_name, sort_order, created_at, updated_at) VALUES
  ('mall-2aca5df619b4cfc6', 'Fixture套餐分类', 10, NOW(), NOW())
ON CONFLICT (category_id) DO NOTHING;

-- 5. 套餐商品（is_bundle=true, is_visible=true）
INSERT INTO products (product_id, category_id, name, price, special_price, is_bundle, is_visible, sort_order, created_at, updated_at) VALUES
  ('FY-FIX-BUNDLE-01', 'mall-2aca5df619b4cfc6', 'Fixture 套餐 ¥180 (SKU A + SKU B)', 200.00, 180.00, true, true, 1, NOW(), NOW())
ON CONFLICT (product_id) DO NOTHING;

-- 6. 套餐子 SKU 关联（bundle_price 覆盖 sku.price → 下单 unit_real_price=90）
-- 用 NOT EXISTS 守卫（约束名在 drizzle push 库与原库不一致，不依赖约束名）
INSERT INTO mall_product_skus (product_id, sku_id, bundle_price, sort_order, created_at)
SELECT v.product_id, v.sku_id, v.bundle_price, v.sort_order, NOW()
FROM (VALUES
  ('FY-FIX-BUNDLE-01', 'FY-FIX-SKU-BUNDLE-A', 90.00, 10),
  ('FY-FIX-BUNDLE-01', 'FY-FIX-SKU-BUNDLE-B', 90.00, 20)
) AS v(product_id, sku_id, bundle_price, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM mall_product_skus m WHERE m.product_id = v.product_id AND m.sku_id = v.sku_id
);

COMMIT;

-- 验证
SELECT '一级分类' AS t, category_name FROM product_categories WHERE product_kind IS NULL ORDER BY sort_order;
SELECT '普通商品可选(__normal__渲染)' AS t, pc.category_name, ps.spec_name, ps.price
  FROM product_skus ps JOIN product_categories pc ON ps.category_id=pc.category_id
  WHERE ps.is_experience=false AND ps.is_enabled=true AND pc.product_kind='护理项目' ORDER BY pc.sort_order, ps.sort_order;
SELECT '体验卡可选' AS t, ps.spec_name, ps.price FROM product_skus ps WHERE ps.is_experience=true;
SELECT '套餐' AS t, p.name, mps.sku_id, mps.bundle_price FROM products p JOIN mall_product_skus mps ON p.product_id=mps.product_id WHERE p.is_bundle=true ORDER BY mps.sort_order;
