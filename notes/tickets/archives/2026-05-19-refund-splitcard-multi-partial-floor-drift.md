# Ticket: splitRefundByOriginalPayment 多次部分退款 floor 累计误差 — 【已归档：被 I4 覆盖】

> **归档备注（2026-05-19）**
>
> 本 ticket 决策为 **C 方案（不修拆分逻辑，靠定时审计告警）**。在实施 C 方案过程中发现 `fengyu-admin/src/cron/steps/audit-payment-invariants.ts` 的 **I4 不变量已经实现储值卡余额校验**：
> - 阈值 **0.01 元**（比本 ticket 拟定的 0.10 元更严，能捕获更小漂移）
> - 写 `operation_logs(action='cron.audit_invariants')` + 调 `notifyOps()` 告警通道
> - 已注册到 cron `run.ts` 并随每日 03:00 跑批
>
> 因此本 ticket 的"新建定时审计 STEP"任务**重复劳动**，决定不新建独立 STEP。本文件归档保留作为决策记录。
>
> 后续如果业务接受度变化（例如严格审计上线），可重新评估 A 方案"最后一笔补差"或 B 方案"动态比例"。

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-19 |
| 实施状态 | **已归档（被 audit-payment-invariants I4 覆盖）** |
| 优先级 | **P2**（每次部分退款 floor 误差 ≤ 0.01 元；多次累计 ≤ 几分钱；严格审计场景下不闭合）|
| 端 | fengyu-admin + fengyu-staff（三端同源副本）|
| 修复成本 | **S**（在最后一笔退款时补差，或改为"剩余预付/剩余总额"动态比例）|
| 来源 | 2026-05-18 充值卡跨三端调试审计（B2.1）+ refund-cascade.js 深查 |
| 决策点 | **请你判断**：修 / 不修 / 仅审计告警 |
| 关联文件 | `fengyu-admin/src/lib/refund.ts` L133-148, `fengyu-staff/cloudfunctions/staffApi/utils/refund.js`（独立副本）|

---

## 0 一句话

`splitRefundByOriginalPayment(refundAmount, origPrepaidCardAmount, origTotalAmount)` 用**固定比例** `floor(origPrepaid/origTotal × refundAmount, 2)` 拆分储值卡回冲份额，多次部分退款的累计 floor 误差**无补差机制**，最后一笔不闭合。

---

## 1 复现证据

### 1.1 拆分函数实现

```ts
// fengyu-admin/src/lib/refund.ts L133-148
export function splitRefundByOriginalPayment(
  refundAmount: number,
  origPrepaidCardAmount: number,
  origTotalAmount: number,
): { refundByCard: number; refundByOrigin: number } {
  let refundByCard = 0
  let refundByOrigin = Math.round(refundAmount * 100) / 100

  if (origPrepaidCardAmount > 0 && origTotalAmount > 0 && refundAmount > 0) {
    const raw = (origPrepaidCardAmount / origTotalAmount) * refundAmount
    refundByCard = Math.floor(raw * 100) / 100
    refundByOrigin = Math.round((refundAmount - refundByCard) * 100) / 100
  }

  return { refundByCard, refundByOrigin }
}
```

注释自己说"反向相减，无尾差"——但这指的是**单次拆分**的尾差由 `refundByOrigin` 吸收，**不是多次累计**。

### 1.2 累计误差举例

**场景**：原单 total=1000，prepaid=99（比例 9.9%）

| 退款笔次 | 退款金额 | floor(0.099 × refund) | refundByCard | refundByOrigin |
|---------|---------|----------------------|--------------|----------------|
| 1 | 333 | 32.967 → 32.96 | 32.96 | 300.04 |
| 2 | 333 | 32.967 → 32.96 | 32.96 | 300.04 |
| 3 | 334 | 33.066 → 33.06 | 33.06 | 300.94 |
| **合计** | **1000** | — | **98.98** | **901.02** |

应回冲储值卡 99 元，实际只回冲 98.98 元 → **顾客储值卡少 0.02 元**，差额沉淀到 `refundByOrigin`（多退现金）。

### 1.3 退款 cascade 实际不闭合的原因

`fengyu-staff/cloudfunctions/staffApi/helpers/refund-cascade.js` 处理 5 通道：sale_allocations / service_commissions / user_coupons / point_transactions / pickup_records — **完全不碰 prepaid_cards.balance**。

储值卡回冲逻辑在 `approveRefund` 内部（staff order.js L1668-1693），直接用 `sopRow.amount`（已被 `splitRefundByOriginalPayment` 拆分写入 sale_order_payments）回冲。所以拆分误差在写 sop 时就固化了。

---

## 2 影响评估

| 维度 | 实际影响 |
|------|---------|
| 单次部分退款 | ≤ 0.01 元（refundByOrigin 吸收尾差，refundByCard 永远 ≤ 真实比例） |
| 多次部分退款 | 累计 ≤ N × 0.01 元（N = 退款笔次） |
| 一次性全退 | ✓ 闭合（raw = origPrepaid，floor 无损） |
| 业务感知度 | 顾客几乎不会发现；财务审计可能挑出 |

**典型边界**：实际业务中一笔订单部分退款超过 3 次的比例 < 1%，累计误差 ≤ 0.03 元。

---

## 3 候选方案（请你判断）

### 方案 A：最后一笔补差（推荐）

**实现**：调 `splitRefundByOriginalPayment` 前先查 `card_transactions WHERE ref_order_id like 'SOP-%' AND saleOrderId 关联` 求和，若本次退款是"剩余的最后一笔"则补差（refundByCard = origPrepaid - 已累计回冲）。

**代价**：admin/staff 两端同源函数都要改，且函数签名需要新增 `pg` client 参数或改外部包装；snapshot 测试同步。约 30 行 + 测试 + 跨端守护。

**好处**：完全闭合；累计误差永远归零；语义清晰。

### 方案 B：动态比例

**实现**：每次拆分用 `(origPrepaid - 已回冲) / (origTotal - 已退) × refundAmount`，而不是固定 `origPrepaid / origTotal`。

**代价**：同样需要查历史回冲累计；改动比 A 大；更难推理。

**好处**：避免"补差"特例语义；任意中间退款都接近精确。

### 方案 C：接受现状 + 审计告警

**实现**：定时任务扫 prepaid_cards 余额一致性，发现漂移 > 0.10 元的告警，不自动修复。

**代价**：极小；不解决根因。

**好处**：零代码改动；保留人工干预空间。

---

## 4 我的建议

**方案 C**。原因：
- 0.02-0.03 元的误差业务影响极小
- 任何"补差"逻辑都引入新的状态依赖（必须查历史回冲累计），增加事务复杂度
- 真正出问题的是"严格审计场景"，但本项目目前没有这类场景上线压力
- 若将来需要严格审计，再升级 A 或 B

---

## 5 决策点

请选择 A / B / C，我按方案实施。

---

## 6 关联引用

- `fengyu-admin/src/lib/refund.ts` L133-148
- `fengyu-staff/cloudfunctions/staffApi/utils/refund.js`（独立副本，同函数）
- `fengyu-admin/src/actions/refunds.ts` L623, L761 调用点
- `fengyu-staff/cloudfunctions/staffApi/routes/order.js` L1529, L1668-1693 调用点
- `fengyu-staff/cloudfunctions/staffApi/helpers/refund-cascade.js`（不涉及 prepaid_cards，已验证）
