-- ============================================================
-- 2026-05-30 凤御 3 个拉卡拉商户 legacy 行手抄入库
-- ============================================================
-- 数据来源：拉卡拉商户后台截图（用户手抄）
-- 同一归属合作方 24583784「美丫丫」，同一联系人张凯（136****6903）
--
-- 3 行：
--   1) 蓝茉（已存在 legacy 行，UPDATE merchant_name + form_data）
--   2) 象湖（INSERT lakala_merchants + 连 stores FK）
--   3) 凤仪韵（INSERT lakala_merchants，孤立行不挂 stores）
--
-- 双库执行：5434/fengyu（dev）+ 5433/fengyu_wxapp（prod）
-- 注：realname_status 暂用 'not_submitted' 保守起点，等 IP 白名单通后调拉卡拉反查刷新
-- ============================================================

BEGIN;

-- ============================================================
-- 1) 蓝茉店：补全 form_data
-- ============================================================
UPDATE lakala_merchants SET
  merchant_name = '南昌县蓝茉美容院',
  form_data = jsonb_build_object(
    'merInnerNo', '4002026052582608078',
    'merCupNo', '82242107230052S',
    'agentCode', '24583784',
    'agentName', '美丫丫',
    'contactName', '张凯',
    'contactPhoneMasked', '136****6903',
    'sourceNote', '2026-05-30 拉卡拉后台截图手抄（fix/001 后续补齐）'
  ),
  updated_at = now()
WHERE id = 'lm_legacy_store-1779333287626';

-- ============================================================
-- 2) 象湖店：新建 lakala_merchants 行 + 连 stores FK
-- ============================================================
INSERT INTO lakala_merchants (
  id, merchant_name, out_org_code, merchant_no,
  onboarding_status, contract_status,
  wx_realname_status, alipay_realname_status,
  applicant_user_id, last_req_ids, form_data,
  created_at, updated_at
) VALUES (
  'lm_legacy_store-1779809820771',
  '南昌县象湖燕美御生活美容馆',
  'legacy-store-1779809820771',
  '82242107230052U',
  'completed',
  'signed',
  'not_submitted',
  'not_submitted',
  NULL,
  '{}'::jsonb,
  jsonb_build_object(
    'merInnerNo', '4002026052532607913',
    'merCupNo', '82242107230052U',
    'agentCode', '24583784',
    'agentName', '美丫丫',
    'contactName', '张凯',
    'contactPhoneMasked', '136****6903',
    'sourceNote', '2026-05-30 拉卡拉后台截图手抄（fix/001 后续补齐）'
  ),
  now(),
  now()
)
ON CONFLICT (out_org_code) DO NOTHING;

UPDATE stores
  SET lakala_merchant_id = 'lm_legacy_store-1779809820771',
      updated_at = now()
  WHERE store_id = 'store-1779809820771'
    AND lakala_merchant_id IS NULL;

-- ============================================================
-- 3) 凤仪韵店：孤立行（不挂 storeId，不接入小程序）
-- ============================================================
INSERT INTO lakala_merchants (
  id, merchant_name, out_org_code, merchant_no,
  onboarding_status, contract_status,
  wx_realname_status, alipay_realname_status,
  applicant_user_id, last_req_ids, form_data,
  created_at, updated_at
) VALUES (
  'lm_legacy_fengyiyun',
  '南昌县凤仪韵美容美体馆',
  'legacy-fengyiyun',
  '82242107230052R',
  'completed',
  'signed',
  'not_submitted',
  'not_submitted',
  NULL,
  '{}'::jsonb,
  jsonb_build_object(
    'merInnerNo', '4002026052552607045',
    'merCupNo', '82242107230052R',
    'agentCode', '24583784',
    'agentName', '美丫丫',
    'contactName', '张凯',
    'contactPhoneMasked', '136****6903',
    'sourceNote', '2026-05-30 拉卡拉侧入网但不接入小程序业务（fix/001 后续补齐）'
  ),
  now(),
  now()
)
ON CONFLICT (out_org_code) DO NOTHING;

COMMIT;

-- ============================================================
-- 校验
-- ============================================================
SELECT id, merchant_no, merchant_name, onboarding_status
  FROM lakala_merchants
  ORDER BY merchant_no;
-- 期望：3 行（蓝茉 52S / 凤仪韵 52R / 象湖 52U）

SELECT store_id, store_name, lakala_merchant_no, lakala_merchant_id
  FROM stores
  WHERE lakala_merchant_id IS NOT NULL
  ORDER BY store_name;
-- 期望：2 行（蓝茉 + 象湖），都有 lakala_merchant_id
