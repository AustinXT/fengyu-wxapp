# 审计报告：充值卡 + 卡流水 (14)

**审计时间**：2026-04-25 23:30
**域 ID**：14
**审计员**：claude-opus-4-7
**审计时长**：~25 分钟
**关联 PR/Ticket**：retain audit-03 P0-03-02（confirmOfflinePayment 不写 payments / 不扣卡）；retain audit-11 P0-11-01/04/06；MIGRATION 0003 schema drift

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/prepaid-card.ts:12-26` `prepaid_cards (cardId PK, userId FK→client_wechat_users, balance NUMERIC(10,2), uq_prepaid_cards_user(userId))` `db/schema/prepaid-card.ts:31-48` `card_transactions (id bigserial, cardId FK, type enum 充值/扣款, amount NUMERIC(10,2), refOrderId varchar(30) FK→sale_orders, idx_card_txns_card_id)` | ↑ | ↑ |
| 枚举 | `db/schema/enums.ts:89` `cardTransactionTypeEnum = ['充值','扣款']` | ↑ | ↑ |
| 列表 read | `actions/card-transactions.ts:94-192` `getCardTransactionsPaginated`（流水分页 + summary） + `actions/cards.ts:78-206` `getCardsPaginated`（**实际是 sale_items 疗程卡/单次卡**，非 prepaid_cards！） | `routes/customer.js:865-887` `customerBalance`（店长查顾客余额） + `routes/order.js:418` `SELECT balance` | `routes/card.js:60-78` `list`（用户余额）+ `:84-103` `balance`（同结果）+ `:108-140` `history`（近 6 月流水分页） |
| 充值入账（type='充值'） | `actions/orders.ts:55-108` `applyRechargeOnOrderPaid`（confirmOfflinePayment 链路，admin 端） + `:1416-1439` createConversionOrder 差额退余 | `routes/order.js:929-982` confirmOffline 链路 + `:2268-2292` createConversion 差额退余 + `:1560-1586` approveRefund 储值卡部分回冲 | `payNotify/index.js:234-293` 微信回调入账 + `routes/order.js:1057-1084` cancel 反向回冲（仅全额抵扣单） |
| 扣款（type='扣款'） | `actions/orders.ts:1637-1665` createRepayment（admin 端） | `routes/order.js:840-885` confirmOffline 主路径 + `:1807-1834` createRepayment 储值卡通道 | `routes/order.js:503-523` create 全额抵扣 + `:1416-1446` confirmPrepaidFull + `:1598-1664` 多次回款（continuePayment） |
| 创建充值订单 | （admin 无 UI，复用 client/staff 流程） | `routes/card.js:33-80` `rechargeSkus` + `:95-266` `recharge`（店长替开） | `routes/card.js:188-325` `recharge`（自助充值，含 mock 微信支付） |
| 配置 | — | `utils/recharge.js`（RECHARGE_TIERS / RECHARGE_VIRTUAL_SKU_ID） | `routes/_constants.js` + `routes/card.js:14-18` 内置 TIERS |
| 测试 | `actions/cards.test.ts` + `actions/card-transactions.test.ts` + `actions/orders.test.ts:540-577`（confirmOfflinePayment 仅覆盖 **非充值订单** branch） | `__tests__/routes/card.test.js` + `__tests__/routes/order.test.js:856-3970`（多个 prepaid_cards 测试） | `__tests__/routes/card.test.js`（含 mock） |

## 2. 数据流图

```
顾客自助充值 (clientApi):
  card.recharge(faceValue) → matchTier 算 payAmount → INSERT sale_orders(待支付) + sale_items(虚拟 SKU, product_name='预付充值卡 ¥X')
       → 返回 mock 支付参数
  payNotify(回调) → 状态 '已支付' → applyRecharge: 识别 sale_items pc.product_kind='充值卡'
       → UPSERT prepaid_cards(card_id, user_id, balance) ON CONFLICT(user_id) DO UPDATE
       → INSERT card_transactions(type='充值', amount=faceValue, ref_order_id=saleOrderId)

店长替顾客充值 (staffApi):
  card.recharge → 走 sale_orders('销售单', '待确认收款'/'待支付', sku=真实档位 OR 虚拟 SKU)
  线下 → order.confirmOffline → 与 payNotify 同段识别逻辑写 prepaid_cards + card_transactions
  微信 → payNotify 入账（同上）

管理后台确认线下收款 (admin):
  orders.confirmOfflinePayment → status='已支付' → applyRechargeOnOrderPaid
  ❌ 但 INSERT 引用已 DROP 的 store_id 列 → 运行时失败 → 整个事务回滚

消费扣卡:
  client.create (useCard, 全额抵扣 paid_amount=0) → FOR UPDATE prepaid_cards
       → UPDATE balance -= prepaidCardAmount + INSERT card_transactions(扣款)
       ⛔ 不写 sale_order_payments('储值卡抵扣') → invariant 破裂（audit-03 P0-03-02）
  client.confirmPrepaidFull → 同上 ⛔（同破裂）
  staff.confirmOffline → 完整：扣卡 + INSERT '储值卡抵扣' + INSERT '首次支付'
  payNotify → 微信全/部分支付 → 含 prepaid_card_amount > 0 时扣卡（不写 '储值卡抵扣' payments，但写 '首次支付'）
  admin.confirmOfflinePayment → 完全不识别 prepaid_card_amount → 既不扣卡也不写 payments

回退（type='充值' 反向）:
  staff.approveRefund → 按 floor(prepaid/total × refund) 拆分 → INSERT type='充值' 回冲（audit-11 P0-11-06: 比例漂移）
  client.cancel(全额抵扣已支付) → 反向 INSERT 充值流水（自检 hasDeducted）
```

## 3. 自身漏洞

### 3.1 P0（阻断 / 资损 / 越权）

#### **[P0-14-01]** admin `applyRechargeOnOrderPaid` / `createConversionOrder` 引用已 DROP 的 store_id 列（运行时硬失败）

- 文件：`fengyu-admin/src/actions/orders.ts:91-98`、`fengyu-admin/src/actions/orders.ts:1424-1430`
- 现象：两段 SQL 均执行
  ```sql
  INSERT INTO prepaid_cards (card_id, user_id, store_id, balance) VALUES (...)
  ON CONFLICT (user_id, store_id) DO UPDATE SET balance = ...
  ```
  `store_id` 列在 `db/migrations/0003_abandoned_aqueduct.sql:52` 已 `ALTER TABLE prepaid_cards DROP COLUMN store_id`，且唯一索引由 `uq_prepaid_cards_user_store` 改为 `uq_prepaid_cards_user(user_id)`（schema `db/schema/prepaid-card.ts:24` 确认）。
- 风险：admin `confirmOfflinePayment` 任何包含 `RECHARGE_VIRTUAL_SKU_ID` 行的订单（自定义金额充值）都会在事务里抛 `column "store_id" does not exist` → 整个事务回滚 → admin 无法替顾客确认充值订单（线下场景）。同样地，admin `createConversionOrder` 在差额 < 0（顾客退余到储值卡）时全部失败。运行时崩溃，业务流程阻断。
- 复现：1) 顾客在 client 端用虚拟 SKU 提交充值订单；2) admin 跳过支付直接 confirmOfflinePayment；3) PG 抛错 `42703 column "store_id" does not exist`；4) admin UI 报"确认收款失败，请稍后重试"（catch 块仅模糊提示）。
- 修复：(L7) 同步 admin SQL 与 schema：删除 `store_id` 列引用 + ON CONFLICT 改为 `(user_id)`。建议从 staff/payNotify 抄过来（已是单列 ON CONFLICT），保留 ref_order_id 幂等。同时 staff `routes/order.js:2275-2283` createConversion 的 INSERT 已是 `(card_id, user_id, balance)` + `ON CONFLICT (user_id)`，admin 只是没跟上。

#### **[P0-14-02]** card_transactions 缺 UNIQUE(ref_order_id, type) 约束（应用层去重 TOCTOU）

- 文件：`db/schema/prepaid-card.ts:31-48`、所有 INSERT 路径（payNotify:255、staff/order.js:847+946+1564、client/order.js:506+1037+1431+1659、admin/orders.ts:81）
- 现象：表仅有 `idx_card_txns_card_id`，**没有任何 UNIQUE 约束**。所有写入路径采用"先 SELECT 1 FROM card_transactions WHERE ref_order_id=$1 AND type=$2 LIMIT 1，如无则 INSERT"。在事务内（FOR UPDATE 或外层 status CAS 锁）多数路径有保护，但有几处不在同事务（admin `applyRechargeOnOrderPaid` 的 dup check `tx.execute(SELECT 1)` 在 tx 内是安全的；但 staff `routes/order.js:1810-1834` createRepayment 中的 dup check 实际**没有**——它直接 INSERT 不去重，依赖 `card_transactions.ref_order_id` 指向新生成的 FY-HKD 凭证单号天然唯一）。
- 风险：仅"应用层去重 + 事务内 FOR UPDATE 卡行"双重保护。一旦未来新增写入路径或事务边界变化（如某段被搬到事务外），无 DB-level 兜底，重复扣款将被静默写入。同时无法用 SQL 校验"一对 ref_order_id+type 全表唯一"做对账。
- 复现：1) 模拟两个并发事务 T1/T2 同时进入 `client.confirmPrepaidFull`，假设 SELECT FOR UPDATE 锁失效（如不同 user）但 ref_order_id 相同——不可能在同一订单发生。但如果跨 changeType（先 type='扣款' 再 type='充值'）则**确实**可写入两行——这是设计内的（cancel 回冲）。然而对 (ref_order_id, '扣款') 的重复写入应被 UNIQUE 阻挡。
- 修复：(L0) 加 `CREATE UNIQUE INDEX uq_card_tx_ref_type ON card_transactions(ref_order_id, type) WHERE ref_order_id IS NOT NULL`（partial unique，因 ref_order_id 可空）。

#### **[P0-14-03]** admin 端无 prepaid_cards 余额管理 UI（缺业务能力 + 财务无法校账）

- 文件：`fengyu-admin/src/app/(main)/cards/`（实为 sale_items 疗程卡，与本域无关）；admin 端**没有** `/prepaid-cards` 路由。
- 现象：管理后台仅在 `/card-transactions` 提供**只读**流水查询。无法：(a) 查看单个顾客余额详情；(b) 强制充值/扣款（异常处理场景）；(c) 作废卡或清零；(d) 余额对账（balance vs SUM(card_transactions.amount)）。
- 风险：财务遇到资损（如 P0-14-01 引发的事务失败导致流水写入但 balance 未变 / 反之）无任何修复入口；客户投诉只能开发直连 PG。`balance = SUM(card_transactions.amount)` 不变量无监控，与 audit-03/audit-11 退款链路漂移叠加，资损可能长期不被发现。
- 复现：业务侧报告"顾客 A 储值卡余额异常"→ 财务无法在 admin 查 → 必须 SSH 进 PG 跑查询。
- 修复：(L7+L9) admin 加 `/prepaid-cards` 列表页（用 `prepaidCards` 表 JOIN clientWechatUsers）+ 详情页（含余额、最近 N 笔流水、对账数）+ "强制调整余额"按钮（写 operation_logs + INSERT card_transactions(type='充值'/'扣款', ref_order_id=NULL)）。

#### **[P0-14-04]** balance 与流水的对账不变量无任何 SQL/cron 守护（隐性资损）

- 文件：`db/schema/prepaid-card.ts`（无约束 / 触发器）；admin `src/cron/steps/`（无对账 step）；staff/client routes（无对账动作）
- 现象：约束理论上 `prepaid_cards.balance` ≡ `COALESCE(SUM(card_transactions.amount), 0)`（按 cardId 聚合）。schema 未提供 trigger 强制此不变量；cron 未提供 audit step（对比 cron `STEP 5/audit-points-balance.ts` 已有积分余额校验，但**没有**充值卡余额校验）。
- 风险：任何代码 bug 导致 balance UPDATE 与 card_transactions INSERT 不一致（如 P0-14-01 admin 失败 / payNotify 中途异常 / 事务保存点回滚不彻底），都不会被自动发现。叠加多个修改路径（11 处 INSERT card_transactions、9 处 UPDATE balance），漂移风险显著。
- 复现：手工注入：UPDATE prepaid_cards SET balance = balance - 100 WHERE card_id = X，不写流水 → 永久沉默。
- 修复：(L0) 写一个 cron STEP 6（仿 STEP 5 积分校验）：`SELECT pc.card_id, pc.balance, COALESCE(SUM(ct.amount),0) AS expected, pc.balance - COALESCE(SUM(ct.amount),0) AS drift FROM prepaid_cards pc LEFT JOIN card_transactions ct USING(card_id) GROUP BY pc.card_id, pc.balance HAVING pc.balance != COALESCE(SUM(ct.amount),0)`，告警 ops。

#### **[P0-14-05]** 卡流水 `amount` 列无符号 CHECK 约束（数据完整性）

- 文件：`db/schema/prepaid-card.ts:40` `amount NUMERIC(10,2)`，无 CHECK
- 现象：注释说 "topup 为正，deduct 为负"，但无 `CHECK ((type = '充值' AND amount > 0) OR (type = '扣款' AND amount < 0))`。对比 `sale_order_payments.chk_sop_amount_sign` 有此 CHECK（audit-03 §1）。当前应用层是一致的（充值传正，扣款传 -prepaidAmount），但任意 bug 都可能写反。
- 风险：admin summary `case when amount > 0 then ... else 0 end` 按符号汇总；若有 type='扣款' AND amount > 0 的脏行，summary 会把它算入"充值"——金额漂移。
- 复现：注入脏行 → admin /card-transactions summary "总充值" 失真。
- 修复：(L0) 加 CHECK 约束 + 数据回填扫描。

### 3.2 P1（数据一致 / 状态错乱）

#### **[P1-14-06]** retain：admin confirmOfflinePayment 不识别 prepaid_card_amount（不扣卡 / 不写 '储值卡抵扣' payments）

- retained from `audit-03-payment-flow.md` P0-03-02
- 文件：`fengyu-admin/src/actions/orders.ts:426-487`
- 现象：admin 路径仅 `UPDATE saleOrders SET status='已支付'` + 单品到期日 + applyRechargeOnOrderPaid（处理充值入账），但**没有**针对 `sale_orders.prepaid_card_amount > 0` 的扣卡逻辑（无 SELECT prepaid_cards FOR UPDATE / 无 UPDATE balance / 无 INSERT card_transactions(扣款) / 无 INSERT sale_order_payments('储值卡抵扣')）。
- 风险：admin 替顾客确认线下收款时，**储值卡 balance 永不被扣**；同时违反"prepaid_card_amount = SUM payments(储值卡抵扣) WHERE status='已支付'"不变量。后续 staff approveRefund 按 prepaid/total 比例拆分会读到错误的快照。
- 修复：(L7) admin 路径补齐扣卡 + 写 payments（与 staff confirmOffline 同段对齐）。

#### **[P1-14-07]** retain：client.create 全额抵扣 / confirmPrepaidFull 漏写 '储值卡抵扣' payments 行

- retained from `audit-03-payment-flow.md` P0-03-02 (b/c)
- 文件：`fengyu-client/cloudfunctions/clientApi/routes/order.js:503-523`、`:1416-1446`
- 现象：扣卡 + INSERT card_transactions(扣款) 完整，但**未** INSERT sale_order_payments('储值卡抵扣')。staff confirmOffline (`:877-883`) 已正确写入。三端不一致。
- 风险：admin /orders 详情页"款项明细"展示 SUM(payments) 显示为空，但订单状态已支付——财务/客服看到"无任何收款流水但订单已支付"错觉。后续 approveRefund 拆分比例失真（audit-11 P0-11-06）。

#### **[P1-14-08]** confirmPrepaidFull 状态 UPDATE 缺 rowCount 校验（CAS 半破）

- 文件：`fengyu-client/cloudfunctions/clientApi/routes/order.js:1448-1456`
- 现象：
  ```sql
  UPDATE sale_orders SET status = '已支付', client_user_id = COALESCE(...), paid_at = NOW(), updated_at = NOW()
  WHERE sale_order_id = $2 AND status = '待支付'
  ```
  WHERE 含 `status='待支付'` CAS，但**未检 result.rowCount**。如果在事务内被并发改 status（理论上同事务+FOR UPDATE prepaid_cards 行级锁可阻止，但 sale_orders 行未锁），扣卡已落库但订单状态未变，最终静默成功返回 `status='已支付'` 假值。
- 风险：极小概率但语义破坏。同 audit-02 P0-02-04 模式。
- 修复：(L3) 加 `if (updateRes.rowCount === 0) throw new Error('INVALID_STATE: 订单状态已变更')`。

#### **[P1-14-09]** scanAdjust 写 sale_orders 不在事务 + 无 rowCount 检查

- 文件：`fengyu-client/cloudfunctions/clientApi/routes/order.js:1354-1363`
- 现象：单条 `pg.query(UPDATE sale_orders ... WHERE ... AND status='待支付')`，未在事务内，未检 rowCount，且改 prepaid_card_amount/paid_amount/payment_method 三个字段不持久原子。
- 风险：顾客扫码反复"调整"时与 staff confirmOffline / payNotify 抢同一订单，可能写入悬空状态。
- 修复：(L3) 包事务 + FOR UPDATE 该订单 + rowCount 校验。

#### **[P1-14-10]** client.recharge 无 sourceChannel / store 校验，仅看 `bound_store_id`

- 文件：`fengyu-client/cloudfunctions/clientApi/routes/card.js:188-325`
- 现象：充值订单 store_id 来自 `ctx.auth.boundStoreId`，但顾客若同时有员工开单订单 / 跨店消费场景，业绩归属可能与"实际办卡门店"不符。schema 注释说"卡余额跨店共享"，但订单仍按门店归属业绩。
- 修复：(L3) 业务确认 source_channel + 是否需要 promoter_employee_id 字段（与 sale_orders 其他路径对齐）。

#### **[P1-14-11]** client.recharge 用 mock 支付参数，且无任何"跳过支付直接入账"防御

- 文件：`fengyu-client/cloudfunctions/clientApi/routes/card.js:317-323`
- 现象：返回 `mockMode: true` 的 paySign='mock_sign'。配合 `audit-04` P0-04-01（payNotify 完全无签名校验），可绕过支付直接入账储值卡。
- 风险：与 audit-04 同根。任何外部攻击者构造 payNotify 回调即可凭空生成储值卡余额。
- 修复：(L3) 接入真实微信支付 + audit-04 修复签名校验。

#### **[P1-14-12]** card.history 仅 6 个月窗口，但分页 total 未返回（前端无法知道是否还有更多）

- 文件：`fengyu-client/cloudfunctions/clientApi/routes/card.js:108-140`
- 现象：返回 `{records: []}`，无 `total` / `hasMore`，前端只能"加载更多直到空"，体验差且每次多查询一次 LIMIT+1 也未实现。
- 修复：(L3) 加 COUNT(*) 或 LIMIT $pageSize+1 探测下一页。

### 3.3 P2（代码质量）

#### **[P2-14-13]** card_id 生成方式分裂（FY-CARD- vs gen_random_uuid）

- payNotify `index.js:272`、staff `routes/order.js:964`/`:1570`：`FY-CARD-{Date.now()}{rand 3 位}`（碰撞概率：同毫秒同 rand → 1/1000）
- staff `routes/order.js:2277`、admin `actions/orders.ts:92`/`:1424`：`gen_random_uuid()::text`
- admin `applyRechargeOnOrderPaid` 注释说"与 payNotify 的 FY-CARD- 前缀格式保持一致"但代码实际写 FY-CARD（`actions/orders.ts:87-89`）。conversion 又改用 uuid。
- 修复：统一为 `FY-CARD-` 或全部 uuid。

#### **[P2-14-14]** RECHARGE_TIERS 在 client 与 staff 各一份硬编码（耦合 + 单点漂移）

- client `routes/card.js:14-18`、staff `utils/recharge.js`（独立模块）
- TODO 注释承认要做 `recharge_tier_config` 表，未实现。
- 修复：抽到 `system_configs` 或独立表。

#### **[P2-14-15]** 错误前缀 `INSUFFICIENT_BALANCE:` 不在 4 项约定（UNAUTHORIZED/PHONE_REQUIRED/INVALID_PARAMS/PERMISSION_DENIED）

- 出现于 staff/order.js:858/862、client/order.js:389/1421/1426/1607、payNotify/index.js:311
- 与 CLAUDE.md 约定不符；前端判错需额外分支。
- 修复：（讨论后定义新前缀或归并到 INVALID_PARAMS）。

#### **[P2-14-16]** card_transactions 表无 UNIQUE 约束 + 无 created_at 索引（admin 流水分页 ORDER BY desc(createdAt) 全表扫）

- admin `card-transactions.ts:149` `.orderBy(desc(cardTransactions.createdAt))`，schema 仅 idx_card_txns_card_id。
- 修复：(L0) 加 `CREATE INDEX idx_card_tx_created ON card_transactions(created_at DESC)`。

#### **[P2-14-17]** balance 字段精度 NUMERIC(10,2)，max ≈ 99,999,999.99（足够）但显式 cast 不一致

- staff/order.js:2282 `creditAmount.toFixed(2)`、admin/orders.ts:93 `${faceValue.toFixed(2)}`、payNotify 直接传 number
- 三端混用 string vs number，依赖 PG 自动 cast。
- 修复：(L3) 统一传 string `${X.toFixed(2)}`。

## 4. 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| store_id 列引用 | 仍引用（已 DROP） | 已对齐（无 store_id） | 已对齐 | admin runtime 失败 | P0 |
| ON CONFLICT 列集 | `(user_id, store_id)` | `(user_id)` | `(user_id)` | admin runtime 失败 | P0 |
| 写 '储值卡抵扣' payments | confirmOfflinePayment 不写、createRepayment 写 | confirmOffline 写、createRepayment 写、approveRefund 不写 | confirmPrepaidFull 不写、create 全额抵扣不写、continuePayment 写 | invariant 破裂 | P0 |
| card_id 前缀 | FY-CARD-（applyRecharge） + uuid（conversion） | FY-CARD-（confirmOffline / approveRefund） + uuid（createConversion） | — | 命名混乱、追溯困难 | P2 |
| ref_order_id 幂等键 | (ref_order_id) | (ref_order_id, type='扣款') / (ref_order_id, type='充值') | (ref_order_id, type='扣款') / (ref_order_id, type='充值') | admin 缺 type 区分（cancel 回冲后重 confirm 会被误判已扣） | P1 |
| 余额 UPDATE CAS | 无 `WHERE balance >= $1` | 无（依赖 FOR UPDATE + 应用层校验） | 无 | 全部依赖 FOR UPDATE 串行化，单条 UPDATE 自身不防超卖 | P1（违反 real.md #1 等价物精神） |
| 充值入账触发 | confirmOfflinePayment | confirmOffline | payNotify | admin 路径会 runtime 失败（P0-14-01） | P0 |

**注**：`real.md` #1 "次数防超卖：原子操作（单条 UPDATE + 条件判断），禁止先读后写"严格读应包含余额扣减。当前实现"FOR UPDATE → 应用层校验 → UPDATE balance = balance - X"是常见模式，但**单条 UPDATE 没有 `AND balance >= $1` 守卫**——若 FOR UPDATE 行锁因 isolation level 失效（理论上 PG 默认 read committed 下 FOR UPDATE 是安全的），就会出现负余额。建议加 CAS 守卫作为"双重保险"。

## 5. 横切检查

- [x] **CC1 数值精度**：balance NUMERIC(10,2)、amount NUMERIC(10,2) — OK；toFixed(2) 与 number 混用 → P2-14-17。 *缺 CHECK amount sign* → P0-14-05。
- [x] **CC2 并发幂等**：FOR UPDATE 序列化 OK；但 card_transactions 缺 (ref_order_id, type) UNIQUE → P0-14-02；balance UPDATE 无 CAS → P1（上表）；scanAdjust 不在事务 → P1-14-09；confirmPrepaidFull 缺 rowCount → P1-14-08。
- [x] **CC3 组织域隔离**：prepaid_cards 跨店共享（schema 注释明确），admin /card-transactions scope 用 `client_wechat_users.bound_store_id` 近似（`actions/card-transactions.ts:47`）—— OK。client `card.list/balance/history` 按 `userId` 隔离 OK。staff `customer.customerBalance` 仅校验 requireManager 不限定该顾客所属门店 → 跨店店长可查任意顾客余额（与 audit-10 P0-10 类似）。
- [x] **CC4 后端鉴权**：staff `card.recharge` requireManager OK；client `card.list` 无 requirePhone（`card.js:60-78` 仅依赖 `ctx.auth.userId`，但 auth 中间件已经校验 openid → user）；`card.balance` 显式 requirePhone OK；`card.history` **未** requirePhone（只看 userId）。
- [x] **CC5 错误码**：`INSUFFICIENT_BALANCE:` 不在 4 项约定 → P2-14-15。
- [x] **CC6 PII**：流水含 ref_order_id（订单号）+ amount，无身份证/手机号；admin /card-transactions 详情含 customerPhone/Name 但不脱敏 → 与 customers 模块一致（不在本域纠正）。
- [x] **CC7 时间字段**：created_at DEFAULT NOW() OK；updated_at $onUpdate OK；card_transactions 无 updated_at（流水不可变）— OK。
- [x] **CC8 WXML/Vant**：N/A（本审计不涉及前端）
- [x] **CC9 测试与残留**：admin `cards.test.ts` 测的是 sale_items 疗程卡；admin `orders.test.ts` confirmOfflinePayment 测试**绕过**充值订单 branch（`:553` 注释明示）→ P0-14-01 没被任何测试覆盖。

## 6. 修复建议（按 L0→L9 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema | `db/schema/prepaid-card.ts` | (a) 加 `CHECK ((type='充值' AND amount > 0) OR (type='扣款' AND amount < 0))`；(b) 加 `CREATE UNIQUE INDEX uq_card_tx_ref_type ON card_transactions(ref_order_id, type) WHERE ref_order_id IS NOT NULL`；(c) 加 `CREATE INDEX idx_card_tx_created ON card_transactions(created_at DESC)` | P0-14-02、P0-14-05、P2-14-16 |
| L0 cron | `fengyu-admin/src/cron/steps/audit-prepaid-balance.ts`（新建，仿 audit-points-balance） | balance vs SUM(amount) 对账，告警 ops | P0-14-04 |
| L7 admin | `fengyu-admin/src/actions/orders.ts:91-98` `:1424-1430` | 删除 `store_id` 列引用、ON CONFLICT 改 `(user_id)` | P0-14-01 |
| L7 admin | `fengyu-admin/src/actions/orders.ts:426-487` `confirmOfflinePayment` | 补齐扣卡 + 写 payments（参考 staff confirmOffline `routes/order.js:840-885`） | P1-14-06 |
| L7 admin | `fengyu-admin/src/app/(main)/prepaid-cards/`（新建） + `actions/prepaid-cards.ts`（新建） | 余额管理 UI（列表/详情/强制调整） + operation_logs 写入 | P0-14-03 |
| L3 client | `fengyu-client/cloudfunctions/clientApi/routes/order.js:519-522`、`:1441-1445` | INSERT card_transactions 后追加 INSERT sale_order_payments('储值卡抵扣') | P1-14-07 |
| L3 client | `fengyu-client/cloudfunctions/clientApi/routes/order.js:1448-1456` | UPDATE 后检 rowCount，0 行抛 INVALID_STATE | P1-14-08 |
| L3 client | `fengyu-client/cloudfunctions/clientApi/routes/order.js:1354-1363` `scanAdjust` | 包事务 + FOR UPDATE 该订单 + rowCount 校验 | P1-14-09 |
| L3 client | `fengyu-client/cloudfunctions/clientApi/routes/card.js:108-140` `history` | 加 total 或 hasMore | P1-14-12 |
| L3 client | `fengyu-client/cloudfunctions/clientApi/routes/card.js:60` `list` | 加 requirePhone（与 balance 一致） | CC4 |
| L3 staff | `fengyu-staff/cloudfunctions/staffApi/routes/customer.js:865-887` `customerBalance` | 加跨店校验（参考 audit-10 P0-10） | CC3 |

## 7. 验证 SQL（在 5434 EXPLAIN，禁止写入）

```sql
-- (a) 验证 admin 端 SQL 在 5434 必失败（理论 EXPLAIN 已能报错）
EXPLAIN INSERT INTO prepaid_cards (card_id, user_id, store_id, balance)
VALUES ('FY-CARD-test', 'u-test', 's-test', '100.00');
-- 预期：ERROR: column "store_id" of relation "prepaid_cards" does not exist

-- (b) 检查全表 balance 对账漂移
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
                         THEN sop.amount::numeric ELSE 0 END), 0) AS expected
FROM sale_orders so
LEFT JOIN sale_order_payments sop ON sop.sale_order_id = so.sale_order_id
WHERE so.prepaid_card_amount > 0
GROUP BY so.sale_order_id, so.prepaid_card_amount
HAVING so.prepaid_card_amount::numeric !=
       COALESCE(SUM(CASE WHEN sop.status='已支付' AND sop.change_type='储值卡抵扣'
                         THEN sop.amount::numeric ELSE 0 END), 0)
LIMIT 50;

-- (e) 含 amount 符号异常（type=充值但 amount<=0 / type=扣款但 amount>=0）
SELECT id, type, amount, ref_order_id, created_at
FROM card_transactions
WHERE (type='充值' AND amount <= 0) OR (type='扣款' AND amount >= 0)
LIMIT 50;
```

## 8. 回归测试用例（建议）

1. **admin confirmOfflinePayment 触发充值**：插入一条含虚拟 SKU 的待确认收款订单（client_user_id 非空），调用 confirmOfflinePayment → 必须成功 + balance 增加 + card_transactions(type='充值') 1 行 + sale_order_payments('首次支付') 1 行。
2. **admin createConversionOrder priceDiff < 0**：构造转换单差额 -50，调用 → balance 增加 50 + card_transactions(type='充值', amount=50)。
3. **client.create 全额抵扣**：useCard=true + balance=100 + total=100，必须 status='已支付' + balance=0 + card_transactions(扣款,-100) + sale_order_payments(储值卡抵扣, 100)。
4. **client.cancel 已支付全额抵扣**：调用 cancel → status='已关闭' + balance 回冲 + card_transactions(充值, 100)。
5. **payNotify 充值入账幂等**：连续两次同 transactionId → 第二次不写 card_transactions/不增 balance。
6. **payNotify 储值卡扣款余额不足**：order.prepaid_card_amount=200, balance=100 → 整个事务回滚 + 订单仍 '待支付'。
7. **balance 对账 cron**：手工注入 prepaid_cards.balance=999，运行 audit-prepaid-balance step → 告警 ops。
8. **card.history 越权**：A 用户 cardId, B 用户 openid → 422 INVALID_PARAMS（已实现 ownership 校验）。

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB）：☑（含 schema 修改 + admin 缺 UI + cron）
- 涉及历史数据：☑（balance vs 流水对账可能已漂移）
- 修复成本：M（admin SQL fix S，admin 余额 UI L，cron audit S，schema CHECK/UNIQUE M）

## 10. 后续待办

- [ ] 与 audit-03/audit-04/audit-11 联动：储值卡 + 支付 + 退款的 `sale_order_payments` invariant 统一修复（建议作为一个独立 ticket "储值卡 payments 一致性总修"）
- [ ] 在生产 5434 跑 §7(b)(c)(d)(e) 4 个对账 SQL，记录当前漂移基数
- [ ] 决定 admin 是否上线 `/prepaid-cards` 余额管理（涉及业务流程）
- [ ] 评估 RECHARGE_TIERS 是否要建表（运营改档不发版）
