-- ============================================================================
-- Step A — 回款单迁移
-- ============================================================================
-- 来源：notes/tickets/2026-04-26-sale-order-domain-refactor.md §3.2
-- 前置：0018_black_madrox.sql 已 apply（sale_order_payment_details 表已存在；
--       sale_order_payments 主表已删 operator_employee_id / note 列；
--       saleOrderTypeEnum 已减为 3 值——但本步骤需要在减值之前执行，
--       因此实际执行顺序：先跑本 SQL（仍能查到 '回款单'），再让 0018 完成
--       enum 减值。详见 README §2 执行顺序）。
--
-- ⚠️ 实际部署时 0018 的 enum 减值（M6）必须**最后**跑：
--   1. M1-M5 / M7（除 enum 减值外的所有 schema 变更）
--   2. 数据迁移 Step A → B → C → D
--   3. M6 enum 减值（此时已无 '回款单' / '退款单' 行）
-- 但 drizzle-kit 把 M6 写在了 0018 末尾的同一个 .sql 里，无法拆分。
-- 解决方案：执行时手动拆 0018.sql 为两段（M1-M5/M7 + M6），中间插入数据迁移。
-- 或者先跑数据迁移（在 0018 还没 apply 时），再跑 0018 完整文件。
--
-- 推荐：先跑数据迁移（旧 schema 下），再 apply 0018（drizzle-kit 一刀切到位）。
-- 但前提是 sale_order_payment_details 子表当前不存在（这一步无法用 details 子表）。
-- 因此最稳的执行顺序见 README §2，由 DBA 把 0018 拆为前置 + 后置两段。
--
-- 本 SQL 假定执行时：
--   - 旧 saleOrderTypeEnum 仍含 '回款单' / '退款单' 值
--   - sale_order_payment_details 子表已存在（M2 已 apply）
--   - sale_order_payments 主表的 operator_employee_id / note 列**还**存在（M3 未 apply）
--   - 否则需调整 INSERT 字段列表
--
-- 设计要点：
--   - 用 CTE + RETURNING 拿到 (sale_order_id, payment_id) 映射
--   - 历史回款单的 received 即本次回款金额
--   - source_end='admin'（历史回款均由 admin 录入）
--   - paid_at / created_at 从原行拷贝，保留时间序
-- ============================================================================

BEGIN;

-- A0: 预检 — 列出待迁移的回款单（DRY-RUN 时启用，部署时跳过）
-- SELECT sale_order_id, ref_sale_order_id, received, payment_method, paid_at
-- FROM sale_orders WHERE sale_order_type = '回款单' ORDER BY created_at;

-- A1: 把每条回款单建一条 sale_order_payments[change_type='回款'] 行，
--     RETURNING 拿到 payment_id 到 mapping 临时表
DROP TABLE IF EXISTS tmp_repayment_mapping;
CREATE TEMP TABLE tmp_repayment_mapping (
    legacy_sale_order_id VARCHAR(30) PRIMARY KEY,    -- 原"回款单"的 sale_order_id
    new_payment_id BIGINT NOT NULL                    -- 新 sale_order_payments 行 id
);

WITH inserted_payments AS (
    INSERT INTO sale_order_payments (
        sale_order_id,         -- 原销售单 ID（注意：用 ref_sale_order_id）
        change_type,
        amount,
        payment_method,
        external_txn_id,
        status,
        source_end,
        paid_at,
        created_at
    )
    SELECT
        so.ref_sale_order_id,                          -- 原销售单 ID
        '回款',                                          -- changeType
        so.received,                                    -- 回款金额（原回款单的 received）
        so.payment_method,
        NULL,                                           -- 历史回款单无三方流水号
        '已支付',                                        -- 状态：已收款
        'admin',                                        -- 来源端：历史回款由 admin 录入
        so.paid_at,                                     -- 保留原 paid_at
        so.created_at                                   -- 保留原 created_at
    FROM sale_orders so
    WHERE so.sale_order_type = '回款单'
      AND so.ref_sale_order_id IS NOT NULL              -- 兜底：理论上回款单必有 ref
    RETURNING id AS payment_id, sale_order_id AS new_sale_order_id, created_at AS payment_created_at
)
INSERT INTO tmp_repayment_mapping (legacy_sale_order_id, new_payment_id)
SELECT
    so.sale_order_id,
    ip.payment_id
FROM inserted_payments ip
JOIN sale_orders so
  ON so.ref_sale_order_id = ip.new_sale_order_id
  AND so.created_at = ip.payment_created_at
  AND so.sale_order_type = '回款单';

-- A2: 把每条回款单的 operator / note 写入 sale_order_payment_details
INSERT INTO sale_order_payment_details (
    payment_id,
    operator_employee_id,
    note,
    created_at,
    updated_at
)
SELECT
    m.new_payment_id,
    so.opened_by,                                       -- 历史回款的"操作人" = sale_orders.opened_by
    so.remark,                                          -- 备注
    so.created_at,
    NOW()
FROM tmp_repayment_mapping m
JOIN sale_orders so ON so.sale_order_id = m.legacy_sale_order_id;

-- A3: 删除原回款单的明细 / 分配 / 提货 / 流水（若有）
-- 注意：sale_items / sale_allocations / pickup_records 等子表通过 sale_order_id FK 引用
-- 必须先 DELETE 子表，再 DELETE 主表
DELETE FROM sale_allocations WHERE sale_item_id IN (
    SELECT sale_item_id FROM sale_items WHERE sale_order_id IN (
        SELECT legacy_sale_order_id FROM tmp_repayment_mapping
    )
);

DELETE FROM sale_items WHERE sale_order_id IN (
    SELECT legacy_sale_order_id FROM tmp_repayment_mapping
);

-- A4: 删除原回款单主表行
DELETE FROM sale_orders WHERE sale_order_type = '回款单';

-- A5: 输出迁移行数（部署时用于核对）
SELECT
    'Step A — 回款单迁移完成' AS step,
    (SELECT COUNT(*) FROM tmp_repayment_mapping) AS migrated_count,
    (SELECT COUNT(*) FROM sale_order_payments WHERE change_type = '回款' AND source_end = 'admin') AS new_repayment_count;

COMMIT;

-- A6: 清理临时表（COMMIT 后）
-- TEMP TABLE 在 session 结束自动清理，但本 SQL 跨多文件时建议显式 DROP
-- DROP TABLE IF EXISTS tmp_repayment_mapping;
-- 注意：02 / 03 / 04 step 不依赖 tmp_repayment_mapping，可安全 DROP
