# Ticket: 储值卡按门店抵扣消费（像现金一样花）

> 生成日期：2026-04-23
> 严重级别：P1（产品增量 / 新增抵扣通道）
> 端：fengyu-client（顾客端）+ fengyu-staff（员工端）+ fengyu-admin（可选增量）
> 影响面：DB（1 处 schema 变更，**不扩枚举**） + clientApi / staffApi / payNotify 全链路 + 下单页 UI + 结算弹层 UI + admin 订单详情显示
> 前置：`2026-04-16-client-prepaid-card-recharge`（充值通路）已完成；`p1-sale-items-store-binding`（sale_items.store_id）已完成
>
> **一句话目标**：顾客在 A 店充值的储值卡只能在 A 店消费；储值卡是"**抵扣项**"（与优惠券同类），不是"支付方式"；余额不够时，剩余金额仍按 `['微信', '支付宝', '线下']` 中的一种走正常支付通道。

---

## 0 一句话背景

现在储值卡只能充值、能查余额流水，**但不能用来付款**。顾客/员工普遍理解"充了值就要能当钱花"，否则充值功能形同虚设。本 ticket 把储值卡接入下单结算侧：

- **定位为"抵扣项"**：UI 和数据模型都把储值卡放在"抵扣区"（和优惠券并列），**不**与"微信 / 支付宝 / 线下"并列。支付方式枚举保持不变。
- **门店隔离**：A 店的卡不能用于 B 店消费（schema 已约束，代码侧强制对齐）
- **全链路闭环**：下单 → 抵扣 → 支付 → 扣款流水；退款/关闭/转换单差额 → 回冲 → 充值流水
- 典型场景：订单 ¥300 / 本店余额 ¥100 → 储值卡抵 ¥100 + 微信支付 ¥200

---

## 1 问题定位

### 1.1 现状盘点（基于 2026-04-23 代码扫描）

| 位置 | 现状 | 能力缺口 |
|---|---|---|
| `db/schema/prepaid-card.ts:14-35` | `store_id NOT NULL` + `UNIQUE(user_id, store_id)` | ✅ schema 已就绪 |
| `db/schema/enums.ts:48` | `cardTransactionTypeEnum = ['充值', '扣款']` | ✅ `'扣款'` 枚举存在但从未被写入（全仓 grep 0 处） |
| `db/schema/enums.ts:23` | `paymentMethodEnum = ['微信', '支付宝', '线下']` | ❌ 无"储值卡"，也无"复合支付"表达能力 |
| `db/schema/order.ts:57` | `payment_method` NOT NULL，单值 | ❌ 无法表达"部分储值卡 + 部分微信" |
| `clientApi/routes/order.js:create/pay/offlinePay` | 支付金额 = `total_amount`，不读 prepaid_cards | ❌ 无抵扣入口 |
| `staffApi/routes/order.js:create/confirmOffline` | 同上 | ❌ 无抵扣入口 |
| `payNotify/index.js:100+` | 仅处理"充值单"入账 prepaid_cards；不处理"消费扣款"路径 | ❌ 消费侧未实现 |
| `staffApi/order.js:createRefund/rejectRefund` | 退款流程不检查 `card_transactions(type='扣款')` | ❌ 退款时不回冲储值卡 |
| `staffApi/order.js:1617+`（转换单） | 已实现"负差额充入储值卡"（UPSERT + type='充值'） | ⚠️ 正差额（补款）**没用**储值卡分摊，需要改 |

### 1.2 DB schema 选型决策

**核心约束**（用户明确指示）：
- **储值卡是"抵扣项"，不是"支付方式"**。`payment_method` 枚举**保持不变**，始终只在 `['微信', '支付宝', '线下']` 三个值里选。不新增 `'储值卡'`。
- **储值卡抵扣额不计入实付金额**。实付金额 = 走支付通道（微信/支付宝/线下）的钱 = `total_amount - prepaid_card_amount`。

**方案**：`sale_orders` 新增两个字段，不扩任何枚举：

| 字段 | 类型 | 含义 |
|---|---|---|
| `prepaid_card_amount` | `numeric(10,2) NOT NULL DEFAULT 0` | 本单由储值卡承担的金额（抵扣额，**不算实付**） |
| `paid_amount` | `numeric(10,2) NOT NULL DEFAULT 0` | 本单通过 `payment_method` 指定通道实际收到的钱（**实付**） |

**不变量**（CHECK 约束 + 应用层双校验）：
```
prepaid_card_amount >= 0
paid_amount         >= 0
prepaid_card_amount + paid_amount = total_amount
payment_method ∈ {'微信', '支付宝', '线下'}    ← 枚举不扩
```

**字段语义澄清**：
- `total_amount`：**订单应付总额**（原价 - 优惠券折扣），含义不变，**历史数据不动**
- `prepaid_card_amount`：储值卡抵扣的部分
- `paid_amount`：实付金额（历史订单回填 = `total_amount`，与现在报表口径一致；新订单 = `total_amount - prepaid_card_amount`）
- `payment_method`：**实付金额**走的通道；当 `paid_amount = 0`（全额储值卡抵扣）时，仍需填一个合法值作为"名义通道"（取用户在 UI 上点选的按钮文案），但数据库语义上此字段对资金流无实际影响

> **为什么要新加 `paid_amount` 而不是复用 `total_amount`**：
> - 若让 `total_amount` 直接扣掉储值卡，等于改动现有字段含义，所有存量报表/中间层 SQL 都可能静默漂移（GMV 一夜之间变少）
> - 加一列 `paid_amount` 是向前兼容的：老报表继续用 `SUM(total_amount)` 得"订单总销售额"（含储值卡核销），新报表/对账用 `SUM(paid_amount)` 得"通过支付通道的实际收入"
> - 财务对账天然清晰："微信通道应到账 = Σpaid_amount WHERE payment_method='微信'"

**最终 migration 内容**：
- `ALTER TABLE sale_orders ADD COLUMN prepaid_card_amount numeric(10,2) NOT NULL DEFAULT 0`
- `ALTER TABLE sale_orders ADD COLUMN paid_amount numeric(10,2) NOT NULL DEFAULT 0`（迁移后一次性 `UPDATE sale_orders SET paid_amount = total_amount WHERE paid_amount = 0` 回填历史值，使老订单口径 = `total_amount`）
- CHECK：`chk_prepaid_paid_sum`：`prepaid_card_amount + paid_amount = total_amount`
- CHECK：`chk_prepaid_card_nonneg`：`prepaid_card_amount >= 0`
- CHECK：`chk_paid_nonneg`：`paid_amount >= 0`

### 1.3 门店隔离的语义

schema 注释已经明确（prepaid-card.ts:12）：
> 消费时云函数必须校验卡的 store_id 与当前消费门店一致，否则拒绝。

本 ticket 把这句话落到代码层：每次抵扣前 `SELECT balance FROM prepaid_cards WHERE user_id=$1 AND store_id=$2 FOR UPDATE`，查不到 → 该店无卡（balance=0）；查到但 balance 不足 → 拒绝或部分扣（看前端勾选策略）。

---

## 2 设计决策

### 2.1 顾客端下单页结构（明确分层：抵扣区 ≠ 支付方式区）

下单页把金额构成显式分为 3 段："订单总额 → 抵扣 → 实付"，与现金流实际走向对齐：

```
┌──────────────────────────────────────┐
│  订单明细                             │
│  某护理项目 × 1          ¥300.00     │
├──────────────────────────────────────┤
│  订单总额                ¥300.00     │
├──────────────────────────────────────┤
│  抵扣                                 │
│   优惠券 新客 -¥30  [ 更换 > ]       │
│   储值卡（本店余额 ¥320.50）         │
│     使用储值卡   [ 开关 ● ]          │
│     抵扣 ¥270.00（不计入实付）        │
├──────────────────────────────────────┤
│  实付金额                ¥0.00       │
│  支付方式：⊙微信 ○支付宝 ○线下       │
└──────────────────────────────────────┘
           [ 提交订单 ]
```

**布局约束（重点）**：
- 储值卡区块**位于"抵扣"段内**，与优惠券并列；**严禁**把储值卡塞进"支付方式"按钮组
- 支付方式按钮组**始终只展示** `微信 / 支付宝 / 线下` 三选一；语义是"**实付金额**走哪个通道"
- 订单明细下方明示三行金额："订单总额 / 抵扣小计 / 实付金额"，让顾客一眼看清"储值卡抵的 ¥A 不是我现在要掏出的钱"

**交互规则**：
1. **本店余额 = 0**：储值卡子区块显示"本店暂无储值卡余额"，开关灰显不可点
2. **本店余额 ≥ `订单总额 - 优惠券`（即应抵扣部分）**：默认开关开，抵扣额 = 应抵扣部分，**实付 = 0**；此时支付方式按钮组保留，默认选中"微信"作为名义通道，提交时传给后端但不走真实通道
3. **本店余额 < 应抵扣部分**：默认开关开，抵扣额 = 本店余额，实付 = 应抵扣部分 - 余额；用户在支付方式选微信/支付宝/线下
4. 用户可手动**关闭**储值卡开关 → `prepaid_card_amount=0`，走原现金流
5. **"抵扣 ¥270（不计入实付）"**的副文案用浅灰小字固定提示，消除顾客"我还要额外付这笔钱吗"的疑虑

> **不支持"自定义抵扣金额"**：默认"能抵多少抵多少"。字段 `prepaid_card_amount` 支持任意 ≤ 余额的正数，未来若开自定义输入只改 UI。

### 2.2 员工端开单（店长结算弹层）

`fengyu-staff/miniprogram/pages/billing/*`（开单 Tab 的"去结算"弹层）同样采用"抵扣区 + 支付方式区"两段式，**不**把储值卡塞进支付方式：

```
订单总额                  ¥300.00

抵扣
  优惠券   [选择]        -¥30.00
  储值卡   本店余额 ¥320.50
           ● 使用        -¥270.00（不计入实付）

实付金额                  ¥0.00
支付方式
  ⊙ 微信（顾客扫码）
  ○ 支付宝
  ○ 线下（现金/刷卡）
```

- 支付方式三选一保持原有枚举
- 店长可看到顾客本店余额（接口 `staff.customerBalanceForStore({ customerUserId })`，scope 强制为 ctx.auth.storeId）
- 实付 = 0 时仍需选支付方式作为名义通道（默认"微信"）

### 2.3 扣款时机与幂等

**原则**：`sale_items.store_id` 确定的门店 = 扣款门店；扣款动作只在订单**从"待支付/待确认收款"→"已支付"**时发生，确保一次订单最多一次扣款。

| 场景 | 触发点 | 动作 |
|---|---|---|
| 微信支付（客户端，实付 > 0） | `payNotify` 收到微信成功回调 | 扣 `prepaid_card_amount`；payment_method 原样保留（'微信'）|
| 全额抵扣订单（实付 = 0） | `order.create` 事务内直接扣减 | 无需唤起微信支付；订单立即置 '已支付'；payment_method 记录 UI 名义通道（默认 '微信'） |
| 线下支付（客户端） | `order.offlinePay` → 员工 `confirmOffline` | 确认收款时扣 `prepaid_card_amount` |
| 店长开单（员工端，实付 > 0） | `staffApi.order.create` | 创建订单时落 `prepaid_card_amount`；扣减延迟到 `confirmOffline` 或 payNotify |
| 店长开单（员工端，全额抵扣） | `staffApi.order.create` | 同事务扣减；状态直接 '已支付' |
| 退款 | `staffApi.order.approveRefund` | 回冲：INSERT `type='充值', amount=+储值卡部分退款额`（复用 prepaid_cards UPSERT）|
| 订单关闭（`closeExpiredPending` / 超时）| 关闭动作 | **无需回冲**（未扣过就不用退，`prepaid_card_amount` 在创建时只是"承诺额"）|
| 订单取消（'待支付'→'已取消'）| `order.cancel` | 未扣无需回冲；已扣（全额抵扣单）则反向 INSERT `type='充值'` |
| 转换单正差额补款 | `createConversion` 的"正差额"分支（客户补钱）| 允许储值卡抵扣，同 order.create 链路 |
| 转换单负差额退款 | `createConversion` 的"负差额"分支（多退给客户）| 保留现有逻辑（充入储值卡 type='充值'），不变 |

**关键数据一致性保证**：
- 所有扣款都在**同一事务**内完成：`BEGIN; SELECT balance FOR UPDATE; UPDATE balance; INSERT card_transactions; UPDATE sale_orders (status, ...); COMMIT;`
- 幂等：`INSERT INTO card_transactions ... WHERE NOT EXISTS (SELECT 1 FROM card_transactions WHERE ref_order_id=$1 AND type='扣款')`（扣款不会重复写入）
- 对于微信支付场景，`payNotify` 也做幂等（现有充值分支的范式可直接复用）

### 2.4 "承诺额"与"扣减额"的边界

因为存在"订单创建时占用余额 → 微信支付中 → 支付成功后才真正扣"的时间窗口，必须防止"余额超卖"。

**简化策略（选用）**：不引入"冻结"概念；承诺额不扣减实际 balance。但**每次 order.create 前**，实时 `SELECT balance WHERE user_id=$1 AND store_id=$2 FOR UPDATE` 检查，且同事务 INSERT sale_orders 带 `prepaid_card_amount`；后续 payNotify / confirmOffline 再 `FOR UPDATE` 扣减。

**超卖风险场景**：用户同时创建两个订单 A、B（各占 200 元），余额 300 元。A 付成功扣到 100，B 再付时余额 100 < 200 → B 付款阶段拒绝或重新计算。

**缓解**：在 payNotify/confirmOffline 真正扣减时二次校验 `balance >= prepaid_card_amount`；若不足则：
- 客户端：报错 `INSUFFICIENT_BALANCE`，订单保持"待支付"，提示用户调整支付方式
- 员工端：提示店长，让顾客补现金/微信

> 这个方案简单但需业务接受"存在极小概率的重试成本"。更严格的方案是引入"冻结额度"表，不在本期做，留作后续。

### 2.5 退款回冲规则

`approveRefund` 创建退款单（`sale_order_type='退款单'`）时：

1. 找到被退订单的 `prepaid_card_amount`（或者 `SELECT amount FROM card_transactions WHERE ref_order_id=$1 AND type='扣款'`）
2. 若本次退款金额 ≤ 储值卡已抵扣额，按"储值卡全退"回冲；否则按比例拆分（储值卡全退 + 剩余退原通道）
3. INSERT `card_transactions(type='充值', amount=+退款储值卡部分, ref_order_id=退款单 ID)`
4. UPDATE `prepaid_cards.balance += 退款储值卡部分`

**拆分比例**：退款额 / 原订单总额 × 储值卡抵扣额；向下取 2 位小数，尾差走原通道。

### 2.6 admin 端展示（可选，不阻塞）

admin 订单详情已显示 `payment_method`；补充显示：
- 若 `prepaid_card_amount > 0`：展示"订单总额 ¥X / 储值卡抵 ¥A / 实付 ¥B（支付方式）"三行结构，与顾客端下单页的金额分层一致
- 订单列表新增筛选项"有储值卡抵扣"（布尔，`prepaid_card_amount > 0`）；**不**往 `payment_method` 下拉里塞"储值卡"选项
- 统计口径：`SUM(total_amount)` = 订单总销售额（含储值卡核销），`SUM(paid_amount)` = 通过支付通道的实收金额。两种口径分别给报表一行，让财务自己取舍

---

## 3 实施计划

### 3.1 DB（`db/schema/` + migration）

**不扩枚举**。仅加两列 + CHECK 约束。

| # | 任务 |
|---|------|
| D1 | `schema/order.ts`：`saleOrders` 新增 `prepaidCardAmount: numeric('prepaid_card_amount', { precision: 10, scale: 2 }).notNull().default('0')` |
| D2 | `schema/order.ts`：`saleOrders` 新增 `paidAmount: numeric('paid_amount', { precision: 10, scale: 2 }).notNull().default('0')` |
| D3 | `npm run db:generate` 产出迁移 |
| D4 | **临时 docker PG 验证**：空库跑一遍 `drizzle-kit migrate` 成功 |
| D5 | 在生成的 `.sql` 末尾追加手写段（drizzle 不会自动生成，参照 `_archive_pre_baseline_2026_04/sql/0018_green_rogue.sql` 模式）：<br>① `UPDATE sale_orders SET paid_amount = total_amount WHERE paid_amount = 0` — 历史数据回填<br>② `ALTER TABLE sale_orders ADD CONSTRAINT chk_prepaid_card_nonneg CHECK (prepaid_card_amount >= 0)`<br>③ `ALTER TABLE sale_orders ADD CONSTRAINT chk_paid_nonneg CHECK (paid_amount >= 0)`<br>④ `ALTER TABLE sale_orders ADD CONSTRAINT chk_prepaid_paid_sum CHECK (prepaid_card_amount + paid_amount = total_amount)` |
| D6 | 跑 5434（测试库） + 5433（开发库）两库 migrate；**禁止用 psql 直连 DDL** |

### 3.2 客户端（fengyu-client）

#### 3.2.1 clientApi 云函数

| # | 文件 | 改动 |
|---|---|---|
| C1 | `routes/card.js` | 新增 `card.balanceForStore({ storeId })`：返回本店余额，无卡返回 `{ balance: 0, cardId: null }` |
| C2 | `routes/order.js:create` | payload 增补 `useCard: boolean, prepaidCardAmount?: number`（允许前端显式传，否则后端按 `min(balance, totalAmount - couponDiscount)` 自动算）；事务内 `SELECT balance FOR UPDATE`，写入 `sale_orders.prepaid_card_amount` + `paid_amount = total_amount - prepaid_card_amount`；`payment_method` 保持前端传的值（微信/支付宝/线下）。若 `paid_amount === 0`（全额抵扣），同事务 INSERT `card_transactions(type='扣款')` + UPDATE balance + 订单状态直接 '已支付' |
| C3 | `routes/order.js:pay` | 微信支付应调金额 = `paid_amount`；若 = 0 直接短路（兼容 create → 单独 pay 的重试场景） |
| C4 | `routes/order.js:offlinePay` | 类似 pay，但由店长确认时扣减；`paid_amount = 0` 时也需走 confirmOffline 流程记录已支付状态（或 create 阶段已处理） |
| C5 | `routes/order.js:cancel` | 订单取消：检查 `card_transactions` 是否已有 `ref_order_id + type='扣款'`，若无则无需回冲（承诺额从未落地）；若已扣（全额抵扣订单创建后立刻取消）则反向 INSERT `type='充值'` 回冲 |
| C6 | `index.js` 路由表 | 新增 `card.balanceForStore` 映射 |
| C7 | `payNotify/index.js` | 新增"消费扣款"分支：微信支付成功回调时，若 `prepaid_card_amount > 0`，事务内 `FOR UPDATE` 扣减 prepaid_cards + INSERT `card_transactions(type='扣款')`；幂等同充值分支。payment_method 不动。 |

#### 3.2.2 小程序前端

| # | 文件 | 改动 |
|---|---|---|
| F1 | `pagesOrder/confirm/*`（下单确认页）| 顶部 `onLoad` 拉取 `card.balanceForStore`；新增"储值卡"区块 UI（§2.1 的 mockup）；开关 + 抵扣金额 + 剩余金额联动 |
| F2 | `pagesOrder/confirm/*` | 点击"提交订单"时把 `useCard + prepaidCardAmount` 传给 `order.create`；后端返回订单号后按剩余金额决定是否发起微信支付 |
| F3 | `app.wxss` / 本地样式 | 区块配色：品牌红 `#C0322A` 高亮"本店余额"、金额数字加粗 |
| F4 | 新增单测 | `confirm.test.ts`：余额充足/不足/为 0、用户开关切换、剩余金额计算的边界 |

### 3.3 员工端（fengyu-staff）

#### 3.3.1 staffApi 云函数

| # | 文件 | 改动 |
|---|---|---|
| S1 | `routes/card.js` 或扩展到 `customer.js` | 新增 `staff.customerBalanceForStore({ customerUserId })`：店长查顾客在本店的余额（scope 到店长自身 storeId） |
| S2 | `routes/order.js:create` | payload 增补 `useCard: boolean, prepaidCardAmount?: number`；逻辑同 C2；仅允许扣减 `ctx.auth.storeId` 门店的卡（防越权） |
| S3 | `routes/order.js:confirmOffline` | 逻辑同 C4 |
| S4 | `routes/order.js:approveRefund` | 计算退款储值卡部分（§2.5 规则） → INSERT `card_transactions(type='充值')` + UPDATE balance；同事务内完成 |
| S5 | `routes/order.js:createConversion` | 正差额分支（补款）允许复用抵扣链路；负差额分支（多退）保留现有"充入储值卡"逻辑不变 |
| S6 | `routes/order.js:createRepayment`（回款单）| 同理，支持储值卡抵扣 |
| S7 | `index.js` 路由 | 补映射 |

#### 3.3.2 小程序前端

| # | 文件 | 改动 |
|---|---|---|
| T1 | `pages/billing/*`（开单 Tab）结算弹层 | **新增"抵扣区"**（与支付方式区分离），内含储值卡开关 + 抵扣额；支付方式按钮组**保持** `微信/支付宝/线下` 三选一，不加任何新选项；底部分 3 行展示"订单总额 / 抵扣 / 实付" |
| T2 | 顾客详情页（`pagesWorkbench/customer-detail`） | "本店储值卡余额"字段显示（便于店长评估） |
| T3 | 单测 | 结算弹层开关切换、余额显示、提交参数构造（含 prepaidCardAmount 与支付方式的独立性） |

### 3.4 admin（可延后，不阻塞本 ticket）

| # | 任务 |
|---|------|
| A1 | `src/actions/orders.ts`：`OrderDetail` 返回结构新增 `prepaidCardAmount` 与 `paidAmount` 两字段 |
| A2 | 订单详情页显示三行金额"订单总额 / 储值卡抵扣 / 实付（微信/支付宝/线下）" |
| A3 | 列表新增筛选项"有储值卡抵扣"（布尔），**不**动 `payment_method` 下拉（枚举未扩） |
| A4 | `getCardTransactions`（见 `admin-card-transactions-page` ticket）支持筛选 type='扣款' |
| A5 | 仪表盘/报表：明确两口径 `SUM(total_amount)` vs `SUM(paid_amount)`，按财务需要开放 |

### 3.5 文档 / 规范

- `.42cog/pm/client.pr.spec.md` — 追加"储值卡抵扣支付"业务规则
- `.42cog/pm/staff.pr.spec.md` — 追加店长结算侧储值卡支付
- `.42cog/dev/client.sys.spec.md` / `staff.sys.spec.md` — 支付链路图更新（payNotify + confirmOffline + create 三处扣减点）
- `CLAUDE.md`（顾客端 / 员工端）— 路由表补 `card.balanceForStore`

---

## 4 验收标准

### 4.1 门店隔离
1. 顾客在 A 店充值 500 元（已有充值流程）→ `prepaid_cards` 行 `store_id=A, balance=500`
2. 顾客绑定切到 B 店后在 B 店下单 300 元 → 下单页"储值卡"区块显示"本店暂无储值卡余额"（B 店无卡）→ 走微信/支付宝/线下，`prepaid_card_amount=0, paid_amount=300`
3. 切回 A 店下单 300 元 → 区块显示"本店余额 ¥500"，默认抵扣 300，实付 0
4. 云函数 `order.create` 若前端篡改 `prepaidCardAmount=500`（超门店余额）→ 返回 `INSUFFICIENT_BALANCE`

### 4.2 全额抵扣（实付 = 0）
5. A 店余额 500，下单 300（无优惠券）→ 提交 → `sale_orders` 写入 `total_amount=300, prepaid_card_amount=300, paid_amount=0, payment_method='微信'`（名义通道，UI 上默认选中），`status='已支付'`
6. `prepaid_cards.balance = 200`（500 - 300）
7. `card_transactions` INSERT `type='扣款', amount=-300, ref_order_id=订单号`
8. 订单详情页显示三行："订单总额 ¥300 / 储值卡抵扣 ¥300 / 实付 ¥0"；支付方式标注"不适用（全额抵扣）"或隐藏
9. **财务口径**：该单 `total_amount=300` 计入"订单总销售额"；`paid_amount=0` **不**计入"通过支付通道的收入"

### 4.3 部分抵扣 + 剩余微信
10. A 店余额 100，下单 300 → 区块显示"储值卡抵扣 ¥100（不计入实付）"，实付 ¥200
11. 用户选"微信"支付剩余 → `sale_orders(total_amount=300, prepaid_card_amount=100, paid_amount=200, payment_method='微信', status='待支付')`
12. `card_transactions` **此时未 INSERT**（扣减延迟到支付成功）
13. 微信支付成功回调 `payNotify` → 同事务：prepaid_cards.balance=0 + INSERT `card_transactions(type='扣款', amount=-100)` + sale_orders.status='已支付'
14. 订单详情显示"订单总额 ¥300 / 储值卡抵 ¥100 / 实付 ¥200（微信）"
15. **微信对账**：微信通道本订单应到账 ¥200（= `paid_amount`），不是 ¥300

### 4.4 CHECK 约束
16. 直接 psql 尝试写入 `prepaid_card_amount=100, paid_amount=100, total_amount=300` → 被 `chk_prepaid_paid_sum` 拒绝（不等式违反）
17. 尝试写 `prepaid_card_amount=-10` → 被 `chk_prepaid_card_nonneg` 拒绝

### 4.5 幂等
18. payNotify 重复投递同一单 → card_transactions 不重复插；prepaid_cards.balance 不重复扣
19. 客户端 order.cancel 在已扣款后（全额抵扣单）→ 反向 INSERT `type='充值'` + balance 回冲；重复 cancel 无副作用

### 4.6 店长开单
20. 店长在 A 店给 A 店有卡顾客开单 300 元 → 结算弹层"抵扣"区显示储值卡开关 + 本店余额 ¥500，"支付方式"区仍为微信/支付宝/线下三选一
21. 店长开启储值卡开关（抵扣 ¥300）+ 选"微信"作名义通道 → 订单直接 '已支付'（`paid_amount=0`），card_transactions + balance 联动
22. 部分抵扣（储值卡 ¥100）+ 选"线下" ¥200 → 订单 '待确认收款'，balance 未动；`confirmOffline` 后才扣减；确认后 `paid_amount=200, payment_method='线下'`

### 4.7 退款回冲
23. 全额抵扣订单 `total=300, prepaid=300, paid=0`，退款 ¥100 → card_transactions INSERT `type='充值', amount=+100, ref_order_id=退款单 ID`；balance += 100；退款单的 `paid_amount=0`（原本就没走通道，也不从通道退）
24. 部分抵扣订单（`prepaid=100, paid=200`）退款 ¥150 → 按比例拆：储值卡退 `100/300 × 150 = 50`（向下取 2 位），微信退 `150 - 50 = 100`；分别入 card_transactions 和微信退款通道
25. 退款单的金额字段：退款单 `total_amount = -150, prepaid_card_amount = -50, paid_amount = -100`（符号约定按现有退款单规则；关键是不变量 `prepaid + paid = total` 依然成立）

### 4.8 边界校验
26. 储值卡余额 0 时后端拒绝 `useCard=true`（`INSUFFICIENT_BALANCE`）；前端 UI 也自检禁用开关
27. `prepaid_card_amount > total_amount - couponDiscount`（超出应抵部分）→ 返回 `INVALID_PARAMS`
28. `prepaid_card_amount` 小数位 > 2 → 拒绝
29. 超卖并发：A、B 两订单各抢 ¥200，余额 ¥300 → 先到 payNotify 的订单扣成功；后到订单在 `SELECT FOR UPDATE` 时发现 balance=100 < 200 → `INSUFFICIENT_BALANCE`，订单保留"待支付"待用户处理

### 4.9 回归
30. 无储值卡订单的支付流程完全不变（`prepaid_card_amount=0, paid_amount=total_amount` 默认值不影响任何老逻辑）
31. 现有充值流程不变；现有充值流水查询不变
32. 历史订单 migration 后 `paid_amount = total_amount`，GMV 报表老口径 `SUM(total_amount)` 数字不变
33. 转换单负差额"多退入卡"逻辑（staffApi/order.js:1617）不变；正差额"补款"支持储值卡抵扣
34. E2E 跑通：充值 ¥500 → 下单 ¥300 全额抵扣 → 查余额 ¥200 → 退款 ¥100 → 查余额 ¥300（三个流水行：充值 +500、扣款 -300、充值 +100）

### 4.10 单测
35. 新增云函数单测（clientApi/order + staffApi/order + payNotify）覆盖 §4.2-4.8 共 18+ 场景，**重点覆盖 `paid_amount` 计算**
36. 前端单测覆盖 §4.1-4.3 的 UI 组合 + 金额计算边界 + "实付不含抵扣"文案的断言
37. 覆盖率不跌破现有门槛（admin 80%+、client/staff 现有水位）

---

## 5 风险与缓解

| 风险 | 缓解 |
|---|---|
| 并发超卖（§2.4 场景）| `SELECT FOR UPDATE` + payNotify 二次校验；极端情况给明确错误码让前端引导切换支付方式 |
| 全额抵扣订单跳过 order.pay 直接完结，与现有"订单必须经过 pay"的前端假设冲突 | order.create 返回 `{ saleOrderId, paymentParams: null, status: '已支付', reason: 'prepaid_card_full' }`；前端按 `status` 分支跳详情页而非唤起支付 |
| `payment_method` 在实付 = 0 时的填值歧义 | 规定：按 UI 上用户选中的按钮（默认"微信"）落库；语义为"名义通道"，资金流实际不经过；不引入 null 或新枚举 |
| 店长开单时"顾客本店余额"跨门店查询导致隐私泄漏 | `staff.customerBalanceForStore` 强制 `storeId = ctx.auth.storeId`，不接受 payload 指定 |
| 承诺额 vs 扣减额的心智复杂度（特别是未支付订单占用余额但未扣减） | §2.4 明确"不冻结"；订单详情的"储值卡抵扣"数字在"待支付"时标注"支付成功后扣减" |
| 退款比例按 (储值卡 / 总额) 拆分可能产生 0.01 元尾差 | 规则：储值卡部分向下取 2 位；尾差走原通道；`approveRefund` 返回值明列 `refundByCard` + `refundByOrigin` 便于审计 |
| 转换单 / 回款单的储值卡分摊规则不明 | §3.3.1 S5/S6 标注"沿用 order.create 链路"；PR 前用 1-2 个具体业务 case 和产品对齐 |
| 历史订单 `paid_amount` 回填时机（migrate 是否锁表）| D5 里的 `UPDATE sale_orders SET paid_amount = total_amount` 数据量取决于历史订单总数；若超 100 万行建议在低峰期跑或分批；可先在测试库观察锁持续时间 |
| 财务"订单总销售额"和"实付金额"两口径混淆 | admin dashboard 改动**不在本期**；本期只确保字段写对；财务口径另开 ticket 和产品同步 |
| 现有 `total_amount` 相关 SQL 是否会被误伤 | 遍历 `grep -rn "total_amount" src/ fengyu-admin/src/` 核对每处语义：大部分场景是"订单金额"不需要改；只有**支付通道实际收款**相关处（如微信对账）需改读 `paid_amount` |

---

## 6 待产品 / 运营确认（PR 前必须答复）

1. **默认策略**：下单时默认"能抵多少抵多少"（抵扣开关默认开）？还是默认不抵扣（用户手动勾选）？
2. **实付 = 0 时 payment_method 填什么**：按 UI 名义通道（默认"微信"）✓？还是固定填"线下"表示不走线上？
3. **部分抵扣是否支持自定义金额**：本 ticket 默认"全量抵扣"（UI 不给 input），字段 `prepaid_card_amount` 预留任意值支持。是否在本期开放 input？
4. **退款拆分规则**：按订单比例（储值卡/总额 × 退款额）✓？还是"优先退原支付通道直到用完，再退储值卡"？
5. **全额抵扣订单的"已支付"时机**：订单创建即已支付 ✓？还是保留"待支付"一秒让前端有机会取消？
6. **员工端店长开单**：能不能允许店长**代顾客勾选**"用储值卡抵扣"（跳过顾客本人确认）？还是必须发二维码让顾客扫码后选？
7. **顾客端已绑定 A 店但用"扫码下单"跳 B 店产品**：储值卡抵扣按 A 店（绑定门店）还是 B 店（扫码门店）？本 ticket 倾向**按订单落账门店**（即 B 店），但需要产品确认
8. **超卖错误码 `INSUFFICIENT_BALANCE`**：是否让前端自动降级（关掉抵扣、走纯微信重付）？还是弹框让用户决定？
9. **转换单/回款单补款**：是否开放储值卡通道？（本 ticket §3.3.1 S5/S6 按"开放"实施；若产品方认为补款场景特殊，可关闭）
10. **财务/admin 口径**：报表需不需要立刻暴露 `SUM(paid_amount)`（通道实收）？本 ticket 只改订单详情三行展示，仪表盘改动默认 defer 到下个迭代

---

## 7 前置依赖

- ✅ `2026-04-16-client-prepaid-card-recharge` 已 merge：充值通路完整，`prepaid_cards` / `card_transactions` 表已有数据流入
- ✅ `p1-sale-items-store-binding` 已 merge：`sale_items.store_id` NOT NULL，扣款能按门店落账
- ✅ schema 已具备 `store_id NOT NULL` + `UNIQUE(user_id, store_id)`
- 微信支付商户号已对接（本 ticket 不改支付 SDK，只改**订单应付金额计算**，微信支付的金额由 `paid_amount` 决定）

---

## 8 相关文件

- `db/schema/prepaid-card.ts:14-35` — 储值卡账户 + 流水
- `db/schema/enums.ts:23` — paymentMethodEnum（**本期不动**，保持 `['微信','支付宝','线下']`）
- `db/schema/enums.ts:48` — cardTransactionTypeEnum（'扣款' 枚举已存在未使用，本期启用）
- `db/schema/order.ts:57` — payment_method 列（保持原语义，表示实付通道）
- `fengyu-client/cloudfunctions/clientApi/routes/card.js` — 待新增 `balanceForStore`
- `fengyu-client/cloudfunctions/clientApi/routes/order.js:150-500` — create/pay/offlinePay/cancel 支付链路
- `fengyu-client/cloudfunctions/payNotify/index.js:100-160` — 现有充值入账；新增消费扣款分支
- `fengyu-staff/cloudfunctions/staffApi/routes/order.js:150-600` — 店长 create + confirmOffline
- `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1200-1650` — createRefund/createConversion/createRepayment 分支
- `fengyu-client/miniprogram/pagesOrder/confirm/*` — 下单确认页（储值卡 UI 区块）
- `fengyu-staff/miniprogram/pages/billing/*` — 结算弹层（支付方式选项）
- `.42cog/pm/client.pr.spec.md` / `.42cog/pm/staff.pr.spec.md` — 合并后补业务规则
- `notes/tickets/2026-04-16-client-prepaid-card-recharge.md` — 前置 ticket
- `notes/tickets/2026-04-16-admin-card-management.md` / `2026-04-16-admin-card-transactions-page.md` — admin 侧的展示配套，可独立演进

---

## 9 后续演进（本期不做）

- **冻结额度表** `prepaid_card_holds(card_id, sale_order_id, held_amount, created_at, expires_at)`：订单创建即冻结、支付成功释放扣减、取消/超时释放；解决 §2.4 的超卖风险
- **跨店转账**：允许顾客把 A 店余额部分转到 B 店（需产品设计转账规则 + 手续费）
- **储值卡过期**：`prepaid_cards.expire_date`（目前无字段）+ 定时任务扫表标记作废
- **储值卡赠送/转让**：顾客 → 顾客的余额转移
- **充值配置表化** `recharge_tier_config`：档位和折扣运营可配
