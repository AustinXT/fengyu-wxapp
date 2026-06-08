-- ============================================================================
-- e2e-chains/_helpers/seed-fyfix-fixtures.sql
--
-- 重建 test-fixtures.json 的 FY-FIX-* 固定夹具中【不依赖商品域】的部分：
--   顾客 FY-FIX-CLIENT-01 + 储值卡 FY-FIX-CARD-01 + 5 张优惠券。
--
-- 背景（2026-06-08 E2E 现状排查）：
--   当前 5434/fengyu 库相比 fixtures 创建时已大幅重导——test-fixtures.json 里
--   硬编码的真实 SKU（c79157b29c9e974c 等）/ category（d303ac8871eafd97 缦之羽）/
--   product_kind 枚举（护理项目/体验卡…）在当前库均不存在（现 product_kind 为
--   明星/王牌/招牌…）。因此体验卡 SKU(FY-FIX-SKU-TRIAL)、套餐(FY-FIX-BUNDLE-01)
--   等商品类夹具【未纳入本脚本】——它们与当前商品域系统性脱节，需专门对齐工程。
--
-- 列名/约束已对齐当前库真实 schema（2026-06-08 核实）：
--   client_wechat_users NOT NULL: user_id, customer_type, spending_tier, points_balance
--   coupon_templates.applicable_category_ids 为 text[]（{cat-id} 格式）
--   card_transactions.id 自增（nextval），无 (card_id) 唯一约束 → NOT EXISTS 守卫幂等
--
-- 幂等：可重复执行。
-- ============================================================================

BEGIN;

-- 1. 顾客 FY-FIX-CLIENT-01（link-1~31/38/42 核心顾客；phone 13800138000 当前空闲）
INSERT INTO client_wechat_users (
  user_id, customer_id, name, phone, bound_store_id,
  customer_type, customer_status, gender, member_level,
  spending_tier, points_balance, created_at, updated_at
) VALUES (
  'FY-FIX-CLIENT-01', 'WF-FIX-001', 'Fixture测试客', '13800138000', 'store-nc01',
  '会员客', '保有会员-稳定', '女', NULL,
  '<1990', 0, NOW(), NOW()
)
ON CONFLICT (user_id) DO UPDATE SET
  phone = EXCLUDED.phone, bound_store_id = EXCLUDED.bound_store_id,
  customer_type = EXCLUDED.customer_type, updated_at = NOW();

-- 2. 储值卡 FY-FIX-CARD-01（balance 1000，link-10/26/40）
INSERT INTO prepaid_cards (card_id, user_id, balance, created_at, updated_at) VALUES
  ('FY-FIX-CARD-01', 'FY-FIX-CLIENT-01', 1000.00, NOW(), NOW())
ON CONFLICT (card_id) DO UPDATE SET balance = 1000.00, updated_at = NOW();

-- 2b. 初始充值流水 +1000（NOT EXISTS 守卫，card_transactions 无唯一键）
INSERT INTO card_transactions (card_id, type, amount, created_at)
SELECT 'FY-FIX-CARD-01', '充值', 1000.00, NOW()
WHERE NOT EXISTS (SELECT 1 FROM card_transactions WHERE card_id = 'FY-FIX-CARD-01');

-- 3. 优惠券模板（link-11/20/28/29/30）
--    品项券 applicable_category_ids 指向「洗-无创纹身」所属 category（当前库存在）
INSERT INTO coupon_templates (
  template_id, name, coupon_type, discount_value, min_spend, max_discount,
  validity_mode, valid_days, applicable_category_ids, is_active, created_at, updated_at
) VALUES
  ('FY-FIX-CT-01',       'Fixture现金券满200减30', '现金券', 30.00, 200.00, NULL,  'days', 30, NULL, true, NOW(), NOW()),
  ('FY-FIX-CT-DISCOUNT', 'Fixture折扣券8折',        '折扣券', 0.80,  200.00, 50.00, 'days', 30, NULL, true, NOW(), NOW()),
  ('FY-FIX-CT-ITEM',     'Fixture品项券',           '品项券', 30.00, 200.00, NULL,  'days', 30, '{8db7dd26-0ff8-46ce-abee-eb41e0218443}', true, NOW(), NOW()),
  ('FY-FIX-CT-MINSPEND', 'Fixture现金券满500减50',  '现金券', 50.00, 500.00, NULL,  'days', 30, NULL, true, NOW(), NOW()),
  ('FY-FIX-CT-EXPIRED',  'Fixture过期券',           '现金券', 20.00, NULL,   NULL,  'days', 30, NULL, true, NOW(), NOW())
ON CONFLICT (template_id) DO NOTHING;

-- 4. 用户券（user_coupons）— 4 张未使用 + 1 张已过期
INSERT INTO user_coupons (
  coupon_id, template_id, user_id, status, expire_at, created_at, updated_at
) VALUES
  ('FY-FIX-COUPON-01',   'FY-FIX-CT-01',       'FY-FIX-CLIENT-01', '未使用', NOW() + INTERVAL '30 days', NOW(), NOW()),
  ('FY-FIX-CPN-DISCOUNT','FY-FIX-CT-DISCOUNT', 'FY-FIX-CLIENT-01', '未使用', NOW() + INTERVAL '30 days', NOW(), NOW()),
  ('FY-FIX-CPN-ITEM',    'FY-FIX-CT-ITEM',     'FY-FIX-CLIENT-01', '未使用', NOW() + INTERVAL '30 days', NOW(), NOW()),
  ('FY-FIX-CPN-MINSPEND','FY-FIX-CT-MINSPEND', 'FY-FIX-CLIENT-01', '未使用', NOW() + INTERVAL '30 days', NOW(), NOW()),
  ('FY-FIX-CPN-EXPIRED', 'FY-FIX-CT-EXPIRED',  'FY-FIX-CLIENT-01', '未使用', NOW() - INTERVAL '1 day',  NOW(), NOW())
ON CONFLICT (coupon_id) DO NOTHING;

COMMIT;

-- 验证
SELECT 'client' AS t, user_id, phone, bound_store_id FROM client_wechat_users WHERE user_id = 'FY-FIX-CLIENT-01';
SELECT 'card' AS t, card_id, balance FROM prepaid_cards WHERE card_id = 'FY-FIX-CARD-01';
SELECT 'card_txn' AS t, count(*)::text AS cnt FROM card_transactions WHERE card_id = 'FY-FIX-CARD-01';
SELECT 'coupon_tpl' AS t, count(*)::text AS cnt FROM coupon_templates WHERE template_id LIKE 'FY-FIX-CT-%';
SELECT 'user_coupon' AS t, count(*)::text AS cnt FROM user_coupons WHERE coupon_id LIKE 'FY-FIX-%';
