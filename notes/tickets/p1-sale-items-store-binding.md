# Ticket: P1 顾客卡/院装产品与门店绑定

> 生成日期：2026-04-15
> 严重级别：P1（业务规则强约束；当前实现允许跨店核销卡与跨店提货，违反"一店一账户"规则）
> 关联进行中改动：`db/schema/prepaid-card.ts`（充值卡已先行，未提交 diff）
> 修复归属：拆 2 个 PR 上线，共享一个 feature 分支
> - PR-A：`db/schema` + `db/migrations` + staffApi 写入/校验（P0 阻塞其它）
> - PR-B：clientApi + 两端小程序 UI + admin（可选）

---

## 0 一句话背景

当前数据模型里，**顾客已购的疗程卡、单次卡（体验卡）、院装产品都没有 `store_id` 字段**，必须 JOIN `sale_orders` 才能推导"这张卡是哪家店卖的"。业务规则要求：**一张卡只能在购买门店使用**（与充值卡"一户一店一账户"口径一致）。核销/提货的关键路径上目前都没有这个校验，导致：

1. 员工端 `service.complete` 的原子 UPDATE 不 WHERE `store_id`，可以用 A 店卡做 B 店服务
2. 员工端 `customer.paidOrders` 不按 `ctx.auth.storeId` 过滤，B 店员工能看到并选中 A 店卡开服务单
3. 客户端 `order.appointableItems` 返回用户全部订单的卡，无"跨店禁用"提示
4. 院装产品 `pickup_records` 记录了提货门店，但没有对比 `sale_items` 的购买门店

本 ticket 把 `sale_items` 从"门店关系靠 JOIN 推导"升级为"门店快照 + 入库写入 + 核销/提货/查询全链路强制校验"。**`prepaid_cards` 已由另一处未提交 diff 先行处理**，本 ticket 不重复，仅在迁移时确认其一致。

---

## 1 问题定位

### 1.1 数据模型（db/schema）

| 位置 | 说明 |
|---|---|
| `db/schema/order.ts:108-158` | `sale_items` 无 `store_id` 列，门店关系隐含在 `sale_order_id → sale_orders.store_id` |
| `db/schema/order.ts:117` | `ref_sale_item_id` 支持回款/转换/退款引用原销售行，同一张卡的派生行必须继承同一 `store_id` |
| `db/schema/service.ts:15-47` | `service_orders.store_id` 已有（NOT NULL）— 核销端有基准值可对比 |
| `db/schema/pickup.ts:14-42` | `pickup_records.store_id` 已有 — 提货端有基准值可对比，但代码未做比对 |
| `db/schema/prepaid-card.ts`（未提交 diff） | 充值卡 `store_id` 已从 nullable 改为 NOT NULL + `UNIQUE(user_id, store_id)`，本 ticket 的卡/产品延用同一语义但无 UNIQUE（一个顾客在同店可有多张疗程卡） |

### 1.2 后端（staffApi 云函数）

**INSERT 侧（order.js 共 5 处）** — 都未写入 `store_id`：

| 位置 | 单据类型 | store_id 来源 |
|---|---|---|
| `fengyu-staff/cloudfunctions/staffApi/routes/order.js:471` | 销售单 create | `ctx.auth.storeId`（或 `orderRow.store_id`） |
| `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1039` | 退款单 refund | **继承** `ref_sale_items.store_id`（必须与原销售行一致，禁止跨店退款） |
| `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1220` | 回款单 repay | **继承** `ref_sale_items.store_id` |
| `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1374` | 转换单 convert_out | **继承** `ref_sale_items.store_id` |
| `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1405` | 转换单 convert_in | `ctx.auth.storeId`（新生成的卡绑当前店） |

**核销侧（service.js）** — 原子 UPDATE 未校验门店：

| 位置 | 说明 |
|---|---|
| `fengyu-staff/cloudfunctions/staffApi/routes/service.js:336-342` | `UPDATE sale_items SET remaining_sessions = remaining_sessions - $1 WHERE sale_item_id = $2 AND remaining_sessions >= $1 AND remaining_sessions IS NOT NULL` — 必须增加 `AND store_id = $3` 并把 `service_orders.store_id` 作为第三个参数传入 |
| `fengyu-staff/cloudfunctions/staffApi/routes/service.js:81-112`（前置校验区，预计位置） | 取卡信息的 SELECT 已经 JOIN `sale_orders` 拿到 store_id，本 ticket 直接从 `si.store_id` 读，并在进入事务前先行 `throw 'INVALID_PARAMS: 卡不属于当前门店'` |

**提货侧（order.js / pickup 动作）**：

| 位置 | 说明 |
|---|---|
| `fengyu-staff/cloudfunctions/staffApi/routes/order.js`（pickup 动作 INSERT pickup_records 处） | 当前原子累加 `sale_items.picked_up_quantity` 时未 WHERE `store_id`；同样要加 `AND store_id = $ctx.auth.storeId`，确保"只能在购买门店提货" |

**查询侧（customer.js / order.js）**：

| 位置 | 说明 |
|---|---|
| `fengyu-staff/cloudfunctions/staffApi/routes/customer.js`（`paidOrders` action） | 查顾客已购订单 SQL 无 `AND o.store_id = $ctx.auth.storeId`，员工能看到顾客跨店卡；需加门店过滤，同时返回 `store_id` / `store_name` 供前端区分 |
| `fengyu-staff/cloudfunctions/staffApi/routes/customer.js`（`detail` action） | 如返回"最近服务/最近购买"等汇总是否按店过滤，需要 review |

### 1.3 客户端（clientApi 云函数 + fengyu-client/miniprogram）

| 位置 | 说明 |
|---|---|
| `fengyu-client/cloudfunctions/clientApi/routes/order.js`（`appointableItems` action） | 返回可预约/可核销的卡清单。当前返回用户全部已支付订单的 items，不按门店过滤；本 ticket 要求返回时带上 `store_id` + `store_name`，并由前端显示"在 X 店可用"标记（是否强制过滤到用户 `boundStoreId` 需产品确认，默认保守：显示但不过滤） |
| `fengyu-client/cloudfunctions/clientApi/routes/service.js`（`list` action） | 服务记录列表返回的 store 字段来自 `service_orders.store_id`，不受本 ticket 影响 |
| `fengyu-client/miniprogram/pagesOrder/treatment-cards/treatment-cards.ts` / `.wxml` | "我的疗程卡"页面，卡片需显示门店名；跨店卡可 gray/tag "仅 X 店可用" |
| `fengyu-client/miniprogram/pagesProfile/prepaid-cards/prepaid-cards.ts` | 充值卡由另一改动处理，本 ticket 只校对字段命名一致 |
| `fengyu-client/miniprogram/pagesAppointment/appointment-create/appointment-create.ts` | 预约创建时选卡：前端 appointableItems 返回带 store_id 后，需把不属于预约门店的卡禁用或隐藏 |

### 1.4 员工端小程序（fengyu-staff/miniprogram）

| 位置 | 说明 |
|---|---|
| `fengyu-staff/miniprogram/packageService/service-create/service-create.ts` | 开服务单时通过 `customer.paidOrders` 取卡下拉。API 侧加了店过滤后，前端改为显示"本店卡"并提示"如需跨店核销请先转店" |
| `fengyu-staff/miniprogram/packageCustomer/customer-detail/customer-detail.ts` | 顾客详情页若展示"全部卡包"，按店分组；若 API 仅返回本店卡，在空态增加"顾客在本店无已购卡" |

### 1.5 管理后台（fengyu-admin，可选）

- 目前无"卡包管理"独立页，顾客详情页展示已购订单时本 ticket 只需保证 Drizzle 查询不破，新列 `sale_items.store_id` 自动跟着 schema 推导即可
- 若未来增"卡包管理"页，可据此字段做跨店转卡功能（超纲）

---

## 2 设计决策

### 2.1 字段冗余 vs 纯 JOIN

**方案选定：冗余**。在 `sale_items` 新增 `store_id text NOT NULL REFERENCES stores(store_id)`。

| 理由 | 说明 |
|---|---|
| 核销路径最薄 | 原子 `UPDATE sale_items ... WHERE store_id = $X` 不需要事务内二次 SELECT JOIN |
| 索引收益 | `(store_id, sale_order_id)` 组合索引覆盖"员工端查本店顾客卡"主查询 |
| 单据变换一致 | 回款/转换/退款通过 `ref_sale_item_id` 必须继承原店，用冗余字段使约束可数据库级校验（见 §2.2 约束） |
| 数据量可控 | 美容院体量 `sale_items` 不会成为热点表，增 1 列无显著代价 |

### 2.2 数据库级约束（CHECK / TRIGGER）

**轻量 CHECK（加）**：
- `sale_items.store_id` NOT NULL（FK 到 stores）

**继承约束（可选，加）**：
- 一个 `CHECK` 或触发器保证：当 `ref_sale_item_id IS NOT NULL` 时 `store_id == (SELECT store_id FROM sale_items WHERE sale_item_id = ref_sale_item_id)`
- 风险：触发器会复杂化 drizzle-kit 的 snapshot diff；**本 ticket 选择不加触发器**，改为在云函数 INSERT 派生行时，`store_id` 直接取原行 `store_id`（见 §1.2 表格），由代码保证

**UNIQUE（不加）**：
- 与 `prepaid_cards.UNIQUE(user_id, store_id)` 不同，疗程卡允许同顾客同店多张卡

### 2.3 院装产品的语义

- `sale_items.product_type = '院装产品'` 的行：`store_id` 表示"只能在此店提货"
- 提货动作 (`pickup_records` INSERT) 在事务内：
  1. `UPDATE sale_items SET picked_up_quantity = picked_up_quantity + $1 WHERE sale_item_id = $2 AND store_id = $3 AND (quantity - picked_up_quantity) >= $1` — 加了 `store_id = $3`
  2. `INSERT INTO pickup_records (sale_item_id, pickup_quantity, store_id, ...)` — `pickup_records.store_id` 必须等于 `sale_items.store_id`（代码保证，不加触发器）

### 2.4 历史数据

**本项目 feedback 明确："开发阶段不需要历史数据兼容或向后兼容逻辑"** （参见 memory `feedback_no_legacy_compat.md`）。因此：

- 迁移策略：直接 `ADD COLUMN store_id NOT NULL`，允许迁移前清空 `sale_items` 或回填后再加 NOT NULL
- 推荐 SQL（migration 末尾手写，drizzle-kit 生成后追加）：
  ```sql
  -- Step 1: 先加 nullable
  ALTER TABLE sale_items ADD COLUMN store_id text;
  -- Step 2: 回填（从 sale_orders 取）
  UPDATE sale_items si
  SET store_id = so.store_id
  FROM sale_orders so
  WHERE si.sale_order_id = so.sale_order_id;
  -- Step 3: 加 NOT NULL + FK + 索引
  ALTER TABLE sale_items ALTER COLUMN store_id SET NOT NULL;
  ALTER TABLE sale_items
    ADD CONSTRAINT sale_items_store_id_fkey
    FOREIGN KEY (store_id) REFERENCES stores(store_id);
  CREATE INDEX idx_sale_items_store_order ON sale_items(store_id, sale_order_id);
  ```
- 注意：此为 drizzle-kit 生成 SQL 之外的**手写追加**部分，符合 `db/CLAUDE.md` "唯一例外"条款

### 2.5 与充值卡 diff 的协调

- `db/schema/prepaid-card.ts` 当前未提交 diff 已将 `store_id` 改为 NOT NULL + UNIQUE
- 本 ticket 的改动**不要覆盖或回滚**该 diff；建议把两块改动合并进同一个 `db:generate` 产物，再跑一次 `db:migrate`（两库都跑）
- 前端充值卡页面改动由充值卡那条线自管，本 ticket 不处理

---

## 3 实施计划（按 PR 拆分）

### PR-A（阻塞其他，必须先落地）

**目标**：DB schema 落地 + 云函数写入/校验闭环，保证上线后新卡全链路强制绑店、核销拒绝跨店。

| # | 任务 | 文件 |
|---|------|------|
| A1 | `sale_items` 新增 `storeId` 字段（Drizzle） | `db/schema/order.ts` |
| A2 | 新增 `(store_id, sale_order_id)` 组合索引 | 同上 |
| A3 | `db:generate` 并在生成的 SQL 末尾追加回填 + NOT NULL 收紧 DDL（见 §2.4） | `db/migrations/00NN_*.sql` |
| A4 | 本地临时 PG 空库 `db:migrate` 验证一次 | 文档流程 |
| A5 | staffApi order.js 5 处 INSERT `sale_items` 加 `store_id` 列与参数 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js`:471/1039/1220/1374/1405 |
| A6 | staffApi service.js 原子 UPDATE 加 `AND store_id = $3`，失败时抛 `INVALID_PARAMS: 跨店核销禁止` | `fengyu-staff/cloudfunctions/staffApi/routes/service.js`:336-342 |
| A7 | staffApi service.js 前置校验区 SELECT 改为直接取 `si.store_id`，不再 JOIN sale_orders 推导 | 同上 |
| A8 | staffApi order.js 院装提货动作 UPDATE 加 `AND store_id = $` | `fengyu-staff/cloudfunctions/staffApi/routes/order.js`（pickup 段） |
| A9 | staffApi customer.paidOrders SQL 加 `AND o.store_id = $ctx.auth.storeId`，并返回 `store_id`/`store_name` | `fengyu-staff/cloudfunctions/staffApi/routes/customer.js` |
| A10 | 更新 staffApi 单测：新增"跨店核销应拒绝"、"跨店提货应拒绝"、"customer.paidOrders 只返回本店卡"三条 | `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/` |
| A11 | 两库都跑 `db:migrate`（5434/fengyu + 5433/fengyu_wxapp） | 文档流程 |
| A12 | staffApi 部署（按 cloudbase-deploy skill，禁止 `fn deploy --force`） | 文档流程 |

**A6 关键 SQL（最终形态）**：

```javascript
// service.js complete action
const updateResult = await client.query(
  `UPDATE sale_items
   SET remaining_sessions = remaining_sessions - $1
   WHERE sale_item_id = $2
     AND store_id = $3
     AND remaining_sessions >= $1
     AND remaining_sessions IS NOT NULL`,
  [item.session_used, item.sale_item_id, serviceOrder.store_id]
)
if (updateResult.rowCount === 0) {
  // 区分两种失败：次数不够 vs 跨店
  const probe = await client.query(
    `SELECT store_id, remaining_sessions FROM sale_items WHERE sale_item_id = $1`,
    [item.sale_item_id]
  )
  if (probe.rows[0]?.store_id !== serviceOrder.store_id) {
    throw new Error('INVALID_PARAMS: 该卡仅在 ' + probe.rows[0]?.store_id + ' 可用，当前门店无法核销')
  }
  throw new Error('INVALID_PARAMS: 剩余次数不足')
}
```

### PR-B（可与 PR-A 并行开发，PR-A 先 merge）

**目标**：两端小程序 UI 显示门店归属 + 跨店卡前端禁用。

| # | 任务 | 文件 |
|---|------|------|
| B1 | clientApi `appointableItems` SQL 返回 `store_id`/`store_name` | `fengyu-client/cloudfunctions/clientApi/routes/order.js` |
| B2 | clientApi `card.list` / 相关 list 返回值一致性 review | `fengyu-client/cloudfunctions/clientApi/routes/card.js` 等 |
| B3 | 客户端 treatment-cards 页面：卡片显示门店名；非预约门店的卡加"仅 X 店可用"tag | `fengyu-client/miniprogram/pagesOrder/treatment-cards/treatment-cards.{ts,wxml,wxss}` |
| B4 | 客户端 appointment-create：选卡时禁用非预约门店的卡 | `fengyu-client/miniprogram/pagesAppointment/appointment-create/appointment-create.ts` |
| B5 | 员工端 service-create：卡下拉已经只有本店（PR-A 生效后），加空态"本店无可用卡" | `fengyu-staff/miniprogram/packageService/service-create/service-create.ts` |
| B6 | 员工端 customer-detail："已购卡"区块加"仅显示本店" 的提示文案 | `fengyu-staff/miniprogram/packageCustomer/customer-detail/customer-detail.ts` |
| B7 | clientApi/staffApi 前端类型定义同步 store_id 字段 | 各 `.d.ts` / 类型文件 |

### 不在本 ticket 范围内

- [ ] 管理后台"顾客卡包管理"独立页（超纲）
- [ ] "卡转店"业务流（顾客主动申请把 A 店卡转到 B 店）
- [ ] 跨店核销审批（未来若产品放开需求，可在 sale_items 增 `cross_store_allowed` 标记位，本 ticket 不做）
- [ ] 充值卡改动（另一处未提交 diff 已先行，本 ticket 不重复）

---

## 4 验收标准

1. **DB schema**：`sale_items.store_id` 存在、NOT NULL、有 FK 到 `stores`、有 `(store_id, sale_order_id)` 索引；两库（5434 + 5433）都已迁移
2. **入库**：staffApi order.js 全部 5 处 INSERT 写入 `store_id`；销售/转入用 `ctx.auth.storeId`，退款/回款/转出用 `ref_sale_items.store_id` 继承
3. **核销**：staffApi service.complete 用 A 店卡做 B 店服务单 → 报错 `INVALID_PARAMS: 该卡仅在 X 可用`；次数不足 → 报错 `INVALID_PARAMS: 剩余次数不足`
4. **提货**：staffApi pickup 用 A 店院装产品在 B 店提货 → 报错；同店提货正常
5. **员工查询**：staffApi customer.paidOrders 在 B 店登录查 A 店顾客 → 只返回顾客在 B 店的已购卡（0 条也合法）
6. **客户端显示**：顾客"我的疗程卡"页面每张卡显示所属店名；预约页选卡时非预约店的卡置灰
7. **单测**：PR-A 新增至少 3 条云函数单测（跨店核销拒、跨店提货拒、paidOrders 店过滤）全绿
8. **回归**：原有 staffApi/clientApi 测试套件不出现 regression

---

## 5 风险与缓解

| 风险 | 缓解 |
|---|---|
| 迁移时 `sale_orders` 中存在 `store_id` 为无效外键的历史行导致回填后 NOT NULL 失败 | 迁移前 `SELECT COUNT(*) FROM sale_orders WHERE store_id NOT IN (SELECT store_id FROM stores)` 预检；开发阶段可直接 TRUNCATE 重录 |
| drizzle-kit 自动生成的 SQL 会把"加列→NOT NULL→FK"分成多步还是合成一步 | 生成后人工 review migration SQL，必要时拆分顺序并在末尾追加回填 UPDATE |
| 现有回款/转换/退款测试可能不覆盖"派生行 store_id 继承"路径 | PR-A A10 的单测须补 |
| CloudBase 部署后环境变量被 `--force` 重置 | 按 cloudbase-deploy skill 的 `tcb fn code update`，**禁止** `tcb fn deploy --force` |
| PR-A 和充值卡未提交 diff 合并顺序混乱 | 建议先 `git add -p db/schema/prepaid-card.ts` 合入本 ticket feature 分支，再 `db:generate` 一次出完整 migration |

---

## 6 前置依赖与环境

- Drizzle 迁移流程（db/CLAUDE.md 严格模式）
- 两个 PG 实例都需有权限：5434/fengyu + 5433/fengyu_wxapp
- 临时空库 docker 容器用于 migration 零起验证（见 db/CLAUDE.md "临时 PG" 段）
- staffApi 部署通过 cloudbase-mcp MCP 或 `tcb fn code update`

---

## 7 相关文档

- `db/CLAUDE.md` — Drizzle 工作流 + 两库同步规范
- `db/schema/order.ts` — sale_orders / sale_items / sale_allocations 定义
- `db/schema/service.ts` — service_orders / service_items 定义
- `db/schema/pickup.ts` — pickup_records 定义
- `db/schema/prepaid-card.ts` — 充值卡（对照参考 UNIQUE 约束写法）
- `.42cog/cog.md` — 认知模型中的"门店"与"卡包"实体定义
- memory `feedback_no_legacy_compat.md` — 开发阶段不做历史兼容（本 ticket 据此选择直接回填 + NOT NULL）
- memory `project_cloudbase_envvar_risk.md` — 部署风险提醒
- memory `project_db_dual_env.md` — 两库同步规范
