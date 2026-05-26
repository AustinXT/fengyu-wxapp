-- ============================================================================
-- Step E — 全量校验（迁移后 + 上线前必跑）
-- ============================================================================
-- 来源：notes/tickets/2026-04-26-sale-order-domain-refactor.md §3.6 + §6.1 + §6.2
-- 通过标准：每条 SELECT 输出 0 / OK 才算通过；任何 > 0 的偏差都需人工介入
--
-- 执行方式：psql -h ... -U fengyu -d fengyu -f 05_step_e_validation.sql 2>&1 | tee validation.log
-- ============================================================================

\echo '============================================================'
\echo 'Step E — Sale Order Domain Refactor Validation Report'
\echo '============================================================'

-- ----------------------------------------------------------------------------
-- E1: sale_orders 不应再有 '回款单' / '退款单'
-- ----------------------------------------------------------------------------
\echo ''
\echo 'E1: sale_orders.sale_order_type 残留 (期望 0)'
SELECT
    'E1' AS check_id,
    COUNT(*) AS legacy_type_remaining,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM sale_orders
WHERE sale_order_type::text IN ('回款单', '退款单');

-- ----------------------------------------------------------------------------
-- E2: 已支付退款流水数量校验（外部对账，需迁移前抓取 baseline）
-- ----------------------------------------------------------------------------
\echo ''
\echo 'E2: sale_order_payments[退款,已支付] 总数（需对照迁移前 baseline）'
SELECT
    'E2' AS check_id,
    COUNT(*) AS migrated_paid_refund_count,
    'compare with pre-migration count of saleOrders[type=退款单, status IN (已支付,已完成)]' AS note
FROM sale_order_payments
WHERE change_type = '退款' AND status = '已支付';

\echo ''
\echo 'E2-aux: sale_order_payments[回款,已支付] 总数（需对照迁移前 saleOrders[type=回款单] 总数）'
SELECT
    'E2-aux' AS check_id,
    COUNT(*) AS migrated_repayment_count,
    'compare with pre-migration count of saleOrders[type=回款单]' AS note
FROM sale_order_payments
WHERE change_type = '回款' AND source_end = 'admin';

-- ----------------------------------------------------------------------------
-- E3: 不变量 received = SUM(payments[首次支付/回款/储值卡抵扣].amount)
-- ----------------------------------------------------------------------------
\echo ''
\echo 'E3: sale_orders.received 不变量校验 (期望 0 偏差行)'
SELECT
    'E3' AS check_id,
    COUNT(*) AS rows_with_drift,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM sale_orders so
WHERE ABS(so.received - COALESCE((
    SELECT SUM(sop.amount) FROM sale_order_payments sop
    WHERE sop.sale_order_id = so.sale_order_id
      AND sop.status = '已支付'
      AND sop.change_type IN ('首次支付', '回款', '储值卡抵扣')
), 0)) > 0.01;

-- E3-detail: 列出偏差最大的 10 条供人工核对
\echo ''
\echo 'E3-detail: 偏差最大的前 10 条（供人工核对）'
SELECT
    so.sale_order_id,
    so.received AS expected_received,
    COALESCE((
        SELECT SUM(sop.amount) FROM sale_order_payments sop
        WHERE sop.sale_order_id = so.sale_order_id AND sop.status = '已支付'
          AND sop.change_type IN ('首次支付', '回款', '储值卡抵扣')
    ), 0) AS actual_payments_sum,
    so.received - COALESCE((
        SELECT SUM(sop.amount) FROM sale_order_payments sop
        WHERE sop.sale_order_id = so.sale_order_id AND sop.status = '已支付'
          AND sop.change_type IN ('首次支付', '回款', '储值卡抵扣')
    ), 0) AS drift
FROM sale_orders so
WHERE ABS(so.received - COALESCE((
    SELECT SUM(sop.amount) FROM sale_order_payments sop
    WHERE sop.sale_order_id = so.sale_order_id AND sop.status = '已支付'
      AND sop.change_type IN ('首次支付', '回款', '储值卡抵扣')
), 0)) > 0.01
ORDER BY ABS(so.received - COALESCE((
    SELECT SUM(sop.amount) FROM sale_order_payments sop
    WHERE sop.sale_order_id = so.sale_order_id AND sop.status = '已支付'
      AND sop.change_type IN ('首次支付', '回款', '储值卡抵扣')
), 0)) DESC
LIMIT 10;

-- ----------------------------------------------------------------------------
-- E4: 不变量 refunded_amount = -SUM(payments[退款,已支付].amount)
-- ----------------------------------------------------------------------------
\echo ''
\echo 'E4: sale_orders.refunded_amount 不变量校验 (期望 0 偏差行)'
SELECT
    'E4' AS check_id,
    COUNT(*) AS rows_with_drift,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM sale_orders so
WHERE ABS(so.refunded_amount - COALESCE((
    SELECT -SUM(sop.amount) FROM sale_order_payments sop
    WHERE sop.sale_order_id = so.sale_order_id
      AND sop.status = '已支付'
      AND sop.change_type = '退款'
), 0)) > 0.01;

-- ----------------------------------------------------------------------------
-- E5: sale_allocations.is_void=true 行数 ≥ 历史已退款单关联 sa 行数
-- ----------------------------------------------------------------------------
\echo ''
\echo 'E5: sale_allocations 软删除覆盖率 (期望 covered=true)'
WITH refunded_orders AS (
    SELECT DISTINCT sop.sale_order_id
    FROM sale_order_payments sop
    WHERE sop.change_type = '退款' AND sop.status = '已支付'
),
expected_voided AS (
    SELECT COUNT(*) AS n
    FROM sale_allocations sa
    JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
    WHERE si.sale_order_id IN (SELECT sale_order_id FROM refunded_orders)
),
actual_voided AS (
    SELECT COUNT(*) AS n
    FROM sale_allocations sa
    JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
    WHERE si.sale_order_id IN (SELECT sale_order_id FROM refunded_orders)
      AND sa.is_void = true
)
SELECT
    'E5' AS check_id,
    expected_voided.n AS expected_voided_rows,
    actual_voided.n AS actual_voided_rows,
    CASE WHEN actual_voided.n >= expected_voided.n THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM expected_voided, actual_voided;

-- ----------------------------------------------------------------------------
-- E6: service_commissions.voided_at 非空行数覆盖率
-- ----------------------------------------------------------------------------
\echo ''
\echo 'E6: service_commissions 软删除覆盖率 (期望 covered=true)'
WITH refunded_orders AS (
    SELECT DISTINCT sop.sale_order_id
    FROM sale_order_payments sop
    WHERE sop.change_type = '退款' AND sop.status = '已支付'
),
expected AS (
    SELECT COUNT(*) AS n
    FROM service_commissions sc
    JOIN service_items si ON si.service_item_id = sc.service_item_id
    JOIN sale_items sli ON sli.sale_item_id = si.sale_item_id
    WHERE sli.sale_order_id IN (SELECT sale_order_id FROM refunded_orders)
),
actual AS (
    SELECT COUNT(*) AS n
    FROM service_commissions sc
    JOIN service_items si ON si.service_item_id = sc.service_item_id
    JOIN sale_items sli ON sli.sale_item_id = si.sale_item_id
    WHERE sli.sale_order_id IN (SELECT sale_order_id FROM refunded_orders)
      AND sc.voided_at IS NOT NULL
)
SELECT
    'E6' AS check_id,
    expected.n AS expected_voided_rows,
    actual.n AS actual_voided_rows,
    CASE WHEN actual.n >= expected.n THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM expected, actual;

-- ----------------------------------------------------------------------------
-- E7: customer_points.balance = SUM(point_transactions.amount) per user
-- ----------------------------------------------------------------------------
\echo ''
\echo 'E7: customer_points.balance 一致性校验 (期望 0 偏差用户)'
SELECT
    'E7' AS check_id,
    COUNT(*) AS users_with_balance_drift,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM customer_points cp
WHERE ABS(cp.balance - COALESCE((
    SELECT SUM(pt.amount) FROM point_transactions pt WHERE pt.user_id = cp.user_id
), 0)) > 0.01;

-- ----------------------------------------------------------------------------
-- E8: pickup_records.picked_up_quantity 不允许负
-- ----------------------------------------------------------------------------
\echo ''
\echo 'E8: pickup_records.picked_up_quantity 非负校验 (期望 0 违例)'
SELECT
    'E8' AS check_id,
    COUNT(*) AS negative_pickup_rows,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pickup_records
WHERE picked_up_quantity < 0;

-- ----------------------------------------------------------------------------
-- E9: sale_order_payment_details 行数 vs sale_order_payments 行数（应该接近）
-- ----------------------------------------------------------------------------
\echo ''
\echo 'E9: sale_order_payment_details 覆盖率 (大多数 payments 行应有 details)'
SELECT
    'E9' AS check_id,
    (SELECT COUNT(*) FROM sale_order_payments) AS payments_total,
    (SELECT COUNT(*) FROM sale_order_payment_details) AS details_total,
    ROUND(
        100.0 * (SELECT COUNT(*) FROM sale_order_payment_details)
        / NULLIF((SELECT COUNT(*) FROM sale_order_payments), 0),
        2
    ) AS coverage_pct;

-- ----------------------------------------------------------------------------
-- E10: chk_sop_amount_sign 不变量（DB CHECK 已强制，此处仅审计）
-- ----------------------------------------------------------------------------
\echo ''
\echo 'E10: sale_order_payments amount 符号一致性 (DB CHECK 兜底，期望 0)'
SELECT
    'E10' AS check_id,
    COUNT(*) AS sign_violation_rows,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM sale_order_payments
WHERE NOT (
    (change_type IN ('首次支付','回款','储值卡抵扣') AND amount > 0)
    OR (change_type = '退款' AND amount < 0)
);

-- ----------------------------------------------------------------------------
-- E11: uq_sop_status_audit 唯一性（不应有同原单两笔 in-flight 退款审批）
-- ----------------------------------------------------------------------------
\echo ''
\echo 'E11: 同原单 in-flight 退款审批唯一性 (期望 0)'
SELECT
    'E11' AS check_id,
    COUNT(*) AS duplicated_in_flight_audits,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM (
    SELECT sale_order_id, COUNT(*) AS n
    FROM sale_order_payments
    WHERE change_type = '退款' AND status = '待审批'
    GROUP BY sale_order_id
    HAVING COUNT(*) > 1
) dup;

-- ----------------------------------------------------------------------------
-- E12: saleOrderTypeEnum 应只剩 3 值
-- ----------------------------------------------------------------------------
\echo ''
\echo 'E12: saleOrderTypeEnum 当前值集 (期望 3 值)'
SELECT
    'E12' AS check_id,
    COUNT(*) AS enum_value_count,
    array_agg(enumlabel ORDER BY enumsortorder) AS values,
    CASE WHEN COUNT(*) = 3 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_enum e
JOIN pg_type t ON t.oid = e.enumtypid
WHERE t.typname = 'sale_order_type';

-- ----------------------------------------------------------------------------
-- E13: paymentFlowStatusEnum 应有 5 值（含 '待审批'）
-- ----------------------------------------------------------------------------
\echo ''
\echo 'E13: paymentFlowStatusEnum 当前值集 (期望 5 值含待审批)'
SELECT
    'E13' AS check_id,
    COUNT(*) AS enum_value_count,
    array_agg(enumlabel ORDER BY enumsortorder) AS values,
    CASE WHEN COUNT(*) = 5 AND '待审批' = ANY(array_agg(enumlabel)) THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_enum e
JOIN pg_type t ON t.oid = e.enumtypid
WHERE t.typname = 'payment_flow_status';

-- ----------------------------------------------------------------------------
-- E14: service_commissions.voided_at / voided_reason 列存在性（schema 校验）
-- ----------------------------------------------------------------------------
\echo ''
\echo 'E14: service_commissions schema 校验 (期望 voided_at + voided_reason 存在)'
SELECT
    'E14' AS check_id,
    COUNT(*) FILTER (WHERE column_name IN ('voided_at', 'voided_reason')) AS new_columns_present,
    CASE WHEN COUNT(*) FILTER (WHERE column_name IN ('voided_at', 'voided_reason')) = 2
         THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'service_commissions';

-- ----------------------------------------------------------------------------
-- E15: sale_orders 应已删除 paid_amount / wechat_transaction_id / alipay_transaction_id
-- ----------------------------------------------------------------------------
\echo ''
\echo 'E15: sale_orders 列删除校验 (期望 0 残留)'
SELECT
    'E15' AS check_id,
    COUNT(*) FILTER (WHERE column_name IN ('paid_amount', 'wechat_transaction_id', 'alipay_transaction_id')) AS legacy_cols_remaining,
    CASE WHEN COUNT(*) FILTER (WHERE column_name IN ('paid_amount', 'wechat_transaction_id', 'alipay_transaction_id')) = 0
         THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'sale_orders';

\echo ''
\echo '============================================================'
\echo '校验结束 — 任何 verdict=FAIL 都需人工介入'
\echo '============================================================'
