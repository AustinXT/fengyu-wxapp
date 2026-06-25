-- ============================================================================
-- seed-fyfix-service.sql — e2e service_orders 种子（解除 cron 全量 module-load 阻断）
--
-- 背景（2026-06-10）：cron-02/05/12 等 spec 在文件顶层 `const REAL = ensure()` 调用前置检查，
-- 其中查 `SELECT DISTINCT market_name FROM service_orders LIMIT 1`，fengyu_e2e 无 service_orders
-- 会致顶层 throw '需要 fixture' → playwright 加载该 spec 失败 → 整个全量套件 EXIT=1 不跑任何 test。
--
-- 建一笔 seed 服务单（带 market_name）让 cron 顶层 ensure 通过，使全量 e2e-chains 可加载。
-- 依赖：store-nc01（seed-e2e）、FY-TEST-EMP-MR1（seed-fyfix-staff）、FY-FIX-CLIENT-01（seed-fyfix-fixtures）。
-- 幂等：ON CONFLICT DO NOTHING。
-- ============================================================================
INSERT INTO service_orders (
  service_order_id, status, service_order_type, market_name, store_id,
  service_date, assigned_employee_id, client_user_id, created_at, updated_at
) VALUES (
  'FY-FIX-SVC-SEED', '已完成', '售前', '南昌市场', 'store-nc01',
  CURRENT_DATE, 'FY-TEST-EMP-MR1', 'FY-FIX-CLIENT-01', NOW(), NOW()
)
ON CONFLICT (service_order_id) DO NOTHING;

SELECT 'service_orders.market_name' AS check, COALESCE((SELECT DISTINCT market_name FROM service_orders LIMIT 1), '空') AS value;
