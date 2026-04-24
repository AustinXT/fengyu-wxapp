# Ticket: 储值卡抵扣消费（像现金一样花）

> 生成日期：2026-04-23（2026-04-24 按产品反馈修订：取消门店绑定、实付=0 填'无'、去除超卖复杂度）
> 严重级别：P1（产品增量 / 新增抵扣通道）
> 端：fengyu-client（顾客端）+ fengyu-staff（员工端）+ fengyu-admin（可选增量）
> 影响面：DB（**2 处 schema 变更 + 1 处枚举扩展**） + clientApi / staffApi / payNotify 全链路 + 下单页 UI + 结算弹层 UI + admin 订单详情显示
> 前置：`2026-04-16-client-prepaid-card-recharge`（充值通路）已完成；`p1-sale-items-store-binding`（sale_items.store_id）已完成
>
> **一句话目标**：储值卡是"**抵扣项**"（与优惠券同类），不是"支付方式"；**余额与门店无关**（顾客换门店后仍可继续花）；余额不够时，剩余金额仍按 `['微信', '支付宝', '线下']` 中的一种走正常支付通道；**实付=0 时 `payment_method` 填 '无'**（新增枚举值）。

---

## 0 一句话背景

现在储值卡只能充值、能查余额流水，**但不能用来付款**。顾客/员工普遍理解"充了值就要能当钱花"，否则充值功能形同虚设。本 ticket 把储值卡接入下单结算侧：

- **定位为"抵扣项"**：UI 和数据模型都把储值卡放在"抵扣区"（和优惠券并列），**不**与"微信 / 支付宝 / 线下"并列
- **跨店共享**：储值卡余额与门店无关，顾客换绑门店后原余额继续可用（**本 ticket 同步调整 prepaid_cards schema**）
- **实付 = 0 的语义明确化**：`paymentMethodEnum` 扩展加 `'无'` 值；全额抵扣订单 `payment_method = '无'`，不再需要"名义通道"概念
- **全链路闭环**：下单 → 抵扣 → 支付 → 扣款流水；退款/关闭/转换单差额 → 回冲 → 充值流水
- 典型场景：订单 ¥300 / 卡内余额 ¥100 → 储值卡抵 ¥100 + 微信支付 ¥200

---

## 1 问题定位

### 1.1 现状盘点（基于 2026-04-23 代码扫描）

| 位置 | 现状 | 能力缺口 |
|---|---|---|
| `db/schema/prepaid-card.ts:14-35` | `store_id NOT NULL` + `UNIQUE(user_id, store_id)` | ⚠️ **需要变更**：DROP `store_id` 列（或改 nullable 作充值门店审计），`UNIQUE(user_id, store_id)` → `UNIQUE(user_id)`。目标：一户一账户，余额与门店无关 |
| `db/schema/enums.ts:48` | `cardTransactionTypeEnum = ['充值', '扣款']` | ✅ `'扣款'` 枚举存在但从未被写入（全仓 grep 0 处） |
| `db/schema/enums.ts:23` | `paymentMethodEnum = ['微信', '支付宝', '线下']` | ⚠️ **需要扩展**：新增 `'无'` 值，用于表达"全额储值卡抵扣，无实付通道"的语义；**仍不新增"储值卡"**（储值卡是抵扣项，非支付方式） |
| `db/schema/order.ts:57` | `payment_method` NOT NULL，单值 | ❌ 无法表达"部分储值卡 + 部分微信"；扩枚举后 `'无'` 承担"全额抵扣"场景 |
| `clientApi/routes/order.js:create/pay/offlinePay` | 支付金额 = `total_amount`，不读 prepaid_cards | ❌ 无抵扣入口 |
| `staffApi/routes/order.js:create/confirmOffline` | 同上 | ❌ 无抵扣入口 |
| `payNotify/index.js:100+` | 仅处理"充值单"入账 prepaid_cards；不处理"消费扣款"路径 | ❌ 消费侧未实现 |
| `staffApi/order.js:createRefund/rejectRefund` | 退款流程不检查 `card_transactions(type='扣款')` | ❌ 退款时不回冲储值卡 |
| `staffApi/order.js:1617+`（转换单） | 已实现"负差额充入储值卡"（UPSERT + type='充值'） | ⚠️ 正差额（补款）**没用**储值卡分摊，需要改 |

### 1.2 DB schema 选型决策

**核心约束**（用户明确指示）：
- **储值卡是"抵扣项"，不是"支付方式"**。`payment_method` 不新增 `'储值卡'`。
- **扩枚举加 `'无'`**：表达"实付=0，全额抵扣，不走任何支付通道"的语义。最终 `paymentMethodEnum = ['微信', '支付宝', '线下', '无']`。
- **储值卡抵扣额不计入实付金额**。实付金额 = 走支付通道的钱 = `total_amount - prepaid_card_amount`。
- **余额与门店无关**：一户一账户，`prepaid_cards` 的 `store_id` 从核心约束退化为"可选审计字段"（或直接 DROP）。

#### 1.2.1 `sale_orders` 新增两列

| 字段 | 类型 | 含义 |
|---|---|---|
| `prepaid_card_amount` | `numeric(10,2) NOT NULL DEFAULT 0` | 本单由储值卡承担的金额（抵扣额，**不算实付**） |
| `paid_amount` | `numeric(10,2) NOT NULL DEFAULT 0` | 本单通过 `payment_method` 指定通道实际收到的钱（**实付**） |

**不变量**（CHECK 约束 + 应用层双校验）：
```
prepaid_card_amount >= 0
paid_amount         >= 0
prepaid_card_amount + paid_amount = total_amount
payment_method ∈ {'微信', '支付宝', '线下', '无'}
paid_amount = 0  ⇔  payment_method = '无'       ← 新增语义约束（应用层强校验，CHECK 不便表达双向蕴含）
paid_amount > 0  ⇒  payment_method ∈ {'微信','支付宝','线下'}
```

**字段语义澄清**：
- `total_amount`：**订单应付总额**（原价 - 优惠券折扣），含义不变，**历史数据不动**
- `prepaid_card_amount`：储值卡抵扣的部分
- `paid_amount`：实付金额（历史订单回填 = `total_amount`，与现在报表口径一致；新订单 = `total_amount - prepaid_card_amount`）
- `payment_method`：**实付金额**走的通道；`paid_amount = 0` 时 = `'无'`（全额抵扣），再不用"名义通道"这种心智负担

> **为什么要新加 `paid_amount` 而不是复用 `total_amount`**：
> - 若让 `total_amount` 直接扣掉储值卡，等于改动现有字段含义，所有存量报表/中间层 SQL 都可能静默漂移（GMV 一夜之间变少）
> - 加一列 `paid_amount` 是向前兼容的：老报表继续用 `SUM(total_amount)` 得"订单总销售额"（含储值卡核销），新报表/对账用 `SUM(paid_amount)` 得"通过支付通道的实际收入"
> - 财务对账天然清晰："微信通道应到账 = Σpaid_amount WHERE payment_method='微信'"

#### 1.2.2 `prepaid_cards` schema 调整（去门店绑定，保留 store_id 作审计）

**采用方案 B**（2026-04-24 产品决策 #2）：

- `UNIQUE(user_id, store_id)` → `UNIQUE(user_id)`：一户一账户
- `store_id` 列保留但改 **nullable**，语义变为"**首次充值门店**"（审计字段）：
  - 仅在首次 INSERT 时写入当时的 `ctx.auth.storeId`
  - 后续充值 UPSERT：`ON CONFLICT (user_id) DO UPDATE SET balance = prepaid_cards.balance + EXCLUDED.balance`（**不更新 store_id**）
  - 消费/退款/扣减：完全不读 store_id，仅按 user_id 定位账户
  - 经营分析用例：`SELECT store_id, SUM(balance), COUNT(*) FROM prepaid_cards GROUP BY store_id` 得各门店的首次充值客群贡献
- `card_transactions` 本身无 store_id，流水表不变
- 云函数消费侧：`SELECT balance FROM prepaid_cards WHERE user_id=$1 FOR UPDATE`（无 store_id 条件）

#### 1.2.3 `paymentMethodEnum` 扩展

- `ALTER TYPE payment_method ADD VALUE '无'`（PG 原生枚举扩展语法，drizzle-kit 会识别）
- drizzle schema `schema/enums.ts:23` 数组加 `'无'`
- 现有所有读取 `paymentMethodEnum` 的代码（admin Zod、前端类型）需要同步加该值的 label / 显示逻辑

#### 1.2.4 最终 migration 内容

- `ALTER TABLE sale_orders ADD COLUMN prepaid_card_amount numeric(10,2) NOT NULL DEFAULT 0`
- `ALTER TABLE sale_orders ADD COLUMN paid_amount numeric(10,2) NOT NULL DEFAULT 0`
- `UPDATE sale_orders SET paid_amount = total_amount WHERE paid_amount = 0` 回填历史
- CHECK：`chk_prepaid_paid_sum`、`chk_prepaid_card_nonneg`、`chk_paid_nonneg`（同前）
- `ALTER TYPE payment_method ADD VALUE '无'`
- `ALTER TABLE prepaid_cards DROP CONSTRAINT uq_prepaid_cards_user_store`（或 drizzle 命名）
- `ALTER TABLE prepaid_cards ADD CONSTRAINT uq_prepaid_cards_user UNIQUE (user_id)`
- `ALTER TABLE prepaid_cards DROP COLUMN store_id`（方案 A）/ `ALTER COLUMN store_id DROP NOT NULL`（方案 B）

### 1.3 ~~门店隔离的语义~~ → 跨店共享

**撤销**原 schema 注释（`prepaid-card.ts:12`）中的"按门店隔离"语义。新规则：

- 一个顾客一个储值卡账户，余额全局可用
- 顾客换绑门店（`client_wechat_users.store_id` 变更）不影响余额
- 消费时无需核对门店：`SELECT balance FROM prepaid_cards WHERE user_id=$1 FOR UPDATE` 即可

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
│   储值卡（余额 ¥320.50）             │
│     使用储值卡   [ 开关 ● ]          │
│     抵扣 ¥270.00（不计入实付）        │
├──────────────────────────────────────┤
│  实付金额                ¥0.00       │
│   （全额抵扣，无需选择支付方式）      │
└──────────────────────────────────────┘
           [ 提交订单 ]
```

**布局约束（重点）**：
- 储值卡区块**位于"抵扣"段内**，与优惠券并列；**严禁**把储值卡塞进"支付方式"按钮组
- 支付方式按钮组**仅在实付 > 0 时展示** `微信 / 支付宝 / 线下` 三选一；语义是"**实付金额**走哪个通道"
- **实付 = 0 时**：支付方式按钮组**隐藏**（或灰显不可选），显示副文案"全额抵扣，无需选择支付方式"；提交时后端自动落 `payment_method='无'`
- 订单明细下方明示三行金额："订单总额 / 抵扣小计 / 实付金额"，让顾客一眼看清"储值卡抵的 ¥A 不是我现在要掏出的钱"

**交互规则**：
1. **余额 = 0**：储值卡子区块显示"暂无储值卡余额"，开关灰显不可点
2. **余额 ≥ `订单总额 - 优惠券`（即应抵扣部分）**：默认开关开，抵扣额 = 应抵扣部分，**实付 = 0**；支付方式区隐藏；后端落 `payment_method='无'`
3. **余额 < 应抵扣部分**：默认开关开，抵扣额 = 余额，实付 = 应抵扣部分 - 余额；支付方式区显示，用户选微信/支付宝/线下
4. 用户可手动**关闭**储值卡开关 → `prepaid_card_amount=0`，走原现金流（支付方式区显示）
5. **"抵扣 ¥270（不计入实付）"**的副文案用浅灰小字固定提示，消除顾客"我还要额外付这笔钱吗"的疑虑

> **不支持"自定义抵扣金额"**：默认"能抵多少抵多少"。字段 `prepaid_card_amount` 支持任意 ≤ 余额的正数，未来若开自定义输入只改 UI。

### 2.2 员工端开单（店长结算弹层 = 预选，不直接扣卡）

**核心语义（2026-04-24 决策 #6）**：店长端所有对储值卡的操作都是"**预选**"，订单落 `prepaid_card_amount`、`payment_method`（若实付=0 则落 `'无'`）作为建议值，但 **`prepaid_cards.balance` 完全不动**。所有真正扣卡动作在顾客扫码确认链路内发生。

`fengyu-staff/miniprogram/pages/billing/*`（开单 Tab 的"去结算"弹层）UI：

```
订单总额                  ¥300.00

抵扣（预选）
  优惠券   [选择]        -¥30.00
  储值卡   余额 ¥320.50
           ● 预选抵扣    -¥270.00（不计入实付）

实付金额                  ¥0.00
    （全额抵扣，payment_method='无'）

⚠ 顾客扫码确认后才真正扣卡

           [ 生成付款码 ]
```

- "使用"按钮文案改为 "**预选抵扣**"，提示店长此操作仅是建议
- 底部副文案固定提示 "顾客扫码确认后才真正扣卡"，消除店长 "我点了就扣了" 的误解
- 支付方式枚举扩展后为 4 值（微信/支付宝/线下/无）；弹层 UI 仅在实付 > 0 时展示前三项按钮组作为**建议通道**，实付 = 0 时隐藏按钮组 + 显示"全额抵扣（payment_method='无'）"
- 店长可看到顾客储值卡**实时**余额（接口 `staff.customerBalance({ customerUserId })`，无门店范围限制；仅店长角色可访问）
- 点击"生成付款码" → 订单 `status='待支付'`，`prepaid_card_amount/paid_amount/payment_method` 作为**预选值**写入订单，balance 不变；返回二维码数据

#### 2.2.1 顾客扫码确认页（客户端承担）

顾客扫码后进入"订单确认 + 调整"页面，展示店长预选的抵扣方案并允许调整：

- 默认显示店长预选的抵扣开关状态、抵扣金额、实付金额、支付方式
- 顾客可**调整**：
  - 关掉储值卡抵扣开关 → `prepaidCardAmount=0`，重算实付 = `total_amount`，支付方式区显示
  - 调整抵扣金额（若未来开放自定义 input，本期不做）
  - 改支付方式（若实付 > 0）
- 顾客点击"**确认支付**"时：
  - 实付 = 0（全额抵扣）：客户端调 `clientApi.order.confirmPrepaidFull`（新端点，见 §3.2.1 C9），同事务扣卡 + 置已支付
  - 实付 > 0 + 微信：唤起微信支付，支付成功 payNotify 扣卡
  - 实付 > 0 + 线下：调 `order.offlinePay` 置 '待确认收款'，等店长 confirmOffline 时扣卡
- 订单 TTL：参考现有"待支付"订单的超时关闭机制（若已有 30 分钟自动关单，此场景复用）；超时未确认 → 自动关单，`prepaid_card_amount` 归 0（从未真正扣过）

### 2.3 扣款时机与幂等

**原则**：
- 储值卡余额不分门店，任意门店下单都可扣同一账户
- 扣款动作只在订单**从"待支付/待确认收款"→"已支付"**时发生，确保一次订单最多一次扣款
- **staffApi 侧不直接扣卡**（2026-04-24 决策 #6）；所有扣卡仅发生在 clientApi + payNotify + confirmOffline

| 场景 | 触发点 | 动作 |
|---|---|---|
| 顾客端直下单 + 全额抵扣（实付 = 0） | `clientApi.order.create` 事务内 | 同事务扣减 balance + INSERT card_transactions + 置 '已支付'；`payment_method='无'` |
| 顾客端直下单 + 微信支付（实付 > 0） | `payNotify` 收到微信成功回调 | 同事务扣 `prepaid_card_amount` + 置 '已支付'；payment_method 原样保留（'微信'）|
| 顾客端直下单 + 线下支付（实付 > 0） | 店长 `staffApi.order.confirmOffline` | 确认收款时同事务扣 `prepaid_card_amount` + 置 '已支付' |
| **店长开单 → 顾客扫码确认**（全额抵扣） | `clientApi.order.confirmPrepaidFull`（新端点，顾客点"确认支付"触发） | 同事务扣减 balance + INSERT card_transactions + 置 '已支付' |
| **店长开单 → 顾客扫码 + 调整 → 微信支付** | `payNotify` | 顾客可能调整后实付变化，payNotify 按最终 `prepaid_card_amount/paid_amount` 扣卡 |
| **店长开单 → 顾客扫码 + 调整 → 线下支付** | 店长 `confirmOffline` | 同上，按顾客调整后的最终值扣 |
| 退款 | `staffApi.order.approveRefund` | 回冲：INSERT `type='充值', amount=+refundByCard`（§2.5 拆分规则）|
| 订单关闭（`closeExpiredPending` / 超时）| 关闭动作 | **无需回冲**（未扣过）；`prepaid_card_amount` 作为预选值归 0 |
| 订单取消（'待支付'→'已取消'）| `order.cancel` | 未扣无需回冲；已扣（顾客确认后立刻取消）则反向 INSERT `type='充值'` |
| 转换单正差额补款 | 员工端 `createConversion` 正差额分支 → 生成补款订单 → 顾客扫码确认扣 | 同"店长开单 → 顾客扫码"链路 |
| 转换单负差额退款 | `createConversion` 负差额分支（多退给客户）| 保留现有逻辑（充入储值卡 type='充值'），UPSERT 维度改为 user_id |

**关键数据一致性保证**：
- 所有扣款都在**同一事务**内完成：`BEGIN; SELECT balance FOR UPDATE; UPDATE balance; INSERT card_transactions; UPDATE sale_orders (status, ...); COMMIT;`
- 幂等：`INSERT INTO card_transactions ... WHERE NOT EXISTS (SELECT 1 FROM card_transactions WHERE ref_order_id=$1 AND type='扣款')`（扣款不会重复写入）
- 对于微信支付场景，`payNotify` 也做幂等（现有充值分支的范式可直接复用）

### 2.4 "承诺额"与"扣减额"的边界

业务语境：商品上架即可售，无库存限制。下单**不锁定商品**，储值卡只是支付侧的抵扣通道，不存在"库存超卖"类场景。

**策略**：
- `order.create` 阶段 `SELECT balance FROM prepaid_cards WHERE user_id=$1 FOR UPDATE` 做**基础余额检查**，`prepaid_card_amount > balance` 直接返回 `INSUFFICIENT_BALANCE`（参数校验错误，不是并发错误）
- `order.create` 只**写入**订单的 `prepaid_card_amount` 字段，**不修改** balance
- payNotify / confirmOffline 真正扣减时再次 `FOR UPDATE`，扣减前做最后一次余额检查；极端情况（两单并发且都在 create 时通过检查）最晚到达的那一单直接返回 `INSUFFICIENT_BALANCE`，订单保持"待支付"让用户手动关掉抵扣重付

**不做**：
- 不引入"冻结额度表"或任何独立的 hold 记录
- 不引入"承诺额占用"的独立计数
- 不做预扣/预留的复杂重试流程

> 余额是钱不是库存，场景量级也小（同一顾客极少同时开两单），`FOR UPDATE` + 简单的二次校验足够覆盖。

### 2.5 退款回冲规则

`approveRefund` 创建退款单（`sale_order_type='退款单'`）时：

1. 读取被退订单的 `prepaid_card_amount` 与 `total_amount`
2. **拆分计算**（2026-04-24 决策 #4，保证无尾差）：
   ```
   refundByCard    = floor( prepaid_card_amount / total_amount * refundAmount, 2 )   // 向下取 2 位
   refundByOrigin  = refundAmount - refundByCard                                       // 反向相减，不独立算
   ```
   不变量：`refundByCard + refundByOrigin ≡ refundAmount`（精确相等，无 0.01 漂移）
3. 若 `refundByCard > 0`：同事务 INSERT `card_transactions(type='充值', amount=+refundByCard, ref_order_id=退款单 ID)` + UPDATE `prepaid_cards.balance += refundByCard`
4. 若 `refundByOrigin > 0`：走原通道退款（微信 API 退款 / 线下凭证）
5. `approveRefund` 返回值必须明列 `refundByCard` 与 `refundByOrigin` 两项，便于审计

**边界**：
- 全额抵扣订单（`paid_amount=0`）退任何金额 → `refundByCard = refundAmount`，`refundByOrigin = 0`
- 无抵扣订单（`prepaid_card_amount=0`）退任何金额 → `refundByCard = 0`，`refundByOrigin = refundAmount`
- 退款额超过订单总额：参数校验拒绝（`INVALID_PARAMS`）
- 小数精度测试用例必须覆盖：`prepaid=100, total=300, refund=150 → refundByCard=49.99（floor(49.995)）, refundByOrigin=100.01`

### 2.6 admin 端展示（可选，不阻塞）

admin 订单详情已显示 `payment_method`；补充显示：
- 若 `prepaid_card_amount > 0`：展示"订单总额 ¥X / 储值卡抵 ¥A / 实付 ¥B（支付方式）"三行结构，与顾客端下单页的金额分层一致
- 订单列表新增筛选项"有储值卡抵扣"（布尔，`prepaid_card_amount > 0`）；**不**往 `payment_method` 下拉里塞"储值卡"选项
- 统计口径：`SUM(total_amount)` = 订单总销售额（含储值卡核销），`SUM(paid_amount)` = 通过支付通道的实收金额。两种口径分别给报表一行，让财务自己取舍

---

## 3 实施计划

### 3.1 DB（`db/schema/` + migration）

**含 1 处枚举扩展 + 2 处 schema 变更**（详见 §1.2）。

| # | 任务 |
|---|------|
| D1 | `schema/order.ts`：`saleOrders` 新增 `prepaidCardAmount: numeric('prepaid_card_amount', { precision: 10, scale: 2 }).notNull().default('0')` |
| D2 | `schema/order.ts`：`saleOrders` 新增 `paidAmount: numeric('paid_amount', { precision: 10, scale: 2 }).notNull().default('0')` |
| D3 | `schema/enums.ts:23`：`paymentMethodEnum` 数组追加 `'无'` → `['微信', '支付宝', '线下', '无']` |
| D4 | `schema/prepaid-card.ts`：<br>① 去掉 `storeId` 列（方案 A）**或**改为 nullable 保留作审计（方案 B，PR 前定）<br>② `uniqueIndex('uq_prepaid_cards_user_store')` → `uniqueIndex('uq_prepaid_cards_user').on(table.userId)`<br>③ 更新文件顶部注释：删"金额按门店隔离"的表述，改为"一户一账户，余额跨店共享" |
| D5 | `npm run db:generate` 产出迁移 |
| D6 | **临时 docker PG 验证**：空库跑一遍 `drizzle-kit migrate` 成功（重点验证枚举扩展 + prepaid_cards 约束变更的 SQL 顺序） |
| D7 | 在生成的 `.sql` 末尾追加手写段（drizzle 不会自动生成，参照 `_archive_pre_baseline_2026_04/sql/0018_green_rogue.sql` 模式）：<br>① `UPDATE sale_orders SET paid_amount = total_amount WHERE paid_amount = 0` — 历史数据回填<br>② `ALTER TABLE sale_orders ADD CONSTRAINT chk_prepaid_card_nonneg CHECK (prepaid_card_amount >= 0)`<br>③ `ALTER TABLE sale_orders ADD CONSTRAINT chk_paid_nonneg CHECK (paid_amount >= 0)`<br>④ `ALTER TABLE sale_orders ADD CONSTRAINT chk_prepaid_paid_sum CHECK (prepaid_card_amount + paid_amount = total_amount)` |
| D8 | 跑 5434（测试库） + 5433（开发库）两库 migrate；**禁止用 psql 直连 DDL** |

### 3.2 客户端（fengyu-client）

#### 3.2.1 clientApi 云函数

| # | 文件 | 改动 |
|---|---|---|
| C1 | `routes/card.js` | 新增 `card.balance()`：返回当前用户储值卡余额（跨店统一），无卡返回 `{ balance: 0, cardId: null }`。**不接受 storeId 参数** |
| C2 | `routes/order.js:create` | 顾客端**直接下单**流程（非店长开单扫码）：payload 增补 `useCard: boolean, prepaidCardAmount?: number`（允许前端显式传，否则后端按 `min(balance, totalAmount - couponDiscount)` 自动算）；事务内 `SELECT balance FROM prepaid_cards WHERE user_id=$1 FOR UPDATE`，写入 `sale_orders.prepaid_card_amount` + `paid_amount = total_amount - prepaid_card_amount`；`payment_method` 规则：`paid_amount > 0` 取前端传值，`paid_amount === 0` 后端强制落 `'无'`。若 `paid_amount === 0`（全额抵扣），同事务 INSERT `card_transactions(type='扣款')` + UPDATE balance + 订单直接 '已支付' |
| C3 | `routes/order.js:pay` | 微信支付应调金额 = `paid_amount`；若 = 0 直接短路 |
| C4 | `routes/order.js:offlinePay` | 类似 pay，但由店长确认时扣减 |
| C5 | `routes/order.js:cancel` | 订单取消：检查 `card_transactions` 是否已有 `ref_order_id + type='扣款'`，若无则无需回冲；若已扣则反向 INSERT `type='充值'` 回冲 |
| C6 | `index.js` 路由表 | 新增 `card.balance`、`order.scanAdjust`、`order.confirmPrepaidFull` 映射 |
| C7 | `payNotify/index.js` | 新增"消费扣款"分支：微信支付成功回调时，若 `prepaid_card_amount > 0`，事务内 `SELECT balance WHERE user_id=$1 FOR UPDATE` 扣减 prepaid_cards + INSERT `card_transactions(type='扣款')`；扣减前做 `balance >= prepaid_card_amount` 校验，不足则失败并保持订单"待支付"；幂等同充值分支 |
| C8 | `routes/card.js:recharge`（前置 ticket 产出） | 配合 schema 变更，UPSERT 改为 `ON CONFLICT (user_id) DO UPDATE SET balance = prepaid_cards.balance + EXCLUDED.balance`，**不**在 DO UPDATE 分支里覆盖 store_id（保留首次值） |
| C9 | `routes/order.js:scanAdjust`（新端点，服务"店长开单 → 顾客扫码"链路） | 顾客扫码后拉取订单详情 + 预选抵扣方案；允许顾客**调整**：`{ saleOrderId, useCard: boolean, prepaidCardAmount?: number, paymentMethod?: '微信'｜'支付宝'｜'线下' }`。后端重算 `prepaid_card_amount` / `paid_amount` / `payment_method` 并 UPDATE sale_orders（status 保持 '待支付'，balance 仍不动）。所有规则同 C2 的校验逻辑 |
| C10 | `routes/order.js:confirmPrepaidFull`（新端点，全额抵扣确认支付） | 顾客在扫码页点"确认支付"且 `paid_amount=0` 时调用；事务内 `SELECT balance FOR UPDATE` 校验 + 扣减 balance + INSERT `card_transactions(type='扣款')` + 置 '已支付'。不足余额返回 `INSUFFICIENT_BALANCE`，前端弹框（决策 #7） |

#### 3.2.2 小程序前端

| # | 文件 | 改动 |
|---|---|---|
| F1 | `pagesOrder/confirm/*`（下单确认页）| 顶部 `onLoad` 拉取 `card.balance`；新增"储值卡"区块 UI（§2.1 的 mockup）；开关默认开（决策 #1）；抵扣额 + 实付额联动 |
| F2 | `pagesOrder/confirm/*` | 点击"提交订单"时把 `useCard + prepaidCardAmount` 传给 `order.create`；后端返回订单号后按剩余金额决定是否发起微信支付；实付 = 0 时隐藏"支付方式"按钮组，显示"全额抵扣"副文案 |
| F3 | **扫码确认页（新页面或改造现有扫码详情页）** | 服务"店长开单 → 顾客扫码"链路：进入页拉取订单详情（含店长预选的抵扣方案）；UI 允许顾客调整开关、改支付方式；"确认支付"触发 `order.confirmPrepaidFull`（实付=0）或走现有微信/线下链路（实付>0）。调整保存到 `order.scanAdjust`，或在"确认支付"点一并提交 |
| F4 | `app.wxss` / 本地样式 | 区块配色：品牌红 `#C0322A` 高亮"储值卡余额"、金额数字加粗 |
| F5 | 新增单测 | `confirm.test.ts`：余额充足/不足/为 0、用户开关切换、剩余金额计算的边界、实付=0 时支付方式区隐藏；`scan.test.ts`：顾客调整后金额重算、确认支付参数构造 |

### 3.3 员工端（fengyu-staff）

#### 3.3.1 staffApi 云函数

| # | 文件 | 改动 |
|---|---|---|
| S1 | `routes/card.js` 或扩展到 `customer.js` | 新增 `staff.customerBalance({ customerUserId })`：店长查顾客储值卡余额（跨店统一，仅店长角色可访问） |
| S2 | `routes/order.js:create` | **店长开单 = 预选，不扣卡**（决策 #6）：payload 增补 `useCard: boolean, prepaidCardAmount?: number`；事务内仅 `SELECT balance WHERE user_id=$1`（**不加 FOR UPDATE**，因为不写）做基础余额校验（预选值 ≤ 当前余额）；写入 `sale_orders` 的 `prepaid_card_amount`（预选值）+ `paid_amount = total - prepaid_card_amount` + `payment_method`（实付=0 时落 '无'）；状态 = '待支付'；**`prepaid_cards.balance` 不动，`card_transactions` 不写入**；返回订单号 + 二维码数据 |
| S3 | `routes/order.js:confirmOffline` | 店长确认线下收款时扣卡：事务内 `FOR UPDATE` + 二次校验 + 扣减 balance + INSERT card_transactions + 置 '已支付' |
| S4 | `routes/order.js:approveRefund` | 计算退款储值卡部分（§2.5 规则，按比例算储值卡部分，原通道部分反向相减）→ INSERT `card_transactions(type='充值')` + UPDATE balance；同事务内完成；返回明细 `{ refundByCard, refundByOrigin }` |
| S5 | `routes/order.js:createConversion` | 正差额分支（补款）：生成补款订单，沿用"店长开单 → 顾客扫码确认"链路（同 S2 逻辑），顾客确认后才扣卡；负差额分支（多退给客户）保留现有"充入储值卡"逻辑，UPSERT 维度改为 `ON CONFLICT (user_id)` |
| S6 | `routes/order.js:createRepayment`（回款单）| 同 S5 正差额逻辑 |
| S7 | `index.js` 路由 | 补映射 |

#### 3.3.2 小程序前端

| # | 文件 | 改动 |
|---|---|---|
| T1 | `pages/billing/*`（开单 Tab）结算弹层 | **新增"抵扣区（预选）"**（与支付方式区分离），内含储值卡开关（文案 "预选抵扣"）+ 抵扣额；支付方式按钮组在 `实付 > 0` 时展示 `微信/支付宝/线下` 三选一作为建议通道，**实付 = 0 时隐藏并显示"全额抵扣 payment_method='无'"**；底部分 3 行展示"订单总额 / 抵扣 / 实付"；**固定副文案 "顾客扫码确认后才真正扣卡"** |
| T2 | `pages/billing/*` 结算动作 | 点"生成付款码"调 `staffApi.order.create`（S2 逻辑，不扣卡）；返回订单号 + 二维码渲染；店长可看到"订单已创建，等待顾客确认"状态提示 |
| T3 | 顾客详情页（`pagesWorkbench/customer-detail`） | "储值卡余额"字段显示（便于店长评估，无门店维度） |
| T4 | 单测 | 结算弹层开关切换、余额显示、提交参数构造、实付=0 时支付方式区隐藏；**断言 create 返回后 balance 未变**（模拟后端不扣卡的契约） |

### 3.4 admin（可延后，不阻塞本 ticket）

| # | 任务 |
|---|------|
| A1 | `src/actions/orders.ts`：`OrderDetail` 返回结构新增 `prepaidCardAmount` 与 `paidAmount` 两字段 |
| A2 | 订单详情页显示三行金额"订单总额 / 储值卡抵扣 / 实付（微信/支付宝/线下/无）" |
| A3 | 列表新增筛选项"有储值卡抵扣"（布尔，`prepaid_card_amount > 0`）；`payment_method` 下拉同步加入 `'无'` 选项（枚举已扩） |
| A4 | `getCardTransactions`（见 `admin-card-transactions-page` ticket）支持筛选 type='扣款' |
| A5 | 仪表盘/报表：明确两口径 `SUM(total_amount)` vs `SUM(paid_amount)`，按财务需要开放 |
| A6 | admin Zod 校验 / 类型定义（`paymentMethodEnum` / `PaymentMethod` 类型）同步加 `'无'` 值 |

### 3.5 文档 / 规范

- `.42cog/pm/client.pr.spec.md` — 追加"储值卡抵扣支付（跨店共享）"业务规则；同步撤销原按门店隔离的描述
- `.42cog/pm/staff.pr.spec.md` — 追加店长结算侧储值卡支付；`payment_method` 枚举新增 `'无'`
- `.42cog/dev/client.sys.spec.md` / `staff.sys.spec.md` — 支付链路图更新（payNotify + confirmOffline + create 三处扣减点）；数据模型改图更新 prepaid_cards（一户一账户）
- `CLAUDE.md`（顾客端 / 员工端）— 路由表补 `card.balance`

---

## 4 验收标准

### 4.1 跨店共享
1. 顾客在 A 店充值 500 元 → `prepaid_cards` 唯一行 `user_id=X, balance=500`（无 store_id 约束，或 store_id 仅作首次审计字段）
2. 顾客绑定切到 B 店后在 B 店下单 300 元 → 下单页"储值卡"区块显示"余额 ¥500"，默认抵扣 300，实付 0（跨店仍可用）
3. 顾客再次切到 C 店下单 100 元 → 区块显示"余额 ¥200"，默认抵扣 100，实付 0
4. 云函数 `order.create` 若前端篡改 `prepaidCardAmount=500`（超余额）→ 返回 `INSUFFICIENT_BALANCE`（基础余额校验，非并发错误）
5. `prepaid_cards` 表 `UNIQUE(user_id)` 生效：同一顾客不会出现两行记录

### 4.2 全额抵扣（实付 = 0，payment_method = '无'）
6. 余额 500，下单 300（无优惠券）→ 提交 → `sale_orders` 写入 `total_amount=300, prepaid_card_amount=300, paid_amount=0, payment_method='无', status='已支付'`
7. `prepaid_cards.balance = 200`（500 - 300）
8. `card_transactions` INSERT `type='扣款', amount=-300, ref_order_id=订单号`
9. 下单页提交时**前端未显示支付方式按钮组**；订单详情页显示三行："订单总额 ¥300 / 储值卡抵扣 ¥300 / 实付 ¥0"；`payment_method` 展示为"无（全额抵扣）"
10. **财务口径**：该单 `total_amount=300` 计入"订单总销售额"；`paid_amount=0` **不**计入"通过支付通道的收入"
11. 若前端恶意传 `payment_method='微信'` 且 `prepaidCardAmount=300`（意图伪装通道）→ 后端检测 `paid_amount=0` 强制覆盖为 `'无'`

### 4.3 部分抵扣 + 剩余微信
12. 余额 100，下单 300 → 区块显示"储值卡抵扣 ¥100（不计入实付）"，实付 ¥200
13. 用户选"微信"支付剩余 → `sale_orders(total_amount=300, prepaid_card_amount=100, paid_amount=200, payment_method='微信', status='待支付')`
14. `card_transactions` **此时未 INSERT**（扣减延迟到支付成功）
15. 微信支付成功回调 `payNotify` → 同事务：`SELECT balance FOR UPDATE` 发现 `balance >= 100` → 扣成 balance=0 + INSERT `card_transactions(type='扣款', amount=-100)` + sale_orders.status='已支付'
16. 订单详情显示"订单总额 ¥300 / 储值卡抵 ¥100 / 实付 ¥200（微信）"
17. **微信对账**：微信通道本订单应到账 ¥200（= `paid_amount`），不是 ¥300

### 4.4 CHECK 约束
18. 直接 psql 尝试写入 `prepaid_card_amount=100, paid_amount=100, total_amount=300` → 被 `chk_prepaid_paid_sum` 拒绝（不等式违反）
19. 尝试写 `prepaid_card_amount=-10` → 被 `chk_prepaid_card_nonneg` 拒绝
20. 尝试写入 `paid_amount=0, payment_method='微信'` → 应用层校验拒绝（paid_amount=0 ⇔ payment_method='无'）

### 4.5 幂等
21. payNotify 重复投递同一单 → card_transactions 不重复插；prepaid_cards.balance 不重复扣
22. 客户端 order.cancel 在已扣款后（全额抵扣单）→ 反向 INSERT `type='充值'` + balance 回冲；重复 cancel 无副作用

### 4.6 店长开单（预选 → 顾客扫码确认 → 扣卡）
23. 店长给顾客开单 300 元 → 结算弹层"抵扣区（预选）"显示储值卡开关 + 余额 ¥500，文案"预选抵扣 ¥300（不计入实付）"
24. 店长勾选预选抵扣 → 点"生成付款码" → `staffApi.order.create`：`sale_orders(total=300, prepaid=300, paid=0, payment_method='无', status='待支付')`；**balance 仍 = 500（未扣）**，**card_transactions 无新行**；返回二维码
25. 顾客扫码进入确认页 → 看到预填方案"储值卡抵扣 ¥300，实付 ¥0"+"确认支付"按钮
26. 顾客直接点"确认支付" → `clientApi.order.confirmPrepaidFull` → 事务内扣 balance: 500→200、INSERT `card_transactions(type='扣款', amount=-300)`、置 '已支付'
27. 顾客在扫码页**调整**：关掉储值卡开关 → 调 `order.scanAdjust { useCard: false }` → 后端重写 `prepaid=0, paid=300, payment_method` 由顾客选的通道落（微信/支付宝/线下）→ 订单仍 '待支付'；顾客后续按选的通道完成支付
28. 顾客在扫码页调整为**部分抵扣**：勾储值卡 + 调整为 ¥100 + 选"微信" → `order.scanAdjust` 落 `prepaid=100, paid=200, payment_method='微信'` → 顾客唤起微信支付 ¥200 → payNotify 成功回调 → 事务内扣 balance: 500→400、INSERT `扣款 -100`、置 '已支付'
29. 超时 / 顾客未确认：订单被关单（沿用现有 TTL），`prepaid_card_amount` 从未落地，balance 仍 500
30. 跨店场景：店长在 A 店给曾在 B 店充值的顾客开单 → 结算弹层显示余额 ¥500 → 顾客扫码确认后扣成功（跨店可用）

### 4.7 退款回冲（精度规则见决策 #4）
31. 全额抵扣订单 `total=300, prepaid=300, paid=0, payment_method='无'`，退款 ¥100 → `refundByCard = floor(300/300 × 100, 2) = 100.00`，`refundByOrigin = 100 - 100 = 0`；INSERT `card_transactions(type='充值', amount=+100)`；balance += 100
32. 部分抵扣订单（`prepaid=100, paid=200, total=300`）退款 ¥150 → `refundByCard = floor(100/300 × 150, 2) = floor(50.00, 2) = 50.00`，`refundByOrigin = 150 - 50 = 100.00`；分别入 card_transactions 和微信退款通道
33. **精度边界用例**：`prepaid=100, total=301, refund=150` → `refundByCard = floor(100/301 × 150, 2) = floor(49.8338...) = 49.83`，`refundByOrigin = 150 - 49.83 = 100.17`；**断言两者之和精确 = 150**，无 0.01 漂移
34. 退款单的金额字段：退款单 `total_amount = -150, prepaid_card_amount = -50, paid_amount = -100`（符号按现有退款单规则；不变量 `prepaid + paid = total` 依然成立）

### 4.8 边界校验
35. 储值卡余额 0 时后端拒绝 `useCard=true`（`INSUFFICIENT_BALANCE`）；前端 UI 也自检禁用开关
36. `prepaid_card_amount > total_amount - couponDiscount`（超出应抵部分）→ 返回 `INVALID_PARAMS`
37. `prepaid_card_amount` 小数位 > 2 → 拒绝
38. payNotify / confirmOffline / confirmPrepaidFull 扣减前二次校验：若此时 `balance < prepaid_card_amount` → 返回 `INSUFFICIENT_BALANCE`，订单保持"待支付"（由**前端弹框**由用户决定，**不做自动降级**）

### 4.9 回归
39. 无储值卡订单的支付流程完全不变（`prepaid_card_amount=0, paid_amount=total_amount` 默认值不影响任何老逻辑）
40. 现有充值流程：schema 变更后，`recharge` 按 user_id UPSERT（不再按 user+store）；同一用户多次充值合并到同一行；`store_id` 保留首次充值门店（不覆盖）— **前置 ticket 代码需同步修改**
41. 历史订单 migration 后 `paid_amount = total_amount`，GMV 报表老口径 `SUM(total_amount)` 数字不变
42. 转换单负差额"多退入卡"逻辑（staffApi/order.js:1617）保留；UPSERT 维度改为 `ON CONFLICT (user_id)`；正差额"补款"沿用"店长开单 → 顾客扫码确认"链路
43. E2E 跑通：充值 ¥500（A 店）→ 换绑 B 店 → 下单 ¥300 全额抵扣 → 查余额 ¥200、`store_id` 仍为 A（首次充值门店不变）→ 退款 ¥100 → 查余额 ¥300（三个流水行：充值 +500、扣款 -300、充值 +100）
44. E2E 店长链路：店长开单 ¥300 预选全额抵扣 → 生成二维码 → 余额未扣（仍 500）→ 顾客扫码确认 → 扣成 200 → 状态 '已支付'

### 4.10 单测
45. 新增云函数单测（clientApi/order + staffApi/order + payNotify）覆盖 §4.2-4.8 共 25+ 场景，**重点覆盖**：`paid_amount` 计算、`payment_method='无'` 强制落库、staffApi.create 不扣卡的契约、scanAdjust 重算、精度边界（尤其 #33）
46. 前端单测覆盖 §4.1-4.3 的 UI 组合 + 金额计算边界 + "实付不含抵扣"文案的断言 + 实付=0 时支付方式区隐藏 + 扫码确认页的调整行为
47. 覆盖率不跌破现有门槛（admin 80%+、client/staff 现有水位）

---

## 5 风险与缓解

| 风险 | 缓解 |
|---|---|
| 全额抵扣订单跳过 order.pay 直接完结，与现有"订单必须经过 pay"的前端假设冲突 | clientApi.order.create / confirmPrepaidFull 返回 `{ saleOrderId, paymentParams: null, status: '已支付', reason: 'prepaid_card_full' }`；前端按 `status` 分支跳详情页而非唤起支付 |
| 前端可能传 `payment_method='微信'` 但 `paid_amount=0`（误选通道）| 后端强校验：`paid_amount = 0` 时强制覆盖 `payment_method='无'`（无视前端传值），不报错以避免用户体验问题 |
| 余额不足场景：下单瞬间余额够但真正扣减时被其他端扣走 | `FOR UPDATE` + 扣减前二次校验；命中不足返回 `INSUFFICIENT_BALANCE`，订单保持"待支付"；**前端弹框由用户决定**（决策 #7），不自动降级 |
| `prepaid_cards` schema 变更破坏前置 ticket 的充值代码 | C8 明确 `card.recharge` 需同步改 UPSERT 维度；注意 `ON CONFLICT DO UPDATE` 不覆盖 store_id 以保留首次充值门店（决策 #2）；否则首次部署会写入失败或覆盖审计字段 |
| **店长预选订单长时间挂起 / 二维码泄露**（决策 #6）| 复用现有"待支付"订单的超时关闭机制；扫码页不做权限校验（扫到码即可确认），但二维码 URL 含订单 id，订单本身与顾客 userId 绑定，顾客 openid 不匹配时拒绝 scanAdjust / confirmPrepaidFull |
| **店长预选余额与顾客确认时余额漂移**：店长看到 500、生成二维码，顾客扫码时已经被别的订单扣到 100 | 扫码确认页进入时实时拉 `card.balance`，若预选值 > 当前余额，UI 自动下调到 min(预选, 当前)，提示"余额已变化" |
| 退款比例精度（§2.5 + 决策 #4）| 规则：储值卡部分 `floor(prepaid/total × refund, 2)`；原通道 = 退款总额 − 储值卡部分（反向相减，不独立计算）；保证无尾差 |
| 转换单 / 回款单的储值卡分摊规则 | §3.3.1 S5/S6 沿用"店长开单 → 顾客扫码确认"链路；PR 前用 1-2 个具体业务 case 和产品对齐 |
| 历史订单 `paid_amount` 回填时机（migrate 锁表）| D7 `UPDATE sale_orders SET paid_amount = total_amount` 数据量取决于历史订单总数；若超 100 万行建议在低峰期跑或分批；先在测试库观察锁持续时间 |
| 财务"订单总销售额"和"实付金额"两口径混淆 | admin dashboard 改动**不在本期**（决策 #9）；本期只确保字段写对；财务口径另开 ticket 和产品同步 |
| 现有 `total_amount` 相关 SQL 是否会被误伤 | 遍历 `grep -rn "total_amount" src/ fengyu-admin/src/` 核对每处语义：大部分场景是"订单金额"不需要改；只有**支付通道实际收款**相关处（如微信对账）需改读 `paid_amount` |
| 已有顾客在多店有余额的合并策略（若线上已有数据） | 按 [no-legacy-compat](feedback_no_legacy_compat.md) 原则，开发阶段可 truncate `prepaid_cards` + `card_transactions` 重来；若需保留，写一次性合并脚本 `SUM(balance) GROUP BY user_id, MIN(created_at) 对应的 store_id`（取首次门店），不在本 ticket 范围 |

---

## 6 产品决策（2026-04-24 全部确认）

### 前置语义（推翻原 ticket 的三项设计假设）

- ✅ **储值卡跨店共享**：顾客换绑门店后余额继续可用（详见 §1.2.2 + §1.3）
- ✅ **实付 = 0 时 `payment_method = '无'`**：扩枚举新增 `'无'`，不用"名义通道"概念（详见 §1.2.3）
- ✅ **无超卖场景**：商品无库存限制，储值卡按简单 `FOR UPDATE` + 扣减前二次校验即可，不引入冻结表（详见 §2.4）

### 九项实施决策

| # | 决策 | 影响位置 |
|---|------|---------|
| 1 | **抵扣开关默认开**（能抵多少抵多少，用户可手动关闭） | §2.1 / §2.2 UI |
| 2 | `prepaid_cards.store_id` **保留为 nullable**，作"**首次充值门店**"审计字段（便于经营数据分析，如各门店充值贡献统计）。不参与业务逻辑；顾客换绑门店或跨店消费时该字段**不更新**，始终保持首次充值时的值。UNIQUE 约束改为 `(user_id)` | §1.2.2 / §3.1 D4 / §3.2.1 C8 |
| 3 | 部分抵扣**不开放**自定义金额 input（全量抵扣，UI 只给开关，留待后续迭代） | §2.1 / §2.2 |
| 4 | 退款按比例拆 + **精度约束**：**储值卡部分按比例算并向下取 2 位**（`floor((prepaid_card_amount / total_amount) × refund_amount, 2)`），**原通道部分 = 总退款额 − 储值卡部分**（反向相减，不独立计算）。保证 `储值卡退款 + 原通道退款 ≡ 总退款额`，无尾差漂移 | §2.5 / §4.7 |
| 5 | 全额抵扣订单**创建即已支付**（order.create 同事务内完成） | §2.3 / §4.2 |
| 6 | **店长开单 = 预选，不落扣减**：<br>① 店长勾选储值卡抵扣 → 订单 `status='待支付'`，`prepaid_card_amount` 记作"预选值"，`prepaid_cards.balance` **未动**<br>② 生成付款二维码<br>③ 顾客扫码后看到**预填的抵扣方案**，可调整（含关掉抵扣、改支付方式，调整范围 ≤ 实时余额）<br>④ 顾客确认后才真正扣卡<br>所有扣卡动作**仅发生在 clientApi + payNotify + confirmOffline 三处**，staffApi 侧不直接扣 | §2.2 / §2.3 / §3.3.1 / §4.6 |
| 7 | `INSUFFICIENT_BALANCE` → 前端**弹框**让用户决定（关抵扣重付 / 取消订单），**不做自动降级** | §4.8 / §5 |
| 8 | 转换单 / 回款单补款**开放**储值卡抵扣（沿用 order.create 链路） | §3.3.1 S5/S6 |
| 9 | 财务/admin 口径本期仅做**订单详情三行展示**；仪表盘 `SUM(paid_amount)` defer 到下期 | §2.6 / §3.4 |

---

## 7 前置依赖

- ✅ `2026-04-16-client-prepaid-card-recharge` 已 merge：充值通路完整，`prepaid_cards` / `card_transactions` 表已有数据流入。**⚠️ 本 ticket 会反向调整该 ticket 的 schema**（去门店绑定），充值代码需同步改 UPSERT 维度（由 user+store → user）
- ✅ `p1-sale-items-store-binding` 已 merge：`sale_items.store_id` NOT NULL，订单仍记录消费门店（仅作审计，不参与储值卡扣款路由）
- 当前 schema `store_id NOT NULL + UNIQUE(user_id, store_id)` 是**本 ticket 要修改的起点，不是要保留的约束**
- 微信支付商户号已对接（本 ticket 不改支付 SDK，只改**订单应付金额计算**，微信支付的金额由 `paid_amount` 决定）

---

## 8 相关文件

- `db/schema/prepaid-card.ts:14-35` — 储值卡账户 + 流水（**本 ticket 调整**：UNIQUE 去 store_id；store_id 列 DROP 或改 nullable；顶部注释撤销"门店隔离"表述）
- `db/schema/enums.ts:23` — paymentMethodEnum（**本 ticket 扩展**：追加 `'无'` → 4 值）
- `db/schema/enums.ts:48` — cardTransactionTypeEnum（'扣款' 枚举已存在未使用，本期启用）
- `db/schema/order.ts:57` — payment_method 列（语义不变，扩枚举后可接受 `'无'`）
- `fengyu-client/cloudfunctions/clientApi/routes/card.js` — 待新增 `balance`（无 storeId）；recharge 改 UPSERT 维度
- `fengyu-client/cloudfunctions/clientApi/routes/order.js:150-500` — create/pay/offlinePay/cancel 支付链路
- `fengyu-client/cloudfunctions/payNotify/index.js:100-160` — 现有充值入账；新增消费扣款分支
- `fengyu-staff/cloudfunctions/staffApi/routes/order.js:150-600` — 店长 create + confirmOffline
- `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1200-1650` — createRefund/createConversion/createRepayment 分支
- `fengyu-client/miniprogram/pagesOrder/confirm/*` — 下单确认页（储值卡 UI 区块）
- `fengyu-staff/miniprogram/pages/billing/*` — 结算弹层（抵扣区 + 支付方式区分离，实付=0 时隐藏支付方式区）
- `.42cog/pm/client.pr.spec.md` / `.42cog/pm/staff.pr.spec.md` — 合并后补业务规则
- `notes/tickets/2026-04-16-client-prepaid-card-recharge.md` — 前置 ticket（**需联动修改**充值代码以适配新 schema）
- `notes/tickets/2026-04-16-admin-card-management.md` / `2026-04-16-admin-card-transactions-page.md` — admin 侧的展示配套，可独立演进

---

## 9 后续演进（本期不做）

- **储值卡过期**：`prepaid_cards.expire_date`（目前无字段）+ 定时任务扫表标记作废
- **储值卡赠送/转让**：顾客 → 顾客的余额转移
- **充值配置表化** `recharge_tier_config`：档位和折扣运营可配
- **自定义抵扣金额**：UI 开放 input 让用户选抵多少（本期"全量抵扣"足够）
- **多币种/多账户模型**：若未来引入"线上线下分账户"或"活动专款"需要，再分拆账户维度
