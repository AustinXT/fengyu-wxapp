-- ============================================================================
-- Step B — 退款单迁移
-- ============================================================================
-- 来源：notes/tickets/2026-04-26-sale-order-domain-refactor.md §3.3
-- 前置：Step A 已 COMMIT；同样需要在 0018 enum 减值前执行（详见 01.sql 头注释）
--
-- 设计要点：
--   - 退款 amount 强制取负值（chk_sop_amount_sign 约束）
--   - 4 个状态分支：已支付 / 已完成 → status='已支付'
--                   待审批 → status='待审批'
--                   已关闭 / 支付失败 → status='已作废'
--   - B4 用 mapping 临时表（兼容多笔退款 created_at 撞期场景）
--   - sale_order_payment_details 写入：refund_reason / ref_sale_item_id /
--     session_count / audit_employee_id / audit_at / audit_remark / note
-- ============================================================================

BEGIN;

-- B0: 预检 — 列出待迁移的退款单按状态分布（DRY-RUN）
-- SELECT status, COUNT(*) FROM sale_orders WHERE sale_order_type = '退款单' GROUP BY status;

-- B1-mapping: 创建 mapping 临时表，记录每条退款单 → 新 payment_id
DROP TABLE IF EXISTS tmp_refund_mapping;
CREATE TEMP TABLE tmp_refund_mapping (
    legacy_sale_order_id VARCHAR(30) PRIMARY KEY,
    new_payment_id BIGINT NOT NULL,
    legacy_status TEXT NOT NULL                  -- 留作 B4 分支判断
);

-- B1: 已审批通过的退款单 → status='已支付', amount<0
WITH inserted AS (
    INSERT INTO sale_order_payments (
        sale_order_id,         -- 用 ref_sale_order_id 指向原销售单
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
        so.ref_sale_order_id,
        '退款',
        -ABS(so.received),                              -- 强制负数（received 是退款金额绝对值）
        so.payment_method,
        NULL,
        '已支付',
        'admin',
        so.paid_at,
        so.created_at
    FROM sale_orders so
    WHERE so.sale_order_type = '退款单'
      AND so.status IN ('已支付', '已完成')
      AND so.ref_sale_order_id IS NOT NULL
    RETURNING id AS payment_id, sale_order_id AS new_sale_order_id, created_at AS payment_created_at
)
INSERT INTO tmp_refund_mapping (legacy_sale_order_id, new_payment_id, legacy_status)
SELECT
    so.sale_order_id,
    i.payment_id,
    so.status::text
FROM inserted i
JOIN sale_orders so
  ON so.ref_sale_order_id = i.new_sale_order_id
  AND so.created_at = i.payment_created_at
  AND so.sale_order_type = '退款单'
  AND so.status IN ('已支付', '已完成');

-- B2: 待审批的退款单 → status='待审批', amount<0
--     注意：此处 amount 用 total_amount（待审批的 received 一般为 0，未实际退款）
WITH inserted AS (
    INSERT INTO sale_order_payments (
        sale_order_id, change_type, amount, payment_method,
        external_txn_id, status, source_end, created_at
    )
    SELECT
        so.ref_sale_order_id,
        '退款',
        -ABS(so.total_amount),
        so.payment_method,
        NULL,
        '待审批',
        'admin',
        so.created_at
    FROM sale_orders so
    WHERE so.sale_order_type = '退款单'
      AND so.status = '待审批'
      AND so.ref_sale_order_id IS NOT NULL
    RETURNING id AS payment_id, sale_order_id AS new_sale_order_id, created_at AS payment_created_at
)
INSERT INTO tmp_refund_mapping (legacy_sale_order_id, new_payment_id, legacy_status)
SELECT
    so.sale_order_id,
    i.payment_id,
    so.status::text
FROM inserted i
JOIN sale_orders so
  ON so.ref_sale_order_id = i.new_sale_order_id
  AND so.created_at = i.payment_created_at
  AND so.sale_order_type = '退款单'
  AND so.status = '待审批';

-- B3: 已驳回 / 已关闭的退款单 → status='已作废', amount<0
WITH inserted AS (
    INSERT INTO sale_order_payments (
        sale_order_id, change_type, amount, payment_method,
        external_txn_id, status, source_end, created_at
    )
    SELECT
        so.ref_sale_order_id,
        '退款',
        -ABS(so.total_amount),
        so.payment_method,
        NULL,
        '已作废',
        'admin',
        so.created_at
    FROM sale_orders so
    WHERE so.sale_order_type = '退款单'
      AND so.status IN ('已关闭', '支付失败')
      AND so.ref_sale_order_id IS NOT NULL
    RETURNING id AS payment_id, sale_order_id AS new_sale_order_id, created_at AS payment_created_at
)
INSERT INTO tmp_refund_mapping (legacy_sale_order_id, new_payment_id, legacy_status)
SELECT
    so.sale_order_id,
    i.payment_id,
    so.status::text
FROM inserted i
JOIN sale_orders so
  ON so.ref_sale_order_id = i.new_sale_order_id
  AND so.created_at = i.payment_created_at
  AND so.sale_order_type = '退款单'
  AND so.status IN ('已关闭', '支付失败');

-- B4: details 表写入 refund_reason / ref_sale_item_id / session_count / audit_*
--     使用 mapping 表，避免 created_at 配对歧义
INSERT INTO sale_order_payment_details (
    payment_id,
    operator_employee_id,                       -- 发起人（来自 sale_orders.opened_by）
    refund_reason,
    ref_sale_item_id,                           -- 关联的具体 sale_item（部分退款时填）
    session_count,
    audit_employee_id,                          -- 审批人（已审批的填，待审批为 NULL）
    audit_at,
    audit_remark,
    note,
    created_at,
    updated_at
)
SELECT
    m.new_payment_id,
    so.opened_by,
    so.refund_reason,
    NULL,                                       -- 老 sale_orders 退款单未存 ref_sale_item_id（粒度为整单）；
                                                -- 若业务有部分退款则需从 sale_items[item_direction='退出'] 反查，
                                                -- 此处一阶段保守为 NULL
    NULL,                                       -- session_count 同理（无字段映射，此处 NULL）
    so.approved_by,                             -- 审批人
    so.approved_at,
    so.rejected_reason,                         -- 审批备注用驳回原因（已审批通过则为 NULL）
    so.remark,
    so.created_at,
    NOW()
FROM tmp_refund_mapping m
JOIN sale_orders so ON so.sale_order_id = m.legacy_sale_order_id;

-- B5: 删除原退款单的子表数据（sale_items / sale_allocations）
DELETE FROM sale_allocations WHERE sale_item_id IN (
    SELECT sale_item_id FROM sale_items WHERE sale_order_id IN (
        SELECT legacy_sale_order_id FROM tmp_refund_mapping
    )
);

DELETE FROM sale_items WHERE sale_order_id IN (
    SELECT legacy_sale_order_id FROM tmp_refund_mapping
);

-- B6: 删除原退款单主表行
DELETE FROM sale_orders WHERE sale_order_type = '退款单';

-- B7: 输出迁移行数
SELECT
    'Step B — 退款单迁移完成' AS step,
    (SELECT COUNT(*) FROM tmp_refund_mapping WHERE legacy_status IN ('已支付', '已完成')) AS migrated_paid,
    (SELECT COUNT(*) FROM tmp_refund_mapping WHERE legacy_status = '待审批') AS migrated_pending,
    (SELECT COUNT(*) FROM tmp_refund_mapping WHERE legacy_status IN ('已关闭', '支付失败')) AS migrated_voided,
    (SELECT COUNT(*) FROM tmp_refund_mapping) AS total_migrated,
    (SELECT COUNT(*) FROM sale_order_payments WHERE change_type = '退款') AS new_refund_payment_count;

COMMIT;

-- B8: tmp_refund_mapping 在 04_step_d_5channel_rollback.sql 中可能被引用，
--     如果 D 在同一 session 顺序执行可保留；跨 session 则需重建。
--     本目录建议把 01-04 在同一 session 中按序执行（README §2 推荐）。
