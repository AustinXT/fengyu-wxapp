# Ticket: 管理层数据中心首页「项目数」指标落地

> 生成日期：2026-04-25
> 严重级别：P2（占位 -- 已上线，本 ticket 把它换成真实数；不阻塞其他 ticket）
> 端：DB schema + staffApi（service.create 写入 + mgmt-dashboard.summary 查询）+ fengyu-staff 前端
> 影响面：1 张表加 1 列 / 2 处写入路径补快照 / 1 处查询接口出数 / 1 处前端渲染 / 1 处文档登记
> 前置：[mgmt-dashboard-snapshot-fields](./archives/2026-04-25-mgmt-dashboard-snapshot-fields.md) 已落地（service_items 已具备 sale_items 快照拷贝模式）
> 后置：无
>
> **一句话目标**：把"项目数"指标的口径定下来 —
> `SUM(service_items.session_used) WHERE sales_category IN ('自销自耗','他销自耗') AND service_orders.status = '已完成'`，
> 为此给 `service_items` 加 `sales_category` 快照列、在 `service.create` 写入时从 `sale_items` 拷贝、
> 在 `mgmtDashboard.summary` 输出真实 `projectCount`、前端把硬编码 `--` 替换为真实数、并在 `metrics.md` 登记。

---

## 0 一句话背景

`pages/mgmt-dashboard` 的"数据中心" tab 目前 8 卡片中 7 项已出数，唯独"项目数"小卡 + 派生"人均项目数"
卡仍写死 `--`。`mgmtDashboard.summary` 接口返回 `projectCount: { today: 0, month: 0 }`，前端 `buildDisplay`
强制覆盖为 `--`，并标记 TODO（`mgmt-dashboard.js:461`、`mgmt-dashboard.ts:247/270`）。

业务方已明确：「**项目数 = 服务明细中"凤御自销+自耗"和"凤御自耗"两类项目的实际划卡次数之和**」。
对应到 schema 即 `service_items.session_used` SUM，按 `sales_category` 过滤。

> 关于命名：2026-04-25 已完成 `salesCategoryEnum` 翻新（旧 `自采自销` → `自销自耗`），
> 详见 `notes/adapt-plans/00-decisions.md` #2 与 migration `0009_*`。
> 本 ticket 直接使用最新枚举值 `自销自耗` + `他销自耗`。

`service_items` 当前**没有** `sales_category` 列。如果不补快照，统计 SQL 必须 `JOIN sale_items` 拿
`sale_items.sales_category`，性能勉强可接受，但语义脆弱：`sale_items.sales_category` 不可变（开单时
固化），从 `service_items` 反查到 `sale_items` 实际是稳定的，但**多 1 次 JOIN 之后顺手再 JOIN
service_orders 拿 status/service_date** 已经 3 表，到管理层"今日 + 本月" 2 次查询每次 3 表 JOIN，
不如把 `sales_category` 与 `unit_real_price`、`is_shengmei` 一起在 `service_items` 上落快照（这 3 个
字段都遵循"开单时落"的同一模式）。

---

## 1 字段定义

### 1.1 `service_items.sales_category`（新增列）

```ts
// db/schema/service.ts，加在 isShengmei 附近（约 line 62）
import { allocationStatusEnum, salesCategoryEnum, serviceOrderStatusEnum, serviceOrderTypeEnum } from './enums'

// serviceItems 内追加：
salesCategory: salesCategoryEnum('sales_category'),
```

- 类型：`sales_category` 枚举（与 `sale_items.sales_category` 同枚举），**可空**
- 来源：`service.create` 时从对应 `sale_items.sales_category` 拷贝快照
- 不可变：service_item 创建后不再修改（即便 sale_items 被改也不动）
- 与现有 `is_shengmei`、`unit_real_price` 三个快照字段共享同一来源（sale_items），共用同一查询

> **为什么不 JOIN sale_items 即时算**：避免 sale_items 列变更（如未来引入 `sales_category` 修订）后历史
> 统计漂移；同 ticket1 对 `is_shengmei` 的处理。

---

## 2 Migration

### 2.1 生成

```bash
cd db && npm run db:generate
```

drizzle-kit 应产出形如 `migrations/0009_<adjective>_<noun>.sql`：

```sql
ALTER TABLE "service_items" ADD COLUMN "sales_category" "sales_category";
```

### 2.2 历史回填（追加在生成的 .sql 末尾）

按 `db/CLAUDE.md` §2 约定，**只能追加**手写 UPDATE，不能修改 drizzle-kit 生成的 ALTER：

```sql
-- 历史回填：service_items.sales_category ← sale_items.sales_category
UPDATE service_items sit
SET sales_category = si.sales_category
FROM sale_items si
WHERE sit.sale_item_id = si.sale_item_id
  AND sit.sales_category IS NULL;
```

> **本地验证**：按 `db/CLAUDE.md` §2.1 步骤 3，临时起 docker PG 跑一次空库 migrate 确认。

### 2.3 部署

按 `db/CLAUDE.md` §3 强制要求：**5434/fengyu** 和 **5433/fengyu_wxapp** 都跑 `db:migrate`，缺一会再次 drift。

---

## 3 写入路径修改

### 3.1 `staffApi/routes/service.js` — `service.create` 写 `sales_category`

定位：`service.js:195-222`。当前 SELECT `sale_items` 时已经取了 `sku_id, unit_real_price, is_shengmei`，
INSERT `service_items` 时已经把 `is_shengmei` 一起写入。本 ticket 把 `sales_category` 加进来（字段名、
变量名、SELECT 列表、INSERT 列表 + 占位符全部按现有模式扩展）。

```js
// SELECT 多取一列
const siRows = await client.query(
  `SELECT si.sku_id, si.unit_real_price, si.is_shengmei, si.sales_category
   FROM sale_items si
   WHERE si.sale_item_id = $1`,
  [item.saleItemId]
)
const skuId = siRows.rows[0]?.sku_id || null
const unitRealPrice = siRows.rows[0]?.unit_real_price || null
const isShengmei = siRows.rows[0]?.is_shengmei ?? null
const salesCategory = siRows.rows[0]?.sales_category ?? null

// INSERT 多写一列
await client.query(
  `INSERT INTO service_items
     (service_item_id, sale_item_id, unit_real_price, service_order_id,
      sku_id, session_used, employee_id, service_duration, is_shengmei, sales_category)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
  [
    serviceItemId, item.saleItemId, unitRealPrice, serviceOrderId, skuId,
    item.sessionUsed, item.employeeId || resolvedStaffWfId,
    item.serviceDuration || null, isShengmei, salesCategory,
  ]
)
```

> `service.complete`、`service.cancel`、`service.start` 等其他生命周期接口**不需要改**：它们只更新
> `service_orders` 状态字段，不写入 `service_items`。

### 3.2 退服务 / 校正流程 — 暂无独立路径

当前没有"修改 service_items 的 sales_category"业务路径；`service.cancel` 是软取消（更新 service_orders.status
为「已取消」），不删 service_items 行。本 ticket 不需要新增路径。

---

## 4 mgmtDashboard.summary 接口修改

定位：`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js`。

### 4.1 新增 `queryProjectCount`

仿现有 `queryHeadcount`（同源 `service_orders` + `service_items`，过滤 `status='已完成'` + 时间窗口 + scope），
加 `sales_category` IN 过滤：

```js
async function queryProjectCount(scopeType, scopeId, date, mode) {
  const sc = buildSaleScope(scopeType, scopeId, 'so', 2)
  const rows = await pg.query(
    `SELECT COALESCE(SUM(sit.session_used), 0) AS v
       FROM service_orders so
       JOIN service_items sit ON sit.service_order_id = so.service_order_id
      WHERE ${sc.sql}
        AND so.status = '已完成'
        AND sit.sales_category IN ('自销自耗', '他销自耗')
        AND ${timeWindow('so.service_date', mode, 1, true)}`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}
```

### 4.2 `summary()` 加入并行查询 + 移除占位

```js
const [
  // ...原有 17 项...
  projectCountToday,
  projectCountMonth,
] = await Promise.all([
  // ...原有 17 项...
  queryProjectCount(scopeType, scopeId, date, 'day'),
  queryProjectCount(scopeType, scopeId, date, 'month'),
])

// 输出（删除 TODO 占位）
projectCount: { today: Number(projectCountToday), month: Number(projectCountMonth) },
```

> **去掉的代码**：`mgmt-dashboard.js:461-462` 的 `// TODO: 待业务定义"项目数"口径后实现` 与 `projectCount: { today: 0, month: 0 }`。

---

## 5 前端修改

### 5.1 `pages/mgmt-dashboard/mgmt-dashboard.ts`

定位：`mgmt-dashboard.ts:247` 与 `:270`。

```ts
// 247 行 — 项目数小卡（替换硬编码 '--'）
projectCount: {
  today: formatCount(s.projectCount.today),
  month: formatCount(s.projectCount.month),
},

// 270 行 — 人均项目数（替换硬编码 '--'）
projectCount: {
  day: perEmpCount(s.projectCount.today),
  month: perEmpCount(s.projectCount.month),
},
```

`buildDisplay` 的其余 7 个指标已是这个模式，本节只是补齐第 8 项。

### 5.2 `pages/mgmt-dashboard/mgmt-dashboard.wxml`

定位：`mgmt-dashboard.wxml:69-73`。当前硬编码：

```xml
<view class="dash-card-row"><text class="lbl">今日：</text><text class="val">--</text></view>
<view class="dash-card-row"><text class="lbl">本月：</text><text class="val">--</text></view>
```

替换为：

```xml
<view class="dash-card-row"><text class="lbl">今日：</text><text class="val">{{ display.projectCount.today }}</text></view>
<view class="dash-card-row"><text class="lbl">本月：</text><text class="val">{{ display.projectCount.month }}</text></view>
```

> "人均项目数"卡（line 149-153）已经使用 `display.perEmployee.projectCount.day/month`，不需要改 wxml，
> 只需 `buildDisplay` 把数据填上即可（5.1 已完成）。

---

## 6 metrics.md 更新

定位：`/Users/nv/proj.xt.com/fengyu-wxapp/notes/references/metrics.md`。

### 6.1 客流 / 客量 / 新会员 表 — 把"项目数"行写实

把：
```md
| 项目数 | _占位_ | _待定义_ | _待定义_ |
```

改为：
```md
| 项目数 | `SUM(session_used)` | `service_items.session_used` | JOIN service_orders；`status='已完成'` ∩ `service_items.sales_category IN ('自销自耗','他销自耗')` ∩ `[service_date]` |
```

### 6.2 派生指标表 — 去掉"人均项目数"的占位说明

把：
```md
| 人均项目数 日/月 | `projectCount.today/.month / employeeCount` | 占位（projectCount 本身仍是 `--`） |
```

改为：
```md
| 人均项目数 日/月 | `projectCount.today/.month / employeeCount` | `employeeCount=0 → '--'` |
```

### 6.3 快照字段依赖表 — 追加 1 行

在表末追加：
```md
| `service_items.sales_category` | service.create | `sale_items.sales_category` |
```

### 6.4 变更记录 — 追加 1 行

```md
| 2026-04-25 | 「项目数」指标完整定义；新增 service_items.sales_category 快照依赖 |
```

---

## 7 类型与代码检查

```bash
cd db && npm run db:generate              # 生成 migration
cd fengyu-admin && npx tsc --noEmit       # 确认 admin 端类型不被破坏（admin 不消费 service_items.sales_category）
cd fengyu-staff/cloudfunctions/staffApi && bun test  # staffApi 单测全绿
```

---

## 8 测试与验收

### 8.1 单元/集成测试

**`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/service.test.js`**：
- 现有 `service.create` 用例扩展：mock `sale_items.sales_category = '自销自耗'` → create 后查 `service_items` →
  断言 `sales_category = '自销自耗'`
- 新增用例：`sales_category` 为 null 时 service_items 也写入 null（不报错）

**`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/mgmt-dashboard.test.js`**：
- 把 `mgmt-dashboard.test.js:337-353` 的"项目数占位"用例改名为"项目数真实出数"：
  - mock `queryProjectCount` 对应 SQL 返回 `{ v: 7 }`（today）和 `{ v: 42 }`（month）
  - 断言 `ctx.result.projectCount` = `{ today: 7, month: 42 }`，**不再断言 = `{ today: 0, month: 0 }`**
- SQL 形态断言：拦截 `pg.query`，用 regex 验证项目数 SQL 同时含
  `service_items` + `session_used` + `sales_category IN` + `已完成` + `service_date`

### 8.2 数据完整性 SQL（部署后跑一次）

```sql
-- 1. 历史 service_items.sales_category 回填覆盖率
SELECT COUNT(*) AS total,
       COUNT(sales_category) AS filled,
       COUNT(*) FILTER (WHERE sales_category IS NULL) AS null_cnt
FROM service_items;
-- 期望：filled = total（service_items 必有 sale_items 关联，sale_items.sales_category 也历史回填过）
-- 若 null_cnt > 0：grep 出 sale_item_id 反查 sale_items.sales_category 是否本身就是 NULL（古旧导入数据）

-- 2. 项目数与现行 headcount 关系自检（按门店抽 1 天）
SELECT so.store_id, COUNT(*) AS service_order_count, SUM(sit.session_used) AS total_sessions,
       SUM(sit.session_used) FILTER (WHERE sit.sales_category IN ('自销自耗','他销自耗')) AS project_count
FROM service_orders so
JOIN service_items sit ON sit.service_order_id = so.service_order_id
WHERE so.service_date = CURRENT_DATE - 1
  AND so.status = '已完成'
GROUP BY so.store_id
ORDER BY total_sessions DESC LIMIT 5;
-- 期望：project_count <= total_sessions；project_count / total_sessions 比例与业务方预期一致（通常 50-90%）
```

### 8.3 端到端验收

- 微信开发者工具登录 HQ / market 账号 → 切到 `mgmt-dashboard` 首页 → 项目数小卡显示真实数字（不是 `--`）
- 切换"市场 / 门店"筛选 → 项目数随之变化
- 切换不同日期 → 项目数随之变化
- 人均项目数（人效区）显示真实 `项目数 / employeeCount`，`employeeCount=0` 时仍展示 `--`

---

## 9 风险与权衡

| 风险 | 影响 | 缓解 |
|---|---|---|
| 历史 `sale_items.sales_category` 本身存在 NULL（部分旧导入数据） | 项目数被低估（NULL 不命中 `IN` 条件） | §8.2 SQL #1 自检；若 NULL 比例 > 5% 需要业务方明确补救（手工填或视为某一类） |
| 业务方对"项目数"口径未来若扩到 `他销他耗` | 单点改 SQL 即可（`mgmt-dashboard.js` 1 处 `IN (...)`） | 写在 SQL 字面，未抽常量；改动直观 |
| 派生"人均项目数"在 `employeeCount=0` 时 fallback 到 `--` | 与 7 项现有派生字段同口径 | 已在 `safeDiv` 实现，无新增风险 |
| `service.create` 写入路径已经 SELECT sale_items 一次，加 1 列对性能无影响 | — | — |
| `service_items` 现有数据量（单店每月 ~千条） | migration 回填 UPDATE 全量扫表，需要分钟级 | 可接受；若超 5min 需按 `service_order_id` 分批，但当前数据量不到该阈值 |

---

## 10 不在本 ticket 范围

- `salesCategoryEnum` 进一步重命名（如改为「自销他耗」等更细分的 4 值矩阵）— 已超出 2026-04-25 的局部翻新范围，需另开 ticket
- 项目数下钻明细（按门店 / 按品类 / 按员工）— 后续 ticket
- 项目数环比 / 同比 — 当前 8 卡片均无环比展示，统一另开 ticket
- `service_items.sales_category` 改 NOT NULL — 待 §8.2 #1 数据自检通过后再考虑
- 提成计算路径中已存在的 `sales_category` 引用（`service.js:403/425`）— 现状已经走 `sale_items` JOIN，
  本 ticket **不**改提成路径，避免与统计口径耦合；若后续要让提成也用 `service_items.sales_category`
  快照，单独 ticket（依赖：先验证回填覆盖率 100%）

---

## 11 交付物

- [ ] `db/schema/service.ts` serviceItems 加 `salesCategory: salesCategoryEnum('sales_category')`
- [ ] `db/schema/service.ts` import 从 `./enums` 增加 `salesCategoryEnum`
- [ ] `db/migrations/0009_*.sql`（drizzle 生成 + 末尾追加 1 条回填 UPDATE）
- [ ] 5434 + 5433 双库 `db:migrate` 跑完
- [ ] `fengyu-staff/cloudfunctions/staffApi/routes/service.js` `service.create` SELECT + INSERT 各加 1 列
- [ ] `fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js` 加 `queryProjectCount`、并行 Promise.all 加 2 项、`projectCount` 输出去占位
- [ ] `fengyu-staff/miniprogram/pages/mgmt-dashboard/mgmt-dashboard.ts` `buildDisplay` 替换 2 处 `--` 硬编码
- [ ] `fengyu-staff/miniprogram/pages/mgmt-dashboard/mgmt-dashboard.wxml` 项目数小卡 2 行 `--` → `{{}}`
- [ ] `notes/references/metrics.md` 4 处更新（项目数定义 + 派生派生说明 + 快照字段表 + 变更记录）
- [ ] `staffApi __tests__/routes/service.test.js` 用例扩展
- [ ] `staffApi __tests__/routes/mgmt-dashboard.test.js` 把"项目数占位"用例改为"真实出数 + SQL 形态断言"
- [ ] §8.2 数据完整性 SQL #1/#2 抽样跑一次
- [ ] 微信开发者工具端到端验收（§8.3）

---

## 附：调用链速查

```
[业务定义]
项目数 = SUM(service_items.session_used)
       WHERE service_items.sales_category IN ('自销自耗','他销自耗')
         AND service_orders.status = '已完成'
         AND service_orders.service_date 命中所选时间窗口
         AND service_orders.store_id 命中 scope

[快照来源链]
product_skus.sales_category（手工维护）
  ↓ 开单时拷贝（已实现）
sale_items.sales_category
  ↓ 服务创建时拷贝（本 ticket 新增）
service_items.sales_category  ← 项目数统计直接读这里
```
