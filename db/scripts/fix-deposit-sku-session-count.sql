-- 修复寄存单 FY-XSD-WX-2607120093 商品显示「家居产品」的根因
-- 根因：2 个疗程卡 SKU session_count 漏设为 NULL → sale_items.session_count=NULL
--       → admin 订单详情页 sessionCount===null 走「家居产品」兜底文案（误导）
-- 决策：补 session_count=1（「任选1次」=1 次）+ 回填 4 行 sale_items
-- 范围：仅生产 5433（5434 开发库无此 SKU）；幂等（session_count IS NULL 守卫）
-- 依据：paid_sessions 计算 paid-sessions.js:154-161
--   - 寄存单 total_amount=0 → 兜底 paid_sessions = session_count = 1
--   - 销售单已关闭 received=0 → paid_sessions = FLOOR(0 × 1 / sale_amount) = 0

BEGIN;

-- 1) SKU 补次数：疗程卡「任选1次」= 1 次
UPDATE product_skus
SET session_count = 1, updated_at = NOW()
WHERE sku_id IN ('sku-1783737644225','sku-1783737200446')
  AND product_type = '疗程卡' AND session_count IS NULL;

-- 2) 寄存单 sale_items 回填（已支付，顾客可核销 1 次）
UPDATE sale_items
SET session_count = 1, remaining_sessions = 1, paid_sessions = 1
WHERE sale_order_id = 'FY-XSD-WX-2607120093'
  AND sku_id IN ('sku-1783737644225','sku-1783737200446')
  AND product_type = '疗程卡' AND session_count IS NULL;

-- 3) 销售单 sale_items 回填（已关闭 received=0 → paid_sessions=0；未消费 remaining=session_count=1）
--    remaining=1（=session_count）而非 0：「未激活/未消费」语义是 remaining=session_count，
--    且须维持 D3=A 不变量 (session_count - remaining_sessions) <= paid_sessions：(1-1)=0 <= 0 ✓。
--    若写 remaining=0 会违反不变量 (1-0=1>0) 触发 recalcPaidSessionsForOrder 抛 CONFLICT，
--    且订单详情页会误显「已用 1 / 已付 0 / 共 1 次」。
UPDATE sale_items
SET session_count = 1, remaining_sessions = 1, paid_sessions = 0
WHERE sale_order_id = 'FY-XSD-WX-2607120094'
  AND sku_id IN ('sku-1783737644225','sku-1783737200446')
  AND product_type = '疗程卡' AND session_count IS NULL;

-- 4) 验证：回填后的 sale_items + SKU 状态
SELECT so.sale_order_id, so.sale_order_type, so.status, si.sku_id, si.product_name,
       si.session_count AS sc, si.remaining_sessions AS rs, si.paid_sessions AS ps,
       si.quantity, si.received, ps2.session_count AS sku_sc, ps2.product_type AS sku_pt
FROM sale_items si
JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
JOIN product_skus ps2 ON ps2.sku_id = si.sku_id
WHERE si.sku_id IN ('sku-1783737644225','sku-1783737200446')
ORDER BY so.sale_order_id, si.sale_item_id;

COMMIT;
