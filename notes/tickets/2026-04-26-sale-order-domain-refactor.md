# Ticket: sale_order_type 5→3 重构 + saleOrderPayments 子表化 + 退款历史全量回滚

> 生成日期：2026-04-26
> 实施状态：📝 待实施（设计已定，等本 ticket 评审通过）
> 严重级别：**P0**（资金链路重构 + 退款资损根治 + 5 通道历史回滚）
> 端：db / fengyu-admin / fengyu-staff / fengyu-client / cloudfunctions / cron-worker（**全栈**）
> 预估工期：**big bang 1.5 周**（用户决策 Q6.1=B）
> 来源：用户在 SUMMARY.md 决策回访（D-Q6/Q8 + Q6.1/Q6.2/Q6.3 三细节）
> 前置：[审计 SUMMARY](../../docs/audit/SUMMARY.md) §5.1 D-Q6/Q8 + §5.2 Q6.1/Q6.2/Q6.3
> 关联 audit：[audit-02](../../docs/audit/audit-02-order-creation.md) / [audit-03](../../docs/audit/audit-03-payment-flow.md) / [audit-04](../../docs/audit/audit-04-pay-notify.md) / [audit-07](../../docs/audit/audit-07-sales-allocation.md) / [audit-08](../../docs/audit/audit-08-service-commission.md) / [audit-11](../../docs/audit/audit-11-refunds.md) / [audit-13](../../docs/audit/audit-13-coupons.md) / [audit-14](../../docs/audit/audit-14-prepaid-card.md) / [audit-15](../../docs/audit/audit-15-points-member-level.md) / [audit-17](../../docs/audit/audit-17-dashboard.md) / [audit-18](../../docs/audit/audit-18-employee-performance.md) / [audit-20](../../docs/audit/audit-20-pickup.md) / [audit-23](../../docs/audit/audit-23-operation-logs.md) / [audit-CC2](../../docs/audit/audit-CC2-concurrency-idempotency.md)
> 一句话目标：**销售单**只承载销售/内部/转换 3 类业务行；**回款 / 退款**全部下沉为 `sale_order_payments` 流水；**付款详情**（审批/退款明细/备注）独立子表 `sale_order_payment_details`；历史"退款单 / 回款单"行迁移 + 退款关联 5 通道（sa/sc/coupons/points/pickup）全量回滚。

---

## 0 一句话背景

当前 `saleOrderTypeEnum` 5 值（`销售单 / 内部单 / 回款单 / 转换单 / 退款单`）把"实际销售业务"和"对销售业务的金额变动（回款 / 退款）"混在同一张 `sale_orders` 表，导致：

- **业绩 / 看板 / 报表口径系统性错乱**（[audit-17 P0-17-01/02/03](../../docs/audit/audit-17-dashboard.md)、[audit-18 P0-18-01](../../docs/audit/audit-18-employee-performance.md)）：管理层用 `total_amount` 还是 `paid_amount`、要不要过滤 `sale_order_type='退款单'`，三端口径分裂
- **退款不冲销 5 通道**（[audit-07 P0-07-02](../../docs/audit/audit-07-sales-allocation.md) + [audit-08 P0-08-04](../../docs/audit/audit-08-service-commission.md) + [audit-11 P0-11-01/04](../../docs/audit/audit-11-refunds.md) + [audit-15 P0-15-01](../../docs/audit/audit-15-points-member-level.md) + [audit-20 P0-20-01](../../docs/audit/audit-20-pickup.md)）：退款单审批通过后 sa/sc/coupons/points/pickup 全部不冲销，**这是当前最高资损面**
- **退款 in-flight 唯一性靠事务外读**（[audit-CC2 A3-TOCTOU](../../docs/audit/audit-CC2-concurrency-idempotency.md)）：缺 partial unique 兜底
- **回款 / 退款行不该有独立的 sale_order_id**：它们本质是依附在原销售单的金额变动，当前用独立行 + `ref_sale_order_id` 引用是反常态

---

## 1 设计决策（用户 2026-04-26）

### 1.1 saleOrderType 5 → 3 值（D-Q6）

```diff
- saleOrderTypeEnum: ['销售单', '内部单', '回款单', '转换单', '退款单']
+ saleOrderTypeEnum: ['销售单', '内部单', '转换单']
```

- `回款单` 行 → 全部迁到 `sale_order_payments(change_type='回款')`
- `退款单` 行 → 全部迁到 `sale_order_payments(change_type='退款', amount<0)`
- 退款审批流：从"退款单 status 待审批 → 已支付"迁到 `sale_order_payments.status 待审批 → 已支付`

### 1.2 saleOrders "瘦身"为汇总表（Q6.2 用户进一步澄清）

> "saleOrder 只记录汇总的结果和状态"

| 类别 | 字段 | 处理 |
|------|------|------|
| **保留**（订单级身份与汇总）| sale_order_id / sale_order_type / client_user_id / store_id / employee_id / total_amount / received / refunded_amount / status / sale_order_datetime / created_at / updated_at | 保留，且 received / refunded_amount / paid_at 由 trigger 或应用层从 sale_order_payments 聚合 |
| **删除**（冗余 / 已被 payments 表达）| wechat_transaction_id / alipay_transaction_id / paid_amount（与 received 重复）| 字段删除（已在 [audit-04 S04-1](../../docs/audit/audit-04-pay-notify.md) 标记冗余）|

> **不变量**（DB CHECK 或应用层 + cron 守护）：
> - `received = SUM(sop.amount WHERE status='已支付' AND change_type IN ('首次支付','回款','储值卡抵扣'))`
> - `refunded_amount = -SUM(sop.amount WHERE status='已支付' AND change_type='退款')`
> - `total_amount - prepaid_card_amount = payable_amount`（保持现有规则）

### 1.3 sale_order_payments 子表化（Q6.2=B）

#### 1.3.1 主表 `sale_order_payments` 保留（瘦身）

| 字段 | 状态 |
|------|------|
| id / saleOrderId / changeType / amount / paymentMethod / externalTxnId / status / sourceEnd / createdAt / paidAt | 保留 |
| operatorEmployeeId | **下沉到子表 `sale_order_payment_details`** |
| note | **下沉到子表 `sale_order_payment_details`** |

#### 1.3.2 新建子表 `sale_order_payment_details`

```sql
CREATE TABLE sale_order_payment_details (
    payment_id BIGINT PRIMARY KEY REFERENCES sale_order_payments(id) ON DELETE RESTRICT,

    -- 操作人 / 备注（从主表下沉）
    operator_employee_id VARCHAR(32) REFERENCES staff_wechat_users(employee_id),
    note TEXT,

    -- 退款专属
    refund_reason TEXT,                                                   -- 退款原因（发起人填）
    ref_sale_item_id VARCHAR(30) REFERENCES sale_items(sale_item_id),     -- 关联具体 sale_item（部分退款）
    session_count INTEGER,                                                -- 退疗程卡时的次数

    -- 审批专属
    audit_employee_id VARCHAR(32) REFERENCES staff_wechat_users(employee_id),  -- 审批人
    audit_at TIMESTAMP,                                                   -- 审批时间
    audit_remark TEXT,                                                    -- 审批备注 / 拒绝原因

    -- 第三方回调原始 payload（拉卡拉对接后用）
    raw_payload JSONB,

    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sopd_operator ON sale_order_payment_details(operator_employee_id);
CREATE INDEX idx_sopd_audit_employee ON sale_order_payment_details(audit_employee_id);
CREATE INDEX idx_sopd_ref_sale_item ON sale_order_payment_details(ref_sale_item_id);
```

> **设计原则**（用户原话）："saleOrder 只记录汇总的结果和状态"——所有付款细节下沉到 `sale_order_payment_details`，主表 `sale_order_payments` 仅留资金流水核心字段。
>
> 子表 1:1 关联（payment_id 既是 PK 也是 FK），仅当 payment 行需要详情时才有子表行（实际几乎所有 payment 行都需要 operator/note，所以**实质大多数 payment 行都有 details 行**）。

### 1.4 paymentFlowStatusEnum 4 → 5 值

```diff
- ['待支付', '已支付', '已作废', '已退款']
+ ['待支付', '待审批', '已支付', '已作废', '已退款']
```

新增 `'待审批'`：用于退款流水"已发起、待审批"状态。

| 状态 | 含义 | 触发场景 |
|------|------|---------|
| 待支付 | 线上支付已发起未到账 | client.pay |
| **待审批**（新）| 退款已发起、待店长 / 财务审批 | staff.createRefund / admin.createRefund |
| 已支付 | 到账（线下/储值卡直接落此） | payNotify、staff.confirmOffline、approveRefund |
| 已作废 | 创建后被取消 | 超时关闭 / 手动撤销 |
| 已退款 | 首次支付/回款行整笔退款时置此（仅原行）| approveRefund 反向冲销原行 |

### 1.5 退款 5 通道全量回滚（Q6.3=A）

历史已退款单关联的衍生数据**一并冲销**：

| 通道 | 回滚动作 | 影响 |
|------|---------|------|
| sale_allocations | 已退款单关联的 sa 行 → `is_void=true, voided_at=NOW(), voided_reason='2026-04-26 历史退款回滚'` | 员工历史业绩重算（可能负数）|
| service_commissions | 同上（先 ALTER 加 voided_at 列）| 员工提成重算（可能负数）|
| user_coupons | 已用券若未过期 → `status='未使用', used_at=NULL` | 顾客权益恢复 |
| point_transactions | 写反向流水 `change_type='消费冲销'`，amount 取负值 | customer_points.balance 重算 |
| pickup_records | 已退商品的 picked_up_quantity 反向恢复 | 提货上限恢复 |

> **公告策略**：员工业绩可能负数 → 需事前公告 + 审批流程（"我们正在修复历史退款资损"）。资金面无变化（已退款资金已退给顾客）。

### 1.6 实施模式：big bang（Q6.1=B）

> 用户选 B（一次切，1.5 周）；放弃了我推荐的双轨过渡 A。

理由（用户未明说，推测）：
- 当前线上数据量小（baseline reset 2026-04-10 后），迁移 SQL 几秒搞定
- 双轨期代码复杂度（新旧并存）反而引入新 bug
- 业务方时间窗口紧（推广员业绩归属、退款资损每日累积）

**风险接受**：迁移 SQL 出错难回滚 → **强制冷备份 + 预演 + 灰度窗口选择**（详见 §5）。

---

## 2 Schema 变更（migration 一次性）

### 2.1 改动清单

```sql
-- M1: 加 paymentFlowStatusEnum '待审批' 值
ALTER TYPE payment_flow_status ADD VALUE IF NOT EXISTS '待审批' BEFORE '已支付';

-- M2: 建子表 sale_order_payment_details
CREATE TABLE sale_order_payment_details (
    -- 见 §1.3.2 完整 DDL
);

-- M3: sale_order_payments 主表瘦身（在 details 表数据迁移完成后）
ALTER TABLE sale_order_payments DROP COLUMN operator_employee_id;
ALTER TABLE sale_order_payments DROP COLUMN note;

-- M4: service_commissions 加 voided_at（与 sale_allocations 对齐）
ALTER TABLE service_commissions ADD COLUMN voided_at TIMESTAMP;
ALTER TABLE service_commissions ADD COLUMN voided_reason TEXT;
CREATE INDEX idx_sc_voided_at ON service_commissions(voided_at) WHERE voided_at IS NOT NULL;

-- M5: 删除 saleOrders 冗余列
ALTER TABLE sale_orders DROP COLUMN wechat_transaction_id;
ALTER TABLE sale_orders DROP COLUMN alipay_transaction_id;
-- paid_amount 是否删除待 §3.6 评估（与 received 冗余 vs 需保留作快照？）

-- M6: saleOrderTypeEnum 5→3（最后一步，等历史 saleOrders[type='回款单'/'退款单'] 全部迁出后）
-- PG enum 不能直接 DROP VALUE，需重建：
CREATE TYPE sale_order_type_new AS ENUM ('销售单', '内部单', '转换单');
ALTER TABLE sale_orders ALTER COLUMN sale_order_type TYPE sale_order_type_new USING sale_order_type::text::sale_order_type_new;
DROP TYPE sale_order_type;
ALTER TYPE sale_order_type_new RENAME TO sale_order_type;

-- M7: 5 项 partial unique（与 epic E5 合并落地）
CREATE UNIQUE INDEX uq_sop_status_audit ON sale_order_payments(sale_order_id, change_type) WHERE change_type='退款' AND status='待审批';
-- 防同一原单出现多笔 in-flight 退款审批
-- ... 其他 4 项见 [SCHEMA-CHANGES.md](../../docs/audit/SCHEMA-CHANGES.md)
```

### 2.2 Drizzle schema 改动

需改文件：
- `db/schema/order.ts`：saleOrders 列删除 / saleOrderTypeEnum 减值 / saleOrderPayments 列下沉
- `db/schema/order.ts`（同文件新增）：salePaymentDetails table 定义
- `db/schema/enums.ts`：paymentFlowStatusEnum 加 '待审批'
- `db/schema/service-commission.ts`：增 voided_at / voided_reason
- `db/schema/index.ts`：导出新 table

---

## 3 数据迁移（一次性 SQL）

### 3.1 预备：冷备份

```bash
# 全库备份（custom format）
pg_dump -h 47.113.202.7 -p 5434 -U fengyu -Fc -f ~/backups/fengyu-$(date +%Y%m%d-%H%M%S)-pre-domain-refactor.dump fengyu

# 关键表只读快照（额外保险）
pg_dump -h 47.113.202.7 -p 5434 -U fengyu -t sale_orders -t sale_order_payments -t sale_allocations -t service_commissions -t user_coupons -t point_transactions -t pickup_records -Fc -f ~/backups/fengyu-tables-$(date +%Y%m%d-%H%M%S).dump fengyu
```

### 3.2 Step A — 回款单迁移（saleOrders[type='回款单'] → sale_order_payments[change_type='回款']）

```sql
BEGIN;

-- A1: 把每条回款单建一条 sop[首次支付/回款] 行
INSERT INTO sale_order_payments (
    sale_order_id,        -- 注意：用 ref_sale_order_id（指向原销售单）
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
    so.received,                                    -- 回款金额
    so.payment_method,
    NULL,                                           -- 历史回款单无三方流水号
    '已支付',                                        -- 状态
    'admin',                                        -- 来源端（历史回款由 admin 录入）
    so.paid_at,
    so.created_at
FROM sale_orders so
WHERE so.sale_order_type = '回款单';

-- A2: 把每条回款单的 operator / note 写入 sale_order_payment_details
-- (插入对应 payments 行后取得 id 再回填，需要 RETURNING 或 CTE)
WITH inserted AS (
    -- 同 A1 RETURNING 拿到 (sale_order_id, id) 映射
    SELECT id, sale_order_id FROM sale_order_payments
    WHERE source_end = 'admin' AND change_type = '回款'
)
INSERT INTO sale_order_payment_details (payment_id, operator_employee_id, note)
SELECT inserted.id, so.employee_id, so.note
FROM sale_orders so
JOIN inserted ON inserted.sale_order_id = so.ref_sale_order_id
WHERE so.sale_order_type = '回款单';

-- A3: 删除原回款单行（在原 saleOrders 表里）
DELETE FROM sale_orders WHERE sale_order_type = '回款单';

COMMIT;
```

### 3.3 Step B — 退款单迁移（saleOrders[type='退款单'] → sale_order_payments[change_type='退款']）

```sql
BEGIN;

-- B1: 已审批通过的退款单 → status='已支付', amount<0
INSERT INTO sale_order_payments (sale_order_id, change_type, amount, payment_method, status, source_end, paid_at, created_at)
SELECT
    so.ref_sale_order_id,
    '退款',
    -ABS(so.received),                              -- 强制负数
    so.payment_method,
    '已支付',
    'admin',
    so.paid_at,
    so.created_at
FROM sale_orders so
WHERE so.sale_order_type = '退款单' AND so.status IN ('已支付', '已完成');

-- B2: 待审批的退款单 → status='待审批', amount<0
INSERT INTO sale_order_payments (sale_order_id, change_type, amount, payment_method, status, source_end, created_at)
SELECT so.ref_sale_order_id, '退款', -ABS(so.total_amount), so.payment_method, '待审批', 'admin', so.created_at
FROM sale_orders so
WHERE so.sale_order_type = '退款单' AND so.status = '待审批';

-- B3: 已驳回 / 已关闭的退款单 → status='已作废'
INSERT INTO sale_order_payments (sale_order_id, change_type, amount, payment_method, status, source_end, created_at)
SELECT so.ref_sale_order_id, '退款', -ABS(so.total_amount), so.payment_method, '已作废', 'admin', so.created_at
FROM sale_orders so
WHERE so.sale_order_type = '退款单' AND so.status IN ('已关闭', '支付失败');

-- B4: details 表写入 refund_reason / ref_sale_item_id / session_count / audit_*
-- (类似 A2 的 CTE 模式)
INSERT INTO sale_order_payment_details (
    payment_id, operator_employee_id, refund_reason, ref_sale_item_id, session_count,
    audit_employee_id, audit_at, audit_remark, note
)
SELECT
    sop.id,
    so.employee_id,                                  -- 发起人
    so.refund_reason,
    so.ref_sale_item_id,
    so.session_count,
    so.audit_employee_id,                            -- 审批人（如有）
    so.audit_at,
    so.audit_remark,
    so.note
FROM sale_orders so
JOIN sale_order_payments sop
  ON sop.sale_order_id = so.ref_sale_order_id
  AND sop.change_type = '退款'
  AND sop.created_at = so.created_at                 -- 用 created_at 配对（建议加临时 mapping 列更稳）
WHERE so.sale_order_type = '退款单';

-- B5: 删除原退款单行
DELETE FROM sale_orders WHERE sale_order_type = '退款单';

COMMIT;
```

### 3.4 Step C — 重算 saleOrders 汇总字段

```sql
BEGIN;

-- C1: received 重算
UPDATE sale_orders so SET received = COALESCE((
    SELECT SUM(sop.amount) FROM sale_order_payments sop
    WHERE sop.sale_order_id = so.sale_order_id
      AND sop.status = '已支付'
      AND sop.change_type IN ('首次支付', '回款', '储值卡抵扣')
), 0);

-- C2: refunded_amount 重算（取正值，与历史口径一致）
UPDATE sale_orders so SET refunded_amount = COALESCE((
    SELECT -SUM(sop.amount) FROM sale_order_payments sop
    WHERE sop.sale_order_id = so.sale_order_id
      AND sop.status = '已支付'
      AND sop.change_type = '退款'
), 0);

-- C3: status 重算（如需，按 received vs total_amount + refunded_amount 推导）
-- 通常迁移后 status 不变，但需要校验一遍
COMMIT;
```

### 3.5 Step D — 5 通道历史回滚（Q6.3=A 全量）

```sql
BEGIN;

-- D1: sale_allocations 软删（已退款单关联的）
UPDATE sale_allocations sa SET is_void = true, voided_at = NOW(),
    voided_reason = '2026-04-26 历史退款回滚（D-Q6.3=A 全量）'
WHERE sa.sale_order_id IN (
    SELECT DISTINCT so.sale_order_id FROM sale_orders so
    JOIN sale_order_payments sop ON sop.sale_order_id = so.sale_order_id
    WHERE sop.change_type = '退款' AND sop.status = '已支付'
);

-- D2: service_commissions 软删（先 ALTER 加 voided_at + voided_reason 列）
UPDATE service_commissions sc SET voided_at = NOW(),
    voided_reason = '2026-04-26 历史退款回滚（D-Q6.3=A 全量）'
WHERE sc.service_order_id IN (
    SELECT DISTINCT so2.service_order_id FROM service_orders so2
    JOIN sale_items si ON si.sale_item_id = so2.sale_item_id
    JOIN sale_order_payments sop ON sop.sale_order_id = si.sale_order_id
    WHERE sop.change_type = '退款' AND sop.status = '已支付'
);

-- D3: user_coupons 回滚（仅未过期的）
UPDATE user_coupons uc SET status = '未使用', used_at = NULL, used_sale_order_id = NULL
WHERE uc.used_sale_order_id IN (
    SELECT DISTINCT sop.sale_order_id FROM sale_order_payments sop
    WHERE sop.change_type = '退款' AND sop.status = '已支付'
)
AND uc.expires_at > NOW();

-- D4: point_transactions 反向流水（amount 取负）
INSERT INTO point_transactions (
    user_id, ref_sale_order_id, change_type, amount, created_at, note
)
SELECT
    pt.user_id,
    pt.ref_sale_order_id,
    '消费冲销',
    -pt.amount,                                       -- 反向
    NOW(),
    '2026-04-26 历史退款回滚'
FROM point_transactions pt
WHERE pt.ref_sale_order_id IN (
    SELECT DISTINCT sop.sale_order_id FROM sale_order_payments sop
    WHERE sop.change_type = '退款' AND sop.status = '已支付'
)
AND pt.change_type IN ('消费赠送', '回款赠送');

-- D5: customer_points.balance 重算
UPDATE customer_points cp SET balance = COALESCE((
    SELECT SUM(pt.amount) FROM point_transactions pt WHERE pt.user_id = cp.user_id
), 0);

-- D6: pickup_records 回滚（picked_up_quantity 反向恢复）
-- 涉及单品 / 家居产品 SKU 退出的 pickup
UPDATE pickup_records pr SET picked_up_quantity = GREATEST(0, picked_up_quantity - retract.qty)
FROM (
    SELECT pr2.id, COALESCE(SUM(spd.session_count), 1) AS qty
    FROM pickup_records pr2
    JOIN sale_order_payments sop ON sop.sale_order_id = pr2.sale_order_id
    JOIN sale_order_payment_details spd ON spd.payment_id = sop.id
    WHERE sop.change_type = '退款' AND sop.status = '已支付'
    GROUP BY pr2.id
) retract
WHERE retract.id = pr.id;

COMMIT;
```

> **注意**：D 步骤的 SQL 是示意，实际执行需 DBA 配合 + dry-run + 逐表抽样比对。

### 3.6 Step E — 校验 SQL（迁移后 + 上线前）

```sql
-- E1: saleOrders 不应再有 '回款单' / '退款单'
SELECT count(*) FROM sale_orders WHERE sale_order_type IN ('回款单', '退款单');
-- 预期：0

-- E2: sale_order_payments[change_type='退款', status='已支付'] 总笔数应等于原退款单总数
SELECT count(*) FROM sale_order_payments WHERE change_type = '退款' AND status = '已支付';
-- 预期：等于迁移前的 SELECT count(*) FROM sale_orders WHERE sale_order_type = '退款单' AND status IN ('已支付','已完成')

-- E3: 不变量 received = SUM(payments)
SELECT count(*) FROM sale_orders so
WHERE ABS(so.received - COALESCE((
    SELECT SUM(sop.amount) FROM sale_order_payments sop
    WHERE sop.sale_order_id = so.sale_order_id
      AND sop.status = '已支付'
      AND sop.change_type IN ('首次支付', '回款', '储值卡抵扣')
), 0)) > 0.01;
-- 预期：0

-- E4: 不变量 refunded_amount = -SUM(payments[退款])
-- 类似 E3

-- E5: 5 通道回滚后续审计（详细参见 audit-CC1 §7）
-- ...
```

---

## 4 代码改动清单（按域）

### 4.1 db/

- [ ] `db/schema/order.ts` — saleOrders 列删除 / saleOrderTypeEnum 减值 / saleOrderPayments 列下沉 / 加 salePaymentDetails table
- [ ] `db/schema/service-commission.ts` — 增 voided_at / voided_reason
- [ ] `db/schema/enums.ts` — paymentFlowStatusEnum 加 '待审批'
- [ ] `db/migrations/00NN_sale_order_domain_refactor.sql` — 一次性 migration（按 §2 §3 顺序）

### 4.2 fengyu-admin

| 文件 | 改动 |
|------|------|
| `src/app/(main)/refunds/*` | 整页改为退款流水管理（按 sale_order 维度展示退款历史，源 sale_order_payments 而非 sale_orders）|
| `src/actions/refunds.ts` | createRefund / approveRefund / rejectRefund 重写：写 sale_order_payments + sale_order_payment_details，5 通道 cascade |
| `src/actions/orders.ts` | 删除"创建回款单 / 创建退款单"路径；createConversionOrder 保留；createSalesOrder 不变 |
| `src/app/(main)/orders/*` | 列表过滤 sale_order_type 选项 5→3；详情页"已退款"展示由 saleOrders[type='退款单'] 改为聚合 sale_order_payments[退款] |
| `src/lib/recharge.ts` | 充值入账逻辑（applyRechargeOnOrderPaid）梳理：原本可能依附"回款单"，改为依附 saleOrderPayments[首次支付/回款] |
| `src/app/(main)/dashboard/*` | 业绩 SQL 重写：从"过滤 sale_order_type='退款单'"改为"received - refunded_amount"或直接 received（已含冲销）|

### 4.3 fengyu-staff

| 文件 | 改动 |
|------|------|
| `cloudfunctions/staffApi/routes/order.js` | 删除 createRefund / approveRefund / rejectRefund / refundList "依附退款单"路径，改为操作 sale_order_payments + 5 通道 cascade |
| `cloudfunctions/staffApi/routes/order.js` | createSalesOrder 保留；不再支持 `sale_order_type='回款单'/'退款单'` 入参 |
| `cloudfunctions/staffApi/routes/customer.js` | refundHistory 数据源从 sale_orders[type='退款单'] 改为聚合 sale_order_payments[退款] |
| `cloudfunctions/staffApi/routes/staff.js` | performanceDetail / dashboard / monthlyCalendar 重写：sa 已带 voided 字段，agg 时 `WHERE is_void=false` |
| `cloudfunctions/staffApi/routes/mgmt-dashboard.js` | 业绩 SQL 重写（同 admin 的 dashboard）|

### 4.4 fengyu-client

> client 不直接操作退款，但有间接 UI（已支付订单展示退款状态）

| 文件 | 改动 |
|------|------|
| `cloudfunctions/clientApi/routes/order.js` | detail 接口返回的退款状态由聚合 sale_order_payments[退款] 计算 |
| `miniprogram/pages/order/*` | "已退款"标签 / 退款流水时间线展示数据源更换 |

### 4.5 fengyu-staff/cloudfunctions/payNotify

> 待拉卡拉对接（D-Q11-2026-04-26 范围）；当前先确保 stub disable，重构期间 payNotify 不写"回款单"

### 4.6 fengyu-staff/cloudfunctions/cron-worker

| STEP | 改动 |
|------|------|
| 业绩 / 提成相关 | 加 `WHERE is_void=false`（sa）+ `WHERE voided_at IS NULL`（sc）|
| 新增 STEP `audit-payment-invariants.ts` | 5 项不变量 cron 守护（received / refunded_amount / sa 总和等）|

---

## 5 实施 Phase（big bang，1.5 周）

### Phase 0 — 预检（D-1 day）

- [ ] 跑 §3.1 冷备份 → 确认备份可恢复（dry-run restore 到测试库）
- [ ] 跑 §3 SQL dry-run 在测试库验证（用生产数据脱敏副本）
- [ ] 业务方公告：业绩 / 提成历史可能负数（5 通道回滚的副作用）
- [ ] admin / staff 端冻结新业务（拒绝新建回款单 / 退款单），仅允许销售单
- [ ] **灰度窗口选择**：周末凌晨 2-6 点（业务最低谷）

### Phase 1 — schema 迁移 + 数据迁移（Day 1，预计 1 小时）

执行顺序（事务边界）：
1. M1 加 paymentFlowStatusEnum '待审批'
2. M2 建 sale_order_payment_details
3. M4 service_commissions 加 voided_at
4. **冻结写入 30 分钟**（应用层切只读，等 PG 备份点稳定）
5. Step A：迁移回款单
6. Step B：迁移退款单
7. Step C：重算 saleOrders 汇总
8. Step D：5 通道全量回滚
9. Step E：校验 SQL 全部通过
10. M3：sale_order_payments 主表瘦身（删 operator / note 列）
11. M5：删 saleOrders 冗余列
12. M6：saleOrderTypeEnum 5→3 重建
13. M7：partial unique 索引
14. **解冻写入**

### Phase 2 — 代码部署（Day 1-3）

- [ ] db/schema 改动 merge + drizzle-kit generate（仅校验，不再迁移）
- [ ] admin Next.js 部署
- [ ] staff cloudfunctions 部署（`tcb fn code update`，**禁用 --force**）
- [ ] client cloudfunctions 部署
- [ ] cron-worker 部署

### Phase 3 — 验证 + 业务方回归（Day 4-7）

- [ ] 业务方逐项验证（参见 §6 验证 checklist）
- [ ] cron 不变量审计 STEP 跑 1 周观察偏差告警
- [ ] DBA 双周对账（received / refunded_amount / sa 总和 vs 历史快照）

### Phase 4 — 收尾（Day 8-10）

- [ ] 删除归档代码（旧的 createRefund / createRecharge 实现）
- [ ] spec 校对（backend.pr.spec.md / admin.pr.spec.md 删除 5 值描述）
- [ ] 关闭本 ticket，归档到 `notes/tickets/archives/`

---

## 6 验证 Checklist

### 6.1 数据迁移正确性

- [ ] §3.6 校验 SQL E1-E5 全部通过
- [ ] sale_orders 总行数 = 迁移前 - (回款单数 + 退款单数)
- [ ] sale_order_payments[退款,已支付] 总笔数 = 迁移前 saleOrders[退款单,已支付/已完成] 总数
- [ ] sale_order_payments[回款] 总笔数 = 迁移前 saleOrders[回款单] 总数
- [ ] saleOrders.received SUM = sale_order_payments[已支付,首次支付/回款/储值卡抵扣].amount SUM
- [ ] saleOrders.refunded_amount SUM = -sale_order_payments[已支付,退款].amount SUM

### 6.2 5 通道回滚正确性

- [ ] sale_allocations.is_void=true 行数 = 历史已退款单关联 sa 行数（按 sale_order_id 关联校验）
- [ ] service_commissions.voided_at 非空行数 = 历史已退款单关联 sc 行数
- [ ] user_coupons '未使用' 行数 = 历史已退款单关联 user_coupons 行数 - 已过期
- [ ] customer_points.balance SUM 全库 = SUM(point_transactions.amount)
- [ ] pickup_records.picked_up_quantity SUM 全库 = SUM(已退款外的合法提货)

### 6.3 业务回归（业务方主导）

- [ ] admin 创建退款 / 审批 / 驳回 / 拒绝（4 状态全路径）
- [ ] staff 店长创建退款 / 审批
- [ ] client 顾客查看订单"已退款"状态展示正确
- [ ] payNotify 对接前确保 stub disable 不写"回款单"
- [ ] 看板 / 绩效 / 员工提成数字与历史对账一致（去除已退款部分后）
- [ ] 操作日志（operation_logs）覆盖完整：createRefund / approveRefund / rejectRefund 全部写入

### 6.4 横切验证

- [ ] CC1 数值精度：`chk_sop_amount_sign` 仍生效；金额计算无 toFixed/Math.round 跨端漂移
- [ ] CC2 并发：partial unique uq_sop_status_audit 生效，并发审批不重复
- [ ] CC3 scope：staff customer.refundHistory 加 store_id 过滤
- [ ] CC4 鉴权：admin refunds 全部 action 加 requirePermission；staff routes 加 requireManager
- [ ] CC6 PII：sale_order_payment_details.note / refund_reason 不含完整 phone/openid

---

## 7 风险与回滚预案

### 7.1 主要风险

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 迁移 SQL 出错 | 中 | 数据损坏 | 冷备份 + dry-run + 灰度窗口 + 应用层冻结 |
| 5 通道回滚 SQL 锁表过久 | 中 | 业务中断 | 分批 SELECT + LIMIT + 业务低谷执行 |
| 员工业绩负数引发争议 | 高 | 内部矛盾 | 公告 + 审批 + 必要时 admin 增"业绩调整说明"页 |
| 迁移后业务方发现"消失"的退款单 | 高 | 投诉 | 提前做"迁移前/后对照表"，保留 saleOrders 备份 90 天 |
| pickup 5 通道 D6 SQL session_count 反推不准 | 中 | 提货数据错乱 | 抽样人工核对 + 容忍 ±1 误差 |

### 7.2 回滚预案

```bash
# Phase 1 出错（冻结写入未解冻前）：
psql -h ... -U fengyu -d fengyu -c "BEGIN; ROLLBACK;"
# 或恢复冷备份：
pg_restore -h ... -U fengyu -d fengyu_restore --clean --create ~/backups/fengyu-XXX.dump

# Phase 2-3 出错（已解冻写入）：
# 不可逆，必须 fix-forward；准备 hotfix 修复程序 + 数据补偿 SQL
```

> **关键判断**：Phase 1 完成 + 冻结解除后即不可回滚（因新写入已基于新 schema），所以 Phase 1 的 dry-run + 校验必须 100% 通过。

---

## 8 关联与依赖

### 8.1 前置依赖

- [ ] [2026-04-26-experience-card-as-sku-flag.md](./2026-04-26-experience-card-as-sku-flag.md) — 体验卡 capability 列（Q5.1/Q5.2 落地，跃迁逻辑前置）
- [ ] D-Q1-2026-04-26：payNotify 立即停用 → 确保重构期间不会有微信/线上回款写入
- [ ] D-Q11-2026-04-26：拉卡拉对接前置 → 重构期间确认线上支付走"线下/储值卡"通道

### 8.2 后续 Epic（解锁）

- [ ] **E2 退款级联 cascade**：本 ticket 已包含
- [ ] **E5 schema 不变量 CHECK 一次性 migration**：与本 ticket 的 partial unique（M7）合并落地
- [ ] **E6 时区统一 + 跨端口径收敛**：dashboard 业绩重算后口径已对齐，时区单独 ticket
- [ ] **E7 跨端副本 helper 抽取**：本 ticket 已抽出 db/helpers/refund-cascade.ts

### 8.3 子任务拆分（可选）

如果 1.5 周 big bang 风险评估太高，可拆为 3 个独立 ticket：
- T1：schema 迁移 + 数据迁移（Phase 0-1）
- T2：5 通道回滚（Step D 单独执行）
- T3：代码切换 + 验证（Phase 2-4）

---

## 9 待最终确认（执行前）

- [ ] 业务方对"员工历史业绩可能负数"接受度（如不接受，需 §1.5 改为方案 B"仅 cutoff 后回滚"）
- [ ] DBA 评估 §3 数据迁移 SQL 的锁影响 + 业务低谷窗口
- [ ] §4.2 admin /refunds 页 UI 重新设计（产品 PRD 评审）
- [ ] §1.4 paymentFlowStatusEnum 加 '待审批' 是否影响 client 现有 UI 文案（CC8 命中）
- [ ] §3.1 冷备份恢复演练（dry-run restore）

---

## 10 后续：sale_order_payment_details 子表回收（2026-05-03）

原拆分动机是"主表保持窄、热路径不拖 nullable 列与 jsonb"。线上验证后发现：

- 8 处 INSERT 全部双写主表+子表，**没有任何代码路径只插主表不插子表**
- 6 处 SELECT 全部 LEFT JOIN，**没有任何业务依赖 detail IS NULL 的语义**
- 子表 3 个索引（idx_sopd_operator / audit_employee / ref_sale_item）从未被 WHERE 过滤走过
- `raw_payload` jsonb 字段零使用（注释里"拉卡拉对接后用"）

→ 决定回收子表，将必要字段并回 `sale_order_payments` 主表：

- 新增 8 列：`operator_employee_id` / `note` / `refund_reason` / `ref_sale_item_id` / `session_count` / `audit_employee_id` / `audit_at` / `audit_remark`
- 不引入 `raw_payload`、不引入 3 个索引
- 数据回填 + DROP TABLE：`db/migrations/0022_keen_freak.sql`（手工调整 ADD COLUMN → UPDATE 回填 → DROP TABLE 顺序避免丢数据）
- 顺带：`approveRefund` / `rejectRefund` 的 "状态翻转 UPDATE + 子表写审批 INSERT/UPSERT" 合并为一条 UPDATE，云函数原本两个隐式自动提交变为单语句，**原子性反而更强**
- 涉及代码：admin orders.ts / refunds.ts / refund-cascade.ts / types.ts；staffApi order.js / customer.js / mgmt-customer.js；clientApi order.js；以及对应测试
