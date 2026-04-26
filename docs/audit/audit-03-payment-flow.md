# 审计报告：款项流水（sale_order_payments）(03)

**审计时间**：2026-04-26
**域 ID**：03
**审计员**：claude-sonnet-4-6
**审计时长**：~60 分钟（含 v1+v2 对比分析）
**版本**：v3（合并 v1 claude-opus-4-7 + v2 claude-sonnet-4-6）
**规范版本**：`real.md` v3.1.0 + `enums.ts` 28 枚举 + migration 0018/0019

---

## 元信息

| 字段 | 值 |
|------|-----|
| 域 ID | 03 |
| 域名称 | 款项流水（sale_order_payments） |
| v1 审计时间 | 2026-04-25 |
| v2 审计时间 | 2026-04-26 14:00 |
| v3 完成时间 | 2026-04-26 |
| v1 审计员 | claude-opus-4-7 |
| v2 审计员 | claude-sonnet-4-6（独立第二轮，从零读源码） |
| v3 审计员 | claude-sonnet-4-6 |
| v1 基准 | sale-order-domain-refactor merge 前（paid_amount 列） |
| v2/v3 基准 | sale-order-domain-refactor merge 后（received 列，migration 0018） |

---

## v1 vs v2 摘要

| 问题 | v1 状态 | v2 状态 | v3 定论 |
|------|---------|---------|---------|
| admin.confirmOfflinePayment 不写 payments + 不扣卡 | P0-03-01 | P0-03v2-01（仍 P0） | **P0-03v2-01** |
| client.create 全额抵扣未写 '储值卡抵扣' payments | P0-03-02 | 已修复 | **[CLOSED from v1]** |
| confirmOffline changeType 事务外读 | P0-03-03 | P0-03v2-03（仍 P0） | **P0-03v2-03** |
| 退款 payments 幂等键缺失 | P0-03-04 | 已修复（uq_sop_status_audit） | **[CLOSED from v1]** |
| close 不作废 payments | P0-03-05 | 降级 P1-03v2-06 | **P1-03v2-06** |
| payNotify 引用已 DROP 列 | 未发现 | P0-03v2-02（新发现） | **P0-03v2-02** |
| confirmOffline 储值卡幂等断层 | 未发现 | P0-03v2-04（新发现） | **P0-03v2-04** |
| admin.recordPayment received 公式漏通道 | 未发现 | P0-03v2-05（新发现） | **P0-03v2-05** |
| paid_at 三端语义不清 | P1-03-06 | 已解决 | 关闭 |
| source_end admin 两类来源 | P1-03-07 | 仍 P2，可接受 | 关闭 |
| payNotify remaining 算法 | P1-03-08 | 因 DISABLED 静默 | 关闭（关注 P0-03v2-02） |
| confirmOffline CAS 竞态 | P1-03-09 | 部分改善（P0 仍在） | 归并 P0-03v2-03 |
| clientApi 无 ownership helper | P1-03-10 | 仍存在 | **P1-03v2-12**（沿用编号） |
| 退款 payments amount 符号 | P1-03-11 | 已解决 | 关闭 |
| 部分支付 paid_at null | P1-03-12 | 已解决 | 关闭 |
| approveRefund 储值卡回冲条件错误 | 未发现 | P1-03v2-07（新发现） | **P1-03v2-07** |
| payNotify 事务外 firstPayCheck 竞态 | 未发现 | P1-03v2-08（新发现） | **P1-03v2-08** |
| admin 部分支付状态未定义 | 未发现 | P1-03v2-09（新发现） | **P1-03v2-09** |
| admin.recordPayment 无幂等键 | 未发现 | P1-03v2-10（新发现） | **P1-03v2-10** |
| staffApi detail SELECT note 已 DROP 列 | 未发现 | P1-03v2-11（新发现） | **P1-03v2-11** |

---

## 3. 自身漏洞

### 3.1 P0（阻断 / 资损 / 越权）

> **[CLOSED from v1]** P0-03-02：client.create 全额抵扣未写 '储值卡抵扣' payments — v2 确认 `clientApi/routes/order.js:573-579` 已修复，新增 INSERT sale_order_payments 行。

> **[CLOSED from v1]** P0-03-04：退款 payments 幂等键缺失（双店长并发）— v2 确认 migration 0018 加了 `uq_sop_status_audit` partial unique，DB 层兜底同原单唯一 in-flight 退款。

---

#### **[P0-03v2-01]** admin `confirmOfflinePayment` 不写 payments 行、`received` 不更新——不变量破坏仍然存在

- **文件**：`fengyu-admin/src/actions/orders.ts:535-596`
- **继承自**：v1 P0-03-01（sale-order-domain-refactor 后字段名从 `paid_amount` 变为 `received`，漏洞未修）
- **现象**：admin.confirmOfflinePayment 仅执行 CAS UPDATE sale_orders status='已支付' + 更新 expire_date + applyRechargeOnOrderPaid（充值入账），**完全不操作 sale_order_payments，不更新 received**。
  - `received` 语义（`db/schema/order.ts:68-75`）：本字段是 sale_order_payments 表 `change_type IN ('首次支付','回款','储值卡抵扣') AND status='已支付'` 行 amount 之和的冗余快照，由应用层每次 payments 变更后同事务双写维护。
  - admin.confirmOfflinePayment 翻 '已支付' 后，`received` 仍为 create 时旧值，而 payments 表无行——**不变量彻底破裂**。
  - 若 create 时线上通道 received=0 而 `prepaid_card_amount=200`，确认收款后 status='已支付' 但 received=0——订单看起来"已支付但实收 0"，报表完全失真。
- **储值卡未扣**：`prepaid_card_amount > 0` 的订单被 admin 确认收款时，不执行储值卡扣减（无 FOR UPDATE prepaid_cards + card_transactions 写入）。顾客扣款逃脱，**直接资损**。
- **数据影响量级**：所有 `offline_confirmed_by IS NOT NULL` 的订单均受影响（历史 + 未来）。
- **复现**：
  1. admin.createOrder paymentMethod='线下', received=0 → status='待支付', received=0, prepaid_card_amount=200
  2. admin.confirmOfflinePayment → status='已支付', received 仍=0, prepaid_cards.balance 未扣
  3. SUM(payments)=0 而 sale_orders.received=0 ——"系统认为收款0，实际应收800"
- **修复**：(L7) admin.confirmOfflinePayment 事务内对齐 staff.confirmOffline：读 `prepaid_card_amount > 0` → 锁卡扣减 → INSERT '储值卡抵扣' payments → INSERT '首次支付' payments → 重算 received → CAS UPDATE sale_orders；或 (L0) 从 admin 移除该 action，统一由店长在小程序操作。

---

#### **[P0-03v2-02]** `payNotify` 遗留代码引用已 DROP 的 `paid_amount` / `wechat_transaction_id` 列——当前 DISABLED 但解禁后即崩

- **文件**：`fengyu-client/cloudfunctions/payNotify/index.js:127-128, 149, 269-271, 283`
- **类型**：新发现（v1 未覆盖 payNotify 细节）
- **现象**：payNotify 当前由 `PAYNOTIFY_DISABLED = true` 全锁（`index.js:54`），返回 -403。但遗留业务代码（DISABLED 守卫下方）仍在 SELECT 和 UPDATE 已 DROP 列：
  - `index.js:128`：`SELECT ... paid_amount, ...`（已 DROP，migration 0018）
  - `index.js:149`：同上（回款凭证单分支）
  - `index.js:269`：`UPDATE sale_orders SET ... paid_amount = $2, ...`（已 DROP）
  - `index.js:271`：`wechat_transaction_id = COALESCE(...)`（已 DROP）
  - `index.js:283`：`wechat_transaction_id = COALESCE(...)`（已 DROP）
  - `index.js:143`：`order.sale_order_type === '回款单'`——'回款单' 值已从枚举删除（migration 0018），此判断永远 false
- **风险**：一旦 PAYNOTIFY_DISABLED 改回 false（拉卡拉对接），payNotify 每次执行触发 PG "column does not exist"，所有微信支付回调失败，订单永远卡在 '待支付'，**所有微信支付订单无法入账**（资损）。
- **修复**：(L3) payNotify 全量替换 `paid_amount → received`，删除 `wechat_transaction_id / alipay_transaction_id`（三方流水号已下沉至 `sale_order_payments.external_txn_id`），删除 `sale_order_type='回款单'` 分支，配合完整 V3 签名校验实施。

---

#### **[P0-03v2-03]** `staff.confirmOffline` `paymentChangeType` 决定（首次支付 vs 回款）在**事务外**读——并发双首次支付漏洞仍然存在

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:847-854`（事务外）vs `:934-940`（事务内 INSERT）
- **继承自**：v1 P0-03-03（代码完全未改，partial unique 未加）
- **现象**：
  ```js
  // 事务外（line 847）：
  const existingPaymentsRow = await pg.query(
    `SELECT 1 FROM sale_order_payments WHERE sale_order_id = $1 AND status = '已支付' AND change_type IN ('首次支付','回款','退款') LIMIT 1`,
    [saleOrderId]
  )
  paymentChangeType = existingPaymentsRow.length > 0 ? '回款' : '首次支付'
  // 事务内（line 934）：直接使用 paymentChangeType INSERT
  ```
- **并发场景**：A、B 并发 confirmOffline 同一订单，均读到 0 行 → 各自决定 '首次支付' → A 进入事务 INSERT 成功 → B 进入事务 INSERT 另一行 '首次支付'——**同一订单 2 行 '首次支付'**。
- **DB 兜底缺失**：`db/schema/order.ts` 只有 `uq_sop_txn`（external_txn_id）和 `uq_sop_status_audit`（退款待审批），**无 `uq_sop_first_payment` partial unique**——v1 建议的 migration 未落地。
- **风险**：同一订单被统计 2 次首次支付，SUM(payments) 偏高，报表/退款拆分双重计数。
- **复现**：两店长同时点确认收款，或 staff.confirmOffline 与 client 端操作并发。
- **修复**：
  - (L0) migration：`CREATE UNIQUE INDEX uq_sop_first_payment ON sale_order_payments (sale_order_id) WHERE change_type = '首次支付'`
  - (L3) 将 existingPaymentsRow SELECT 移入 `pg.transaction` 内并加 `SELECT FOR UPDATE`（先锁行再决策）

---

#### **[P0-03v2-04]** `confirmOffline` 的储值卡幂等基于 `card_transactions.ref_order_id` 但跳过了 payments 行补写——幂等断层

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:863-910`
- **类型**：新发现（v1 未发现此路径）
- **现象**：confirmOffline 的储值卡扣款幂等键为 `SELECT 1 FROM card_transactions WHERE ref_order_id=$1 AND type='扣款'`。幂等分支包含整个扣卡+payments 块：
  ```js
  if (dupCheck.rows.length === 0) {
    // ... 扣卡 + INSERT '储值卡抵扣' payments
  }
  // ↑ 若 card_transactions 已存在（重复调用），跳过 payments 写入
  ```
  若第一次事务在"扣卡+card_transactions 写入"和"INSERT payments"之间崩溃（极小概率），重试时 card_transactions 已存在 → 幂等路径跳过 → `payments` 表永久缺少 '储值卡抵扣' 行，而 `prepaid_cards.balance` 已扣减。不变量 `received = SUM(payments[储值卡抵扣+首次支付+回款])` 破裂。
- **风险**：账实不符（小概率）；退款时 `SUM(payments[储值卡抵扣]) = 0`，`prepaid_card_amount` 重算为 0，储值卡不回冲 → 顾客损失。
- **修复**：(L3) 幂等键独立为 `SELECT 1 FROM sale_order_payments WHERE change_type='储值卡抵扣' AND sale_order_id=$1`，与 card_transactions 幂等解耦；或将两步操作原子化（同一 PG 函数）。

---

#### **[P0-03v2-05]** `admin.recordPayment` 的 `received` 重算公式漏掉 '储值卡抵扣' 通道——received 低估

- **文件**：`fengyu-admin/src/actions/orders.ts:1895-1910`
- **类型**：新发现（v1 未覆盖 recordPayment 内部重算逻辑）
- **现象**：recordPayment 事务末尾重算原单 received：
  ```sql
  COALESCE(SUM(CASE WHEN status='已支付' AND change_type IN ('首次支付','回款')
                    THEN amount::numeric ELSE 0 END), 0) AS new_received
  ```
  **'储值卡抵扣' 未包含在 new_received 公式中**。而 `schema/order.ts:68-75` 不变量明确：`received = SUM(amount WHERE status='已支付' AND change_type IN ('首次支付','回款','储值卡抵扣'))`。
- **对照**：
  - `clientApi/routes/order.js:1554-1558`（confirmPrepaidFull）：`SUM WHERE IN ('首次支付','回款','储值卡抵扣')` ✅
  - `clientApi/routes/order.js:1746`（repay）：`IN ('首次支付','回款','储值卡抵扣')` ✅
  - admin.recordPayment：`IN ('首次支付','回款')` ❌
- **风险**：有储值卡抵扣（prepaid_card_amount > 0）的订单经 admin.recordPayment 后 received 不含已抵扣金额，欠款计算偏高 → 超额允许付款/重复回款 → 资损。
- **复现**：
  1. 订单 total=1000, prepaid=200, payable=800，staff.confirmOffline → received=800（首次支付800 + 储值卡抵扣200=1000 正确）
  2. 之后 admin.recordPayment 用 received=800（漏掉储值卡200）→ remainingPayable 计算错误
  3. 部分支付场景（received=400）+ 储值卡200 → admin.recordPayment 后 received=400（漏200）→ remaining=400 而实际应为 200 → 超收风险
- **修复**：(L7) 修改 admin.recordPayment `new_received` 计算加入 `'储值卡抵扣'`：`change_type IN ('首次支付','回款','储值卡抵扣')`

---

### 3.2 P1（数据一致 / 状态错乱）

#### **[P1-03v2-06]** `staff.close` 关闭 '待确认收款' 订单时不作废已有 payments 行——v1 P0-03-05 降级

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:1068-1138`
- **继承自**：v1 P0-03-05（降级为 P1）
- **现象**：close 允许关闭 '待支付'/'待确认收款'/'支付失败' 状态订单（`line 1091`）。当订单是 '待确认收款' 时，sale_order_payments 中可能已有 1 行 '首次支付/已支付'（staff.create 时写入）。close 事务内只做 CAS UPDATE sale_orders status='已关闭' + 作废 sale_allocations + 释放优惠券，**没有** UPDATE sale_order_payments SET status='已作废'，也没有退还储值卡余额。
- **降级原因**：仅出现在 '待确认收款' → '已关闭' 路径，且此状态下店长已实收现金但反悔关闭，属于业务操作问题而非系统计算错误（若先 confirmOffline 则 payments 行已是 '已支付'，close 属于误操作）。
- **风险**：对账报表中 '已关闭' 订单仍有 '已支付' payments 行，SUM(payments) 虚报营收；储值卡 confirmOffline 已扣，关闭不回冲。
- **修复**：(L3) close 事务内追加 `UPDATE sale_order_payments SET status='已作废' WHERE sale_order_id=$1 AND status IN ('已支付','待支付')`；若有 '储值卡抵扣' 已支付行，还需回冲 prepaid_cards.balance。

#### **[P1-03v2-07]** `approveRefund` 的储值卡回冲仅当 `payment_method='储值卡'` 时触发，混合支付场景储值卡不回冲

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:1593-1617`
- **类型**：新发现
- **现象**：approveRefund 中储值卡回冲逻辑：
  ```js
  if (sopRow.payment_method === '储值卡' && sopRow.client_user_id && refundAbs > 0) {
    // 回冲 prepaid_cards
  }
  ```
  但 createRefund 将原单的支付方式（`resolveRefundPaymentMethod(origOrder.payment_method)` → 微信/支付宝/线下）写入 `payment_method`。若原单 `paymentMethod='线下'`（实际混合了储值卡抵扣），`payment_method` 写 '线下' → `payment_method === '储值卡'` 条件永远不满足 → **储值卡部分不回冲**。
- **风险**：混合支付（线下+储值卡）订单退款时，顾客损失 `refundByCard` 金额。
- **修复**：(L3) approveRefund 从 `spd.note`（`_v=1` JSON，含 `refundByCard` 字段）读取储值卡应退金额，`refundByCard > 0` 时按实际金额回冲储值卡。

#### **[P1-03v2-08]** `payNotify` 事务外 `firstPayCheck` 竞态——虽 DISABLED 但解禁后与 staff.confirmOffline 并发仍触发

- **文件**：`fengyu-client/cloudfunctions/payNotify/index.js:224-229`
- **类型**：新发现（关联 P0-03v2-03）
- **现象**：payNotify（DISABLED 保护下）的 firstPayCheck 在事务内执行（`BEGIN` 之后），相对 staff.confirmOffline 更安全；但由于 sale_orders 无 FOR UPDATE 锁，仍可能与 staff.confirmOffline 并发产生双首次支付。payNotify 用 `ON CONFLICT DO NOTHING` 兜底（`uq_sop_txn`），但仅对有 external_txn_id 的行有效；无 external_txn_id 的情况无法兜底。
- **风险**：低概率，但拉卡拉接入后 DISABLED 解除即生效。
- **修复**：与 P0-03v2-03 同步修复——加 `uq_sop_first_payment` partial unique 索引兜底。

#### **[P1-03v2-09]** `admin.confirmOfflinePayment` 对 `'部分支付'` 状态订单的处理未定义

- **文件**：`fengyu-admin/src/actions/orders.ts:557-560`
- **类型**：新发现
- **现象**：`confirmOfflinePayment` WHERE 条件写死 `eq(saleOrders.status, '待确认收款')`，不接受 '部分支付' 订单。而 staff.confirmOffline 支持 '部分支付' → '已支付' 迁移。若 admin 触发（前端传错 status），CAS 返回 count=0，静默失败（`return { success: false, message: '订单状态已变更' }`）——无任何错误日志区分"订单不存在" vs "状态不匹配"。
- **风险**：admin 无法对 '部分支付' 订单确认最终全款；若想操作须改用 recordPayment（但 recordPayment 写 '回款' 行而非 '首次支付' 行）。
- **修复**：(L7) 增加 `'部分支付'` 到 WHERE 条件（并补齐 payments + received 写入，见 P0-03v2-01）；或在文档/UI 层说明 '部分支付' 须从 staff 端处理。

#### **[P1-03v2-10]** `admin.recordPayment` 幂等依赖前端防重，无后端幂等键或 UNIQUE 约束

- **文件**：`fengyu-admin/src/actions/orders.ts:1700-1701`
- **类型**：新发现（CC2 并发幂等）
- **现象**：注释明确："幂等：本 ticket 简化，依赖前端防重复提交"。线下回款：`external_txn_id` 不建 unique 索引，网络重试可插入重复 '回款' payments 行；储值卡回款每次重新生成 `repaymentOrderId`，无幂等保障。违反 `real.md` #3 "支付幂等"硬约束。
- **风险**：前端双击/网络超时重试 → 多笔 '回款' 行 → `received` 超收 → 退款按偏高 received 计算 → 超额冲销 → 资损。
- **修复**：(L0) `sale_order_payments` 加 partial unique；或 (L7) 前端传 `idempotency_key`，后端做 `ON CONFLICT (sale_order_id, idempotency_key) DO NOTHING`。

#### **[P1-03v2-11]** `staffApi order.detail` 读取 `note` 列但该列已 DROP（migration 0018）

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:1329-1344`
- **类型**：新发现
- **现象**：detail 查询 SELECT 包含 `note`：
  ```js
  SELECT change_type, amount, payment_method, status, paid_at, created_at, note FROM sale_order_payments
  ```
  但 migration 0018（`0018_black_madrox.sql:35`）已将 `note` 从 `sale_order_payments` DROP，下沉至 `sale_order_payment_details`。schema.ts:284 注释："DB 5433 实际仍有此列，migration 0018 未 apply"。若 migration 0018 **已在 5434 生产库执行**，此查询即 PG 报错 "column does not exist"；若未执行，note 仍可读。
- **风险**：production DB apply 0018 后 staff 订单详情页崩溃（payments.note 永远 null 或报错）。
- **修复**：(L3) 改写 SELECT JOIN `sale_order_payment_details`，取 `spd.note, spd.operator_employee_id`；删除直接 `SELECT note FROM sale_order_payments`。

#### **[P1-03v2-12]** `clientApi` 各路由重复 ownership 校验代码无 helper——v1 P1-03-10 仍存在

- **文件**：`clientApi/routes/order.js:622-628`（pay）、`:749-755`（offlinePay）、`:1201-1207`（alipayPay）、`:1404`（confirmPrepaidFull）、`:1555-1557`（repay）
- **继承自**：v1 P1-03-10（无新进展）
- **现象**：每个路由复制粘贴 `if (order.client_user_id) { if (order.client_user_id !== userId) throw 'PERMISSION_DENIED' }`。无 helper，漏一处即越权。
- **风险**：未来新加路由忘记复制 = 越权读写他人订单。
- **修复**：(L3) 抽 `loadOrderForOwner(orderId, userId)` helper，自动校验 + 返回 row；已在 `CROSS-CUTTING.md CC4` 命中。

---

### 3.3 P2（代码质量 / 可维护）

- **[P2-03v2-13]** `confirmOffline` 的 `remainingPayable + 0.001` 浮点容差（`order.js:832`）与 `newSettled + 0.001 >= orderTotal`（`:841`）混合使用。金额校验建议全部改用整数分（×100），避免 0.001 容差在不同分支产生不一致行为。
- **[P2-03v2-14]** `admin.recordPayment` 错误前缀 `'REF_ORDER_NOT_FOUND'`、`'INVALID_STATE:'`、`'OVERPAY:'`、`'INSUFFICIENT_BALANCE:'`、`'CLIENT_NOT_REGISTERED:'`、`'ORDER_ID_GEN_FAILED'` 均不在 4 项约定（`UNAUTHORIZED: / PHONE_REQUIRED: / INVALID_PARAMS: / PERMISSION_DENIED:`），前端 toast 进入"未识别错误"分支。**与 v1 P2-03-14 同源**。
- **[P2-03v2-15]** `createRefund.detailNote` 是 JSON 字符串序列化存入 `sale_order_payment_details.note` 文本列，解析依赖 `JSON.parse`，缺乏 schema 约束。建议改用 `raw_payload jsonb` 列（`order.ts:365` 已定义），避免文本字段存结构化数据。
- **[P2-03v2-16]** `approveRefund` 步骤 3（UPDATE refunded_amount += ABS(amount)）是累加而非重算，但没有 CAS 守卫（`line 1586-1591`）。若多次 approveRefund 同一 paymentId（虽然 CAS 步骤 1 会阻止），不排除极端情况下 refunded_amount 重复累加。建议改为 SUM 重算（与其他端的 received 重算统一）。
- **[P2-03v2-17]** `payNotify/index.js:480` 仍然引用 `sale_order_type = '回款单'` 的查询逻辑，此场景在 migration 0018 后永远不触发（'回款单' 已从枚举删除），但留在代码中造成误解。
- **[P2-03v2-18]** `admin.confirmOfflinePayment` 成功操作日志（`logTransition`）在事务 commit 之后写入（`line 590`），若 logTransition 失败不会回滚业务状态——与其他关键操作的审计逻辑一致（audit-23 已记录），但需与 CC7 时间字段一致性评估。
- **[P2-03v2-19]** `staffApi` 错误前缀 `'CONFLICT:'`、`'INSUFFICIENT_BALANCE:'`、`'INVALID_STATE:'`、`'NOT_FOUND:'` 均不在 4 项约定（v2 新增）。
- **[P2-03v2-20]** `staff.close` 的 `closeExpiredOrder`（`routes/order.js:1071-1098`）与 `clientApi` 的 close/cancel（`clientApi/routes/order.js:15-28, 1020-1085`）两端均未作废 payments 行，**与 P1-03v2-06 同源，分散记录**。

---

## 4. 跨端不一致

| 维度 | admin | staff | client | payNotify | 风险 | 优先级 |
|------|-------|-------|--------|-----------|------|--------|
| confirmOffline 是否写 payments | ❌ 不写 | ✅ 写 首次支付/回款/储值卡 | — | — | received 不变量破坏、储值卡不扣 | **P0** |
| received 重算公式是否含储值卡抵扣 | ❌ recordPayment 漏 '储值卡抵扣' | ✅ 含 | ✅ 含 | N/A（DISABLED） | received 低估 → 超收 | **P0** |
| payNotify DROP 列引用 | — | N/A | **❌ paid_amount/wechat_txn_id 仍在** | — | 解禁后即崩 | **P0** |
| '首次支付' 并发判定位置 | 事务内 | **事务外** | 事务内 | 事务内 | 同订单双首次支付 | **P0** |
| note/operator 字段存储位置 | ✅ JOIN salePaymentDetails | ❌ SELECT note from payments（已 DROP） | ✅ 写 sale_order_payment_details | N/A | production apply 0018 后崩溃 | **P1** |
| 退款储值卡回冲逻辑 | — | ❌ 按 payment_method='储值卡' 判断不准 | — | — | 混合支付退款储值卡不回冲 | **P1** |
| payments 写入后 received 重算 | ✅ SUM 重算 | 增量加 | SUM 重算 | 增量加 | 两种策略混用，并发下可能漂移 | **P1** |
| source_end 值 | 'admin' | 'staff' | 'client' | 'notify' | 一致 | OK |
| chk_sop_amount_sign | schema ✅ | 应用层负值检查 ✅ | 应用层负值保证 ✅ | N/A | 符号约束覆盖 | OK |
| 错误前缀合规 | ❌ 自定义 | ❌ 部分自定义 | ✅ | 内部 | 不属于 4 约定 | **P1** |

---

## 5. 横切检查（仅记录有问题的项）

- [ ] **CC1 数值精度**：amount/received 字段 NUMERIC(10,2)，JS 用 `Math.round(x*100)/100` ✅；`+0.001` 容差散落 confirmOffline/confirmPrepaidFull 多处 → P2-03v2-13 ⚠️；admin.recordPayment received 重算漏通道 → P0-03v2-05 ⚠️
- [ ] **CC2 并发幂等**：
  - `uq_sop_txn`（external_txn_id）幂等键 ✅
  - `uq_sop_status_audit`（退款单原单唯一）✅
  - `uq_sop_first_payment` partial unique **缺失** → P0-03v2-03 ⚠️
  - admin.recordPayment 线下回款幂等**仅依赖前端** → P1-03v2-10 ⚠️
  - confirmOffline 储值卡扣款幂等断层 → P0-03v2-04 ⚠️
  - staff.createRefund in-flight 幂等 → 事务外读 → ⚠️（归并 P0-03v2-03 修复后一起解决）
- [ ] **CC3 组织域隔离**：staff confirmOffline/createRefund/approveRefund 均校验 `store_id = ctx.auth.effectiveStoreId` ✅；admin.recordPayment 注释说"若未来扩展到 scoped 角色需补 isInScope"（`line 1780-1782`）暂 P2；client 按 client_user_id 过滤 ✅。
- [ ] **CC4 后端鉴权**：confirmOffline/createRefund/approveRefund 均有 `requireManager()` ✅；admin.confirmOfflinePayment 有 `requirePermission(session, 'sale_order:update')` ✅；client offlinePay/repay/confirmPrepaidFull 仍手动校验 → P1-03v2-12 ⚠️
- [ ] **CC5 错误码**：admin.recordPayment 错误码不符约定 → P2-03v2-14 ⚠️；staffApi `'CONFLICT:'`、`'INSUFFICIENT_BALANCE:'`、`'INVALID_STATE:'` 均不在 4 项约定 → P2-03v2-19 ⚠️
- [ ] **CC6 PII**：payments.note / payment_details.note 含订单/操作人 ID，无 PII。`console.log('[payNotify] received event:', JSON.stringify(event))`（`payNotify:113`）可能输出完整支付 payload（含金额/订单号），需确认 event 是否含敏感字段。
- [ ] **CC7 时间字段**：`paid_at` 语义清晰（schema `order.ts:292`："status 翻 '已支付' 的时间快照"）✅；confirmOffline `paid_at = targetStatus === '已支付' ? now : (order.paid_at || null)` 逻辑一致 ✅；DB `created_at DEFAULT NOW()` ✅；payments 行不可变设计（无 updated_at 列）OK。
- [ ] **CC8 WXML/Vant**：本域无直接 UI 耦合。
- [ ] **CC9 测试与残留**：
  - staffApi 订单测试覆盖 create/confirmOffline/close/resetFailed/list/detail ✅
  - **admin.confirmOfflinePayment 不写 payments 的核心 P0 未被任何测试覆盖** ⚠️
  - payNotify 遗留的 `paid_amount` / `wechat_transaction_id` 引用（P0-03v2-02）未被测试覆盖 ⚠️
  - `note` 列在 sale_order_payments 中已 DROP（migration 0018），但 staffApi detail 查询仍 SELECT note → P1-03v2-11 ⚠️

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema/migrations | 新 migration `00NN_sop_first_payment_unique.sql` | `CREATE UNIQUE INDEX uq_sop_first_payment ON sale_order_payments (sale_order_id) WHERE change_type = '首次支付'` | P0-03v2-03 |
| L3 payNotify | `payNotify/index.js:127-128,149,269-283` | 全量替换 `paid_amount → received`，删除 `wechat_transaction_id / alipay_transaction_id`，删除 `sale_order_type='回款单'` 分支，配合 V3 签名链路 | P0-03v2-02 |
| L3 staff | `routes/order.js:847-854` | 将 existingPaymentsRow SELECT 移入 `pg.transaction` 内，在 `SELECT FOR UPDATE sale_orders` 后执行；或改为 INSERT '首次支付' ON CONFLICT(uq_sop_first_payment) DO UPDATE SET change_type='回款' | P0-03v2-03 |
| L3 staff | `routes/order.js:863-910` confirmOffline 储值卡幂等 | 幂等键独立为 `SELECT 1 FROM sale_order_payments WHERE change_type='储值卡抵扣' AND sale_order_id=$1`，与 card_transactions 幂等解耦 | P0-03v2-04 |
| L7 admin | `actions/orders.ts:535-596` confirmOfflinePayment | 对齐 staff.confirmOffline：事务内 SELECT FOR UPDATE prepaid_cards → UPDATE balance → INSERT card_transactions → INSERT '储值卡抵扣' payments → INSERT '首次支付'/'回款' payments → 重算 received / prepaid_card_amount → CAS UPDATE sale_orders | P0-03v2-01 |
| L7 admin | `actions/orders.ts:1895-1910` recordPayment | `new_received` SUM 公式加入 `'储值卡抵扣'`：`change_type IN ('首次支付','回款','储值卡抵扣')` | P0-03v2-05 |
| L3 staff | `routes/order.js:1593-1617` approveRefund | 从 `spd.note` JSON（`_v=1, refundByCard`）读取储值卡应退金额，代替 `payment_method === '储值卡'` 判断；`refundByCard > 0` 即触发回冲 | P1-03v2-07 |
| L3 staff | `routes/order.js:1329-1330` detail | 改写 SELECT JOIN `sale_order_payment_details`，取 `spd.note, spd.operator_employee_id`；删除直接 `SELECT note FROM sale_order_payments` | P1-03v2-11 |
| L3 staff/client | `staffApi/routes/order.js:1071-1098` close + `clientApi/routes/order.js:15-28` closeExpiredOrder + `:1020-1085` cancel | 事务内追加 `UPDATE sale_order_payments SET status='已作废' WHERE sale_order_id=$1 AND status IN ('已支付','待支付')`；有 '储值卡抵扣' 已支付行时回冲 balance | P1-03v2-06 |
| L7 admin | `actions/orders.ts:1700-1701` recordPayment | 参数化 idempotency_key，INSERT ON CONFLICT (sale_order_id, idempotency_key) DO NOTHING；或为线下回款加 partial unique | P1-03v2-10 |
| L3 client | `clientApi/routes/order.js` 各路由 | 抽 `loadOrderForOwner(orderId, userId)` helper，统一 ownership 校验，消除复制粘贴 | P1-03v2-12 |
| L7 admin | `actions/orders.ts:557-560` confirmOfflinePayment | 增加 `'部分支付'` 到 WHERE 条件（并补齐 payments + received 写入，见 P0-03v2-01）；或在文档/UI 说明 | P1-03v2-09 |
| L9 前端 | `(main)/orders/_components/record-payment-dialog.tsx` | 错误码映射表更新 | P2-03v2-14 |

---

## 7. 验证 SQL（在 5434 EXPLAIN，禁止写入）

```sql
-- V3-SQL-01：验证 admin.confirmOfflinePayment 不变量破坏（offline_confirmed_by 存在但无 payments 行）
-- 期望：返回 status='已支付' 但 payments 表为空（或 SUM=0）且 offline_confirmed_by IS NOT NULL 的订单
SELECT o.sale_order_id, o.status, o.received, o.prepaid_card_amount,
       o.offline_confirmed_by,
       COALESCE(p.cnt, 0) AS payment_row_count,
       COALESCE(p.paid_sum, 0)::numeric AS payments_paid_sum
FROM sale_orders o
LEFT JOIN (
  SELECT sale_order_id,
         COUNT(*) AS cnt,
         SUM(CASE WHEN status='已支付' AND change_type IN ('首次支付','回款','储值卡抵扣')
                  THEN amount::numeric ELSE 0 END) AS paid_sum
  FROM sale_order_payments
  GROUP BY sale_order_id
) p ON p.sale_order_id = o.sale_order_id
WHERE o.status IN ('已支付', '已完成')
  AND o.offline_confirmed_by IS NOT NULL
  AND COALESCE(p.cnt, 0) = 0
LIMIT 20;

-- V3-SQL-02：验证 received 不变量（SUM payments = received）是否被破坏
SELECT o.sale_order_id, o.status, o.received, o.prepaid_card_amount,
       COALESCE(p.paid_sum, 0)::numeric AS payments_sum,
       ABS(o.received::numeric - COALESCE(p.paid_sum, 0)) AS diff
FROM sale_orders o
LEFT JOIN (
  SELECT sale_order_id,
         SUM(CASE WHEN status='已支付' AND change_type IN ('首次支付','回款','储值卡抵扣')
                  THEN amount::numeric ELSE 0 END) AS paid_sum
  FROM sale_order_payments
  GROUP BY sale_order_id
) p ON p.sale_order_id = o.sale_order_id
WHERE o.status IN ('已支付', '已完成', '部分支付')
  AND ABS(o.received::numeric - COALESCE(p.paid_sum, 0)) > 0.01
LIMIT 30;

-- V3-SQL-03：验证 admin.recordPayment received 公式漏 '储值卡抵扣' 导致的 received 低估
-- 找出有 '储值卡抵扣' payments 行但 received 不含该通道的订单
SELECT o.sale_order_id, o.received, o.prepaid_card_amount,
       COALESCE(p.card_deduction_sum, 0)::numeric AS card_deduction_sum,
       COALESCE(p.cash_sum, 0)::numeric AS cash_sum
FROM sale_orders o
LEFT JOIN (
  SELECT sale_order_id,
         SUM(CASE WHEN status='已支付' AND change_type='储值卡抵扣' THEN amount::numeric ELSE 0 END) AS card_deduction_sum,
         SUM(CASE WHEN status='已支付' AND change_type IN ('首次支付','回款') THEN amount::numeric ELSE 0 END) AS cash_sum
  FROM sale_order_payments
  GROUP BY sale_order_id
) p ON p.sale_order_id = o.sale_order_id
WHERE o.prepaid_card_amount > 0
  AND o.status IN ('已支付', '已完成', '部分支付')
  AND o.offline_confirmed_by IS NOT NULL
  AND COALESCE(p.card_deduction_sum, 0) > 0
  AND ABS(o.received::numeric - COALESCE(p.cash_sum, 0)) < 0.01
LIMIT 20;

-- V3-SQL-04：验证是否存在同订单多行 '首次支付'（事故已发生才有数据）
SELECT sale_order_id, COUNT(*) AS first_pay_count
FROM sale_order_payments
WHERE change_type = '首次支付'
GROUP BY sale_order_id
HAVING COUNT(*) > 1;

-- V3-SQL-05：验证 uq_sop_first_payment 是否已存在
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'sale_order_payments'
  AND indexname LIKE '%first_payment%';

-- V3-SQL-06：验证 migration 0018 是否在 5434 已执行（note/operator_employee_id/paid_amount 是否已 DROP）
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'sale_order_payments'
  AND column_name IN ('note', 'operator_employee_id', 'paid_amount', 'wechat_transaction_id');

-- V3-SQL-07：验证 '已关闭' 订单是否有残留 '已支付' payments（P1-03v2-06）
SELECT o.sale_order_id, o.status, o.offline_confirmed_by IS NOT NULL AS has_offline_confirm,
       COUNT(p.id) AS active_payment_rows
FROM sale_orders o
JOIN sale_order_payments p ON p.sale_order_id = o.sale_order_id
WHERE o.status = '已关闭'
  AND p.status = '已支付'
  AND p.change_type IN ('首次支付','回款','储值卡抵扣')
GROUP BY o.sale_order_id, o.status, o.offline_confirmed_by IS NOT NULL
LIMIT 20;

-- V3-SQL-08：sale_order_type 枚举现有值（验证 '回款单' 是否已删除）
SELECT enumlabel FROM pg_enum
WHERE enumtypid = 'sale_order_type'::regtype
ORDER BY enumsortorder;

-- V3-SQL-09：验证 approveRefund 后 refunded_amount 是否与 SUM 一致
SELECT o.sale_order_id,
       o.refunded_amount::numeric AS stored,
       COALESCE(-SUM(CASE WHEN p.status='已支付' AND p.change_type='退款'
                          THEN p.amount::numeric ELSE 0 END), 0) AS computed
FROM sale_orders o
LEFT JOIN sale_order_payments p ON p.sale_order_id = o.sale_order_id
WHERE o.refunded_amount::numeric > 0
GROUP BY o.sale_order_id, o.refunded_amount
HAVING ABS(o.refunded_amount::numeric - COALESCE(-SUM(CASE WHEN p.status='已支付' AND p.change_type='退款'
                                                           THEN p.amount::numeric ELSE 0 END), 0)) > 0.01
LIMIT 20;
```

---

## 8. 回归测试用例（建议）

1. **admin.confirmOfflinePayment 写 payments + 扣储值卡**：构造 staff.create 待确认收款订单含 prepaid_card_amount=200 + received=400 → admin 触发 → 期望储值卡余额 -200，payments 表 +1 行 '储值卡抵扣'，received 正确。
2. **payNotify DROP 列引用**：构造一笔微信支付，临时设 `PAYNOTIFY_DISABLED = false` → payNotify 触发 → 期望无 PG "column does not exist" 错误。
3. **首次支付并发去重**：mock 两个并发 confirmOffline 同订单 → 期望仅 1 行 '首次支付'（partial unique 命中）。
4. **confirmOffline 储值卡幂等**：第一次事务在"card_transactions 写入"和"INSERT payments"之间 mock 崩溃 → 重试 → 期望 payments 行被补写，prepaid_cards.balance 不重复扣减。
5. **admin.recordPayment received 公式**：构造有储值卡抵扣的订单 → admin recordPayment → 期望 received 包含 '储值卡抵扣' 金额。
6. **approveRefund 混合支付储值卡回冲**：构造 payment_method='线下' 含储值卡抵扣的订单 → createRefund（refundByCard>0）→ approveRefund → 期望储值卡回冲（而非漏掉）。
7. **staffApi detail note 列**：若 migration 0018 已 apply → detail 查询期望 JOIN salePaymentDetails 返回 note。
8. **close 作废 payments**：staff.create paymentMethod='线下' receivedAmount=600 → close → 期望 payments 行 status='已作废'。
9. **received 加总不变量**：插入若干订单，V3-SQL-02 期望返回 0 行。
10. **chk_sop_method_txn**：尝试 INSERT payments 微信通道 + external_txn_id=NULL → 期望 DB CHECK 拦截。

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☑（admin ↔ staff 的 confirmOffline 语义发散；admin ↔ client 的 received 公式发散）
- 全栈（3 端 + DB）：☑
- 涉及历史数据：☑（admin.confirmOfflinePayment 历史确认订单 received 不含 payments，需回填；migration 0018 apply 状态决定 P1-03v2-11 是否即时崩溃）
- 修复成本：
  - P0-03v2-01（admin.confirmOfflinePayment）：**L**（事务体对齐、储值卡扣减、received 重算，需写测试）
  - P0-03v2-02（payNotify DROP 列）：**M**（字段替换 + V3 签名链路）
  - P0-03v2-03（uq_sop_first_payment + 事务内移入）：**S**（1 个 migration + 4 行代码移位）
  - P0-03v2-04（储值卡幂等断层）：**S**（改幂等键判断）
  - P0-03v2-05（recordPayment received 公式）：**S**（改 SUM 公式 1 行）

---

## 10. 后续待办

- [ ] **最高优先级**：确认 migration 0018 在生产库 5434 的实际 apply 状态（`SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 5`）；若已 apply 则 P1-03v2-11 即刻崩溃，需立即修复 staffApi detail 查询。
- [ ] **最高优先级**：写补丁 migration `uq_sop_first_payment` partial unique index（P0-03v2-03）；可独立于其他修复先行。
- [ ] 与 域 04 (payNotify) 对齐：P0-03v2-02 是本域发现的跨功能 P0，应在 audit-04-pay-notify-v2 中连带处理（payNotify 全量重构必须覆盖遗留字段清除）。
- [ ] 与 域 11 (退款) 对齐：P1-03v2-07 approveRefund 储值卡回冲 bug 是退款流程本身的缺陷，建议在 audit-11-refunds 中跟踪。
- [ ] 回填脚本：对 `offline_confirmed_by IS NOT NULL AND payment_row_count=0` 的已支付订单，按 `sale_orders.received` / `prepaid_card_amount` 列重建 payments 行。
- [ ] 追加测试：
  1. admin.confirmOfflinePayment 写 payments + 扣储值卡（目前无覆盖）
  2. payNotify DROP 列引用（需配合 migration apply + 集成测试）
  3. confirmOffline 并发双首次支付（需 mock 并发）
  4. recordPayment 重复提交（应被幂等键拒绝）
  5. staffApi detail JOIN salePaymentDetails（migration 0018 apply 后回归）
