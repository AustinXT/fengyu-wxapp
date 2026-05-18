# Ticket: sale_order_type 新增"寄存单"——剩余次数初始化的特殊订单

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-18 |
| 实施状态 | 待实施 |
| 优先级 | **P0**（与 B4 同属上线关键路径，没有寄存单就无法把 WorkFine 剩余次数导入到小程序核销）|
| 端 | db + fengyu-staff（开单页 + staffApi.order）+ fengyu-admin（订单列表筛选 + createOrder action）+ dashboard / mgmt 全量统计 SQL |
| 修复成本 | **M**（枚举扩展 + 1 个 enum 值在 38 处统计 SQL 的传播 + 双端开单流程小调整）|
| 来源 | meeting-20260507 §一.3 |
| 关联 schema | `/Users/nv/proj.xt.com/fengyu-wxapp/db/schema/enums.ts:22`（saleOrderTypeEnum）/ `/Users/nv/proj.xt.com/fengyu-wxapp/db/schema/order.ts`（sale_orders）|
| 关联代码 | `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/cloudfunctions/staffApi/routes/order.js:208-222` / `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/cloudfunctions/staffApi/routes/mgmt-product.js:176,278` / `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/cloudfunctions/staffApi/routes/mgmt-customer.js:729` |
| 关联反馈 | `notes/memory/feedback_no_shared_cloudfunctions.md`（snapshot 守护跨端一致）/ `notes/memory/feedback_no_legacy_compat.md`（开发期不做向后兼容，直接扩枚举）|

---

## 0 一句话背景

会议决定把 "WorkFine 上的剩余次数初始化到小程序" 这件事抽象为一种特殊订单类型——**寄存单**：复用 `sale_orders` + `sale_items`，复用普通订单流程（可生成服务单核销），不另建表；但所有 dashboard / mgmt 报表必须把寄存单从统计中排除（不收钱、不计营业额、不计客单价、不计提成）。

触发场景一句话："顾客到店时按其剩余卡项开寄存单，来一个倒一个"。

与 B4（WorkFine 历史订单未审核流程）的关系：B4 抓**历史销售订单**用于会员等级 / 标签 / 同环比基线；B5（本 ticket）开**剩余次数寄存单**用于核销次数。两者互补，B4 进金额维度，B5 进次数维度。

---

## 1 现状（grep 实证）

### 1.1 当前 sale_order_type 枚举（待扩展）

```ts
// db/schema/enums.ts:22
export const saleOrderTypeEnum = pgEnum("sale_order_type", ["销售单", "内部单", "转换单"]);
```

说明：回款单 / 退款单已在 2026-04-26 sale-order-domain-refactor 下沉到 `sale_order_payments.change_type`，所以本 ticket 只新增 **"寄存单"** 一个值。

### 1.2 staffApi 开单端的现状

```js
// fengyu-staff/cloudfunctions/staffApi/routes/order.js:208-217
// create 入参校验
if (saleOrderType !== '销售单' && saleOrderType !== '内部单') {
  return error('INVALID_PARAMS: sale_order_type 仅支持 销售单 / 内部单');
}

// fengyu-staff/cloudfunctions/staffApi/routes/order.js:222
if (saleOrderType === '内部单') {
  // 内部单：不允许用优惠券、走特殊价格规则
}
```

→ 寄存单与"内部单"约束类似但更严：**完全不收钱**、不允许任何抵扣、订单直接置 `已支付`。

### 1.3 dashboard / mgmt 统计 SQL（必须排除"寄存单"）

以下是已 grep 确认含 `sale_order_type IN (...)` 或 `NOT IN (...)` 的位置：

```js
// fengyu-staff/cloudfunctions/staffApi/routes/mgmt-product.js:176
AND so.sale_order_type IN ('销售单','转换单')  // → 不加 '寄存单'，天然排除

// fengyu-staff/cloudfunctions/staffApi/routes/mgmt-product.js:278
AND so.sale_order_type IN ('销售单','转换单')  // → 不加 '寄存单'

// fengyu-staff/cloudfunctions/staffApi/routes/mgmt-customer.js:729
AND o.sale_order_type NOT IN ('内部单', '转换单')  // → 显式追加 '寄存单'
```

加上 dashboard / 提成 / 营业额聚合等全量统计 SQL（约 38 处，详见 wx-change-propagation skill 的 L7 层），必须逐处 grep 校对：

- 含 `IN (...)` 包含列表 → **不**追加 '寄存单'
- 含 `NOT IN (...)` 排除列表 → **必须**追加 '寄存单'
- 无 sale_order_type 过滤但聚合金额/客单价/提成 → **必须**新增 `AND sale_order_type <> '寄存单'`

### 1.4 admin 订单列表筛选器现状

`fengyu-admin/src/app/(main)/orders/` 当前 sale_order_type 筛选器基于现有 3 值；新增 "寄存单" 选项后，要保证默认列表能区分展示，详情页能正常打开。

`fengyu-admin/src/actions/orders.ts` 的 `createOrder` 及相关 server action 需同步放行 '寄存单' 类型并应用同样的业务约束（不收钱、不抵扣、status 直 '已支付'）。

---

## 2 修复方案（5 PR）

### PR-1：枚举扩展 + migration

**文件**：`db/schema/enums.ts` + `db/migrations/00NN_*.sql`

```ts
// enums.ts:22
export const saleOrderTypeEnum = pgEnum("sale_order_type", [
  "销售单",
  "内部单",
  "转换单",
  "寄存单",   // ← 新增：WorkFine 剩余次数初始化专用，不收钱、不入统计
]);
```

走 db/CLAUDE.md 标准流程：
1. 改 enums.ts
2. `npm run db:generate`
3. 临时 PG（端口 54399）验证空库从零 apply OK
4. 对 5434/fengyu 跑 `npm run db:migrate`（5433 可选灾备双跑）
5. PR 同时包含 `schema/*.ts` + `migrations/00NN_*.sql` + `migrations/meta/`

### PR-2：staffApi 开单端 + staff 小程序开单页

**文件**：
- `fengyu-staff/cloudfunctions/staffApi/routes/order.js`
- `fengyu-staff/miniprogram/pages/order-create/order-create.ts`
- `fengyu-staff/miniprogram/pages/order-create/order-create.wxml`

#### 2.1 staffApi.order.create 业务约束

```js
// 入参校验放行 '寄存单'
if (!['销售单', '内部单', '寄存单'].includes(saleOrderType)) {
  return error('INVALID_PARAMS: sale_order_type 取值非法');
}

// 寄存单专属约束
if (saleOrderType === '寄存单') {
  // 1) 不允许任何优惠券 / 储值卡抵扣
  if (couponId || prepaidCardDeduction) {
    return error('INVALID_STATE: DEPOSIT_NO_DISCOUNT: 寄存单不允许使用优惠券或储值卡');
  }
  // 2) 强制写入：不收钱
  payableAmount = 0;
  received = 0;
  paymentMethod = '无';
  // 3) 订单状态直接置 '已支付'（无支付动作）
  initialStatus = '已支付';
  // 4) sale_items 正常写入（含 session_count / remaining_sessions），允许后续生成 service_orders
  //    sale_item 价格字段建议存原价快照供审计，但不计入 received
}
```

#### 2.2 staff 开单页 UI

- 订单类型 Tab 增加 "寄存单"，**仅店长**（`isManager()`）可见
- 选中"寄存单"后：
  - 支付方式区块隐藏（无支付）
  - 优惠券 / 储值卡入口禁用并提示 "寄存单不收款"
  - 结算页文案改为 "确认寄存"，按钮提交后直接进入"已支付"状态

#### 2.3 操作日志

- 创建寄存单时写 `operation_logs`：`operation_type='create_deposit_order'`、`target_type='sale_order'`、`target_id=saleOrderId`

### PR-3：dashboard / mgmt 全量统计 SQL 补齐"寄存单"过滤

**强制工作流**（按 wx-change-propagation L7 层执行）：

1. 全仓 grep：
   ```bash
   rg "sale_order_type" fengyu-staff/cloudfunctions/staffApi/routes/ fengyu-admin/src/ -n
   ```
2. 把命中的每条 SQL 按"包含 / 排除 / 无过滤"三类分桶
3. 按以下规则逐条修改：

| 类别 | 现状 | 改法 |
|------|------|------|
| `IN ('销售单','转换单')` | 已天然不含寄存单 | **不动** |
| `IN ('销售单')` | 已天然不含寄存单 | **不动** |
| `NOT IN ('内部单', '转换单')` | 漏掉寄存单 | 追加 → `NOT IN ('内部单','转换单','寄存单')` |
| 完全没有 sale_order_type 过滤但参与金额 / 客单价 / 提成聚合 | 漏 | 新增 `AND sale_order_type <> '寄存单'` |
| 服务单 / 次数核销 SQL | 寄存单**要**进 | 不动（寄存单本就要能生成 service_orders） |

**重点模块清单**（grep 后逐文件审计）：

- `fengyu-staff/cloudfunctions/staffApi/routes/mgmt-product.js`（已知 :176, :278）
- `fengyu-staff/cloudfunctions/staffApi/routes/mgmt-customer.js`（已知 :729）
- `fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js`（营业额 / 客流 / 客单价）
- `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js`（提成统计）
- `fengyu-staff/cloudfunctions/staffApi/routes/staff.js`（today/monthly/performance）
- `fengyu-admin/src/actions/dashboard.ts`
- `fengyu-admin/src/actions/orders.ts`（列表如默认排除寄存单需评估）
- `fengyu-admin/src/cron/steps/*.ts`（标签 / 等级重算如涉及金额必须排除）

### PR-4：admin 端列表 + createOrder action

**文件**：
- `fengyu-admin/src/app/(main)/orders/_components/orders-page.tsx`（或同等 list 组件）
- `fengyu-admin/src/app/(main)/orders/[id]/_components/order-detail-page.tsx`
- `fengyu-admin/src/actions/orders.ts`

#### 4.1 列表筛选

- sale_order_type 下拉新增 "寄存单"
- 列表默认查询行为：与现有 4 值并列展示（不默认隐藏），由用户主动筛选
- 列表行额外标识：在"订单类型"列以灰底标签呈现 "寄存单"，便于一眼区分非业务订单

#### 4.2 详情页

- 寄存单详情金额区显示 `应收 0 / 实收 0 / 支付方式 无`
- 顶部加 banner："此订单为剩余次数寄存单，不计入营业额统计"

#### 4.3 createOrder server action

- 与 PR-2 同步放行 '寄存单'，应用同等业务约束（payable=0 / received=0 / status='已支付' / 禁优惠券与储值卡）
- 入参 Zod schema 把 '寄存单' 加入 `z.enum([...])`

### PR-5：跨端一致性与回归校验

#### 5.1 snapshot 测试守护

- `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-sql-snapshot.test.js`：如 PR-3 涉及 staffApi / admin 同字面 SQL，更新 snapshot 一并验证两端漂移
- `cross-end-error-codes-snapshot.test.js`：如 PR-2 新增 `INVALID_STATE: DEPOSIT_NO_DISCOUNT` 子标签，确认子标签前缀符合 `[A-Z_]+`（一级前缀仍走白名单）

#### 5.2 回归用例

新增 e2e 测试 case：
- 用 `bun fengyu-staff/tests/e2e-cloudfn/run-all.mjs --filter order` 验证寄存单创建链路
- 新增"插入 1 条寄存单前后 dashboard 数字不变"断言（详见 §3 DoD）

#### 5.3 spec 文档同步

- `.42cog/pm/backend.pr.spec.md`：sale_order_type 章节 3→4 值，新增"寄存单"语义说明
- `.42cog/pm/admin.pr.spec.md`：订单列表筛选新增 "寄存单" AC
- `.42cog/pm/staff.pr.spec.md`：店长开单流程加 "寄存单" 分支
- memory 新增 `project_deposit_sale_order_type.md`：记录"为什么寄存单复用 sale_orders 而不新表"的设计决策

---

## 3 验收标准（DoD）

### PR-1 schema
- [ ] `saleOrderTypeEnum` 4 值 (`销售单 / 内部单 / 转换单 / 寄存单`) 在 5434/fengyu 落地
- [ ] 临时 PG 空库从零 apply OK
- [ ] `cd fengyu-admin && npx tsc --noEmit` 0 错误
- [ ] `db/migrations/meta/_journal.json` 与 schema 一致

### PR-2 staff 开单
- [ ] staffApi.order.create 入参 '寄存单' 放行；'销售单' / '内部单' 行为不变
- [ ] 开 1 单寄存单：`SELECT received, payable_amount, payment_method, status FROM sale_orders WHERE sale_order_id=?` → `0, 0, '无', '已支付'`
- [ ] 寄存单可生成 service_orders 并能正常核销（service.complete 扣减 remaining_sessions 链路通）
- [ ] 寄存单尝试用优惠券 / 储值卡 → 报 `INVALID_STATE: DEPOSIT_NO_DISCOUNT: ...`
- [ ] staff 端非店长账号订单类型 Tab 看不到 "寄存单"
- [ ] operation_logs 写入 `operation_type='create_deposit_order'`

### PR-3 统计 SQL 全量过滤
- [ ] grep 报告：列出全仓所有 `sale_order_type` 命中（约 38 处），逐条标注"已天然排除 / 已显式加 / 不需要加"
- [ ] 回归测试：在测试库插入 1 条 `total_amount=99999` 的寄存单 sale_orders 行 + 1 条 sale_items
- [ ] 核心 5 指标在插入"前 / 后"完全一致：
  - 当天 / 当月营业额
  - 客单价
  - 客流量
  - 品类分析金额
  - 员工提成总额

### PR-4 admin
- [ ] /orders 列表 sale_order_type 下拉新增 "寄存单"，能筛选出寄存单行
- [ ] /orders/[id] 详情页打开寄存单不报错，顶部 banner 正确显示
- [ ] admin createOrder action 与 staff 行为对齐（已支付 / 0 收款 / 禁抵扣）
- [ ] 权限矩阵：店长 / admin 可创建寄存单；其他角色 403

### PR-5 跨端 + 文档
- [ ] `cross-end-sql-snapshot.test.js` 通过（如有 SQL 字面量改动则 snapshot 同步更新）
- [ ] `cross-end-error-codes-snapshot.test.js` 通过
- [ ] `bun fengyu-staff/tests/e2e-cloudfn/run-all.mjs --filter order` 全绿
- [ ] `bun fengyu-staff/tests/e2e-cloudfn/run-all.mjs --filter mgmt` 全绿（验证统计不污染）
- [ ] backend.pr.spec.md / admin.pr.spec.md / staff.pr.spec.md 同步
- [ ] memory `project_deposit_sale_order_type.md` 写入

### 跨端影响传播表（wx-change-propagation L0-L10 对照）

| 层 | 影响点 | 状态 |
|----|--------|------|
| L0 | `db/schema/enums.ts` saleOrderTypeEnum | PR-1 |
| L1 | drizzle migration + 5434 落地 | PR-1 |
| L3 | staffApi.order.create + admin.actions.orders.createOrder | PR-2 / PR-4 |
| L5 | mgmt-* 统计 SQL（约 38 处） | PR-3 |
| L7 | dashboard 聚合（营业额 / 客流 / 客单价 / 品类 / 提成）| PR-3 |
| L8 | admin/staff 列表 UI 筛选器 + 详情页 banner | PR-2 / PR-4 |
| L9 | backend.pr.spec.md + admin.pr.spec.md + staff.pr.spec.md | PR-5 |

---

## 4 风险与回滚

| 风险 | 缓解 |
|------|------|
| 漏改某条统计 SQL → 寄存单金额污染 dashboard | PR-3 强制 grep 全仓 + e2e "插入前后数字不变" 断言守护 |
| 寄存单生成 service_orders 后核销次数链路有差异 | service.complete 与销售单完全同分支，仅 sale_orders.received=0 不影响 service_items.remaining_sessions 扣减 |
| admin / staff 任一端漏放行 '寄存单' 导致跨端不一致 | PR-5 cross-end snapshot 测试守护；改一端必同步另一端 |
| 历史 sale_order_type 数据迁移 | 本 ticket 不抓历史数据（那是 B4 的事），上线前 PG 清空（参考 `project_pre_launch_data_wipe.md`），寄存单从上线后日常开始正常开 |
| 操作员误把"内部单"开成"寄存单"导致客户次数被白送 | 仅店长可见 "寄存单" Tab + admin operation_logs 全记录 + 详情页明显灰底标识 |
| 寄存单 `sale_items.unit_real_price` 是否要快照原价用于审计 | 建议存原价快照（不影响 received），便于将来对账 / 退寄存。验收时确认字段填法在 schema 注释里写明 |

**回滚**：
- PR-1 枚举：drizzle-kit 不支持 enum value 删除；如需回滚需手写 `ALTER TYPE ... RENAME VALUE` 或新写 migration 把 '寄存单' 全部 UPDATE 成 '内部单' 再 DROP 枚举值（PG 14+ 支持），评估为成本高、不主动回滚
- PR-2/4 代码：commit revert
- PR-3 SQL 改动：commit revert（不影响已存在的寄存单数据语义）

---

## 5 关联

| 项 | 说明 |
|----|------|
| 来源 | `notes/meetings/meeting-20260507/article.md` §一.3 |
| 关联 schema | `/Users/nv/proj.xt.com/fengyu-wxapp/db/schema/enums.ts:22` saleOrderTypeEnum |
| 关联代码 | `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/cloudfunctions/staffApi/routes/order.js` `mgmt-product.js` `mgmt-customer.js` / `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/orders.ts` |
| 关联 ticket | 姊妹 ticket `/Users/nv/proj.xt.com/fengyu-wxapp/notes/tickets/2026-05-18-workfine-legacy-orders-unaudited-flow.md`（B4 抓历史订单金额维度；B5 本 ticket 开寄存单核销次数维度）|
| 关联 feedback | `notes/memory/feedback_no_shared_cloudfunctions.md`（snapshot 守护）/ `notes/memory/feedback_no_legacy_compat.md`（开发期直接扩枚举）|
| 关联 skill | `wx-change-propagation`（结构性变更 L0-L10 传播图，本 ticket 严格按此执行）|
| 关联 spec | 实施后需更新 `.42cog/pm/backend.pr.spec.md` + `admin.pr.spec.md` + `staff.pr.spec.md` |

---

## 完成记录

- **完成日期**：2026-05-18
- **完成 commit**：
  - `fae6cea` feat(db): legacy_orders + 寄存单 双特性 schema 迁移（0037+0038）— migration 0038 + saleOrderTypeEnum 加 '寄存单'
  - `3ffef69` feat(deposit-order): B5 寄存单全链路（admin/staff/小程序 createDeposit）— 14 文件 / 892 行
  - `7a35e83` feat(admin/deposit-order): 寄存单 admin 入口 + 独立创建页 — 3 文件 / 391 行
- **实际落地清单**（合计 17 文件）：
  - **db schema**：`db/schema/enums.ts` + `db/migrations/0038_steady_jazinda.sql`
  - **staff 云函数**：`staffApi/routes/order.js` 新增 `createDeposit`（226 行，独立 action，参考 createConversion/createPickup 范式；非 order.create 分支）
  - **staff 小程序**：`pages/order-create/order-create.{ts,wxml,wxss}` 4 选 1 单据类型 + 独立 `_submitDeposit` 流程（无付款码）
  - **admin actions**：`actions/orders.ts` 新增 `createDepositOrder`（227 行，与 staff 端镜像）
  - **admin UI**：`/orders/create-deposit/page.tsx` + `_components/deposit-order-create-page.tsx`（368 行，与 /orders/create 解耦：仅 `getProductsByKind('__normal__')`）
  - **admin 列表/详情**：`orders/_components/orders-page.tsx` grey badge + `order-detail-page.tsx` 顶部 banner "不计营业额/提成/客单价"
  - **统计 SQL**：
    - 持卡人数 `mgmt-product.cardHolders`：IN list **加** '寄存单'（次数维度纳入）
    - 赠送记录 `giftHistory`（staff/admin 两端）：NOT IN **加** '寄存单'
    - 金额维度（营业额/提成/客单价/dashboard）：天然由 `IN ('销售单','转换单')` 排除 → 不动
  - **测试**：`staffApi/__tests__/routes/mgmt-product.test.js` 形态守卫同步更新
  - **spec**：`.42cog/pm/backend.pr.spec.md` §2.8 四种销售单据模型 + INVALID_STATE 错误码
- **DoD 偏差**：
  - [x] PR-1 enum 在 5434 落地（migration 0038）
  - [x] PR-2 staff/admin createDeposit 全链路（独立 action 范式，**未**走 order.create 分支）
  - [x] PR-3 mgmt 统计 SQL 全量加过滤（金额排除 / 次数 cardHolders 纳入）
  - [x] PR-4 admin /orders 列表筛选 + 创建入口
  - [x] PR-5 dashboard 不受寄存单污染（cross-end snapshot 测试通过）
- **决策应用**：D4=A（实际 admin 也独立 `/orders/create-deposit` 入口，比 ticket 设计更明确）/ D5=A（不生成 sale_allocations）
- **架构亮点**：未走"在 order.create 加分支"的捷径，而是新建独立 `createDeposit` / `createDepositOrder` action，符合现有 `createConversion`/`createPickup`/`createRefund` 范式
- **关联归档**：同批 `2026-05-18-workfine-legacy-orders-unaudited-flow.md` / `2026-05-18-treatment-card-listing-filter-audit.md`
- **关联 memory**：`project_deposit_sale_order_type.md`
