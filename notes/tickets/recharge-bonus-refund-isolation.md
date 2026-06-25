# 充值卡本金/赠送区分 与「赠送不可退」

> 状态：**仅记录现状与实现思路，未实施**。由「订单导出商品明细维度」任务（2026-06-24）衍生发现。
> 待业务确认「消费扣款顺序」后另行立项。

## 背景与现状（2026-06-24 实读结论）

充值卡（储值卡）当前在数据层**无法区分本金与赠送**：

- `prepaid_cards`（`db/schema/prepaid-card.ts`）只有一个合并 `balance`，无本金/赠送维度字段。
- `card_transactions` 只有 `type`(充值/扣款) + `amount`，不拆分本金/赠送。
- 充值档位（`fengyu-admin/src/lib/recharge.ts` + `cards.ts` `getRechargeCardTiers`）：`faceValue`(面值) / `payAmount`(实付本金) / `bonus = faceValue − payAmount`(赠送)。
- `createRechargeOrder`（`fengyu-admin/src/actions/cards.ts`）：充值单 `total_amount=faceValue`、`payable_amount=payAmount`、**不写 `sale_items`**；入账 `applyRechargeOnOrderPaid` 执行 `balance += faceValue`（**本金+赠送合并**），流水记 `amount=faceValue`。

**结论**：赠送金额仅在充值档位配置层 `faceValue − payAmount` 算出，落库即合并丢失。退款逻辑（`lib/refund-cascade.ts` 等）只能基于合并 `balance`，**做不到"只退本金、不退赠送"**。这不是某个字段写错，而是**缺少区分本金/赠送的数据能力**。

## 目标

实现「退款时本金可退、赠送不可退」——退款上限 = 卡内剩余**本金**，赠送部分不可提现/退款。

## 实现思路（待评估）

### 1. Schema：增加本金/赠送维度（二选一）
- **方案 A（推荐·余额双列）**：`prepaid_cards` 增 `principal_balance`（可退本金）+ `bonus_balance`（赠送余额）；以 `balance = principal_balance + bonus_balance` 作为不变量。
- **方案 B（流水拆分）**：`card_transactions` 增 `principal_amount` / `bonus_amount`，余额由流水聚合推导（无冗余列，但查询需聚合）。

### 2. 充值入账
`applyRechargeOnOrderPaid`（被 admin `confirmOfflinePayment`、payNotify 调用）改为：
- `principal_balance += payAmount`
- `bonus_balance += (faceValue − payAmount)`
- 流水按本金/赠送拆分记账。

### 3. 消费扣款顺序（**需业务拍板**）
消费时先扣本金还是先扣赠送，直接决定"剩余可退本金"：
- ① 先扣赠送（赠送优先消耗，留更多可退本金 → 退款敞口偏大）
- ② 先扣本金（减少退款敞口，但赠送沉淀难清）
- ③ 按 本金:赠送 比例扣
- 倾向默认 ①「先扣赠送」（符合常见"赠送先用"口径），但须确认。

### 4. 退款
- 退款上限 = `principal_balance`（当前可退本金），赠送不可退。
- 退款后 `principal_balance -= 退款额`，`balance` 同步递减。
- 触点：`fengyu-admin/src/lib/refund-cascade.ts` + 其它端各自副本。

### 5. 跨端影响（按 CLAUDE.md「禁止跨端共享」，各端独立改 + snapshot 守护）
- 充值入账：admin `cards.ts` / staff `card.recharge` / client / payNotify。
- 消费扣款：clientApi / staffApi 消费引擎。
- 退款：admin + staff + payNotify 的 refund-cascade 副本。

### 6. 历史数据迁移
现有卡 `balance` 无法回溯拆分本金/赠送（数据已合并丢失）。建议历史余额**全部计为本金**（`principal_balance = balance`、`bonus_balance = 0`）——保守口径，对顾客最有利（全可退），避免迁移误扣顾客赠送。

### 7. 配套
- cron `audit-payment-invariants` 增加 `balance = principal_balance + bonus_balance` 校验。
- 与「充值金转入」(`createPrepaidInflow`，旧系统 1:1 等额无赠送) 兼容：转入额全计本金。

## 与本次导出任务的关系
本次「订单导出商品明细维度」已在导出中体现充值单的「本金」(=`payable_amount`) 与「赠送金额」(=`total_amount − payable_amount`) 两列，供对账参考；但**不改变退款行为**——退款能力的修复需本文档另行立项实施。
