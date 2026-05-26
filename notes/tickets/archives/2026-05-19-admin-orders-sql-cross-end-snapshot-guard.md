# Ticket: admin orders.ts 关键 SQL 纳入 cross-end SQL snapshot 守护

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-19 |
| 实施状态 | 已实施（2026-05-19）|
| 优先级 | **P3**（防御性守护；当前三端已字面对齐，但缺自动化保护）|
| 端 | fengyu-admin + fengyu-staff（测试侧补充）|
| 修复成本 | **M**（新增 5-10 个 SQL 片段 snapshot；约 100 行测试）|
| 来源 | 2026-05-19 充值卡跨端实施收尾（T5 改造时发现的"admin 漂移孤岛"问题）|
| 决策 | **直接补 snapshot**，无需选方案 |
| 关联文件 | `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-sql-snapshot.test.js`、`fengyu-admin/src/actions/orders.ts` |

---

## 0 一句话

T5 改造揭示 admin `applyRechargeOnOrderPaid` 在 2026-04-26 capability 化重构时**漏改了** face value 识别（保持单路径直到 2026-05-19），而 staff/client 早已双路径；当前的 cross-end SQL snapshot 测试**没覆盖 admin 端 SQL**，导致 admin 漂移没被立即捕获。需要把 admin 关键 SQL 也纳入守护。

---

## 1 证据

### 1.1 已有的 cross-end SQL snapshot 守护范围

`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-sql-snapshot.test.js` 当前守护：
- `applyRechargeOnOrderPaid` UPSERT 文本（三端独立副本）
- `settlePointsForOrder` SQL
- `paid_sessions` 重算 SQL

但只读取 staff/client 端的源码字符串，**没有读 admin** `fengyu-admin/src/actions/orders.ts` 的对应 SQL 片段。

### 1.2 漂移历史的代价

2026-04-26 capability 化 ticket 实施后：
- staff `routes/order.js` recharge 识别块改为双路径（virtualSku → productName / realSku → sku.price）✓
- client `payNotify/index.js` recharge 识别块同步改为双路径 ✓
- **admin `applyRechargeOnOrderPaid` 留着单路径直到 2026-05-19**（T5 ticket 修复）

漂移期约 23 天。期间真实 SKU 充值卡若从 admin 端开单且通过 `confirmOfflinePayment` 入账，面值会因 `parseRechargeFaceValue(spec_name)` 解析失败而抛 `INVALID_STATE`，订单卡死。生产无暴露的原因可能是"admin 开充值卡单"路径使用率极低。

### 1.3 同类守护已存在

`cross-end-error-codes-snapshot.test.js` 已经守护 admin .ts 端（用 regex 提取源码）。SQL snapshot 可以套用同样模式。

---

## 2 实施

### 2.1 扩展 `cross-end-sql-snapshot.test.js`

定位 `applyRechargeOnOrderPaid SQL 一致性守护（三端独立副本）` describe 块，增加：

- 从 `fengyu-admin/src/actions/orders.ts` 用 regex 提取 `applyRechargeOnOrderPaid` 函数体内的关键 SQL：
  - `SELECT si.sku_id, si.product_name, si.sale_amount FROM sale_items ... WHERE is_recharge_card = true`
  - `INSERT INTO prepaid_cards ... ON CONFLICT (user_id) DO UPDATE`
  - `INSERT INTO card_transactions (card_id, type='充值', amount, ref_order_id) ...`
- 与 staff `routes/order.js` 同名块字面对比（normalize 空白）

### 2.2 扩展守护范围（新增）

把 admin `confirmOfflinePayment` 内的扣卡 SQL 也加入守护（与 staff `confirmOffline` L908-945 字面对齐）：
- `SELECT prepaid_card_amount, client_user_id FROM sale_orders WHERE ... FOR UPDATE`
- `SELECT 1 FROM card_transactions WHERE ref_order_id = ? AND type = '扣款' LIMIT 1`
- `SELECT card_id, balance FROM prepaid_cards WHERE user_id = ? FOR UPDATE`
- `UPDATE prepaid_cards SET balance = balance - ? WHERE card_id = ?`
- `INSERT INTO card_transactions (card_id, type='扣款', amount, ref_order_id, external_ref) ... ON CONFLICT ...`
- `INSERT INTO sale_order_payments ... change_type='储值卡抵扣' ...`

### 2.3 镜像测试（admin 侧）

参考 `fengyu-admin/src/lib/__tests__/error-codes-cross-end.test.ts` 模式，新增 `fengyu-admin/src/actions/__tests__/orders-sql-cross-end.test.ts`（如果该目录不存在，放 `src/lib/__tests__/orders-sql-cross-end.test.ts`）。

逻辑：用 fs 读 staff `routes/order.js` + client `payNotify/index.js` + admin `orders.ts`，三端比对 SQL 片段。

---

## 3 验证

### 3.1 守护能力测试

故意改 admin `orders.ts` 的一段 SQL（例如把 `WHERE is_recharge_card = true` 改成 `WHERE is_recharge_card = TRUE`） → 跨端测试必须立即失败。

恢复后必须立即恢复绿色。

### 3.2 回归

```bash
bun /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-sql-snapshot.test.js
bun /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/lib/__tests__/orders-sql-cross-end.test.ts
```

---

## 4 后续

实施完成后，更新 CLAUDE.md `no-shared-cloudfunctions` 章节，明确"admin 端关键 SQL 也由 snapshot 守护"。

---

## 5 关联引用

- `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-sql-snapshot.test.js`
- `fengyu-admin/src/lib/__tests__/error-codes-cross-end.test.ts`（参考模式）
- `fengyu-admin/src/actions/orders.ts`（applyRechargeOnOrderPaid + confirmOfflinePayment）
- 2026-05-19 T5 改造历史：`notes/tickets/2026-05-19-admin-prepaid-card-picker-hardcoded-tiers.md`
- 2026-05-19 T1 改造历史：`notes/tickets/2026-05-19-admin-confirmoffline-prepaid-card-deduct-missing.md`
