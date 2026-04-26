-- ============================================================================
-- Step D — 5 通道历史退款回滚（Q6.3=A 全量）
-- ============================================================================
-- 来源：notes/tickets/2026-04-26-sale-order-domain-refactor.md §3.5
-- 前置：Step A / B / C 已 COMMIT；sale_order_payments[change_type='退款',status='已支付'] 含全部历史已退款流水
--
-- 5 个通道：
--   D1: sale_allocations           → is_void = true（历史业绩冲销）
--   D2: service_commissions         → voided_at = NOW()（历史提成冲销）
--   D3: user_coupons                → status = '未使用'（仅未过期券恢复）
--   D4: point_transactions          → 写反向流水（消费冲销）
--   D5: customer_points.balance     → 重算
--   D6: pickup_records              → picked_up_quantity 反向恢复
--
-- ⚠️ 业务影响：员工历史业绩 / 提成可能为负，需事前公告（README §3）
--
-- ⚠️ 锁影响：5 通道操作的表都有索引覆盖，但仍建议 dry-run + 抽样审计
-- ============================================================================

BEGIN;

-- D-prep: 创建临时表，记录所有"已退款且关联原销售单"的 sale_order_id（仅审批通过的退款）
DROP TABLE IF EXISTS tmp_refunded_sale_orders;
CREATE TEMP TABLE tmp_refunded_sale_orders AS
SELECT DISTINCT sop.sale_order_id
FROM sale_order_payments sop
WHERE sop.change_type = '退款' AND sop.status = '已支付';

CREATE INDEX idx_tmp_refunded_sale_orders ON tmp_refunded_sale_orders(sale_order_id);

-- 输出本次回滚涉及的原销售单数
SELECT 'D-prep: 5 通道回滚涉及的原销售单数' AS step, COUNT(*) AS affected_sale_orders FROM tmp_refunded_sale_orders;

-- ----------------------------------------------------------------------------
-- D1: sale_allocations 软删除（已退款单关联的）
-- ----------------------------------------------------------------------------
UPDATE sale_allocations sa
SET is_void = true,
    voided_at = NOW(),
    updated_at = NOW()
WHERE sa.is_void = false
  AND sa.sale_item_id IN (
      SELECT si.sale_item_id FROM sale_items si
      WHERE si.sale_order_id IN (SELECT sale_order_id FROM tmp_refunded_sale_orders)
  );

-- D1-output
SELECT 'D1: sale_allocations 软删除完成' AS step,
    (SELECT COUNT(*) FROM sale_allocations WHERE is_void = true) AS total_voided,
    (SELECT COUNT(*) FROM sale_allocations WHERE is_void = true AND voided_at::date = NOW()::date) AS voided_today;

-- ----------------------------------------------------------------------------
-- D2: service_commissions 软删除（已退款单关联的）
-- ----------------------------------------------------------------------------
-- 注意：service_commissions 通过 service_items.service_order_id → service_orders.sale_item_id（如有）
--       → sale_items.sale_order_id 间接关联到原销售单
--       现 schema 里 service_orders 表没有 sale_item_id 列，但 service_items 关联 sale_items
--
-- 关联路径（需根据实际 schema 调整）：
--   service_commissions.service_item_id
--     → service_items.service_item_id
--     → service_items.sale_item_id (假设有)
--     → sale_items.sale_order_id
--     → tmp_refunded_sale_orders.sale_order_id
--
-- ⚠️ 实际 schema 中 service_items 关联 sale_items 的字段未确认，请 DBA dry-run 时核实
-- 以下使用最常见的"service_items.sale_item_id" 关联，必要时调整：

UPDATE service_commissions sc
SET voided_at = NOW(),
    voided_reason = '2026-04-26 历史退款回滚（D-Q6.3=A 全量）',
    updated_at = NOW()
WHERE sc.voided_at IS NULL
  AND sc.is_void = false
  AND sc.service_item_id IN (
      SELECT si.service_item_id FROM service_items si
      JOIN sale_items sli ON sli.sale_item_id = si.sale_item_id
      WHERE sli.sale_order_id IN (SELECT sale_order_id FROM tmp_refunded_sale_orders)
  );

-- D2-output
SELECT 'D2: service_commissions 软删除完成' AS step,
    (SELECT COUNT(*) FROM service_commissions WHERE voided_at IS NOT NULL) AS total_voided;

-- ----------------------------------------------------------------------------
-- D3: user_coupons 回滚（仅未过期的）
-- ----------------------------------------------------------------------------
UPDATE user_coupons uc
SET status = '未使用',
    used_at = NULL,
    used_sale_order_id = NULL
WHERE uc.status = '已使用'
  AND uc.used_sale_order_id IN (SELECT sale_order_id FROM tmp_refunded_sale_orders)
  AND (uc.expires_at IS NULL OR uc.expires_at > NOW());

-- D3-output
SELECT 'D3: user_coupons 恢复完成' AS step,
    (SELECT COUNT(*) FROM user_coupons WHERE status = '未使用' AND used_at IS NULL) AS recovered_count;

-- ----------------------------------------------------------------------------
-- D4: point_transactions 写反向流水（amount 取负）
-- ----------------------------------------------------------------------------
-- 注意：point_transactions 的列名取决于实际 schema（user_id / client_user_id / openid 等）
-- 此处假设字段名 user_id（如不一致请 DBA 调整）
INSERT INTO point_transactions (
    user_id,
    ref_sale_order_id,
    change_type,
    amount,
    created_at,
    note
)
SELECT
    pt.user_id,
    pt.ref_sale_order_id,
    '消费冲销',
    -pt.amount,
    NOW(),
    '2026-04-26 历史退款回滚'
FROM point_transactions pt
WHERE pt.ref_sale_order_id IN (SELECT sale_order_id FROM tmp_refunded_sale_orders)
  AND pt.change_type IN ('消费赠送', '回款赠送')
  -- 防重复执行（如果本 SQL 被 retry，避免无限累加冲销）
  AND NOT EXISTS (
      SELECT 1 FROM point_transactions pt2
      WHERE pt2.ref_sale_order_id = pt.ref_sale_order_id
        AND pt2.user_id = pt.user_id
        AND pt2.change_type = '消费冲销'
        AND pt2.amount = -pt.amount
  );

-- D4-output
SELECT 'D4: point_transactions 反向流水写入完成' AS step,
    (SELECT COUNT(*) FROM point_transactions WHERE change_type = '消费冲销' AND created_at::date = NOW()::date) AS reversal_count;

-- ----------------------------------------------------------------------------
-- D5: customer_points.balance 重算
-- ----------------------------------------------------------------------------
-- 重算所有受影响顾客的余额（仅那些有冲销流水的）
UPDATE customer_points cp
SET balance = COALESCE((
    SELECT SUM(pt.amount) FROM point_transactions pt WHERE pt.user_id = cp.user_id
), 0),
    updated_at = NOW()
WHERE cp.user_id IN (
    SELECT DISTINCT pt.user_id FROM point_transactions pt
    WHERE pt.ref_sale_order_id IN (SELECT sale_order_id FROM tmp_refunded_sale_orders)
);

-- D5-output
SELECT 'D5: customer_points.balance 重算完成' AS step,
    COUNT(*) AS affected_users
FROM customer_points cp
WHERE cp.user_id IN (
    SELECT DISTINCT pt.user_id FROM point_transactions pt
    WHERE pt.ref_sale_order_id IN (SELECT sale_order_id FROM tmp_refunded_sale_orders)
);

-- ----------------------------------------------------------------------------
-- D6: pickup_records 回滚（picked_up_quantity 反向恢复）
-- ----------------------------------------------------------------------------
-- 业务逻辑：
--   原销售单中包含家居产品 SKU，顾客提货后 pickup_records.picked_up_quantity 累计；
--   退款审批通过后，提货上限应恢复（picked_up_quantity 减回）
--
-- session_count 反推策略：
--   1. 优先用 sale_order_payment_details.session_count（部分退款指明退几次）
--   2. 否则用 sale_items.quantity（整单退）
--   3. 兜底 1（保守估计）
--
-- 反推数量上限：picked_up_quantity 不能减为负
WITH retract_qty AS (
    SELECT
        pr.id AS pickup_id,
        COALESCE(
            -- 优先：details 子表里有 session_count
            (SELECT spd.session_count
             FROM sale_order_payment_details spd
             JOIN sale_order_payments sop ON sop.id = spd.payment_id
             WHERE sop.sale_order_id = pr.sale_order_id
               AND sop.change_type = '退款' AND sop.status = '已支付'
               AND spd.ref_sale_item_id = pr.sale_item_id
             LIMIT 1),
            -- 次选：sale_items.quantity（整单退场景）
            (SELECT si.quantity FROM sale_items si WHERE si.sale_item_id = pr.sale_item_id),
            -- 兜底：1
            1
        ) AS qty
    FROM pickup_records pr
    WHERE pr.sale_order_id IN (SELECT sale_order_id FROM tmp_refunded_sale_orders)
)
UPDATE pickup_records pr
SET picked_up_quantity = GREATEST(0, pr.picked_up_quantity - r.qty)
FROM retract_qty r
WHERE r.pickup_id = pr.id
  AND pr.picked_up_quantity > 0;

-- D6-output
SELECT 'D6: pickup_records 提货回滚完成' AS step,
    (SELECT COUNT(*) FROM pickup_records pr
     WHERE pr.sale_order_id IN (SELECT sale_order_id FROM tmp_refunded_sale_orders)) AS pickup_records_affected;

COMMIT;

-- D7: 清理临时表
DROP TABLE IF EXISTS tmp_refunded_sale_orders;
