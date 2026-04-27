-- ============================================================================
-- migrate-sale-order-domain.sql
-- ============================================================================
-- Sale Order Domain Refactor — Consolidated Data Migration Script
--
-- 来源：notes/tickets/2026-04-26-sale-order-domain-refactor.md §3
-- 前置：0018 / 0019 DDL 已 apply（sale_order_payment_details 表已存在；
--       sale_order_type 枚举仍含 '回款单'/'退款单' 值——数据迁移在 enum 减值之前完成）
--
-- 执行顺序（强制）：
--   1. M1-M5+M7（0019 part1: 新增列/表/enum值）
--   2. 本 SQL（Step A → B → C → D → E）
--   3. M6（0019 part2: enum 5→3 减值）
--
-- ⚠️ 幂等性：Step A/B 有 idempotency guard（INSERT ... WHERE NOT EXISTS）；
--   Step D 有防重复回滚保护；Step C/D 可安全重跑。
-- ⚠️ 应用层冻结：执行期间必须冻结 admin / staff / client 写操作。
-- ============================================================================

-- ┌────────────────────────────────────────────────────────────────────────────
-- │ PRE-MIGRATION BASELINE SNAPSHOT（部署前请记录，供 E2/E2-aux 对账）
-- └────────────────────────────────────────────────────────────────────────────
-- 部署前手动执行以下查询并记录结果：
--
-- SELECT COUNT(*) AS baseline_repayment_orders FROM sale_orders WHERE sale_order_type = '回款单';
-- SELECT COUNT(*) AS baseline_refund_orders   FROM sale_orders WHERE sale_order_type = '退款单' AND status IN ('已支付','已完成');
-- SELECT COUNT(*) AS baseline_refund_pending  FROM sale_orders WHERE sale_order_type = '退款单' AND status = '待审批';
-- SELECT COUNT(*) AS baseline_refund_voided   FROM sale_orders WHERE sale_order_type = '退款单' AND status IN ('已关闭','支付失败');
-- COPY 以上结果备用。

RAISE NOTICE '============================================================';
RAISE NOTICE 'Sale Order Domain Refactor — Migration Starting';
RAISE NOTICE '============================================================';
RAISE NOTICE 'Assumes Phase 1 DDL (0018/0019 part1) already applied.';
RAISE NOTICE 'Enum reduction (M6) to be applied AFTER this script.';



-- ┌────────────────────────────────────────────────────────────────────────────
-- │ Step A — 回款单迁移 → sale_order_payments[change_type='回款']
-- └────────────────────────────────────────────────────────────────────────────
-- 映射规则：
--   sale_orders.ref_sale_order_id     → sale_order_payments.sale_order_id（原销售单）
--   sale_orders.received              → amount（正数）
--   sale_orders.payment_method        → payment_method
--   sale_orders.paid_at               → paid_at
--   sale_orders.created_at            → created_at
--   sale_orders.opened_by             → sale_order_payment_details.operator_employee_id
--   sale_orders.remark                → sale_order_payment_details.note
--   source_end = 'admin'
--   status    = '已支付'
-- ============================================================================

BEGIN;

RAISE NOTICE 'Step A: Migrating 回款单 → sale_order_payments...';

-- A0: 预检 — 列出待迁移行（幂等保护）
DO $$
DECLARE
    _cnt INTEGER;
BEGIN
    SELECT COUNT(*) INTO _cnt
    FROM sale_orders WHERE sale_order_type = '回款单';

    RAISE NOTICE 'A0: Found % 回款单 rows to migrate.', _cnt;

    -- A1: 创建 mapping 临时表
    DROP TABLE IF EXISTS tmp_repayment_mapping;
    CREATE TEMP TABLE tmp_repayment_mapping (
        legacy_sale_order_id VARCHAR(30) PRIMARY KEY,
        new_payment_id       BIGINT        NOT NULL
    );
END $$;

-- A1: INSERT sale_order_payments（幂等：跳过已存在的回款流水）
-- 用 (sale_order_id, change_type, amount, created_at) 做幂等键，
-- 避免同一回款单被重复执行时重复写入。
WITH inserted AS (
    INSERT INTO sale_order_payments (
        sale_order_id, change_type, amount, payment_method,
        external_txn_id, status, source_end, paid_at, created_at
    )
    SELECT
        so.ref_sale_order_id            AS sale_order_id,
        '回款'                            AS change_type,
        so.received::numeric(10,2)       AS amount,       -- 正数
        so.payment_method,
        NULL                             AS external_txn_id,
        '已支付'                           AS status,
        'admin'                          AS source_end,
        so.paid_at,
        so.created_at
    FROM sale_orders so
    WHERE so.sale_order_type = '回款单'
      AND so.ref_sale_order_id IS NOT NULL
      -- 幂等 guard：同订单、同金额、同时间戳的行不存在
      AND NOT EXISTS (
          SELECT 1 FROM sale_order_payments sop
          WHERE  sop.sale_order_id = so.ref_sale_order_id
            AND  sop.change_type  = '回款'
            AND  sop.amount       = so.received::numeric(10,2)
            AND  sop.created_at    = so.created_at
      )
    RETURNING id AS payment_id, sale_order_id, created_at
)
INSERT INTO tmp_repayment_mapping (legacy_sale_order_id, new_payment_id)
SELECT so.sale_order_id, ip.payment_id
FROM inserted ip
JOIN sale_orders so
  ON so.ref_sale_order_id = ip.sale_order_id
 AND so.created_at         = ip.created_at
 AND so.sale_order_type    = '回款单';

-- A2: INSERT sale_order_payment_details（操作人 + 备注）
INSERT INTO sale_order_payment_details (
    payment_id, operator_employee_id, note, created_at, updated_at
)
SELECT
    m.new_payment_id,
    so.opened_by,
    so.remark,
    so.created_at,
    NOW()
FROM tmp_repayment_mapping m
JOIN sale_orders so ON so.sale_order_id = m.legacy_sale_order_id
ON CONFLICT DO NOTHING;   -- 兜底幂等

-- A3: 删除子表（回款单理论上只有金额行，但保留删除逻辑以防有孤立的 sale_items）
DELETE FROM sale_allocations
WHERE sale_item_id IN (
    SELECT si.sale_item_id FROM sale_items si
    JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
    WHERE so.sale_order_type = '回款单'
);

DELETE FROM sale_items
WHERE sale_order_id IN (
    SELECT sale_order_id FROM sale_orders WHERE sale_order_type = '回款单'
);

-- A4: DELETE 原回款单主表行
DELETE FROM sale_orders WHERE sale_order_type = '回款单';

-- A5: 汇总输出
RAISE NOTICE 'A: 回款单迁移完成 — migrated: % rows  |  remaining 回款单: %',
    (SELECT COUNT(*) FROM tmp_repayment_mapping),
    (SELECT COUNT(*) FROM sale_orders WHERE sale_order_type = '回款单');

COMMIT;



-- ┌────────────────────────────────────────────────────────────────────────────
-- │ Step B — 退款单迁移 → sale_order_payments[change_type='退款']
-- └────────────────────────────────────────────────────────────────────────────
-- 三种状态分支：
--   B1: 退款单 status IN ('已支付','已完成')  → payment status='已支付',  amount<0
--   B2: 退款单 status = '待审批'              → payment status='待审批', amount<0
--   B3: 退款单 status IN ('已关闭','支付失败') → payment status='已作废', amount<0
--
-- amount 取负：-ABS(so.received) 或 -ABS(so.total_amount)
-- 映射：refund_reason → refund_reason, approved_by → audit_employee_id,
--       approved_at → audit_at, rejected_reason → audit_remark
-- ============================================================================

BEGIN;

RAISE NOTICE 'Step B: Migrating 退款单 → sale_order_payments...';

-- B-prep: 创建 mapping 临时表
DROP TABLE IF EXISTS tmp_refund_mapping;
CREATE TEMP TABLE tmp_refund_mapping (
    legacy_sale_order_id VARCHAR(30) PRIMARY KEY,
    new_payment_id       BIGINT        NOT NULL,
    legacy_status        TEXT          NOT NULL
);

-- B1: 已审批通过的退款单 → status='已支付', amount<0
WITH inserted AS (
    INSERT INTO sale_order_payments (
        sale_order_id, change_type, amount, payment_method,
        external_txn_id, status, source_end, paid_at, created_at
    )
    SELECT
        so.ref_sale_order_id                   AS sale_order_id,
        '退款'                                   AS change_type,
        -ABS(so.received::numeric(10,2))        AS amount,   -- 强制负数
        so.payment_method,
        NULL                                    AS external_txn_id,
        '已支付'                                  AS status,
        'admin'                                 AS source_end,
        so.paid_at,
        so.created_at
    FROM sale_orders so
    WHERE so.sale_order_type = '退款单'
      AND so.status IN ('已支付', '已完成')
      AND so.ref_sale_order_id IS NOT NULL
      -- 幂等 guard
      AND NOT EXISTS (
          SELECT 1 FROM sale_order_payments sop
          WHERE  sop.sale_order_id  = so.ref_sale_order_id
            AND  sop.change_type    = '退款'
            AND  sop.amount         = -ABS(so.received::numeric(10,2))
            AND  sop.created_at     = so.created_at
      )
    RETURNING id AS payment_id, sale_order_id, created_at
)
INSERT INTO tmp_refund_mapping (legacy_sale_order_id, new_payment_id, legacy_status)
SELECT so.sale_order_id, ip.payment_id, '已支付/已完成'::text
FROM inserted ip
JOIN sale_orders so
  ON so.ref_sale_order_id = ip.sale_order_id
 AND so.created_at         = ip.created_at
 AND so.sale_order_type    = '退款单'
 AND so.status             IN ('已支付', '已完成');

-- B2: 待审批的退款单 → status='待审批', amount<0
WITH inserted AS (
    INSERT INTO sale_order_payments (
        sale_order_id, change_type, amount, payment_method,
        external_txn_id, status, source_end, created_at
    )
    SELECT
        so.ref_sale_order_id                   AS sale_order_id,
        '退款'                                   AS change_type,
        -ABS(so.total_amount::numeric(10,2))     AS amount,   -- 待审批未实际退款，用 total_amount
        so.payment_method,
        NULL                                    AS external_txn_id,
        '待审批'                                  AS status,
        'admin'                                 AS source_end,
        so.created_at
    FROM sale_orders so
    WHERE so.sale_order_type = '退款单'
      AND so.status = '待审批'
      AND so.ref_sale_order_id IS NOT NULL
      -- 幂等 guard
      AND NOT EXISTS (
          SELECT 1 FROM sale_order_payments sop
          WHERE  sop.sale_order_id  = so.ref_sale_order_id
            AND  sop.change_type    = '退款'
            AND  sop.amount         = -ABS(so.total_amount::numeric(10,2))
            AND  sop.created_at     = so.created_at
            AND  sop.status         = '待审批'
      )
    RETURNING id AS payment_id, sale_order_id, created_at
)
INSERT INTO tmp_refund_mapping (legacy_sale_order_id, new_payment_id, legacy_status)
SELECT so.sale_order_id, ip.payment_id, '待审批'::text
FROM inserted ip
JOIN sale_orders so
  ON so.ref_sale_order_id = ip.sale_order_id
 AND so.created_at         = ip.created_at
 AND so.sale_order_type    = '退款单'
 AND so.status             = '待审批';

-- B3: 已驳回 / 已关闭的退款单 → status='已作废', amount<0
WITH inserted AS (
    INSERT INTO sale_order_payments (
        sale_order_id, change_type, amount, payment_method,
        external_txn_id, status, source_end, created_at
    )
    SELECT
        so.ref_sale_order_id                   AS sale_order_id,
        '退款'                                   AS change_type,
        -ABS(so.total_amount::numeric(10,2))     AS amount,
        so.payment_method,
        NULL                                    AS external_txn_id,
        '已作废'                                  AS status,
        'admin'                                 AS source_end,
        so.created_at
    FROM sale_orders so
    WHERE so.sale_order_type = '退款单'
      AND so.status IN ('已关闭', '支付失败')
      AND so.ref_sale_order_id IS NOT NULL
      -- 幂等 guard
      AND NOT EXISTS (
          SELECT 1 FROM sale_order_payments sop
          WHERE  sop.sale_order_id  = so.ref_sale_order_id
            AND  sop.change_type    = '退款'
            AND  sop.amount         = -ABS(so.total_amount::numeric(10,2))
            AND  sop.created_at     = so.created_at
            AND  sop.status         = '已作废'
      )
    RETURNING id AS payment_id, sale_order_id, created_at
)
INSERT INTO tmp_refund_mapping (legacy_sale_order_id, new_payment_id, legacy_status)
SELECT so.sale_order_id, ip.payment_id, '已作废'::text
FROM inserted ip
JOIN sale_orders so
  ON so.ref_sale_order_id = ip.sale_order_id
 AND so.created_at         = ip.created_at
 AND so.sale_order_type    = '退款单'
 AND so.status             IN ('已关闭', '支付失败');

-- B4: INSERT sale_order_payment_details（退款详情）
-- 注意：老 sale_orders 退款单未存 ref_sale_item_id / session_count，
--       此处保守写 NULL；如有部分退款需求，需从 sale_items 反查。
INSERT INTO sale_order_payment_details (
    payment_id,
    operator_employee_id,
    refund_reason,
    ref_sale_item_id,
    session_count,
    audit_employee_id,
    audit_at,
    audit_remark,
    note,
    created_at,
    updated_at
)
SELECT
    m.new_payment_id,
    so.opened_by,                     -- 发起人（操作员工）
    so.refund_reason,                 -- 退款原因
    NULL,                              -- 部分退款关联 sale_item（老数据无，保守 NULL）
    NULL,                              -- 退疗程次数（老数据无，保守 NULL）
    so.approved_by,                    -- 审批人
    so.approved_at,                   -- 审批时间
    so.rejected_reason,                -- 驳回原因（审批通过则为 NULL）
    so.remark,                         -- 备注
    so.created_at,
    NOW()
FROM tmp_refund_mapping m
JOIN sale_orders so ON so.sale_order_id = m.legacy_sale_order_id
ON CONFLICT DO NOTHING;   -- 兜底幂等

-- B5: 删除子表（sale_allocations / sale_items）
DELETE FROM sale_allocations
WHERE sale_item_id IN (
    SELECT si.sale_item_id FROM sale_items si
    JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
    WHERE so.sale_order_type = '退款单'
);

DELETE FROM sale_items
WHERE sale_order_id IN (
    SELECT sale_order_id FROM sale_orders WHERE sale_order_type = '退款单'
);

-- B6: DELETE 原退款单主表行
DELETE FROM sale_orders WHERE sale_order_type = '退款单';

-- B7: 汇总输出
RAISE NOTICE 'B: 退款单迁移完成';
RAISE NOTICE '   已支付/已完成: % | 待审批: % | 已作废: % | 总计: %',
    (SELECT COUNT(*) FROM tmp_refund_mapping WHERE legacy_status = '已支付/已完成'),
    (SELECT COUNT(*) FROM tmp_refund_mapping WHERE legacy_status = '待审批'),
    (SELECT COUNT(*) FROM tmp_refund_mapping WHERE legacy_status = '已作废'),
    (SELECT COUNT(*) FROM tmp_refund_mapping);
RAISE NOTICE '   sale_order_payments[change_type=退款] 总量: %',
    (SELECT COUNT(*) FROM sale_order_payments WHERE change_type = '退款');
RAISE NOTICE '   remaining 退款单 in sale_orders: %',
    (SELECT COUNT(*) FROM sale_orders WHERE sale_order_type = '退款单');

COMMIT;



-- ┌────────────────────────────────────────────────────────────────────────────
-- │ Step C — sale_orders.received / refunded_amount 重算
-- └────────────────────────────────────────────────────────────────────────────
-- 不变量（DB CHECK chk_sop_amount_sign 已强制符号一致性）：
--   received        = SUM(sop.amount  WHERE status='已支付' AND change_type IN ('首次支付','回款','储值卡抵扣'))
--   refunded_amount = -SUM(sop.amount  WHERE status='已支付' AND change_type='退款')
-- ============================================================================

BEGIN;

RAISE NOTICE 'Step C: Recalculating sale_orders.received and refunded_amount...';

-- C1: 重算 received（正向收款：首次支付 + 回款 + 储值卡抵扣）
UPDATE sale_orders so
SET received = COALESCE((
    SELECT SUM(sop.amount)
    FROM   sale_order_payments sop
    WHERE  sop.sale_order_id = so.sale_order_id
      AND  sop.status       = '已支付'
      AND  sop.change_type  IN ('首次支付', '回款', '储值卡抵扣')
), 0)::numeric(10,2);

-- C2: 重算 refunded_amount（取正值：-SUM(amount) 其中 amount < 0）
UPDATE sale_orders so
SET refunded_amount = COALESCE((
    SELECT -SUM(sop.amount)
    FROM   sale_order_payments sop
    WHERE  sop.sale_order_id = so.sale_order_id
      AND  sop.status        = '已支付'
      AND  sop.change_type   = '退款'
), 0)::numeric(10,2);

-- C3: 汇总输出
RAISE NOTICE 'C: sale_orders 汇总重算完成';
RAISE NOTICE '   总订单数: % | 有实收: % | 有退款: %',
    (SELECT COUNT(*)                               FROM sale_orders),
    (SELECT COUNT(*) WHERE received        > 0     FROM sale_orders),
    (SELECT COUNT(*) WHERE refunded_amount > 0     FROM sale_orders);
RAISE NOTICE '   实收合计: % | 退款合计: %',
    (SELECT ROUND(SUM(received),2)::numeric FROM sale_orders),
    (SELECT ROUND(SUM(refunded_amount),2)::numeric FROM sale_orders);

-- C4: 列出 payable_amount - received - refunded_amount 偏差 > 0.01 的订单（供人工审计）
RAISE NOTICE 'C: Orders with payable/received/refunded drift (showing top 10):';
RAISE NOTICE '%',
    (SELECT COALESCE(string_agg(
        format('  sale_order_id=%s | payable=%s received=%s refunded=%s drift=%s',
            so.sale_order_id,
            so.payable_amount,
            so.received,
            so.refunded_amount,
            ROUND((so.payable_amount - so.received - so.refunded_amount)::numeric,2)
        ), E'\n'
    ), '  (none)')
    FROM sale_orders so
    WHERE so.sale_order_type IN ('销售单','内部单','转换单')
      AND ABS(so.payable_amount - so.received - so.refunded_amount) > 0.01
    LIMIT 10);

COMMIT;



-- ┌────────────────────────────────────────────────────────────────────────────
-- │ Step D — 5 通道历史退款回滚
-- └────────────────────────────────────────────────────────────────────────────
-- 针对 sale_order_payments[change_type='退款', status='已支付'] 关联的原销售单，
-- 回滚以下 5 通道：
--   D1: sale_allocations           → is_void=true, voided_at=NOW()
--   D2: service_commissions        → voided_at=NOW(), voided_reason
--   D3: user_coupons               → status='未使用', used_at=NULL, used_sale_order_id=NULL（仅未过期）
--   D4: point_transactions          → INSERT reverse entry（type='消费冲销', amount<0）
--   D5: client_wechat_users.points_balance → 重算（基于 point_transactions SUM）
--   D6: pickup_records             → picked_up_quantity 逆向恢复
--
-- ⚠️ 幂等：D4 有防重复冲销 guard；D1-D3 可安全重跑（UPDATE 同值 no-op）
-- ⚠️ 业务影响：员工业绩 / 提成可能变负，详见 README §3 公告
-- ============================================================================

BEGIN;

RAISE NOTICE 'Step D: Rolling back 5 channels for historical refunds...';

-- D-prep: 收集所有已退款原销售单 ID
DROP TABLE IF EXISTS tmp_refunded_sale_orders;
CREATE TEMP TABLE tmp_refunded_sale_orders AS
SELECT DISTINCT sop.sale_order_id
FROM sale_order_payments sop
WHERE sop.change_type = '退款'
  AND sop.status      = '已支付';

CREATE INDEX idx_tmp_rso ON tmp_refunded_sale_orders(sale_order_id);

RAISE NOTICE 'D-prep: % affected original sale orders with 已支付 refunds',
    (SELECT COUNT(*) FROM tmp_refunded_sale_orders);

-- ----------------------------------------------------------------------------
-- D1: sale_allocations 软删除
-- ----------------------------------------------------------------------------
UPDATE sale_allocations sa
SET    is_void   = true,
       voided_at = NOW(),
       updated_at= NOW()
WHERE  sa.is_void = false
  AND  sa.sale_item_id IN (
      SELECT si.sale_item_id FROM sale_items si
      WHERE si.sale_order_id IN (SELECT sale_order_id FROM tmp_refunded_sale_orders)
  );

RAISE NOTICE 'D1: sale_allocations.is_void=true — affected: %',
    (SELECT COUNT(*) FROM sale_allocations
     WHERE sale_item_id IN (
         SELECT si.sale_item_id FROM sale_items si
         WHERE si.sale_order_id IN (SELECT sale_order_id FROM tmp_refunded_sale_orders)
     ) AND is_void = true);

-- ----------------------------------------------------------------------------
-- D2: service_commissions 软删除
-- 关联路径: service_commissions.service_item_id → service_items.service_item_id
--           → service_items.sale_item_id → sale_items.sale_item_id → sale_order_id
-- ----------------------------------------------------------------------------
UPDATE service_commissions sc
SET    voided_at     = NOW(),
       voided_reason = '2026-04-27 历史退款回滚（D2）',
       updated_at     = NOW()
WHERE  sc.voided_at IS NULL
  AND  sc.is_void    = false
  AND  sc.service_item_id IN (
      SELECT si.service_item_id
      FROM   service_items si
      JOIN   sale_items    sli ON sli.sale_item_id = si.sale_item_id
      WHERE  sli.sale_order_id IN (SELECT sale_order_id FROM tmp_refunded_sale_orders)
  );

RAISE NOTICE 'D2: service_commissions voided — affected: %',
    (SELECT COUNT(*) FROM service_commissions
     WHERE service_item_id IN (
         SELECT si.service_item_id FROM service_items si
         JOIN sale_items sli ON sli.sale_item_id = si.sale_item_id
         WHERE sli.sale_order_id IN (SELECT sale_order_id FROM tmp_refunded_sale_orders)
     ) AND voided_at IS NOT NULL);

-- ----------------------------------------------------------------------------
-- D3: user_coupons 回滚（仅未过期券）
-- ----------------------------------------------------------------------------
UPDATE user_coupons uc
SET    status           = '未使用',
       used_at          = NULL,
       used_sale_order_id = NULL
WHERE  uc.status              = '已使用'
  AND  uc.used_sale_order_id IN (SELECT sale_order_id FROM tmp_refunded_sale_orders)
  AND  uc.expire_at           > NOW();   -- 仅未过期券

RAISE NOTICE 'D3: user_coupons restored to 未使用 — affected: %',
    (SELECT COUNT(*) FROM user_coupons uc
     WHERE uc.status              = '未使用'
       AND uc.used_sale_order_id  IN (SELECT sale_order_id FROM tmp_refunded_sale_orders)
       AND uc.expire_at           > NOW());

-- ----------------------------------------------------------------------------
-- D4: point_transactions 写反向流水（幂等 guard）
-- 注意：point_transactions.amount 为 INTEGER
--       type 字段存储积分类型（原字段名，区别于 sop.change_type）
-- ----------------------------------------------------------------------------
WITH refunded_pts AS (
    -- 找出所有需要冲销的积分获取流水
    SELECT DISTINCT pt.id, pt.user_id, pt.ref_sale_order_id, pt.amount
    FROM point_transactions pt
    JOIN tmp_refunded_sale_orders rso ON rso.sale_order_id = pt.ref_sale_order_id
    WHERE pt.type IN ('消费赠送', '回款赠送')
)
INSERT INTO point_transactions (user_id, ref_sale_order_id, type, amount, created_at)
SELECT
    rp.user_id,
    rp.ref_sale_order_id,
    '消费冲销'::text    AS type,
    -rp.amount          AS amount,   -- 整数负数
    NOW()               AS created_at
FROM refunded_pts rp
WHERE NOT EXISTS (
    -- 幂等 guard：同订单、同用户、同金额的冲销行不存在
    SELECT 1 FROM point_transactions pt2
    WHERE  pt2.ref_sale_order_id = rp.ref_sale_order_id
      AND  pt2.user_id            = rp.user_id
      AND  pt2.type               = '消费冲销'
      AND  pt2.amount             = -rp.amount
);

RAISE NOTICE 'D4: point_transactions reverse entries inserted — count: %',
    (SELECT COUNT(*) FROM point_transactions
     WHERE type      = '消费冲销'
       AND ref_sale_order_id IN (SELECT sale_order_id FROM tmp_refunded_sale_orders)
       AND created_at::date  = NOW()::date);

-- ----------------------------------------------------------------------------
-- D5: client_wechat_users.points_balance 重算
-- 注意：积分余额在 client_wechat_users.points_balance（不是独立表）
--       权威源为 point_transactions SUM
-- ----------------------------------------------------------------------------
UPDATE client_wechat_users cwu
SET    points_balance  = COALESCE((
    SELECT SUM(pt.amount)
    FROM   point_transactions pt
    WHERE  pt.user_id = cwu.user_id
), 0),
       points_updated_at = NOW()
WHERE  cwu.user_id IN (
    SELECT DISTINCT pt.user_id
    FROM   point_transactions pt
    JOIN   tmp_refunded_sale_orders rso ON rso.sale_order_id = pt.ref_sale_order_id
);

RAISE NOTICE 'D5: client_wechat_users.points_balance recalculated — affected users: %',
    (SELECT COUNT(*) FROM client_wechat_users cwu
     WHERE cwu.user_id IN (
         SELECT DISTINCT pt.user_id
         FROM point_transactions pt
         JOIN tmp_refunded_sale_orders rso ON rso.sale_order_id = pt.ref_sale_order_id
     ));

-- ----------------------------------------------------------------------------
-- D6: pickup_records 逆向恢复 picked_up_quantity
-- 关联路径: pickup_records.sale_item_id → sale_items.sale_item_id → sale_order_id
-- 注意：pickup_records 没有 sale_order_id 列，必须经由 sale_items 间接关联
--       session_count 反推三层降级：
--         1. sale_order_payment_details.session_count（部分退款指明次数）
--         2. sale_items.quantity（整单退）
--         3. 兜底 1
--       picked_up_quantity 不得为负
-- ----------------------------------------------------------------------------
WITH refund_sale_items AS (
    SELECT si.sale_item_id, si.quantity
    FROM   sale_items si
    WHERE  si.sale_order_id IN (SELECT sale_order_id FROM tmp_refunded_sale_orders)
),
refund_sale_item_ids AS (
    SELECT sale_item_id FROM refund_sale_items
),
retract_qty AS (
    SELECT
        pr.id                                             AS pickup_id,
        pr.sale_item_id,
        pr.picked_up_quantity,
        LEAST(
            pr.picked_up_quantity,
            COALESCE(
                -- 优先：details 子表里有 session_count（部分退款场景）
                (SELECT spd.session_count
                 FROM   sale_order_payment_details spd
                 JOIN   sale_order_payments sop ON sop.id = spd.payment_id
                 WHERE  sop.sale_order_id        IN (SELECT sale_order_id FROM tmp_refunded_sale_orders)
                   AND  sop.change_type            = '退款'
                   AND  sop.status                 = '已支付'
                   AND  spd.ref_sale_item_id       = pr.sale_item_id
                 LIMIT 1),
                -- 次选：sale_items.quantity（整单退）
                (SELECT si.quantity
                 FROM   sale_items si
                 WHERE  si.sale_item_id = pr.sale_item_id
                 LIMIT 1),
                1   -- 兜底：1
            )
        ) AS retract_amt
    FROM   pickup_records pr
    WHERE  pr.sale_item_id IN (SELECT sale_item_id FROM refund_sale_item_ids)
)
UPDATE pickup_records pr
SET    picked_up_quantity = pr.picked_up_quantity - r.retract_amt
FROM   retract_qty r
WHERE  r.pickup_id = pr.id
  AND  r.picked_up_quantity > 0;

RAISE NOTICE 'D6: pickup_records.picked_up_quantity reversed — affected records: %',
    (SELECT COUNT(*) FROM pickup_records pr
     WHERE pr.sale_item_id IN (SELECT sale_item_id FROM refund_sale_item_ids)
       AND pr.picked_up_quantity >= 0);

COMMIT;

-- D-cleanup: 清理临时表
DROP TABLE IF EXISTS tmp_refunded_sale_orders;



-- ┌────────────────────────────────────────────────────────────────────────────
-- │ Step E — 校验（Validation Queries）
-- └────────────────────────────────────────────────────────────────────────────
-- 每条校验都有 verdict 列；期望全部 PASS（FAIL 需人工介入）
-- 执行：psql -f db/scripts/migrate-sale-order-domain.sql 2>&1 | tee migration.log
--      grep -E '^(E[0-9]+|Step E|PASS|FAIL|remaining)' migration.log
-- ============================================================================

RAISE NOTICE '';
RAISE NOTICE '============================================================';
RAISE NOTICE 'Step E — Validation Queries';
RAISE NOTICE '============================================================';

-- E1: sale_orders 不应再有 '回款单' / '退款单'
SELECT
    'E1'                                                                    AS check_id,
    'sale_orders legacy type 残留'                                            AS description,
    COUNT(*)                                                                 AS remaining_count,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL — 需要人工处理' END        AS verdict
FROM   sale_orders
WHERE  sale_order_type IN ('回款单', '退款单');

-- E2: 已支付退款流水数 vs 迁移前 baseline（需人工对照 Step B 输出）
SELECT
    'E2'                                                                              AS check_id,
    'sale_order_payments[退款,已支付] 数量（需对照迁移前 baseline）'                     AS description,
    COUNT(*)                                                                           AS current_count,
    'See B7 output above — compare with pre-migration 退款单[已支付/已完成] count'        AS note,
    CASE WHEN COUNT(*) > 0 THEN 'INFO — 非零表示有历史已退款流水（预期）' ELSE 'WARN — 无退款流水' END AS verdict
FROM   sale_order_payments
WHERE  change_type = '退款'
  AND  status      = '已支付';

-- E2-aux: 回款流水数 vs 迁移前 baseline
SELECT
    'E2-aux'                                                                           AS check_id,
    'sale_order_payments[回款,admin] 数量（需对照迁移前 baseline）'                        AS description,
    COUNT(*)                                                                            AS current_count,
    'See A5 output above — compare with pre-migration 回款单 count'                      AS note,
    CASE WHEN COUNT(*) >= 0 THEN 'INFO' END                                              AS verdict
FROM   sale_order_payments
WHERE  change_type = '回款'
  AND  source_end  = 'admin';

-- E3: 不变量 received = Σ(sop.amount WHERE status='已支付' AND change_type IN ('首次支付','回款','储值卡抵扣'))
SELECT
    'E3'                                                               AS check_id,
    'sale_orders.received 不变量校验'                                   AS description,
    COUNT(*)                                                            AS drift_rows,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END                 AS verdict
FROM   sale_orders so
WHERE  ABS(
    so.received::numeric - COALESCE((
        SELECT SUM(sop.amount)::numeric
        FROM   sale_order_payments sop
        WHERE  sop.sale_order_id = so.sale_order_id
          AND  sop.status        = '已支付'
          AND  sop.change_type   IN ('首次支付', '回款', '储值卡抵扣')
    ), 0)
) > 0.01;

-- E3-detail: 偏差最大的前 10 条
SELECT
    'E3-detail'                                                                   AS check_id,
    so.sale_order_id,
    so.received::numeric                                                         AS stored_received,
    COALESCE((
        SELECT SUM(sop.amount)::numeric
        FROM   sale_order_payments sop
        WHERE  sop.sale_order_id = so.sale_order_id
          AND  sop.status        = '已支付'
          AND  sop.change_type   IN ('首次支付', '回款', '储值卡抵扣')
    ), 0)                                                                         AS actual_sum,
    (so.received::numeric - COALESCE((
        SELECT SUM(sop.amount)::numeric
        FROM   sale_order_payments sop
        WHERE  sop.sale_order_id = so.sale_order_id
          AND  sop.status        = '已支付'
          AND  sop.change_type   IN ('首次支付', '回款', '储值卡抵扣')
    ), 0))                                                                        AS drift
FROM   sale_orders so
WHERE  ABS(
    so.received::numeric - COALESCE((
        SELECT SUM(sop.amount)::numeric
        FROM   sale_order_payments sop
        WHERE  sop.sale_order_id = so.sale_order_id
          AND  sop.status        = '已支付'
          AND  sop.change_type   IN ('首次支付', '回款', '储值卡抵扣')
    ), 0)
) > 0.01
ORDER  BY ABS(
    so.received::numeric - COALESCE((
        SELECT SUM(sop.amount)::numeric
        FROM   sale_order_payments sop
        WHERE  sop.sale_order_id = so.sale_order_id
          AND  sop.status        = '已支付'
          AND  sop.change_type   IN ('首次支付', '回款', '储值卡抵扣')
    ), 0)
) DESC
LIMIT 10;

-- E4: 不变量 refunded_amount = -Σ(sop.amount WHERE status='已支付' AND change_type='退款')
SELECT
    'E4'                                                                   AS check_id,
    'sale_orders.refunded_amount 不变量校验'                                AS description,
    COUNT(*)                                                                AS drift_rows,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END                     AS verdict
FROM   sale_orders so
WHERE  ABS(
    so.refunded_amount::numeric - COALESCE((
        SELECT -SUM(sop.amount)::numeric
        FROM   sale_order_payments sop
        WHERE  sop.sale_order_id = so.sale_order_id
          AND  sop.status        = '已支付'
          AND  sop.change_type   = '退款'
    ), 0)
) > 0.01;

-- E5: sale_allocations.is_void=true 行数覆盖
WITH refunded_orders AS (
    SELECT DISTINCT sop.sale_order_id
    FROM   sale_order_payments sop
    WHERE  sop.change_type = '退款'
      AND  sop.status      = '已支付'
),
expected_voided AS (
    SELECT COUNT(*) AS n
    FROM   sale_allocations sa
    JOIN   sale_items       si ON si.sale_item_id  = sa.sale_item_id
    WHERE  si.sale_order_id IN (SELECT sale_order_id FROM refunded_orders)
      AND  sa.is_void       = false   -- 迁移前应为 false
),
actual_voided AS (
    SELECT COUNT(*) AS n
    FROM   sale_allocations sa
    JOIN   sale_items       si ON si.sale_item_id = sa.sale_item_id
    WHERE  si.sale_order_id IN (SELECT sale_order_id FROM refunded_orders)
      AND  sa.is_void       = true    -- 迁移后应为 true
)
SELECT
    'E5'                                                             AS check_id,
    'sale_allocations.is_void 覆盖率'                                AS description,
    expected_voided.n                                               AS expected_voided,
    actual_voided.n                                                  AS actual_voided,
    CASE WHEN actual_voided.n >= expected_voided.n THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM expected_voided, actual_voided;

-- E6: service_commissions.voided_at 覆盖率
WITH refunded_orders AS (
    SELECT DISTINCT sop.sale_order_id
    FROM   sale_order_payments sop
    WHERE  sop.change_type = '退款'
      AND  sop.status      = '已支付'
),
expected AS (
    SELECT COUNT(*) AS n
    FROM   service_commissions sc
    JOIN   service_items       si ON si.service_item_id = sc.service_item_id
    JOIN   sale_items          sli ON sli.sale_item_id   = si.sale_item_id
    WHERE  sli.sale_order_id   IN (SELECT sale_order_id FROM refunded_orders)
      AND  sc.voided_at       IS NULL
),
actual AS (
    SELECT COUNT(*) AS n
    FROM   service_commissions sc
    JOIN   service_items       si ON si.service_item_id = sc.service_item_id
    JOIN   sale_items          sli ON sli.sale_item_id   = si.sale_item_id
    WHERE  sli.sale_order_id   IN (SELECT sale_order_id FROM refunded_orders)
      AND  sc.voided_at       IS NOT NULL
)
SELECT
    'E6'                                                      AS check_id,
    'service_commissions.voided_at 覆盖率'                   AS description,
    expected.n                                                AS expected_not_voided,
    actual.n                                                  AS actual_voided,
    CASE WHEN actual.n >= expected.n THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM expected, actual;

-- E7: client_wechat_users.points_balance = SUM(point_transactions.amount)
SELECT
    'E7'                                                                          AS check_id,
    'points_balance 一致性校验'                                                     AS description,
    COUNT(*)                                                                       AS users_with_drift,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END                              AS verdict
FROM   client_wechat_users cwu
WHERE  cwu.points_balance <> COALESCE((
    SELECT SUM(pt.amount)
    FROM   point_transactions pt
    WHERE  pt.user_id = cwu.user_id
), 0);

-- E8: pickup_records.picked_up_quantity 非负
SELECT
    'E8'                                                                    AS check_id,
    'pickup_records.picked_up_quantity 非负校验'                             AS description,
    COUNT(*)                                                               AS negative_rows,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL — 需人工处理' END         AS verdict
FROM   pickup_records
WHERE  picked_up_quantity < 0;

-- E9: sale_order_payment_details 覆盖率
SELECT
    'E9'                                                                  AS check_id,
    'sale_order_payment_details 覆盖率'                                   AS description,
    (SELECT COUNT(*) FROM sale_order_payments)                            AS payments_total,
    (SELECT COUNT(*) FROM sale_order_payment_details)                     AS details_total,
    ROUND(
        100.0 * (SELECT COUNT(*) FROM sale_order_payment_details)
        / NULLIF((SELECT COUNT(*) FROM sale_order_payments), 0),
    2)                                                                     AS coverage_pct,
    CASE WHEN (SELECT COUNT(*) FROM sale_order_payment_details) > 0
         THEN 'INFO — 覆盖率需结合业务判断（回款/退款/首次支付应有 details）'
         ELSE 'WARN — 无 details，可能 schema 未就绪' END                    AS verdict;

-- E10: chk_sop_amount_sign DB CHECK 审计（DB 已强制，此处仅读）
SELECT
    'E10'                                                                                         AS check_id,
    'sale_order_payments amount 符号一致性（DB CHECK chk_sop_amount_sign 强制）'                    AS description,
    COUNT(*)                                                                                      AS sign_violations,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL — DB CHECK 应阻止这些行' END                     AS verdict
FROM   sale_order_payments
WHERE  NOT (
    (change_type IN ('首次支付', '回款', '储值卡抵扣') AND amount > 0)
    OR (change_type = '退款' AND amount < 0)
);

-- E11: 同原单 in-flight 退款审批唯一性（uq_sop_status_audit 约束）
SELECT
    'E11'                                                        AS check_id,
    '同原单 in-flight 退款审批唯一性（uq_sop_status_audit 约束）'  AS description,
    COUNT(*)                                                     AS duplicate_in_flight,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END           AS verdict
FROM (
    SELECT sale_order_id, COUNT(*) AS n
    FROM   sale_order_payments
    WHERE  change_type = '退款'
      AND  status      = '待审批'
    GROUP  BY sale_order_id
    HAVING COUNT(*) > 1
) dup;

-- E12: sale_order_type 枚举当前值（enum 减值 M6 待本步骤后执行）
SELECT
    'E12'                                                       AS check_id,
    'sale_order_type 枚举值（期望 3 值：销售单/内部单/转换单）'    AS description,
    COUNT(*)                                                    AS enum_value_count,
    array_agg(enumlabel ORDER BY enumsortorder)                 AS values,
    CASE WHEN COUNT(*) = 3 THEN 'INFO — 3 值（回款单/退款单 待M6删除）'
         WHEN COUNT(*) = 5 THEN 'WARN — 5 值（未执行 enum 减值 M6）'
         ELSE 'FAIL — 枚举值数量异常' END                        AS verdict
FROM   pg_enum e
JOIN   pg_type  t ON t.oid = e.enumtypid
WHERE  t.typname = 'sale_order_type';

-- E13: payment_flow_status 枚举应含 '待审批'（M1 新增）
SELECT
    'E13'                                                           AS check_id,
    'payment_flow_status 枚举含待审批（M1 新增）'                      AS description,
    COUNT(*)                                                        AS enum_value_count,
    array_agg(enumlabel ORDER BY enumsortorder)                     AS values,
    CASE WHEN COUNT(*) = 5 AND '待审批' = ANY(array_agg(enumlabel))
         THEN 'PASS' ELSE 'FAIL' END                                 AS verdict
FROM   pg_enum e
JOIN   pg_type  t ON t.oid = e.enumtypid
WHERE  t.typname = 'payment_flow_status';

-- E14: service_commissions 新增列存在性（voided_at / voided_reason）
SELECT
    'E14'                                                                                           AS check_id,
    'service_commissions 新增列存在性'                                                               AS description,
    COUNT(*) FILTER (WHERE column_name IN ('voided_at', 'voided_reason'))                            AS new_columns_present,
    CASE WHEN COUNT(*) FILTER (WHERE column_name IN ('voided_at', 'voided_reason')) = 2
         THEN 'PASS' ELSE 'FAIL — M4 未 apply 或列名不符' END                                      AS verdict
FROM   information_schema.columns
WHERE  table_schema = 'public'
  AND  table_name   = 'service_commissions';

-- E15: sale_orders 已删除旧列（paid_amount / wechat_transaction_id / alipay_transaction_id）
SELECT
    'E15'                                                                                           AS check_id,
    'sale_orders 旧列已删除'                                                                          AS description,
    COUNT(*) FILTER (WHERE column_name IN ('paid_amount', 'wechat_transaction_id', 'alipay_transaction_id')) AS legacy_cols_remaining,
    CASE WHEN COUNT(*) FILTER (WHERE column_name IN ('paid_amount', 'wechat_transaction_id', 'alipay_transaction_id')) = 0
         THEN 'PASS' ELSE 'FAIL — M5 未删除干净' END                                                AS verdict
FROM   information_schema.columns
WHERE  table_schema = 'public'
  AND  table_name   = 'sale_orders';

-- E16: sale_order_payment_details 表存在性
SELECT
    'E16'                                                   AS check_id,
    'sale_order_payment_details 表存在'                    AS description,
    COUNT(*)                                                AS table_exists,
    CASE WHEN COUNT(*) = 1 THEN 'PASS' ELSE 'FAIL' END     AS verdict
FROM   information_schema.tables
WHERE  table_schema = 'public'
  AND  table_name   = 'sale_order_payment_details';

RAISE NOTICE '';
RAISE NOTICE '============================================================';
RAISE NOTICE 'Migration Complete — Step E Validation Report';
RAISE NOTICE 'Any FAIL verdict requires human review before proceeding.';
RAISE NOTICE 'Enum reduction (M6) must be applied AFTER all PASS.';
RAISE NOTICE '============================================================';



-- ┌────────────────────────────────────────────────────────────────────────────
-- │ POST-MIGRATION CHECKLIST
-- └────────────────────────────────────────────────────────────────────────────
-- [ ] 备份已验证（pg_dump --restore 演练通过）
-- [ ] 所有 Step A/B/C/D/E 成功 COMMIT（无 ROLLBACK）
-- [ ] Step E 所有 verdict = PASS（或已人工处理 FAIL 项）
-- [ ] 业务方公告已发送（README §3 模板）
-- [ ] 员工业绩负数问题已审批
-- [ ] 执行 M6 enum 减值（sale_order_type 5→3）
-- [ ] 重新跑 Step E（E12 应变为 PASS）
-- [ ] 应用层解冻 + 部署新代码
-- [ ] 烟测 5 个核心路径（createOrder / approveRefund / refundHistory / dashboard / pickup）
-- [ ] 通知业务方迁移完成
