-- ============================================================================
-- 测试用 commission_rate_matrix 种子数据
--
-- 用途：给现有市场灌入一份"完整覆盖 sales_category × role × tier"的提成矩阵，
--       让 e2e 测试和 admin 后台手动演示均能命中 commission_rate>0 的规则。
--
-- 涵盖市场：
--   1. 6707cc8b88579108 (南昌市场)   — admin e2e fixture market_org_node_id 默认值
--   2. dad2db0b1249daca (九江市场)   — admin seed.ts 已建过 4 条，此处补全缺失
--   3. TE2L2_MARKET_ORG              — staff e2e fixture 测试市场（如不存在则跳过）
--
-- 维度覆盖：
--   - order_type:    销售单 / 服务单
--   - role_type:     美容师 / 养生师 / 推广师
--   - sales_category: 自销自耗 / 他销自耗 / 他销他耗
--   - tier:          自销自耗 拆 (0, 5000) + (5000, NULL)，其余 (0, NULL)
--
-- 故意不配 sales_category='生态合作' → 用于验证 service.complete 兜底 rate=0
--
-- 幂等：ON CONFLICT ON CONSTRAINT uq_commission_matrix DO NOTHING
--       已有规则保留原值；如需覆盖，改 DO UPDATE。
--
-- 运行：
--   PGPASSWORD=fengyu123 psql -h 101.34.242.103 -p 5433 -U fengyu -d fengyu_wxapp \
--     -f db/scripts/seed-test-commission-matrix.sql
-- ============================================================================

DO $$
DECLARE
  v_org_id TEXT;
  v_markets TEXT[] := ARRAY[
    '6707cc8b88579108',   -- 南昌市场
    'dad2db0b1249daca',   -- 九江市场
    'TE2L2_MARKET_ORG'    -- staff e2e fixture（fixture 跑过会创建；否则跳过）
  ];
BEGIN
  FOREACH v_org_id IN ARRAY v_markets LOOP
    -- 只对已存在于 org_nodes 的市场灌数据（避免 FK 失败）
    IF NOT EXISTS (SELECT 1 FROM org_nodes WHERE id = v_org_id) THEN
      RAISE NOTICE 'skip %: org_nodes 不存在', v_org_id;
      CONTINUE;
    END IF;

    -- ─── 销售单 ────────────────────────────────────────────────────────
    INSERT INTO commission_rate_matrix
      (org_id, order_type, role_type, sales_category, amount_tier_min, amount_tier_max, commission_rate)
    VALUES
      -- 美容师
      (v_org_id, '销售单', '美容师', '自销自耗',    0, 5000, 0.0800),
      (v_org_id, '销售单', '美容师', '自销自耗', 5000, NULL, 0.1000),
      (v_org_id, '销售单', '美容师', '他销自耗',    0, NULL, 0.0600),
      (v_org_id, '销售单', '美容师', '他销他耗',    0, NULL, 0.0500),
      -- 养生师
      (v_org_id, '销售单', '养生师', '自销自耗',    0, 5000, 0.0800),
      (v_org_id, '销售单', '养生师', '自销自耗', 5000, NULL, 0.1000),
      (v_org_id, '销售单', '养生师', '他销自耗',    0, NULL, 0.0600),
      (v_org_id, '销售单', '养生师', '他销他耗',    0, NULL, 0.0500),
      -- 推广师
      (v_org_id, '销售单', '推广师', '自销自耗',    0, NULL, 0.0500),
      (v_org_id, '销售单', '推广师', '他销自耗',    0, NULL, 0.0500)
    ON CONFLICT ON CONSTRAINT uq_commission_matrix DO NOTHING;

    -- ─── 服务单 ────────────────────────────────────────────────────────
    -- price_threshold（#379）：自销自耗 / 他销自耗默认 100，其余 NULL（与迁移 0051 回填口径一致）
    INSERT INTO commission_rate_matrix
      (org_id, order_type, role_type, sales_category, amount_tier_min, amount_tier_max, commission_rate, price_threshold)
    VALUES
      -- 美容师
      (v_org_id, '服务单', '美容师', '自销自耗',    0, 5000, 0.1200,  100),
      (v_org_id, '服务单', '美容师', '自销自耗', 5000, NULL, 0.1800,  100),
      (v_org_id, '服务单', '美容师', '他销自耗',    0, NULL, 0.1000,  100),
      (v_org_id, '服务单', '美容师', '他销他耗',    0, NULL, 0.0800, NULL),
      -- 养生师
      (v_org_id, '服务单', '养生师', '自销自耗',    0, 5000, 0.1200,  100),
      (v_org_id, '服务单', '养生师', '自销自耗', 5000, NULL, 0.1800,  100),
      (v_org_id, '服务单', '养生师', '他销自耗',    0, NULL, 0.1000,  100),
      (v_org_id, '服务单', '养生师', '他销他耗',    0, NULL, 0.0800, NULL)
    ON CONFLICT ON CONSTRAINT uq_commission_matrix DO NOTHING;

    RAISE NOTICE 'seeded commission_rate_matrix for %', v_org_id;
  END LOOP;
END $$;

-- 灌完打印每个市场的规则计数
SELECT n.id AS org_id, n.name AS market, COUNT(crm.id) AS rules
  FROM org_nodes n
  LEFT JOIN commission_rate_matrix crm ON crm.org_id = n.id
 WHERE n.id IN ('6707cc8b88579108', 'dad2db0b1249daca', 'TE2L2_MARKET_ORG')
 GROUP BY n.id, n.name
 ORDER BY n.name;
