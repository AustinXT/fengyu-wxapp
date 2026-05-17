# cron STEP — audit-refund-cascade-coverage（退款 5 通道级联巡检）

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-18 |
| 实施状态 | 待实施 |
| 优先级 | **P0**（SUMMARY §4 L11 列名） |
| 端 | fengyu-admin（cron-worker 子模块） |
| 修复成本 | **S-M**（半天到 1 天，主要在 5 通道 SQL 拼装与基线核对） |
| 来源 | SUMMARY §6.4 L11 长期 — `audit-refund-cascade-coverage.ts` |
| 关联 helper | `fengyu-admin/src/lib/refund-cascade.ts` + `fengyu-staff/cloudfunctions/staffApi/helpers/refund-cascade.js`（双副本，cross-end-sql-snapshot 守护） |
| 关联 cron | `fengyu-admin/src/cron/steps/audit-payment-invariants.ts`（STEP 7，结构最相近） |

---

## 0 一句话背景

退款审批通过时，`cascadeRefund` 同事务级联 5 通道：sale_allocations 软删 / service_commissions 软删 / user_coupons 恢复 / point_transactions 反向流水 / sale_items.picked_up_quantity 回滚（详见 `fengyu-admin/src/lib/refund-cascade.ts:56-212`）。STEP 8 `auditPaymentInvariants` 只检"received / refunded_amount / points_balance / prepaid balance / payable_amount"这 5 项**资金**不变量，**不检 5 通道是否真的全部触发**。如果哪天某个 cascade 通道被注释掉、或某个新加的退款入口忘了调 cascadeRefund，资金侧仍对得上但提成/积分/券/提货已经漂移。

本 ticket 新增 `audit-refund-cascade-coverage.ts`：对所有"已支付的退款行（`sale_order_payments WHERE change_type='退款' AND status='已支付'`）"反向检查 5 通道是否产生了对应记录，发现 mismatch 仅 `INSERT operation_logs` + `notifyOps` 告警，**永不自动修补**（与 STEP 5/7/8 一致）。

## 1 现状（grep 实证）

### 1.1 cascadeRefund 5 通道逐项

`fengyu-admin/src/lib/refund-cascade.ts:56-212` 五段（注释删减保留 SQL）：

```ts
// ── 1) sale_allocations 软删 ──
UPDATE sale_allocations SET is_void=true, voided_at=NOW() WHERE sale_item_id=$1 AND is_void=false
//    或 saleItemId IS NULL 时按 sale_order_id 整单 IN (SELECT sale_item_id FROM sale_items WHERE sale_order_id=$1)

// ── 2) service_commissions 软删 ──
UPDATE service_commissions SET voided_at=NOW(), is_void=true ... WHERE service_item_id IN (SELECT si.service_item_id FROM service_items si WHERE si.sale_item_id=$1)

// ── 3) user_coupons 恢复 ──
UPDATE user_coupons SET status='未使用', used_at=NULL, used_sale_order_id=NULL
  WHERE used_sale_order_id=$1 AND status='已使用' AND expire_at > NOW()

// ── 4) point_transactions 反向流水 ──
INSERT INTO point_transactions (user_id, ref_order_id, type, amount, created_at)
SELECT user_id, ref_order_id, '消费冲销', -amount, NOW()
FROM point_transactions
WHERE ref_order_id=$1 AND type IN ('消费赠送','回款赠送','获取') AND amount>0
  AND NOT EXISTS (SELECT 1 ... type='消费冲销' AND amount=-pt.amount)

// ── 5) sale_items.picked_up_quantity 回滚 ──
UPDATE sale_items SET picked_up_quantity = GREATEST(0, COALESCE(picked_up_quantity,0) - $qty)
  WHERE sale_item_id=$1 AND COALESCE(picked_up_quantity,0) >= $qty
```

**注意**：`pickup_records` 历史行**不删**（审计保留），仅累计列回滚；所以"通道 5 触发"的检测口径是 `sale_items.picked_up_quantity` 的变化量，**不是**数 pickup_records 行。但若原单从未提货过（`picked_up_quantity=0`），通道 5 无需触发也算"已覆盖"（vacuously true）。

### 1.2 sale_order_payments 退款行的口径

`db/schema/order.ts:251-310` `saleOrderPayments`：
- `changeType` 取值 enum `paymentChangeTypeEnum`，退款唯一值是 `'退款'`（已支付正向流水才有 `'首次支付'/'回款'/'储值卡抵扣'`）
- `status='已支付'` 表示 cascade 已经在事务内执行完成；`status='待审批'` / `'已关闭'` 不在审计范围
- `refSaleItemId`（nullable）：部分退款时 = 关联 sale_item，整单退款时 = NULL
- `sessionCount`（nullable）：退疗程卡的次数（影响通道 5 的 GREATEST 量）
- `saleOrderId`：定位原销售单

### 1.3 STEP 7 既有结构对照

`fengyu-admin/src/cron/steps/audit-payment-invariants.ts:51-176` 提供模板：每项不变量一段 SELECT + HAVING / WHERE 过滤偏差 → 命中则 push 到 `details` 数组 → 末尾 1 条 `INSERT operation_logs` + `notifyOps`。本 STEP 完全照搬，**5 通道 = 5 条独立查询**。

### 1.4 现有 5 通道一致性守护

`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-sql-snapshot.test.js:336-446` 已有 describe 块守护"两端 cascadeRefund 字面量同步"（v4 #14 ticket）。**但 snapshot 守的是"代码漂移"，不是"运行时数据落库"**——本 STEP 与 snapshot 互补，分别守静态实现与动态执行。

## 2 修复方案

### 2.1 新建 cron step 文件

新建 `fengyu-admin/src/cron/steps/audit-refund-cascade-coverage.ts`，5 通道各一条 SQL，缺一个就写一条 violation：

```ts
/**
 * STEP 10 — 退款 5 通道级联巡检（audit-11 P0-11 cascade coverage）
 *
 * 决议：与 STEP 6/7/8 一致，**只告警不修复**。
 *   - 自动 cascade 修复会掩盖上游退款逻辑 bug
 *   - 仅写 operation_logs + notifyOps，由 PM 跟 commit 排查
 *
 * 5 通道（与 lib/refund-cascade.ts 1:1 对齐）：
 *   C1: sale_allocations.is_void=true  exists for ref_sale_item_id（或整单）
 *   C2: service_commissions.voided_at IS NOT NULL where service_item_id linked
 *   C3: user_coupons returned-to-stock（status='未使用'，used_sale_order_id 当时已清）
 *       检测口径：if 当时有 ≥1 张 coupon 命中 used_sale_order_id=this AND used_at < refund.updated_at → 现在应该 status='未使用'
 *   C4: point_transactions '消费冲销' row exists for (user_id, ref_order_id)
 *       检测口径：if exists 正向 type IN ('消费赠送','回款赠送','获取') AND amount>0 → 必须 exists 对应负值 '消费冲销'
 *   C5: sale_items.picked_up_quantity 回滚已发生
 *       检测口径：仅在 pickup_records 中存在该 sale_item 的提货记录 AND 退款时间 < pickup max → 该单
 *               picked_up_quantity 必须 < SUM(pickup_records.quantity)（说明已经 GREATEST 减过）
 *               若原本 picked_up_quantity = 0 → 退款也无须回滚，跳过该单
 *
 * 告警机制：
 *   - operation_logs(action='cron.audit_refund_cascade', target_type='cascade_violation', target_id=date)
 *   - notifyOps 单条 markdown：每通道 mismatch 计数 + 前 10 条 sop_payment_id 样例
 *
 * 当前数据零 mismatch 是 DoD 之一（STEP 7 同模式：当前 PG 5434 任何 STEP 8 跑出来 violation=0）。
 */

import { sql } from 'drizzle-orm'
import type { Db } from '../run'
import { notifyOps } from '../lib/notify'

const SAMPLE_LIMIT = 10

interface CascadeViolation {
  channel: 'sa_not_voided' | 'sc_not_voided' | 'coupon_not_returned' | 'point_not_reversed' | 'pickup_not_rolled_back'
  count: number
  samples: Array<Record<string, unknown>>
}

export interface RefundCascadeCoverageResult {
  violations: number
  details: CascadeViolation[]
}

export async function auditRefundCascadeCoverage(db: Db): Promise<RefundCascadeCoverageResult> {
  const details: CascadeViolation[] = []

  // ── C1: sale_allocations 应已软删 ──
  // 对每条已支付的退款 sop_payment：找该单的 sale_item → 期望存在 is_void=true 的 sa 行；
  // 若 sa 全部 is_void=false → mismatch
  const c1 = (await db.execute(sql`
    WITH refunds AS (
      SELECT sop.sop_payment_id, sop.sale_order_id, sop.ref_sale_item_id
      FROM sale_order_payments sop
      WHERE sop.change_type = '退款'
        AND sop.status = '已支付'
    ),
    sa_status AS (
      SELECT r.sop_payment_id,
             COUNT(*) FILTER (WHERE sa.is_void = true)  AS voided,
             COUNT(*)                                    AS total
      FROM refunds r
      LEFT JOIN sale_items si
        ON (r.ref_sale_item_id IS NOT NULL AND si.sale_item_id = r.ref_sale_item_id)
        OR (r.ref_sale_item_id IS NULL     AND si.sale_order_id = r.sale_order_id)
      LEFT JOIN sale_allocations sa ON sa.sale_item_id = si.sale_item_id
      GROUP BY r.sop_payment_id
    )
    SELECT sop_payment_id
    FROM sa_status
    WHERE total > 0 AND voided = 0
    LIMIT ${SAMPLE_LIMIT}
  `)) as Array<{ sop_payment_id: string }>
  // ... count + push 同模板

  // ── C2/C3/C4/C5 同模板，每通道独立 SELECT。完整 SQL 见 §3。──

  if (details.length > 0) {
    const dateStamp = new Date().toISOString().slice(0, 10)
    const detailJson = JSON.stringify({
      _v: 1, _t: 'refund_cascade_coverage',
      date: dateStamp, total: details.length,
      violations: details,
    })
    await db.execute(sql`
      INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
      VALUES ('cron.audit_refund_cascade', 'cascade_violation', ${dateStamp}, ${detailJson}::jsonb, 'cronTask', NOW())
    `)
    const lines = details.map((d) => `- ${d.channel}: ${d.count} 条 mismatch`)
    await notifyOps([
      '⚠️ [cron-worker] cron.audit_refund_cascade',
      '退款 5 通道级联巡检发现 mismatch：',
      ...lines,
      '',
      `时间：${new Date().toISOString()}`,
    ].join('\n'))
  }

  return { violations: details.length, details }
}
```

### 2.2 注册到 STEP 数组

`fengyu-admin/src/cron/run.ts` 修改（在 paymentInvariants 之后追加）：

```diff
+import { auditRefundCascadeCoverage } from './steps/audit-refund-cascade-coverage'

 const STEPS = [
   ...
   ['paymentInvariants',        auditPaymentInvariants],
+  ['refundCascadeCoverage',    auditRefundCascadeCoverage],
+  ['storeUnbindOrphans',       auditStoreUnbindOrphans],  // 见 sibling ticket
 ] as const
```

run.ts 顶部 STEP 总数注释同步更新（8 → 10，若另一 ticket 已加 9）。

### 2.3 单元测试

新建 `fengyu-admin/src/cron/__tests__/audit-refund-cascade-coverage.test.ts`（mock db.execute 按通道返回不同行集）：

| 用例 | 期望 |
|------|------|
| 全部 5 通道一致 | `violations = 0`；无 INSERT；无 notifyOps |
| C1 缺失 1 条 | `details[0].channel='sa_not_voided', count=1`；INSERT 1 行；notifyOps 1 次 |
| C4 缺失 2 条 | `details[0].channel='point_not_reversed', count=2` |
| 同时 C2 + C5 | `details.length=2`；notifyOps 含 2 行 mismatch |

## 3 完整 SQL 模板（5 通道）

```sql
-- C2: service_commissions 应已 voided_at IS NOT NULL
WITH refunds AS (
  SELECT sop.sop_payment_id, sop.sale_order_id, sop.ref_sale_item_id
  FROM sale_order_payments sop
  WHERE sop.change_type = '退款' AND sop.status = '已支付'
),
sc_status AS (
  SELECT r.sop_payment_id,
         COUNT(*) FILTER (WHERE sc.voided_at IS NOT NULL) AS voided,
         COUNT(*)                                          AS total
  FROM refunds r
  LEFT JOIN sale_items s
    ON (r.ref_sale_item_id IS NOT NULL AND s.sale_item_id = r.ref_sale_item_id)
    OR (r.ref_sale_item_id IS NULL     AND s.sale_order_id = r.sale_order_id)
  LEFT JOIN service_items si ON si.sale_item_id = s.sale_item_id
  LEFT JOIN service_commissions sc ON sc.service_item_id = si.service_item_id
  GROUP BY r.sop_payment_id
)
SELECT sop_payment_id FROM sc_status WHERE total > 0 AND voided = 0 LIMIT 10;

-- C3: user_coupons 应已 status='未使用'（仅检"退款时仍未过期"的券；过期券不强制回滚是 cascade 设计 line 134）
WITH refunds AS (
  SELECT sop.sop_payment_id, sop.sale_order_id, sop.updated_at
  FROM sale_order_payments sop
  WHERE sop.change_type = '退款' AND sop.status = '已支付'
)
SELECT r.sop_payment_id
FROM refunds r
WHERE EXISTS (
  SELECT 1 FROM user_coupons uc
  WHERE uc.used_sale_order_id = r.sale_order_id
    AND uc.status = '已使用'
    AND uc.expire_at > r.updated_at        -- 当时还有效
)
LIMIT 10;

-- C4: point_transactions 反向流水必须存在
WITH refunds AS (
  SELECT sop.sale_order_id
  FROM sale_order_payments sop
  WHERE sop.change_type = '退款' AND sop.status = '已支付'
)
SELECT DISTINCT r.sale_order_id
FROM refunds r
JOIN point_transactions pt_pos
  ON pt_pos.ref_order_id = r.sale_order_id
 AND pt_pos.type IN ('消费赠送','回款赠送','获取')
 AND pt_pos.amount > 0
WHERE NOT EXISTS (
  SELECT 1 FROM point_transactions pt_neg
  WHERE pt_neg.ref_order_id = r.sale_order_id
    AND pt_neg.user_id = pt_pos.user_id
    AND pt_neg.type = '消费冲销'
    AND pt_neg.amount = -pt_pos.amount
)
LIMIT 10;

-- C5: sale_items.picked_up_quantity 回滚（仅检"原单有过提货"的）
WITH refunds AS (
  SELECT sop.sop_payment_id, sop.sale_order_id, sop.ref_sale_item_id, sop.session_count
  FROM sale_order_payments sop
  WHERE sop.change_type = '退款' AND sop.status = '已支付'
)
SELECT r.sop_payment_id
FROM refunds r
JOIN sale_items s
  ON (r.ref_sale_item_id IS NOT NULL AND s.sale_item_id = r.ref_sale_item_id)
  OR (r.ref_sale_item_id IS NULL     AND s.sale_order_id = r.sale_order_id)
WHERE EXISTS (
  SELECT 1 FROM pickup_records pr
  WHERE pr.sale_item_id = s.sale_item_id
)
  AND COALESCE(s.picked_up_quantity, 0) >= (
    SELECT COALESCE(SUM(pr.quantity), 0)
    FROM pickup_records pr
    WHERE pr.sale_item_id = s.sale_item_id
  )  -- 等号 = 完全没回滚；> 不可能（GREATEST 兜底）
LIMIT 10;
```

> ⚠️ C3 注意：cascade 中 `expire_at > NOW()` 是恢复门槛，**只恢复退款时还有效的券**。审计 SQL 用 `uc.expire_at > r.updated_at`（退款时的快照），避免审计跑得晚→券过期→误判 mismatch。
> ⚠️ C5 注意：`pickup_records.quantity` 列名以实际 schema 为准（见 `db/schema/pickup.ts:14-44`，若实际列名为 `picked_quantity` 等需调整）。

## 4 DoD（验收 Checklist）

- [ ] `fengyu-admin/src/cron/steps/audit-refund-cascade-coverage.ts` 新建，5 通道 SELECT 完整
- [ ] `fengyu-admin/src/cron/run.ts` STEPS 数组追加 `refundCascadeCoverage` 注册项
- [ ] 单元测试 4 用例全部 PASS（`bun run test -- audit-refund-cascade-coverage`）
- [ ] **当前数据 dry-run 0 mismatch**（`bun run cron:once` → 检查 `operation_logs WHERE action='cron.audit_refund_cascade' AND created_at::date=CURRENT_DATE` 无新行；console 输出 `refundCascadeCoverage: {"violations":0,"details":[]}`）
- [ ] 故意手工"破坏" 1 条 sa（`UPDATE sale_allocations SET is_void=false, voided_at=NULL WHERE sale_item_id IN (SELECT ref_sale_item_id FROM sale_order_payments WHERE change_type='退款' AND status='已支付' LIMIT 1)`），再跑 `--once`，应在 operation_logs 写入 C1 violation
- [ ] notifyOps 告警 markdown 含 5 通道枚举 + 计数 + 时间戳
- [ ] alert 模板字符串（"退款 5 通道级联巡检发现 mismatch"）写入 ticket，运维 / PM 周报可直接引用
- [ ] PR 中 `grep -rn "auditRefundCascadeCoverage" fengyu-admin/src/cron` 至少 2 处命中
- [ ] STEP 8 `auditPaymentInvariants` 不受影响（同跑下两个 STEP 互不依赖）

## 5 风险与回滚

| 风险点 | 评估 | 缓解 |
|--------|------|------|
| 5 通道 SQL 性能（每条 ~JOIN 3-4 表 + EXISTS） | 中 | sale_order_payments 退款行数当前 < 1k 级；JOIN 命中索引（sale_item_id PK、ref_order_id idx）；EXPLAIN ANALYZE 在 PR 中粘出 |
| C3 退款时已过期券误判 | 已规避 | SQL 用 `r.updated_at` 而非 `NOW()`，对齐 cascade 设计 |
| C5 pickup_records 列名漂移 | 中 | 实施前 grep `db/schema/pickup.ts` 确认列名；若需调整在 §3 内同步 |
| 旧数据有遗留 mismatch（重构前的退款）| 中 | 第一次跑前先评估 mismatch 数量，>50 条则视作"历史包袱"，单开 ticket 一次性 fix；STEP 仍上线但 oncall 静默 1 周观察 |
| operation_logs detail 体积过大 | 低 | SAMPLE_LIMIT=10 / 通道，5 通道最多 50 条 row 元数据，<10KB |
| 与 STEP 7/8 同跑总耗时拉长 | 低 | run.ts STEP 间串行已就位，单 STEP 失败不阻塞下一个 |

**回滚**：纯新增文件 + run.ts 1 行 import + 1 行 STEP 追加，回退 PR 即恢复。

## 6 关联

| 项 | 说明 |
|----|------|
| 来源 | [SUMMARY §6.4 / §4 L11 Cron 守护层](../../docs/audit/SUMMARY.md) |
| 关联 audit | audit-07 提成 / audit-08 服务提成 / audit-11 退款 / audit-15 积分 / audit-20 提货 |
| 关联 helper | `fengyu-admin/src/lib/refund-cascade.ts`（单源） + `fengyu-staff/cloudfunctions/staffApi/helpers/refund-cascade.js`（副本） |
| 关联 snapshot | `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-sql-snapshot.test.js:336-446`（静态字面量守护，与本 STEP 互补） |
| 关联 cron | `audit-payment-invariants.ts`（STEP 7，结构模板） |
| 部署 | cron-worker 同镜像；merge 后下次容器重启生效 |
