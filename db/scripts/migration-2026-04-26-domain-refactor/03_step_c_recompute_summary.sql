-- ============================================================================
-- Step C — sale_orders 汇总字段重算
-- ============================================================================
-- 来源：notes/tickets/2026-04-26-sale-order-domain-refactor.md §3.4
-- 前置：Step A / B 已 COMMIT；sale_order_payments 已包含全部历史回款 + 退款行
--
-- 重算的字段：
--   received          = SUM(sop.amount WHERE status='已支付' AND change_type IN ('首次支付','回款','储值卡抵扣'))
--   refunded_amount   = -SUM(sop.amount WHERE status='已支付' AND change_type='退款')
-- ============================================================================

BEGIN;

-- C0: 预检 — 抽样查看几条订单的当前 received vs 期望值（DRY-RUN 时启用）
-- SELECT
--     so.sale_order_id, so.received AS old_received,
--     COALESCE((
--         SELECT SUM(sop.amount) FROM sale_order_payments sop
--         WHERE sop.sale_order_id = so.sale_order_id AND sop.status = '已支付'
--           AND sop.change_type IN ('首次支付', '回款', '储值卡抵扣')
--     ), 0) AS new_received
-- FROM sale_orders so
-- WHERE so.sale_order_type = '销售单'
-- LIMIT 20;

-- C1: 重算 received（实收金额）
UPDATE sale_orders so SET received = COALESCE((
    SELECT SUM(sop.amount) FROM sale_order_payments sop
    WHERE sop.sale_order_id = so.sale_order_id
      AND sop.status = '已支付'
      AND sop.change_type IN ('首次支付', '回款', '储值卡抵扣')
), 0);

-- C2: 重算 refunded_amount（已退款金额，取正值）
UPDATE sale_orders so SET refunded_amount = COALESCE((
    SELECT -SUM(sop.amount) FROM sale_order_payments sop
    WHERE sop.sale_order_id = so.sale_order_id
      AND sop.status = '已支付'
      AND sop.change_type = '退款'
), 0);

-- C3: status 重算（如需）
-- 通常迁移后 status 不变，但需要校验一遍：
--   - 销售单：received >= total_amount → '已完成'/'已支付'
--             0 < received < total_amount → '部分支付'
--             received = 0 AND total_amount > 0 → '待支付' / '已关闭'（保留原值）
--             received < total_amount AND has_refund → 保留原值（业务逻辑复杂，本步不强制改）
-- 此 step 不强制改 status，仅输出可疑订单清单供人工核对：

-- C4: 输出汇总信息
SELECT
    'Step C — sale_orders 汇总重算完成' AS step,
    COUNT(*) AS total_sale_orders,
    SUM(CASE WHEN received > 0 THEN 1 ELSE 0 END) AS orders_with_received,
    SUM(CASE WHEN refunded_amount > 0 THEN 1 ELSE 0 END) AS orders_with_refund,
    ROUND(SUM(received), 2) AS total_received,
    ROUND(SUM(refunded_amount), 2) AS total_refunded
FROM sale_orders;

-- C5: 列出 received 和应收差异较大的订单（供 DBA 抽样审计）
SELECT
    so.sale_order_id,
    so.sale_order_type,
    so.status,
    so.total_amount,
    so.payable_amount,
    so.received,
    so.refunded_amount,
    so.payable_amount - so.received AS unpaid_balance
FROM sale_orders so
WHERE so.sale_order_type = '销售单'
  AND ABS(so.payable_amount - so.received - so.refunded_amount) > 0.01
ORDER BY ABS(so.payable_amount - so.received - so.refunded_amount) DESC
LIMIT 50;

COMMIT;
