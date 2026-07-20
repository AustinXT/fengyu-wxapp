-- ============================================================================
-- fix-overpay-refund-remainder.sql
--
-- 用途：
--   一次性修复「部分支付单退款漏掉多收余数（overpay）」的存量已退款订单。
--   背景：commit 5bded1a2（2026-07-18）修复了 createRefund 的 overpay 哨兵行逻辑，
--   但 prod 云函数待部署，存量已退款单仍卡着 overpay 零头没退给顾客，且积分因按
--   refunded/received 比例冲销也连带残留。本脚本对这些订单补登一笔 overpay 退款行，
--   连带重算 refunded_amount / 积分冲销 / points_balance，使账面与「退款已退干净」一致。
--
--   实际补退现金给顾客是店长线下动作；本脚本只修账面数据。
--
-- 受影响订单（has_refund=true 且 overpay>0，2026-07-20 核实，prod/dev 双库一致）：
--   FY-XSD-WX-2607150028  received=3000 refunded=2786 overpay=214 审批人=FY-260521002
--   FY-XSD-WX-2607170029  received=600  refunded=398  overpay=202 审批人=FY-260521004
--   （另 4 单 overpay>0 但 has_refund=false，从没退过款、属「待退」，不在本脚本范围）
--
-- 执行方式（先开发库验证，再生产库）：
--   psql 'postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp' \
--        -f db/scripts/fix-overpay-refund-remainder.sql
--   psql 'postgresql://fengyu:fengyu123@118.178.196.26:5433/fengyu_wxapp' \
--        -f db/scripts/fix-overpay-refund-remainder.sql
--   执行前务必核对下方 inet_server_addr() 输出的 IP 与目标库一致（dev=47.113.202.7 / prod=118.178.196.26）。
--
-- 特性：
--   - 单事务：BEGIN/COMMIT 包裹，TEMP 表 ON COMMIT DROP；任一步出错整体回滚
--   - 幂等可重入：补登退款行/审计带 NOT EXISTS 守卫；refunded_amount/积分/points_balance 均为重算式覆盖
--   - 对齐 approveRefund 路径：overpay 哨兵行级联极简（通道 1/2/3/5 全 no-op，仅积分通道 4 + refunded 重算）
--   - 事后另需跑 admin cron-worker --once 刷 member_level/spending_tier/customer_status（cron 才能处理降级+150 天保级）
--
-- 对齐参考（不修改这些文件）：
--   fengyu-staff/cloudfunctions/staffApi/routes/order.js:2088-2114  createRefund overpay 哨兵追加
--   fengyu-staff/cloudfunctions/staffApi/routes/order.js:2346-2402  approveRefund 重算 refunded_amount + 级联
--   fengyu-staff/cloudfunctions/staffApi/helpers/refund-cascade.js:152-196  通道4 积分覆盖 + points_balance
--   fengyu-admin/src/lib/refund.ts:94-118  computeOverpayRemainder 公式
-- ============================================================================

\set ON_ERROR_STOP on

\echo '=== 连接复核（确认连的是目标库 IP）==='
SELECT inet_server_addr() AS server_ip, current_database() AS db, now() AS run_at;

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 目标订单表（加单只需追加一行）
-- ────────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE _overpay_targets(
  sale_order_id varchar(30) PRIMARY KEY,
  overpay_amount numeric(10,2) NOT NULL,
  auditor_emp varchar(30) NOT NULL,
  point_user text NOT NULL
) ON COMMIT DROP;

INSERT INTO _overpay_targets (sale_order_id, overpay_amount, auditor_emp, point_user) VALUES
  ('FY-XSD-WX-2607150028', 214.00, 'FY-260521002', 'FYGK-20260715-00011'),
  ('FY-XSD-WX-2607170029', 202.00, 'FY-260521004', 'FYGK-20260717-00029');

-- ────────────────────────────────────────────────────────────────────────────
-- 复核：每单实际 overpay 计算值应 = target.overpay_amount
--   overpay = max(0, (received − refunded) − consumedValue − Σ(未用整次×单价))
-- ────────────────────────────────────────────────────────────────────────────
\echo '=== 复核：每单实际 overpay vs target（应全 OK，MISMATCH 必须排查后再继续）==='
WITH item_calc AS (
  SELECT si.sale_order_id,
    CASE WHEN si.product_type='疗程卡'
      THEN GREATEST(0, COALESCE(si.session_count,0) - COALESCE(si.remaining_sessions,0)) * si.unit_real_price
      ELSE COALESCE(si.picked_up_quantity,0) * si.unit_real_price END AS consumed,
    CASE WHEN si.product_type='疗程卡' THEN
      CASE WHEN si.paid_sessions IS NULL THEN COALESCE(si.remaining_sessions,0)
        ELSE GREATEST(0, LEAST(COALESCE(si.remaining_sessions,0),
              si.paid_sessions - (COALESCE(si.session_count,0) - COALESCE(si.remaining_sessions,0)))) END
    ELSE GREATEST(0, COALESCE(si.quantity,0) - COALESCE(si.picked_up_quantity,0)) END * si.unit_real_price AS max_refund
  FROM sale_items si WHERE si.item_direction = '购买'
),
per_order AS (
  SELECT sale_order_id, SUM(consumed) AS c, SUM(max_refund) AS r
  FROM item_calc GROUP BY sale_order_id
)
SELECT t.sale_order_id, t.overpay_amount AS target,
       round(GREATEST(0,(so.received - so.refunded_amount) - po.c - po.r), 2) AS actual,
       CASE WHEN round(GREATEST(0,(so.received - so.refunded_amount) - po.c - po.r), 2) = t.overpay_amount
            THEN 'OK' ELSE 'MISMATCH' END AS chk
FROM _overpay_targets t
JOIN sale_orders so ON so.sale_order_id = t.sale_order_id
JOIN per_order po ON po.sale_order_id = t.sale_order_id
ORDER BY t.sale_order_id;

-- ────────────────────────────────────────────────────────────────────────────
-- 幂等守卫：已补退 overpay 的订单（note 含 isOverpay:true 的退款行）将排除
-- ────────────────────────────────────────────────────────────────────────────
\echo '=== 幂等守卫：已补退 overpay 的订单数（重跑时应 = 目标行数，即全 SKIP）==='
SELECT COUNT(*) AS already_backed_up
FROM _overpay_targets t
WHERE EXISTS (
  SELECT 1 FROM sale_order_payments sop
   WHERE sop.sale_order_id = t.sale_order_id
     AND sop.change_type = '退款'
     AND sop.note::text LIKE '%"isOverpay":%true%'
);

-- ────────────────────────────────────────────────────────────────────────────
-- 步骤 1：补登 overpay 退款行（哨兵行 refSaleItemId=OVERPAY，不挂品项/不退次数/不触发级联）
-- ────────────────────────────────────────────────────────────────────────────
\echo '=== 步骤 1：补登 overpay 退款行 ==='
INSERT INTO sale_order_payments (
  sale_order_id, change_type, amount, payment_method, external_txn_id,
  status, source_end, operator_employee_id, refund_reason,
  ref_sale_item_id, session_count, note, created_at, paid_at,
  audit_employee_id, audit_at, audit_remark
)
SELECT
  t.sale_order_id, '退款', -t.overpay_amount, '线下'::payment_method, NULL,
  '已支付'::payment_flow_status, 'admin'::payment_source_end, t.auditor_emp,
  '补退多收余数（历史 overpay bug 5bded1a2 数据修复）',
  NULL, NULL,
  (jsonb_build_object(
     '_v', 2,
     'refundByCard', 0,
     'refundByOrigin', t.overpay_amount,
     'handlingFee', 0,
     'refundPaymentMethod', '线下',
     'isWholeOrderRefund', false,
     'items', jsonb_build_array(jsonb_build_object(
        'refSaleItemId', 'OVERPAY',
        'quantity', 0,
        'refundAmount', t.overpay_amount,
        'productType', '多收余数',
        'isFullItemRefund', false,
        'isOverpay', true
     )),
     'overpayAmount', t.overpay_amount
  ))::text,
  NOW(), NOW(),
  t.auditor_emp, NOW(), 'overpay bug 数据修复'
FROM _overpay_targets t
WHERE NOT EXISTS (
  SELECT 1 FROM sale_order_payments sop
   WHERE sop.sale_order_id = t.sale_order_id
     AND sop.change_type = '退款'
     AND sop.note::text LIKE '%"isOverpay":%true%'
);

-- ────────────────────────────────────────────────────────────────────────────
-- 步骤 2：重算 sale_orders.refunded_amount = -Σ(已支付退款)（对齐 approveRefund，幂等自愈）
-- ────────────────────────────────────────────────────────────────────────────
\echo '=== 步骤 2：重算 refunded_amount ==='
UPDATE sale_orders so
   SET refunded_amount = COALESCE((
        SELECT -SUM(sop.amount) FROM sale_order_payments sop
         WHERE sop.sale_order_id = so.sale_order_id
           AND sop.change_type = '退款' AND sop.status = '已支付'
       ), 0),
       updated_at = NOW()
WHERE so.sale_order_id IN (SELECT sale_order_id FROM _overpay_targets);

-- ────────────────────────────────────────────────────────────────────────────
-- 步骤 3：积分通道 4 覆盖式重算（ON CONFLICT 覆盖 target = round(granted × refunded / received)）
--   依赖 partial unique index uq_point_txn_order_user_type
-- ────────────────────────────────────────────────────────────────────────────
\echo '=== 步骤 3：积分冲销覆盖式重算 ==='
INSERT INTO point_transactions (user_id, ref_order_id, type, amount, created_at)
SELECT t.point_user, t.sale_order_id, '消费冲销',
       -(round(g.granted * so.refunded_amount / NULLIF(so.received, 0), 0))::bigint,
       NOW()
FROM _overpay_targets t
JOIN sale_orders so ON so.sale_order_id = t.sale_order_id
JOIN (
  SELECT ref_order_id, SUM(amount) AS granted
    FROM point_transactions
   WHERE type IN ('消费赠送','回款赠送','获取') AND amount > 0
     AND ref_order_id IN (SELECT sale_order_id FROM _overpay_targets)
   GROUP BY ref_order_id
) g ON g.ref_order_id = t.sale_order_id
WHERE so.received > 0
ON CONFLICT (user_id, ref_order_id, type)
  WHERE ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销')
DO UPDATE SET amount = EXCLUDED.amount;

-- ────────────────────────────────────────────────────────────────────────────
-- 步骤 4：points_balance 重算 = Σ(point_transactions)（cron STEP9 只告警不修，必须内联）
-- ────────────────────────────────────────────────────────────────────────────
\echo '=== 步骤 4：重算 points_balance ==='
UPDATE client_wechat_users u
   SET points_balance = COALESCE((
        SELECT SUM(amount) FROM point_transactions WHERE user_id = u.user_id
       ), 0),
       points_updated_at = NOW(),
       updated_at = NOW()
WHERE u.user_id IN (SELECT point_user FROM _overpay_targets);

-- ────────────────────────────────────────────────────────────────────────────
-- 步骤 5：paid_sessions 守护断言（这两单 consumed=0 / paid_sessions=0，补退后仍 0，无需 UPDATE）
--   若未来扩展到已消费订单，此处 ok=false 的行需手动跑 recalcPaidSessionsForOrder 等价逻辑
-- ────────────────────────────────────────────────────────────────────────────
\echo '=== 步骤 5：paid_sessions 守护（consumed <= paid_sessions 应全 true）==='
SELECT t.sale_order_id, si.sale_item_id,
       (COALESCE(si.session_count,0) - COALESCE(si.remaining_sessions,0)) AS consumed,
       si.paid_sessions,
       ((COALESCE(si.session_count,0) - COALESCE(si.remaining_sessions,0)) <= COALESCE(si.paid_sessions,0)) AS ok
FROM _overpay_targets t
JOIN sale_items si ON si.sale_order_id = t.sale_order_id AND si.item_direction = '购买'
ORDER BY t.sale_order_id, si.sale_item_id;

-- ────────────────────────────────────────────────────────────────────────────
-- 步骤 6：operation_logs 审计
-- ────────────────────────────────────────────────────────────────────────────
\echo '=== 步骤 6：写 operation_logs 审计 ==='
INSERT INTO operation_logs (
  operator_employee_id, operator_name, action, target_type, target_id, detail, source, created_at
)
SELECT
  t.auditor_emp, '系统数据修复', 'datafix.overpayRefundBackfill',
  'sale_order_payment', t.sale_order_id,
  jsonb_build_object(
    'saleOrderId', t.sale_order_id,
    'overpayAmount', t.overpay_amount,
    'reason', 'overpay bug 5bded1a2 backfill',
    'note', '历史部分支付单退款漏多收余数，补登哨兵退款行 + 积分冲销覆盖 + points_balance'
  ),
  'admin', NOW()
FROM _overpay_targets t;
-- 注：审计日志无条件写入；重跑会追加审计行（无害，语义上记录每次执行）。

-- ────────────────────────────────────────────────────────────────────────────
-- 修复后对照
-- ────────────────────────────────────────────────────────────────────────────
\echo '=== 修复后：每单 received / refunded / net / 积分净额（net 应=0，积分净额应=0）==='
SELECT so.sale_order_id, so.received, so.refunded_amount,
       (so.received - so.refunded_amount) AS net,
       (SELECT SUM(amount) FROM point_transactions pt WHERE pt.ref_order_id = so.sale_order_id) AS points_net,
       (SELECT COUNT(*) FROM sale_order_payments sop
         WHERE sop.sale_order_id = so.sale_order_id AND sop.change_type='退款'
           AND sop.note::text LIKE '%"isOverpay":%true%') AS overpay_rows
FROM sale_orders so
WHERE so.sale_order_id IN (SELECT sale_order_id FROM _overpay_targets)
ORDER BY so.sale_order_id;

\echo '=== 修复后：顾客积分余额 ==='
SELECT u.user_id, u.name, u.points_balance
FROM client_wechat_users u
WHERE u.user_id IN (SELECT point_user FROM _overpay_targets)
ORDER BY u.user_id;

COMMIT;

\echo '=== 事务已提交。事后请跑 admin cron-worker --once 刷 member_level/spending_tier/customer_status ==='
