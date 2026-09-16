-- 修正销售单 FY-XSD-WX-2607120094 remaining_sessions=0 → 1（D3=A 不变量修复）
--
-- 背景：fix-deposit-sku-session-count.sql step 3 旧版于 2026-07-13 23:26:38 已 apply 到
--       生产 5433，当时误写 remaining_sessions=0。这违反 D3=A 业务不变量
--       (session_count - remaining_sessions) <= paid_sessions：(1-0)=1 > 0，
--       任何 recalcPaidSessionsForOrder 调用会抛 CONFLICT: PAID_SESSIONS_UNDERFLOW，
--       且订单详情页误显「已用 1 / 已付 0 / 共 1 次」。
--
--       fix-deposit-sku-session-count.sql 已订正为 remaining_sessions=1，但其在 5433 的
--       session_count IS NULL 守卫已不满足（SKU 已 session_count=1），重跑无效（NO-OP），
--       故需本独立修正（以 remaining_sessions=0 为幂等守卫）。
--
-- 范围：仅生产库；幂等（remaining_sessions=0 守卫）。
--       ⚠ 上文「生产 5433 / 5434 开发库」是 2026-07 旧拓扑（ali-demo 47.113.202.7）的说法，
--         保留以还原当时语境；当前拓扑见 db/CLAUDE.md，重跑请对准下方 prod 地址。
-- 预期：2 行受影响（FY-XSD-WX-2607120094 的两个疗程卡 SKU 行）。
-- 用法：psql "postgresql://fengyu:fengyu123@118.178.196.26:5433/fengyu_wxapp" -f db/scripts/fix-deposit-sales-order-remaining.sql

BEGIN;

UPDATE sale_items
SET remaining_sessions = 1
WHERE sale_order_id = 'FY-XSD-WX-2607120094'
  AND sku_id IN ('sku-1783737644225','sku-1783737200446')
  AND remaining_sessions = 0;

-- 验证：修正后应 (sc - rs) <= ps，即 (1-1)=0 <= 0 ✓；详情页将显示「已用 0 / 已付 0 / 共 1 次」
SELECT so.sale_order_id, so.sale_order_type, so.status, si.sku_id, si.product_name,
       si.session_count AS sc, si.remaining_sessions AS rs, si.paid_sessions AS ps
FROM sale_items si
JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
WHERE si.sale_order_id = 'FY-XSD-WX-2607120094'
  AND si.sku_id IN ('sku-1783737644225','sku-1783737200446')
ORDER BY si.sale_item_id;

COMMIT;
