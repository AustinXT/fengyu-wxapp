# 审计报告：充值卡 + 卡流水 (14)

**审计时间**：2026-04-26 (重新审计，独立判断，以代码为准)
**域 ID**：14
**审计员**：claude-sonnet-4-6
**审计时长**：~30 分钟
**关联 PR/Ticket**：audit-03（储值卡抵扣 payments invariant）；audit-04（payNotify 签名 + 全锁守卫）；audit-11（退款充值卡回退）；notes/tickets/2026-04-26-sale-order-domain-refactor.md；notes/tickets/2026-04-26-recharge-card-as-sku-flag.md

---

> ### ✅ 2026-05-17 复核状态
>
> | 问题 ID | 原状态 | 2026-05-17 复核 |
> |---------|--------|-----------------|
> | **P0-14-01** admin applyRecharge/createConversion 引用已 DROP 的 `prepaid_cards.store_id` | 未修复 | ✅ **已修复** — `prepaid_cards.store_id` 已于 2026-04-24 DROP；orders.ts L43-105 重写为 user_id 唯一 UPSERT |
> | **E9 R2 充值卡 capability** | 待 R2 | ✅ **已完成** — commit ed3bf1f：`product_skus.is_recharge_card` SKU 表单 + 与 is_experience 互斥校验；payNotify 切 sale_items.is_recharge_card 行级快照 |
> | **D4 充值卡 SKU 严格独立** | 待 | ✅ **已完成** — `clientApi/routes/order.js:266-273` MIXED_RECHARGE_NOT_ALLOWED 应用层校验 + migration 0020 DB trigger 兜底 |
> | **充值卡积分结算** | 待 | ✅ **已完成** — commit 74f5b49 |
> | 其余 P0/P1 | — | 未复核 |

---

## 对比上轮（claude-opus-4-7，2026-04-25 23:30）

| P0-14-01 | admin applyRecharge/createConversionOrder 引用已 DROP store_id | **已修复** — 代码已改为 `(user_id)` ON CONFLICT，注释明确记录 |
| P0-14-02 | card_transactions 无 UNIQUE(ref_order_id, type)          | **仍开放** — schema 与所有迁移确认无此约束 |
| P0-14-03 | admin 无 prepaid_cards 余额管理 UI                         | **仍开放** — /cards 仍为 sale_items 疗程卡，无 /prepaid-cards 页 |
| P0-14-04 | 余额对账无 cron 守护                                        | **已修复** — cron STEP 8 auditPaymentInvariants I4 覆盖 |
| P0-14-05 | card_transactions.amount 无符号 CHECK 约束                  | **仍开放** — schema 确认无 CHECK |
| P1-14-06 | admin confirmOfflinePayment 不识别 prepaid_card_amount 扣卡 | **设计如此** — 注释明确：admin 开单+预选储值卡的扣卡由 staff confirmOffline 执行（admin 开单的订单状态为 '待确认收款'，由店长扫码确认时真正扣卡） |
| P1-14-07 | client.create 全额抵扣 / confirmPrepaidFull 漏写储值卡抵扣 payments | **已修复** — create:574 和 confirmPrepaidFull:1545 均已补写 |
| P1-14-08 | confirmPrepaidFull UPDATE 缺 rowCount 校验                 | **仍开放** — line 1570 UPDATE 未检 rowCount |
| P1-14-09 | scanAdjust 不在事务 + 无 rowCount                         | **仍开放** — line 1441-1450 确认 |
| P1-14-11 | client.recharge mock 支付 + payNotify 无签名校验            | **已缓解** — payNotify 已全锁（PAYNOTIFY_DISABLED=true），充值走线下渠道 |
| P1-14-12 | card.history 无 total/hasMore                             | **仍开放** — 返回 {records:[]} 无分页元数据 |
| P2-14-13 | card_id 生成方式分裂（FY-CARD- vs gen_random_uuid）          | **仍开放** — admin:91 FY-CARD-，admin:1612 gen_random_uuid |
| P2-14-14 | RECHARGE_TIERS 硬编码两份                                  | **仍开放** |
| P2-14-15 | INSUFFICIENT_BALANCE: 不在 4 项约定                         | **仍开放** |
| P2-14-16 | card_transactions 无 created_at 索引                       | **仍开放** |

### 新发现（本轮首次发现）

- **[P0-14-NEW-01]**: payNotify 3b 段（line 389-401）扣余额 + 写 card_transactions(扣款)，但**不写** `sale_order_payments(储值卡抵扣)`，且仍引用已 DROP 的 `paid_amount` 列（migration 0018 DROP）。当前 PAYNOTIFY_DISABLED=true 屏蔽，但拉卡拉对接解除屏蔽后即崩溃。

---

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/prepaid-card.ts:12-26` `prepaid_cards` (cardId PK, userId FK→client_wechat_users, balance NUMERIC(10,2), uq_prepaid_cards_user(userId)) | ↑ | ↑ |
| Schema | `db/schema/prepaid-card.ts:31-48` `card_transactions` (id bigserial PK, cardId FK, type enum 充值/扣款, amount NUMERIC(10,2), refOrderId varchar(30) FK→sale_orders, idx_card_txns_card_id) | ↑ | ↑ |
| 枚举 | `db/schema/enums.ts:97` `cardTransactionTypeEnum = ['充值','扣款']` | ↑ | ↑ |
| 充值卡列表读 | `actions/card-transactions.ts:94-192` `getCardTransactionsPaginated`（流水分页 + summary）+ `actions/cards.ts:78-206` `getCardsPaginated`（**sale_items 疗程卡**，非 prepaid_cards！） | `routes/customer.js:940-962` `customerBalance`（店长查顾客余额）+ `routes/order.js:871` FOR UPDATE balance | `routes/card.js:60-78` `list` + `:84-103` `balance` + `:108-140` `history` |
| 充值入账（type='充值'） | `actions/orders.ts:42-112` `applyRechargeOnOrderPaid`（confirmOfflinePayment 链路）+ `:1603-1626` createConversionOrder 差额退余 | `routes/order.js:962-1012` confirmOffline 识别段 + `:1590-1618` approveRefund 储值卡回冲 | `payNotify/index.js:320-367` 微信回调入账（**DISABLED**）+ `routes/order.js:1166` cancel 反向充值 |
| 扣款（type='扣款'） | `actions/orders.ts:1826-1852` recordPayment 储值卡通道 | `routes/order.js:858-909` confirmOffline 主路径 + `:1871-1892` createRepayment 储值卡通道 | `routes/order.js:552-580` create 全额抵扣 + `:1528-1547` confirmPrepaidFull + `:1696-1715` repay 储值卡通道 |
| 测试 | `actions/cards.test.ts`（sale_items 疗程卡，非 prepaid）+ `actions/card-transactions.test.ts` | `__tests__/routes/card.test.js` + `__tests__/routes/order.test.js`（多个 prepaid 测试） | `__tests__/routes/card.test.js` |

---

## 2. 数据流图

```
顾客自助充值 (clientApi) — 当前线下替代路径:
  staff.card.recharge(skuId/customAmount) → INSERT sale_orders('待确认收款') + sale_items(is_recharge_card=true)
  staff.order.confirmOffline → 识别 is_recharge_card=true 行 → UPSERT prepaid_cards(balance) ON CONFLICT(user_id)
                              → INSERT card_transactions(type='充值') + INSERT payments(首次支付)

管理后台确认线下收款 (admin):
  admin.orders.confirmOfflinePayment → status='已支付' → applyRechargeOnOrderPaid
  → UPSERT prepaid_cards(user_id, balance) ON CONFLICT(user_id)（store_id 已 DROP，✅ 已修复）
  → INSERT card_transactions(type='充值', ref_order_id)

消费扣卡 — 统一路径:
  client.order.create (useCard, 全额抵扣) → FOR UPDATE → UPDATE balance -= prepaid + INSERT card_transactions(扣款)
                                          → INSERT sale_order_payments('储值卡抵扣')（✅ 已补）
  client.confirmPrepaidFull              → FOR UPDATE → UPDATE balance += ... + INSERT card_txns(扣款)
                                          → INSERT payments('储值卡抵扣')（✅ 已补）
                                          → UPDATE sale_orders status='已支付' WHERE status='待支付'（⚠️ 无 rowCount 检查）
  staff.confirmOffline                   → FOR UPDATE → UPDATE balance + INSERT card_txns(扣款) + INSERT payments(储值卡抵扣)（✅ 完整）
  payNotify 3b（DISABLED）              → UPDATE balance + INSERT card_txns(扣款)（❌ 不写 payments；且引用已 DROP paid_amount）

回退（type='充值' 反向）:
  staff.approveRefund                    → INSERT type='充值' 回冲（比例拆分）
  client.cancel（全额抵扣已支付）         → INSERT type='充值' 回冲（hasDeducted 检查）
```

---

## 3. 自身漏洞

### 3.1 P0（阻断 / 资损 / 越权）

#### **[P0-14-01]** ~~admin applyRechargeOnOrderPaid / createConversionOrder 引用已 DROP store_id~~ — **已修复**

- 确认状态：`fengyu-admin/src/actions/orders.ts:90-102` 代码已为：
  ```sql
  INSERT INTO prepaid_cards (card_id, user_id, balance)
  VALUES ($1, $2, $3)
  ON CONFLICT (user_id) DO UPDATE SET balance = prepaid_cards.balance + EXCLUDED.balance, updated_at = NOW()
  ```
  注释明确：「store_id 列已于 2026-04-24 DROP」。
  `createConversionOrder:1610-1616` 同样已对齐（改用 `gen_random_uuid()::text` 为 card_id）。
- 评级：✅ 不再计分

#### **[P0-14-02]** card_transactions 缺 UNIQUE(ref_order_id, type) 约束（应用层去重 TOCTOU）

- 文件：`db/schema/prepaid-card.ts:31-48`；全量迁移 `db/migrations/0000_baseline.sql:440-614` 及后续均未添加
- 现象：表仅有 `idx_card_txns_card_id`（line 614），**无任何 UNIQUE 约束**。所有路径用"先 SELECT 1 WHERE ref_order_id=$1 [AND type=$2]，如无则 INSERT"的应用层去重。在事务 + FOR UPDATE 保护下通常安全，但：
  1. 无 DB 级兜底——未来新增写入路径或事务边界变化时，重复扣款被静默写入；
  2. 对账 SQL 无法用 `HAVING COUNT(*)>1` 验证全表唯一性（audit-11 P0 漂移场景）。
- 风险：duplicate 扣款行被静默写入，balance 正确但流水多行，造成对账 `SUM(amount)` 漂移，触发 cron I4 告警（已修复的 P0-14-04）但无法自动修复。
- 复现：暂无真实路径可触发（事务 + FOR UPDATE 基本防住），但单测无法覆盖此 DB 级约束缺失。
- 修复：(L0) 加 `CREATE UNIQUE INDEX uq_card_tx_ref_type ON card_transactions(ref_order_id, type) WHERE ref_order_id IS NOT NULL`

#### **[P0-14-03]** admin 端无 prepaid_cards 余额管理 UI（缺业务能力 + 财务无法校账）

- 文件：`fengyu-admin/src/app/(main)/cards/`（确认为 sale_items 疗程卡，非 prepaid_cards）；`fengyu-admin/src/app/(main)/card-transactions/`（只读流水查询，无余额 CRUD）
- 现象：管理后台缺乏：(a) 单个顾客余额详情页；(b) 异常场景强制调整余额入口；(c) 作废/清零入口；(d) 余额 vs 流水对账（虽然 cron I4 已有告警，但无修复入口）。
- 风险：业务遇到资损无修复入口；客诉只能 SSH 直连 PG；cron 发现 I4 漂移后无法通过 admin 修复。
- 修复：(L7+L9) admin 加 `/prepaid-cards` 列表页（JOIN clientWechatUsers）+ 详情页（余额、最近 N 笔流水、对账数）+ 「强制调整余额」按钮（写 operation_logs + INSERT card_transactions(type='充值'/'扣款', ref_order_id=NULL)）。

#### **[P0-14-NEW-01]** payNotify 3b 段扣款不写 sale_order_payments + 引用已 DROP paid_amount 列（拉卡拉对接解封后崩溃）

- 文件：`fengyu-client/cloudfunctions/payNotify/index.js:373-401`（3b 扣款段）、`:265-274`（UPDATE sale_orders）、`:128-149`（SELECT 字段）
- 现象：
  1. 3b 段（line 373-401）：`UPDATE prepaid_cards SET balance -= prepaidAmount` + `INSERT card_transactions(扣款)` **不写** `sale_order_payments(change_type='储值卡抵扣')`，违反 payments invariant（sale_orders.prepaid_card_amount 应有对应 SUM(payments 储值卡抵扣)）。
  2. line 265-274 的 `UPDATE sale_orders SET ... paid_amount = $2 ...`：`paid_amount` 列已在 migration 0018（`0018_black_madrox.sql:36`）DROP，解封后运行会报 `column "paid_amount" does not exist`。
  3. line 128 SELECT 也引用了 `paid_amount`——同样崩溃。
- 当前缓解：`PAYNOTIFY_DISABLED = true`（line 54）；所有 invocation 立即返回 403 + 写 operation_logs。
- 风险：当拉卡拉对接解除全锁守卫时，上述两个 bug 同时爆发：(a) runtime 崩溃（paid_amount 不存在）→ 整个事务回滚 → 订单永远停在 '待支付'；(b) 即使修复 paid_amount，仍遗漏 payments(储值卡抵扣) 写入。
- 复现：1) 注释 `PAYNOTIFY_DISABLED=true`；2) 触发 payNotify 调用；3) PG 报 `42703 column "paid_amount" does not exist`。
- 修复：(L3) 解封守卫前必须同步修复 payNotify：(a) 删除 `paid_amount` 列引用，改用 `received` 列（与 orders.ts sale-order-domain-refactor 对齐）；(b) 3b 段补写 `INSERT sale_order_payments('储值卡抵扣')`（参考 staff confirmOffline:896-901）。
- 依赖：此修复必须在 P0-04-01（签名校验）完成并验证后才能解封守卫。

#### **[P0-14-05]** card_transactions.amount 列无符号 CHECK 约束

- 文件：`db/schema/prepaid-card.ts:40` `amount numeric(10,2) NOT NULL`，无 CHECK
- 现象：注释说「topup 为正，deduct 为负」，但无 `CHECK ((type='充值' AND amount > 0) OR (type='扣款' AND amount < 0))`。对比 `sale_order_payments` 有 `chk_sop_amount_sign`（migration 0004）。
- 风险：admin 汇总 SQL（`card-transactions.ts:154`）按符号分组 `CASE WHEN amount > 0`——若有脏行（type='扣款' 但 amount > 0），summary 会把扣款算入充值；财务报表失真。
- 复现：注入脏行 `INSERT INTO card_transactions (card_id, type, amount) VALUES ('x', '扣款', 100)`（需手工绕过应用层）→ admin summary 充值增加 100，扣款无变化。
- 修复：(L0) 加 `ALTER TABLE card_transactions ADD CONSTRAINT chk_ct_amount_sign CHECK ((type='充值' AND amount > 0) OR (type='扣款' AND amount < 0))`；先用 §7(e) SQL 确认无脏数据。

---

### 3.2 P1（数据一致 / 状态错乱）

#### **[P1-14-06]** ~~admin confirmOfflinePayment 不识别 prepaid_card_amount~~ — **设计如此，不计分**

- 确认：`actions/orders.ts:1103-1105` 注释明确说明：「储值卡抵扣 prepaid_card_amount 仅写入 sale_orders 作为"预选"金额；扣卡余额 + 写 '储值卡抵扣' payments 行统一由 staff 端 confirmOffline 执行（admin 开单的订单由店长在小程序 confirmOffline 时扣卡）」。此为业务设计决策，不是 bug。

#### **[P1-14-07]** ~~client.create 全额抵扣 / confirmPrepaidFull 漏写储值卡抵扣 payments~~ — **已修复**

- 确认：`routes/order.js:572-579`（create 全额抵扣段）已写 `INSERT INTO sale_order_payments(...'储值卡抵扣'...)`；`routes/order.js:1541-1547`（confirmPrepaidFull）也已补写。

#### **[P1-14-08]** confirmPrepaidFull UPDATE sale_orders 缺 rowCount 校验（CAS 半破）

- 文件：`fengyu-client/cloudfunctions/clientApi/routes/order.js:1550-1572`
- 现象：
  ```javascript
  await client.query(
    `UPDATE sale_orders ... SET status = '已支付' ... WHERE so.sale_order_id = $2 AND so.status = '待支付'`,
    [userId, saleOrderId]
  )
  ```
  WHERE 含 `status='待支付'` 的 CAS 守卫，但**无 `result.rowCount === 0` 检查**。若并发修改已将 status 改为其他值，UPDATE 返回 rowCount=0 但函数继续执行 `settlePointsSafe` 并返回 `status='已支付'`（ctx.result，line 1580），伪装成成功。此时扣卡已落库但订单状态未变。
- 风险：极小概率，但状态机语义破坏（扣卡已发生但订单仍非 '已支付'）。
- 修复：(L3) `const upRes = await client.query(...)` 后加 `if (upRes.rowCount !== 1) throw new Error('INVALID_STATE: 订单状态已变更，请刷新')` （因为是 FOR UPDATE + 同事务，实际并发风险很低，但应覆盖所有 CAS 路径）。

#### **[P1-14-09]** scanAdjust 不在事务 + UPDATE 无 rowCount 检查

- 文件：`fengyu-client/cloudfunctions/clientApi/routes/order.js:1440-1450`
- 现象：`pg.query(UPDATE sale_orders ... WHERE sale_order_id=$6 AND status='待支付')` 直接裸查，不在事务内，不检 rowCount。若并发 staff confirmOffline / payNotify（当守卫解除后）抢同一订单，可能出现：scanAdjust 写入 prepaid_card_amount、paymentMethod 后，另一事务已将订单扣卡并置 '已支付'，但 scanAdjust 返回 `status='待支付'`（不会感知到冲突）。
- 风险：P1 — 状态错乱风险较低（orderStatus 不变），但 prepaid_card_amount 可能被覆盖为错误值，导致后续 confirmPrepaidFull / payNotify 用错金额扣卡。
- 修复：(L3) 包事务 + `FOR UPDATE` 锁订单行 + UPDATE 后检 rowCount。

#### **[P1-14-10]** client.card.history 无 total/hasMore（前端分页体验差）

- 文件：`fengyu-client/cloudfunctions/clientApi/routes/card.js:108-140`
- 现象：返回 `{records: []}` 无 `total` / `hasMore`，前端无法判断是否还有下一页，需靠"空结果"才能停止加载。
- 修复：(L3) 加 COUNT(*) 或 LIMIT $pageSize+1 探测法。

#### **[P1-14-11]** client.card.list 无 requirePhone（与 balance 接口不一致）

- 文件：`fengyu-client/cloudfunctions/clientApi/routes/card.js:60-78`
- 现象：`list` 仅依赖 auth 中间件的 openid→userId 查找，不调用 `requirePhone`；但同文件 `balance`（line 85）和 `recharge`（line 190）均有 `requirePhone`。
- 风险：未绑定手机号的游客仍可调 card.list（因为 userId 存在于 auth 上下文），虽然 prepaid_cards 中不会有数据，但权限语义不一致。
- 修复：(L3) 在 `list` 开头加 `await requirePhone()(ctx, async () => {})`。

#### **[P1-14-12]** staff customerBalance 无跨店限制（店长可查任意门店顾客余额）

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:940-962`
- 现象：`requireManager()` 校验（line 941）后，直接用 `customerUserId` 查 prepaid_cards，无 `bound_store_id` 或 scope 过滤。多店店长或恶意 manager 可输入任意顾客 userId 查其余额。
- 说明：`prepaid_cards` 跨店共享，schema 注释也说「卡余额跨店共享」。但查询顾客余额的权限应限定在「该顾客绑定门店属于本 manager 的 scope」。
- 风险：数据泄露（低风险，仅暴露余额数字，非 PII）；但违反 real.md #6 组织域隔离原则。
- 修复：(L3) 加校验：先查 `client_wechat_users WHERE user_id=$1 AND bound_store_id = ANY($scopeStoreIds)`，不在 scope 内抛 `PERMISSION_DENIED:`。

---

### 3.3 P2（代码质量）

#### **[P2-14-13]** card_id 生成方式分裂（FY-CARD- 前缀 vs gen_random_uuid）

- `admin/orders.ts:91` (`applyRechargeOnOrderPaid`)：`FY-CARD-${Date.now()}${rand3位}` — 碰撞概率 1/1000（同毫秒同 rand）
- `admin/orders.ts:1612` (`createConversionOrder`)：`gen_random_uuid()::text`
- `staff/routes/order.js:996,1601`：`FY-CARD-${Date.now()}...`
- `payNotify/index.js:347`（DISABLED）：`FY-CARD-${Date.now()}...`
- 评：card_id 仅作 PK，不对外暴露，碰撞风险低（ON CONFLICT(user_id) 保证余额正确）。但不一致影响可追溯性。
- 修复：统一用 `gen_random_uuid()::text` 或 `FY-CARD-${ulid()}`。

#### **[P2-14-14]** RECHARGE_TIERS 两端各一份硬编码

- `client/routes/card.js:14-18`（硬编码 3 档）
- `staff/utils/recharge.js`（独立 utils 模块，TODO 注释已承认需后续 DB 化）
- 修复：运营改档需双端同步发版；建议迁移到 `system_configs` 表或 `recharge_tier_config` 表。

#### **[P2-14-15]** INSUFFICIENT_BALANCE: 前缀不在 4 项约定

- 出现位置：`staff/order.js:875,879`，`client/order.js:389,1418,1514,1519`，`payNotify:386`
- CLAUDE.md 约定 4 项：`UNAUTHORIZED:` / `PHONE_REQUIRED:` / `INVALID_PARAMS:` / `PERMISSION_DENIED:`
- 修复：讨论后统一归并到 `INVALID_PARAMS:` 或正式新增 `INSUFFICIENT_BALANCE:` 为第 5 项约定。

#### **[P2-14-16]** card_transactions 无 created_at 倒序索引

- `card-transactions.ts:149` `.orderBy(desc(cardTransactions.createdAt))`，schema 仅 `idx_card_txns_card_id`。
- 修复：(L0) `CREATE INDEX idx_card_tx_created ON card_transactions(created_at DESC)`。

#### **[P2-14-17]** payNotify 中 faceValue 直接传 number 而非 string

- `payNotify/index.js:354,360`：直接传 `faceValue`（Number 类型），依赖 PG 自动 cast 到 NUMERIC。
- 其他路径：`admin/orders.ts:109` `faceValue.toFixed(2)`；`staff/order.js:2282` `creditAmount.toFixed(2)`。
- 修复：统一传 `faceValue.toFixed(2)` 字符串。

---

## 4. 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| `applyRecharge` 幂等键 | `ref_order_id` LIMIT 1（跨 type） | `ref_order_id + type='充值'` LIMIT 1 | — | admin 少了 type 区分：cancel 后再充值理论会被误判"已充"；实际 cancel 后订单关闭，ref_order_id 不复用，低风险 | P2 |
| 扣款写 payments('储值卡抵扣') | recordPayment ✅ | confirmOffline ✅ | create ✅ / confirmPrepaidFull ✅ / repay ✅ | payNotify 3b（DISABLED）❌ | P0 (P0-14-NEW-01) |
| `balance` UPDATE CAS | `balance -= X WHERE card_id=$Y`（无 `AND balance >= X` 守卫） | `balance -= X WHERE card_id=$Y`（同，但 FOR UPDATE 先检余额） | 同上 | 全部依赖 FOR UPDATE 串行化，单条 UPDATE 无 CAS 守卫 | P1（real.md #1 等价物精神） |
| card_id 生成 | FY-CARD-（applyRecharge） + uuid（conversion） | FY-CARD-（confirmOffline）| N/A | 命名混乱 | P2 |
| payNotify `paid_amount` 引用 | N/A | N/A | `payNotify/index.js:128,149,269`（已 DROP） | 解封后 runtime 崩溃 | P0（P0-14-NEW-01） |

---

## 5. 横切检查

- [x] **CC1 数值精度**：balance NUMERIC(10,2)、amount NUMERIC(10,2) — OK。toFixed(2) 与 number 混用 → P2-14-17。缺 CHECK amount sign → P0-14-05。
- [x] **CC2 并发幂等**：FOR UPDATE 序列化 OK；card_transactions 缺 (ref_order_id, type) UNIQUE → P0-14-02；balance UPDATE 无 CAS → P1（跨端不一致表）；scanAdjust 不在事务 → P1-14-09；confirmPrepaidFull 缺 rowCount → P1-14-08。
- [x] **CC3 组织域隔离**：prepaid_cards 跨店共享（设计如此）；admin /card-transactions scope 用 `client_wechat_users.bound_store_id` 近似 OK。staff `customerBalance` 无 scope 过滤 → P1-14-12。
- [x] **CC4 后端鉴权**：staff `card.recharge` requireManager ✅；client `card.balance` requirePhone ✅；client `card.history` 无 requirePhone（仅看 userId，但 ownership 校验 line 116-119 防越权）；client `card.list` 无 requirePhone → P1-14-11；payNotify DISABLED 守卫 ✅。
- [x] **CC5 错误码**：`INSUFFICIENT_BALANCE:` 不在 4 项约定 → P2-14-15。
- [x] **CC6 PII**：流水含 ref_order_id + amount，无身份证/手机号；admin /card-transactions 展示 customerPhone（raw，未脱敏）—— 与 customers 模块一致，不在本域纠正。
- [x] **CC7 时间字段**：created_at DEFAULT NOW() ✅；updated_at $onUpdate ✅；card_transactions 无 updated_at（流水不可变）— OK。payNotify `paid_at` 字段引用同列（`CASE WHEN $1::text = '已支付' THEN $3 ELSE paid_at END`）— OK（与 received 解耦）。
- [x] **CC8 WXML/Vant**：本次审计以云函数代码为主；前端充值卡余额展示逻辑不在审计范围，无新发现。
- [x] **CC9 测试与残留**：admin `cards.test.ts` 测的是 sale_items（疗程卡），与 prepaid_cards 无关；admin `orders.test.ts` confirmOfflinePayment 是否覆盖充值分支——需单独确认；payNotify 中 `paid_amount` 残留引用（已 DROP 列）→ P0-14-NEW-01。

---

## 6. 修复建议（按 L0→L9 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema | `db/schema/prepaid-card.ts` | (a) 加 `CHECK ((type='充值' AND amount > 0) OR (type='扣款' AND amount < 0))`；(b) 加 `UNIQUE INDEX uq_card_tx_ref_type ON card_transactions(ref_order_id, type) WHERE ref_order_id IS NOT NULL`；(c) 加 `INDEX idx_card_tx_created ON card_transactions(created_at DESC)` | P0-14-02、P0-14-05、P2-14-16 |
| L3 payNotify | `fengyu-client/cloudfunctions/payNotify/index.js:128,149,265-274,373-401` | 删除 `paid_amount` 列引用（SELECT + UPDATE），改用 `received` 列口径；3b 段补写 `INSERT sale_order_payments('储值卡抵扣')` | P0-14-NEW-01 |
| L3 client | `fengyu-client/cloudfunctions/clientApi/routes/order.js:1572` | UPDATE 后加 `if (upRes.rowCount !== 1) throw new Error('INVALID_STATE: ...')` | P1-14-08 |
| L3 client | `fengyu-client/cloudfunctions/clientApi/routes/order.js:1440-1450` `scanAdjust` | 包事务 + `FOR UPDATE` 锁订单 + UPDATE 后检 rowCount | P1-14-09 |
| L3 client | `fengyu-client/cloudfunctions/clientApi/routes/card.js:108-140` `history` | 加 COUNT(*) 或 LIMIT $pageSize+1 探测，返回 total/hasMore | P1-14-10 |
| L3 client | `fengyu-client/cloudfunctions/clientApi/routes/card.js:60` `list` | 开头加 `requirePhone()` | P1-14-11（CC4） |
| L3 staff | `fengyu-staff/cloudfunctions/staffApi/routes/customer.js:948` `customerBalance` | 补 scope 过滤：先查 `client_wechat_users WHERE user_id=$1 AND bound_store_id = ANY($scopeStoreIds)`，不在 scope 抛 `PERMISSION_DENIED:` | P1-14-12（CC3） |
| L7 admin | `fengyu-admin/src/app/(main)/prepaid-cards/`（新建）+ `actions/prepaid-cards.ts`（新建） | 余额管理 UI（列表/详情/强制调整）+ operation_logs 写入 | P0-14-03 |

---

## 7. 验证 SQL（在 5434 EXPLAIN，禁止写入）

```sql
-- (a) 验证 card_transactions 无 UNIQUE 约束（应返回空，代表无约束）
SELECT indexname, indexdef FROM pg_indexes
WHERE tablename = 'card_transactions' AND indexdef LIKE '%UNIQUE%';
-- 期望：空（仅有 idx_card_txns_card_id，非 UNIQUE）

-- (b) 全表 balance 对账漂移（cron I4 的同款 SQL）
SELECT pc.card_id, pc.user_id, pc.balance::numeric AS recorded,
       COALESCE(SUM(ct.amount)::numeric, 0) AS expected,
       (pc.balance::numeric - COALESCE(SUM(ct.amount)::numeric, 0)) AS drift
FROM prepaid_cards pc
LEFT JOIN card_transactions ct ON ct.card_id = pc.card_id
GROUP BY pc.card_id, pc.user_id, pc.balance
HAVING pc.balance::numeric != COALESCE(SUM(ct.amount)::numeric, 0)
ORDER BY ABS(pc.balance::numeric - COALESCE(SUM(ct.amount)::numeric, 0)) DESC
LIMIT 50;

-- (c) 重复扣款检测（应为空）
SELECT ref_order_id, type, COUNT(*) cnt
FROM card_transactions
WHERE ref_order_id IS NOT NULL
GROUP BY ref_order_id, type
HAVING COUNT(*) > 1;

-- (d) prepaid_card_amount vs SUM(payments 储值卡抵扣) 漂移检测
SELECT so.sale_order_id, so.prepaid_card_amount::numeric AS recorded,
       COALESCE(SUM(CASE WHEN sop.status='已支付' AND sop.change_type='储值卡抵扣'
                         THEN sop.amount::numeric ELSE 0 END), 0) AS expected_sum
FROM sale_orders so
LEFT JOIN sale_order_payments sop ON sop.sale_order_id = so.sale_order_id
WHERE so.prepaid_card_amount > 0
  AND so.status IN ('已支付', '已完成')
GROUP BY so.sale_order_id, so.prepaid_card_amount
HAVING so.prepaid_card_amount::numeric !=
       COALESCE(SUM(CASE WHEN sop.status='已支付' AND sop.change_type='储值卡抵扣'
                         THEN sop.amount::numeric ELSE 0 END), 0)
LIMIT 50;

-- (e) amount 符号异常（脏数据检测，应为空）
SELECT id, type, amount, ref_order_id, created_at
FROM card_transactions
WHERE (type='充值' AND amount <= 0) OR (type='扣款' AND amount >= 0)
LIMIT 50;

-- (f) 验证 payNotify 中 paid_amount 列已 DROP（应报 42703 错误）
EXPLAIN SELECT paid_amount FROM sale_orders LIMIT 1;
-- 预期：ERROR:  column "paid_amount" does not exist
```

---

## 8. 回归测试用例（建议）

1. **admin confirmOfflinePayment 充值入账**：含 is_recharge_card=true 明细的 '待确认收款' 订单，调用 → balance 增加 + card_transactions(充值) 1 行。
2. **admin createConversionOrder priceDiff < 0**：差额 -50 → balance 增加 50 + card_transactions(充值, 50)（card_id 为 uuid）。
3. **admin recordPayment 储值卡通道**：prepaidCardAmount=100，balance=200 → balance=100 + card_transactions(扣款,-100) + payments(储值卡抵扣,100)。
4. **client.create 全额抵扣**：useCard=true + balance=100 + total=100 → status='已支付' + balance=0 + card_txns(扣款,-100) + payments(储值卡抵扣,100)。
5. **client.confirmPrepaidFull**：payable=0 + prepaid=100 + balance=200 → status='已支付' + balance=100 + card_txns(扣款,-100) + payments(储值卡抵扣,100)。
6. **client.cancel 已支付全额抵扣**：cancel → status='已关闭' + balance 回冲 + card_txns(充值,100)。
7. **payNotify 充值入账幂等**：连续两次同 transactionId（在解封后）→ 第二次 ON CONFLICT DO NOTHING，不重复充值。
8. **payNotify paid_amount 列检测**：在 5434 执行 `EXPLAIN SELECT paid_amount FROM sale_orders LIMIT 1` → 应报 42703，确认列已 DROP（辅助确认 P0-14-NEW-01 修复必要性）。
9. **staff customerBalance 越权**：用 staffLevel='store_manager' + scopeStoreId=['store-A'] 查 bound_store_id='store-B' 的顾客 → 应返回 PERMISSION_DENIED。

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB）：☑（schema 修改 + payNotify 修复 + admin 新 UI + cron 已有）
- 涉及历史数据：☑（balance vs 流水对账可能已漂移；§7(b)(c)(d)(e) 须先跑）
- 修复成本：
  - P0-14-02（UNIQUE 约束）：S
  - P0-14-03（admin UI）：L
  - P0-14-NEW-01（payNotify paid_amount + payments 补写）：M（需在解封守卫前完成）
  - P0-14-05（amount CHECK）：S（需先 §7(e) 确认无脏数据）
  - P1 项目合计：M

---

## 10. 后续待办

- [ ] 运行 §7(b)(c)(d)(e) 对账 SQL，记录当前漂移基数（**解封 payNotify 守卫前必做**）
- [ ] 修复 payNotify `paid_amount` 列引用 + 3b 段补写 payments（**优先级最高，是解封守卫的前置条件之一**）
- [ ] 评估 P0-14-03 admin `/prepaid-cards` UI 紧迫性（业务是否有余额异常处理需求）
- [ ] L0 schema 变更（UNIQUE + CHECK + index）打包为一个 migration
- [ ] 与 audit-03/audit-04/audit-11 联动：形成「储值卡 payments invariant 总修」ticket
- [ ] 决定 RECHARGE_TIERS 是否 DB 化（P2-14-14，运营自助改档需求）
- [ ] 确认 INSUFFICIENT_BALANCE: 是否正式纳入错误前缀第 5 项，统一约定文档
