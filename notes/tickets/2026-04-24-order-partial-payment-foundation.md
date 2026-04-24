# Ticket: 订单部分支付基础 — 款项流水表 + staff/admin 开单支持首次部分收款

> 生成日期：2026-04-24
> 严重级别：P1（基础架构 / 为 Ticket 2/3 提供 schema 底座）
> 端：db + fengyu-staff（员工端）+ fengyu-admin（管理后台）+ fengyu-client（顾客端读侧）
> 影响面：DB（**1 张新表 + 2 处 schema 变更 + 1 处枚举扩展**） + staffApi.order / admin.actions.orders / clientApi.order.pay 全链路
> 前置：`2026-04-23-prepaid-card-deduction-by-store`（`paid_amount` / `prepaid_card_amount` 列引入）需先合并
> 并行：Ticket 2（多次回款）、Ticket 3（admin 退款补齐）依赖本 ticket 的 schema PR；其余 PR 可并行
>
> **一句话目标**：staff 和 admin 开单时允许首次只收一部分款，订单落到 `'部分支付'` 状态；首次支付、后续回款、退款统一写进新的 `sale_order_payments` 流水表（款项权威源），`sale_orders.paid_amount` 降为冗余快照。

---

## 0 一句话背景

现状：所有订单必须一次性全额支付（`sale_orders.total_amount` 即 `paid_amount`），无法表达"顾客先付一半，后面再补"这种常规场景。原 `回款单`（`sale_order_type='回款单'`）虽预留枚举值并有 staff 端 `createRepayment` 实现，但资金流水散落在多张 `sale_orders` 行里反推，admin/client 端都未对齐。

本 ticket 是**三端款项闭环的基础 PR**：
1. 新建 `sale_order_payments` 表，把"首次支付 + 回款 + 退款 + 储值卡抵扣"四类款项动作统一为流水行
2. `sale_orders.status` 枚举新增 `'部分支付'`；新增 `payable_amount` 冗余列（= `total_amount − prepaid_card_amount`，便于索引 + 前端显示）
3. staff `order.create` 与 admin `createOrder` 入参新增 `receivedAmount`，首次支付即作为 payments 表第 1 行写入
4. clientApi 的 `pay / alipayPay / offlinePay` 改写为 payments 流水写入路径（为 Ticket 2 的 client 回款复用同一套路径打底）

**不做的事**：不改 `sale_order_type`（`回款单`/`退款单` 值保留，作审批单据凭证类型）；不动历史订单（迁移时统一回填 `paid_amount = total_amount`，1 行 payments 流水补齐）。

---

## 1 问题定位

### 1.1 现状盘点（基于 2026-04-24 代码扫描）

| 位置 | 现状 | 能力缺口 |
|---|---|---|
| `db/schema/enums.ts` saleOrderStatusEnum | `['待支付','待确认收款','已支付','已完成','支付失败','已关闭','待审批']` | ⚠️ 缺 `'部分支付'` 状态 |
| `db/schema/order.ts` sale_orders | 有 `total_amount` / `paid_amount`（2026-04-23 ticket 引入）/ `prepaid_card_amount`；但**无款项流水子表** | ❌ 每笔款项变动无独立记录，幂等/审计/对账都要反推 |
| `staffApi/routes/order.js:create` | 入参无 `receivedAmount`；创建即 `status='已支付'`（付清）或 `'待支付'`（线上待回调） | ❌ 无法首次部分收款 |
| `staffApi/routes/order.js:createRepayment` | 已实现，但**新建一条 `sale_order_type='回款单'` 的子订单**承载资金流水（订单号 FY-HKD-WX-） | ⚠️ 资金流水混在 sale_orders 里，Ticket 2 需改写为只写 payments 行 |
| `admin/src/actions/orders.ts:createOrder` | 同 staff：无 `receivedAmount`，一律全额 | ❌ 同上 |
| `clientApi/routes/order.js:pay / alipayPay / offlinePay` | 支付金额 = `total_amount - prepaid_card_amount`，直接更新 `sale_orders.status` | ❌ 无流水行，Ticket 2 的 client 回款无法复用 |
| `payNotify/index.js` 支付回调 | 仅更新 sale_orders 为 `已支付`；无幂等键除 `wechat_transaction_id` | ⚠️ 回调幂等需迁移到 payments 层 |

### 1.2 核心架构决策：款项流水表

**用户明确要求**：首次支付、回款、退款都是同一订单的款项变动，**必须**由独立流水表承载。

**权威源**：`sale_order_payments` 是款项的唯一权威源。`sale_orders.paid_amount` 降级为"冗余快照"，由应用层每次变更后重算（触发器过重，选应用层双写）。

**不变量（应用层 + DB CHECK 双重保障）**：
```
sale_orders.paid_amount         = Σ(sale_order_payments.amount WHERE status='已支付' AND change_type IN ('首次支付','回款'))
                                  + Σ(sale_order_payments.amount WHERE status='已支付' AND change_type='退款')   ← 退款金额为负
sale_orders.prepaid_card_amount = Σ(sale_order_payments.amount WHERE status='已支付' AND change_type='储值卡抵扣')
sale_orders.paid_amount + prepaid_card_amount ≤ sale_orders.total_amount  ← ≤ 是为了允许"退款导致实付<应付"的场景
0 ≤ sale_orders.paid_amount ≤ payable_amount + 已退金额
```

### 1.3 `sale_order_payments` 表设计

```sql
CREATE TABLE sale_order_payments (
  id                   BIGSERIAL PRIMARY KEY,
  sale_order_id        VARCHAR(64) NOT NULL REFERENCES sale_orders(sale_order_id) ON DELETE RESTRICT,

  -- 款项类型（业务维度，决定流水如何参与统计）
  change_type          TEXT NOT NULL,  -- 枚举：首次支付 / 回款 / 退款 / 储值卡抵扣
                                       -- 首次支付：仅订单创建那一刻写入，最多 1 行/订单
                                       -- 回款：订单存活期内多次写入
                                       -- 退款：Ticket 3 写入，amount 为负
                                       -- 储值卡抵扣：下单时若使用储值卡，与"首次支付"同事务并行写 1 行

  -- 资金方向 + 金额（正=流入商家，负=退还顾客）
  amount               NUMERIC(10,2) NOT NULL,
  payment_method       TEXT NOT NULL,  -- 微信 / 支付宝 / 线下 / 储值卡 / 无
  external_txn_id      TEXT,           -- 微信/支付宝三方交易号；线下/储值卡为 NULL

  -- 流水状态
  status               TEXT NOT NULL,  -- 待支付 / 已支付 / 已作废 / 已退款
                                       -- 线上支付发起时为"待支付"，回调到账置"已支付"
                                       -- 线下/储值卡直接写"已支付"
                                       -- "已退款"仅 change_type='首次支付' 或 '回款' 被整笔退款时用

  -- 来源与操作人
  source_end           TEXT NOT NULL,  -- client / staff / admin / notify
  operator_employee_id VARCHAR(32),    -- NULL 表示顾客自助（source_end='client'）
  note                 TEXT,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at              TIMESTAMPTZ,    -- status 翻 '已支付' 的时间
  CONSTRAINT sop_amount_sign CHECK (
    (change_type IN ('首次支付','回款','储值卡抵扣') AND amount > 0) OR
    (change_type = '退款' AND amount < 0)
  ),
  CONSTRAINT sop_method_txn CHECK (
    (payment_method IN ('微信','支付宝') AND external_txn_id IS NOT NULL)
    OR payment_method IN ('线下','储值卡','无')
  )
);

CREATE INDEX sop_order_idx ON sale_order_payments(sale_order_id);
CREATE INDEX sop_status_idx ON sale_order_payments(status, created_at);

-- 幂等：同一订单同一三方交易号只能落一行
CREATE UNIQUE INDEX sop_txn_unique
  ON sale_order_payments(sale_order_id, payment_method, external_txn_id)
  WHERE external_txn_id IS NOT NULL;
```

**新增枚举**：`db/schema/enums.ts`
```ts
export const paymentChangeTypeEnum = pgEnum('payment_change_type', [
  '首次支付', '回款', '退款', '储值卡抵扣',
]);
export const paymentFlowStatusEnum = pgEnum('payment_flow_status', [
  '待支付', '已支付', '已作废', '已退款',
]);
export const paymentSourceEndEnum = pgEnum('payment_source_end', [
  'client', 'staff', 'admin', 'notify',
]);
```

### 1.4 `sale_orders` schema 微调

| 字段 | 动作 | 说明 |
|---|---|---|
| `status` 枚举 | **扩展**：新增 `'部分支付'` | 0 < paid_amount < payable_amount 时 |
| `payable_amount` | **新增** `numeric(10,2) NOT NULL DEFAULT 0` | = `total_amount − prepaid_card_amount`；创建订单时计算并冻结，作为"应付实金金额"冗余列；便于前端/报表按"应付"筛选 |
| `paid_amount` | 保持 | 由 payments 表重算后同步（应用层双写） |
| `paid_at` | 保持 | 改为"最后一次到账时间"（原只记首次全额到账时间） |

**状态机重绘**：

```
          create(receivedAmount=0)
             ↓
        [待支付]  ──────────────────────→ [已关闭]  （超时/手动关闭）
             │
             │ pay() 成功 / offline 确认 / 储值卡抵扣
             │ （部分金额）
             ↓
        [部分支付]  ──────────────────→ [已关闭]  （部分支付订单可关闭，已付部分转退款单）
             │
             │ repay() 付清
             ↓
        [已支付] → [已完成]（服务全部核销后）
```

注意：`'部分支付'` 状态订单仍允许核销服务（按已付比例或业务规则），**本 ticket 不涉及"部分支付订单是否可核销"的业务规则**——默认沿用 `已支付` 逻辑（允许核销），由 Ticket 2 的跟进做业务规则配置。

---

## 2 设计决策

### 2.1 `receivedAmount` 语义

| 场景 | `receivedAmount` 传值 | 结果订单状态 |
|---|---|---|
| 全额现场收款（沿用现有行为） | `= total_amount - prepaid_card_amount` | `已支付`（同现状） |
| 线上支付（微信/支付宝）预留 | `0`，等回调 | `待支付` → 回调到账后 `已支付` |
| 首次部分收款（新能力） | `> 0 && < payable_amount` | `部分支付` |
| 纯挂账 | `0` + payment_method='线下' | `待支付` |

**校验规则**：
- `0 ≤ receivedAmount ≤ payable_amount`
- `receivedAmount > 0 && paymentMethod ∈ {'线下','储值卡'}` → 立即落"已支付"流水
- `receivedAmount > 0 && paymentMethod ∈ {'微信','支付宝'}` → 落"待支付"流水，等回调转"已支付"
- `prepaidCardAmount > 0` → 单独 1 行 `change_type='储值卡抵扣'` 流水，与"首次支付"流水同事务

### 2.2 现有 `回款单` / `退款单` 模型如何共存

**保留**：
- `sale_order_type` 枚举保留 `回款单` / `退款单` 值
- 订单号前缀 `FY-HKD-`（回款） / `FY-TKD-`（退款）保留
- sale_orders 行继续作为**审批单据**（回款申请、退款申请均在此登记审批状态）

**变化**：
- 资金动作**不再**写在 sale_order_type='回款单'/'退款单' 的行上，而是**统一写到 payments 表并 ref 到原销售单**
- 具体：Ticket 2 改写 `createRepayment` 为"新建回款凭证 sale_order（作审批态度） + 向原销售单 payments 表插入 `change_type='回款'` 行"（二者在同一事务）
- Ticket 3 同理改写 `createRefund`

**理由**：保留凭证模型使审批流/订单号规则不变；分离资金流水表使"paid_amount 一目了然"。

### 2.3 历史数据迁移

每条现存 `sale_orders` 根据 `status` 构造 1 行 payments 流水：

```sql
INSERT INTO sale_order_payments (
  sale_order_id, change_type, amount, payment_method,
  external_txn_id, status, source_end, operator_employee_id,
  created_at, paid_at, note
)
SELECT
  sale_order_id,
  '首次支付',
  COALESCE(paid_amount, total_amount),  -- 回填存量
  COALESCE(payment_method, '无'),
  COALESCE(wechat_transaction_id, alipay_transaction_id),
  CASE WHEN status IN ('已支付','已完成') THEN '已支付' ELSE '待支付' END,
  CASE WHEN source='client' THEN 'client' ELSE 'staff' END,
  NULL,
  created_at,
  paid_at,
  '系统迁移回填'
FROM sale_orders
WHERE sale_order_type = '销售单';
```

回款单/退款单的历史数据转为对应原单的 payments 行（`ref_sale_order_id`）。

**迁移顺序**：
1. DDL（建表、加列、扩枚举）
2. 回填 payments（事务执行）
3. 双写启用（应用层 create 同时写 sale_orders.paid_amount + payments 行）
4. 灰度（先 staff，后 admin，最后 client）
5. 旧字段/行为下线（留给 Ticket 2）

### 2.4 DB 改动清单

| 文件 | 动作 |
|---|---|
| `db/schema/enums.ts` | 扩 `saleOrderStatusEnum`（+ `'部分支付'`）；新增 3 枚举 `paymentChangeTypeEnum` / `paymentFlowStatusEnum` / `paymentSourceEndEnum` |
| `db/schema/order.ts` | sale_orders 新增 `payable_amount`；新增 `saleOrderPayments` 表定义 |
| `db/migrations/00XX_order_payments_table.sql` | 建表 + 加列 + 扩枚举 |
| `db/migrations/00XY_backfill_order_payments.sql` | 数据回填（见 2.3） |

---

## 3 实施计划（按 PR 拆分）

### PR-1：Schema + 迁移（最先，阻塞后续）

| # | 任务 | 文件 |
|---|------|------|
| 1.1 | 定义 `saleOrderPayments` + 3 个新枚举 | `db/schema/order.ts`, `db/schema/enums.ts` |
| 1.2 | `sale_orders` 加 `payable_amount` 列 + 扩 `status` 枚举 | `db/schema/order.ts`, `db/schema/enums.ts` |
| 1.3 | 生成 migration | `db/migrations/00XX_*.sql` |
| 1.4 | 回填历史数据（事务脚本） | `db/scripts/backfill-payments.ts` |
| 1.5 | 双库跑（5433 dev + 5434 test），验证不变量（paid_amount 重算一致） | `db:migrate` |

### PR-2：staffApi 改造 —— 写 payments 流水

| # | 任务 | 文件 |
|---|------|------|
| 2.1 | `order.create` 入参加 `receivedAmount`（默认 `payable_amount`） | `fengyu-staff/cloudfunctions/staffApi/routes/order.js` |
| 2.2 | 创建订单事务里，根据 receivedAmount + prepaidCardAmount 插入 1~2 行 payments | 同上 |
| 2.3 | 订单 status 按决策树落地（待支付/部分支付/已支付） | 同上 |
| 2.4 | `confirmOffline` 改写：插入 payments 行（或更新 待支付→已支付） | 同上 |
| 2.5 | payNotify（微信回调）：落 payments 行，更新 sale_orders.paid_amount | `fengyu-staff/cloudfunctions/payNotify/index.js` |
| 2.6 | 单测 + 集成测试（不变量 / 幂等 / 状态机） | `fengyu-staff/cloudfunctions/staffApi/__tests__/` |

### PR-3：admin 改造 —— 同步写 payments 流水

| # | 任务 | 文件 |
|---|------|------|
| 3.1 | `createOrder` Server Action 入参加 `receivedAmount` | `fengyu-admin/src/actions/orders.ts` |
| 3.2 | 事务里插入 payments 行 | 同上 |
| 3.3 | 订单详情页显示 payments 流水表（只读） | `fengyu-admin/src/app/(dashboard)/orders/[id]/page.tsx` + 新增 `<OrderPaymentsTable>` 组件 |
| 3.4 | 开单页 step 3 新增"本次收款"输入（默认应付金额，可改） | `fengyu-admin/src/app/(dashboard)/orders/create/` |
| 3.5 | 类型检查 `cd fengyu-admin && npx tsc --noEmit` + vitest | — |

### PR-4：clientApi 支付侧改写（为 Ticket 2 打底）

| # | 任务 | 文件 |
|---|------|------|
| 4.1 | `pay / alipayPay / offlinePay` 下订单 → 写 payments 行（`change_type='首次支付'`） | `fengyu-client/cloudfunctions/clientApi/routes/order.js` |
| 4.2 | 回调回路走 payments 幂等索引 | 同上 + `payNotify` |
| 4.3 | `detail` 返回 payments 流水列表 | 同上 |
| 4.4 | 订单详情页显示 payments 流水（只读，只到本 ticket） | `fengyu-client/miniprogram/pages/order-detail/` |

### 不在本 ticket 范围

- [ ] 三端回款流程（Ticket 2）
- [ ] admin 退款补齐（Ticket 3）
- [ ] 部分支付订单的核销规则调整（默认行为沿用已支付）
- [ ] 业绩分配按 paid_amount 还是 payable_amount 计算（默认沿用现状 total_amount，留给后续 ticket）

---

## 4 验收标准

1. **Schema 基础**：`\d sale_order_payments` 显示表结构含 4 种 change_type 枚举；`\d sale_orders` 含 `payable_amount` 列和 status 枚举新增 `部分支付`；双库 DDL 一致
2. **历史回填**：存量 N 笔订单 → N 笔 payments 行；随机抽查 10 笔对账 `paid_amount = SUM(amount WHERE status='已支付')`
3. **staff 全额开单（回归）**：现有流程 receivedAmount 不传默认 payable_amount → 订单 `已支付` + 1 行 payments
4. **staff 部分开单（新功能）**：receivedAmount=100 / payable=200 → 订单 `部分支付`，paid_amount=100，payments 表 1 行 status='已支付'
5. **staff 线上待支付**：receivedAmount=200 payment_method='微信' → 订单 `待支付` + payments 行 status='待支付'；wxpay 回调到账 → payments 行转'已支付'，sale_orders 转'已支付'
6. **admin 开单**：同 3/4/5 通过 admin 入口
7. **幂等**：同一微信回调重复 2 次 → payments 表仅 1 行（唯一索引防重）
8. **client 支付改造**：client 下单 → payments 行 source_end='client'；扫码线下确认 → payments 行 source_end='staff'
9. **类型检查**：admin / staff / client 全部 `npx tsc --noEmit` / `bun run typecheck` 无错
10. **单元/集成测试**：新增 ≥ 20 个测试覆盖流水 CRUD、不变量、幂等、状态机

---

## 5 风险与决策点

| 风险/决策 | 处理方案 |
|---|---|
| 双写一致性（sale_orders.paid_amount vs payments 和） | 同事务双写；增加定时校验任务（按天对账） |
| 历史订单回填错误（payment_method 缺失） | 默认回填 `'无'`；异常订单走人工审核清单 |
| `part_paid` 订单的业绩分配 | **不在本 ticket**；留给业绩分配模块按 paid_amount 而非 total_amount 算 |
| 部分支付订单可否发起服务 | 默认允许（等同已支付）；若业务有限制，Ticket 2 再做约束 |
| 旧 `回款单` sale_orders 历史数据 | 转为对应原销售单的 payments 行；原 sale_orders 行保留作审批凭证 |
| 线上支付金额（微信/支付宝下发）需精确 | 微信 `total_fee` = `receivedAmount * 100`，非 `total_amount`；测试覆盖小数精度 |

---

## 6 前置依赖与环境

- **前置 ticket**：`2026-04-23-prepaid-card-deduction-by-store.md`（`paid_amount` / `prepaid_card_amount` 列）需先合并
- **数据库**：双 PG（5433 dev / 5434 test）都要跑 DDL
- **部署顺序**：DDL → 回填 → staffApi → admin → payNotify → clientApi（灰度避免高峰）
- **回滚**：DDL 可回滚（DROP TABLE sale_order_payments + DROP COLUMN payable_amount），但应用代码需对应版本同步回滚

---

## 7 相关引用

- **现有实现**：
  - `fengyu-staff/cloudfunctions/staffApi/routes/order.js` `create`（待加 receivedAmount 入参）
  - `fengyu-staff/cloudfunctions/staffApi/routes/order.js` `createRepayment` 行 1217-1314（Ticket 2 改写参考）
  - `fengyu-staff/cloudfunctions/staffApi/routes/order.js` `createRefund` 行 1012-1127（Ticket 3 改写参考）
  - `fengyu-admin/src/actions/orders.ts` `createOrder`（待加 receivedAmount）
  - `fengyu-client/cloudfunctions/clientApi/routes/order.js` `pay / alipayPay / offlinePay`
- **Schema**：
  - `db/schema/order.ts`（sale_orders 表）
  - `db/schema/enums.ts`（枚举定义）
- **规范文档**：
  - `.42cog/real.md` §2.1（订单状态流转）§2.2（支付幂等）
  - `.42cog/cog.md` §1-3（订单模型）
  - `.42cog/pm/backend.pr.spec.md` §3-5（订单/支付/分配）
- **项目铁律**：
  - 支付幂等（`.42cog/real.md:§2.2`）
  - 状态单向推进（`.42cog/real.md:§2.3`）
  - 待支付订单唯一性（`real.md:§2.1`）
- **并行 ticket**：
  - `2026-04-24-multi-repayment-three-ends.md`（Ticket 2）
  - `2026-04-24-refund-admin-parity-and-rules.md`（Ticket 3）
