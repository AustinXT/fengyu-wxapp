---
title: 管理层数据中心首页「人均提成收入」指标
created: 2026-04-25
completed: 2026-04-25
status: 已完成
severity: P2
scope: staffApi（mgmt-dashboard.summary）+ fengyu-staff 前端 + metrics.md
prereq: [mgmt-dashboard-home-page, mgmt-dashboard-summary-api] 已上线
---

# Ticket: 管理层数据中心首页「人均提成收入」指标

> 一句话目标：在「人效」派生指标区追加 1 个新指标
> **`人均提成收入 = (销售提成收入 + 服务提成收入) / 员工人数`**
> ；接口加 2 项原始指标 `salesCommissionIncome` / `serviceCommissionIncome`，
> 派生在前端 `buildDisplay` 计算，统一遵循 metrics.md 既有约定。

---

## 0 一句话背景

`pages/mgmt-dashboard` 数据中心 tab 当前已上线 8 卡片（业绩、生美业绩、实耗、生美实耗、客流、客量、新会员、项目数）+ 人效区
8 项派生（人均业绩、人均生美业绩、…、人均项目数）。业务方追加一项管理诉求：
**「人均提成收入」**，用于评估"门店给员工带来的平均提成产出"，是衡量门店激励健康度的核心指标。

业务方明确公式：

```
人均提成收入 = (销售提成收入 + 服务提成收入) / 员工人数

  销售提成收入 = SUM(sale_allocations.total_amount)
                 WHERE role_type IN ('美容师','养生师')
                   AND is_void = FALSE
                   AND <时间窗口 + scope，对齐"业绩">

  服务提成收入 = SUM(service_commissions.commission_amount)
                 WHERE role_type IN ('美容师','养生师')
                   AND is_void = FALSE
                   AND <时间窗口 + scope，对齐"实耗">

  员工人数     = metrics.md「员工数（employeeCount）」既有口径
                 = COUNT(*) FROM staff_wechat_users
                   WHERE is_resigned = FALSE
                     AND skills && ARRAY['美容师','养生师']
                     AND <scope>
```

> 「员工人数」复用 `mgmt-dashboard.js:queryEmployeeCount`，不再重复实现。

---

## 1 字段定义

### 1.1 「销售提成收入」（salesCommissionIncome）

| 维度 | 值 |
|------|----|
| 数据源 | `sale_allocations.total_amount` |
| 主过滤 | `role_type IN ('美容师','养生师')` ∩ `is_void = FALSE` |
| 时间窗口 | `[paid_at]`（与「业绩」一致：JOIN `sale_orders.paid_at`） |
| 单据状态 | `sale_orders.status = '已支付'` ∩ `sale_orders.sale_order_type IN ('销售单','转换单')` |
| scope | `sale_items.store_id` 命中 scope（与「业绩」一致） |
| 退款处理 | 退款单 `total_amount` 为负数（schema 注释明确），SUM 自动相互抵销，**符合"净销售提成"语义**，无需特殊处理 |

> **为何与"业绩"完全对齐口径**：销售提成是业绩的下游分配，时间和状态过滤必须一致才能在管理报表上做"业绩
> ↔ 提成"对照分析。回款/转换在 sale_allocations 里仍是正数（schema 注释），但只统计 `sale_order_type IN ('销售单','转换单')`
> 已经把"回款单"排除在外，避免重复入账。

### 1.2 「服务提成收入」（serviceCommissionIncome）

| 维度 | 值 |
|------|----|
| 数据源 | `service_commissions.commission_amount` |
| 主过滤 | `role_type IN ('美容师','养生师')` ∩ `is_void = FALSE` |
| 时间窗口 | `[service_date]`（与「实耗」一致：JOIN `service_orders.service_date`） |
| 单据状态 | `service_orders.status = '已完成'` |
| scope | `service_orders.store_id` 命中 scope（与「实耗」一致） |

> **为何与"实耗"完全对齐口径**：服务提成（手工费 + 消耗提成）是实耗的下游分配，同样为对照分析便利。
> `service_commissions.commission_amount` 已经是 `fixed_fee + consume_amount` 之和，直接 SUM 即可。

### 1.3 「人均提成收入」（avgCommissionPerEmp，前端派生）

```
avgCommissionPerEmp.day   = (salesCommissionIncome.today + serviceCommissionIncome.today) / employeeCount
avgCommissionPerEmp.month = (salesCommissionIncome.month + serviceCommissionIncome.month) / employeeCount
```

防除零：`employeeCount = 0 → '--'`，与现有 8 项派生人效一致。

---

## 2 接口修改：`mgmtDashboard.summary`

定位：`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js`。

### 2.1 新增 `querySalesCommissionIncome`

仿现有 `queryShengmeiRevenue`（同源 `sale_orders` + JOIN）：

```js
async function querySalesCommissionIncome(scopeType, scopeId, date, mode) {
  const sc = buildSaleScope(scopeType, scopeId, 'so', 2)
  const rows = await pg.query(
    `SELECT COALESCE(SUM(sa.total_amount::numeric), 0) AS v
       FROM sale_allocations sa
       JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
       JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
      WHERE ${sc.sql}
        AND sa.is_void = FALSE
        AND sa.role_type IN ('美容师', '养生师')
        AND so.sale_order_type IN ('销售单', '转换单')
        AND so.status = '已支付'
        AND ${timeWindow('so.paid_at', mode, 1, false)}`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}
```

### 2.2 新增 `queryServiceCommissionIncome`

仿现有 `queryStoreConsume`：

```js
async function queryServiceCommissionIncome(scopeType, scopeId, date, mode) {
  const sc = buildSaleScope(scopeType, scopeId, 'so', 2)
  const rows = await pg.query(
    `SELECT COALESCE(SUM(sc2.commission_amount::numeric), 0) AS v
       FROM service_commissions sc2
       JOIN service_items sit ON sit.service_item_id = sc2.service_item_id
       JOIN service_orders so ON so.service_order_id = sit.service_order_id
      WHERE ${sc.sql}
        AND sc2.is_void = FALSE
        AND sc2.role_type IN ('美容师', '养生师')
        AND so.status = '已完成'
        AND ${timeWindow('so.service_date', mode, 1, true)}`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}
```

> JOIN 路径：`service_commissions → service_items → service_orders` 拿 store_id + service_date + status。
> service_items.store_id 当前不存在（service_items 是逻辑明细，物理 store_id 在 service_orders 上），
> 所以走 service_orders 拿 scope；与 metrics.md `scope 过滤`表的 service_orders 行匹配。

### 2.3 `summary()` 加入并行查询 + 输出字段

```js
const [
  // ...原有 21 项 Promise.all...
  salesCommissionToday, salesCommissionMonth,
  serviceCommissionToday, serviceCommissionMonth,
] = await Promise.all([
  // ...原有 21 项...
  querySalesCommissionIncome(scopeType, scopeId, date, 'day'),
  querySalesCommissionIncome(scopeType, scopeId, date, 'month'),
  queryServiceCommissionIncome(scopeType, scopeId, date, 'day'),
  queryServiceCommissionIncome(scopeType, scopeId, date, 'month'),
])

// ctx.result 输出（金额走 round2，与现有 storeRevenue 等一致）
salesCommissionIncome: {
  today: round2(salesCommissionToday),
  month: round2(salesCommissionMonth),
},
serviceCommissionIncome: {
  today: round2(serviceCommissionToday),
  month: round2(serviceCommissionMonth),
},
```

> **为何金额对称返回 today + month**：管理首页其它金额类指标（业绩/生美业绩/实耗/生美实耗）均为 today + month
> 双值，新增字段保持对称便于前端模板复用。即便业务方目前只关心月度，提供 today 不增加成本（只是同 SQL 多一次查询，
> 与现有 8 卡片同模式），并为未来 UI 升级（如"今日提成"卡）保留空间。

---

## 3 前端修改

### 3.1 `pages/mgmt-dashboard/mgmt-dashboard.ts` 类型扩展

定位：`mgmt-dashboard.ts:17-30` 与 `:49-58`。

```ts
// SummaryData 追加 2 字段
interface SummaryData {
  // ...现有...
  salesCommissionIncome: { today: number; month: number }
  serviceCommissionIncome: { today: number; month: number }
  // ...
}

// PerEmployeeDisplay 追加 1 字段
interface PerEmployeeDisplay {
  // ...8 现有...
  commissionIncome: PerEmployeeRow
}
```

### 3.2 `buildDisplay` 计算派生

定位：`mgmt-dashboard.ts:262`（`perEmployee` 对象处）。

```ts
// emp 已在外层 const 取出（line 205）
const totalCommissionDay   = (s.salesCommissionIncome.today + s.serviceCommissionIncome.today)
const totalCommissionMonth = (s.salesCommissionIncome.month + s.serviceCommissionIncome.month)

const perEmpAmount = (n: number) => emp > 0 ? formatAmount(n / emp) : '--'

perEmployee: {
  // ...8 现有...
  commissionIncome: {
    day:   perEmpAmount(totalCommissionDay),
    month: perEmpAmount(totalCommissionMonth),
  },
},
```

> `perEmpAmount` 与现有 `perEmpCount` 平行新增（金额走 `formatAmount` 保留 2 位小数 + 千分位，与 metrics.md
> §数字格式化规则一致）。若已有同语义 helper 直接复用，不重复实现。

### 3.3 `pages/mgmt-dashboard/mgmt-dashboard.wxml` 追加 1 张人效卡

定位：人效区现有 8 卡（line ≈ 130–160 内的 perEmployee 区段）末尾，按现有 dash-card 模板追加：

```xml
<view class="dash-card">
  <view class="dash-card-title">人均提成收入</view>
  <view class="dash-card-row"><text class="lbl">日：</text><text class="val">{{ display.perEmployee.commissionIncome.day }}</text></view>
  <view class="dash-card-row"><text class="lbl">月：</text><text class="val">{{ display.perEmployee.commissionIncome.month }}</text></view>
</view>
```

> 如人效区是 4×2 网格布局，新增第 9 项可能需要补成 4×3 或单独成行，按现有 wxss 实际栅格调整 1 行 wxss
> 即可（不属于本 ticket 设计层决策，由实施时按视觉一致性处理）。

---

## 4 metrics.md 更新

定位：`/Users/nv/proj.xt.com/fengyu-wxapp/notes/references/metrics.md`。

### 4.1 新增"提成"主区段

紧跟"客流 / 客量 / 新会员"区段后，新增：

```md
## 提成

| 指标 | 公式 | 数据源 | 筛选条件 |
|------|------|--------|----------|
| 销售提成收入 | `SUM(total_amount)` | `sale_allocations.total_amount` | JOIN sale_items + sale_orders；`role_type IN ('美容师','养生师')` ∩ `is_void=FALSE` ∩ `sale_order_type IN ('销售单','转换单')` ∩ `status='已支付'` ∩ `[paid_at]` |
| 服务提成收入 | `SUM(commission_amount)` | `service_commissions.commission_amount` | JOIN service_items + service_orders；`role_type IN ('美容师','养生师')` ∩ `is_void=FALSE` ∩ `status='已完成'` ∩ `[service_date]` |

> **为何 role_type 限定美容师/养生师**：管理层观察的是"产能员工"的人均产出；推广师虽享提成但人头不计入
> 「员工数」（参见员工数定义 `skills && ARRAY['美容师','养生师']`），分子分母口径必须一致才有意义。
> **为何销售提成对齐"业绩"口径**：销售提成是业绩的下游分配，时间窗口与状态过滤一致便于"业绩 → 提成"对照分析。
> **为何服务提成对齐"实耗"口径**：服务提成是实耗的下游分配，同理。
```

### 4.2 派生指标表 — 追加 1 行

在「派生指标」表追加：

```md
| 人均提成收入 日/月 | `(salesCommissionIncome + serviceCommissionIncome).today/.month / employeeCount` | `employeeCount=0 → '--'` |
```

### 4.3 scope 过滤表 — 追加 1 行

在「scope」表追加 sale_allocations / service_commissions 行（实际走 JOIN 上游表，方便读者明确）：

```md
| 全部 | sale_allocations / service_commissions 不直接 scope，走 JOIN sale_items / service_orders | — | — |
```

> 或更直观：在表脚加 1 句注解说"提成统计 scope 走上游表的 store_id"，避免新增列让表变臃肿，由实施时
> 按可读性选择。

### 4.4 变更记录 — 追加 1 行

```md
| 2026-04-25 | 「销售提成收入 / 服务提成收入 / 人均提成收入」3 项指标定义；scope 走 JOIN sale_items / service_orders |
```

---

## 5 测试与验收

### 5.1 单元/集成测试

`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/mgmt-dashboard.test.js`：

- 新增用例：mock `pg.query` 对 `salesCommissionIncome` SQL 返回 `{ v: 12345.67 }`（month）→
  断言 `ctx.result.salesCommissionIncome.month === 12345.67`
- 同上 `serviceCommissionIncome`
- SQL 形态断言：用 regex 验证 SQL 同时含
  - 销售提成：`sale_allocations` + `is_void = FALSE` + `role_type IN` + `美容师` + `养生师` + `已支付` + `paid_at`
  - 服务提成：`service_commissions` + `is_void = FALSE` + `role_type IN` + `美容师` + `养生师` + `已完成` + `service_date`
- scope 联合用例：market scope 下两个新查询都正确拼出 `o.parent_id = $`

### 5.2 数据完整性 SQL（部署后跑一次）

```sql
-- 1. 销售提成 ↔ 业绩 比例自检（按门店抽 1 个月）
WITH revenue AS (
  SELECT so.store_id, SUM(so.paid_amount::numeric) AS rev
  FROM sale_orders so
  WHERE so.sale_order_type IN ('销售单','转换单') AND so.status = '已支付'
    AND date_trunc('month', so.paid_at) = date_trunc('month', CURRENT_DATE)
  GROUP BY so.store_id
),
commission AS (
  SELECT si.store_id, SUM(sa.total_amount::numeric) AS comm
  FROM sale_allocations sa
  JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
  JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
  WHERE sa.is_void = FALSE AND sa.role_type IN ('美容师','养生师')
    AND so.sale_order_type IN ('销售单','转换单') AND so.status = '已支付'
    AND date_trunc('month', so.paid_at) = date_trunc('month', CURRENT_DATE)
  GROUP BY si.store_id
)
SELECT r.store_id, r.rev, c.comm, ROUND(c.comm / NULLIF(r.rev, 0) * 100, 2) AS pct
FROM revenue r LEFT JOIN commission c ON r.store_id = c.store_id
ORDER BY r.rev DESC LIMIT 5;
-- 期望：pct（销售提成 / 业绩）通常在个位数百分比；过低 → 检查 role_type 拼写或 is_void 误删；过高 → 检查 sale_order_type 是否漏了滤回款单

-- 2. 服务提成 ↔ 实耗 比例自检
WITH consume AS (
  SELECT so.store_id, SUM(sit.unit_real_price::numeric * sit.session_used) AS cons
  FROM service_orders so
  JOIN service_items sit ON sit.service_order_id = so.service_order_id
  WHERE so.status = '已完成'
    AND date_trunc('month', so.service_date) = date_trunc('month', CURRENT_DATE)
  GROUP BY so.store_id
),
sv_comm AS (
  SELECT so.store_id, SUM(sc2.commission_amount::numeric) AS comm
  FROM service_commissions sc2
  JOIN service_items sit ON sit.service_item_id = sc2.service_item_id
  JOIN service_orders so ON so.service_order_id = sit.service_order_id
  WHERE sc2.is_void = FALSE AND sc2.role_type IN ('美容师','养生师')
    AND so.status = '已完成'
    AND date_trunc('month', so.service_date) = date_trunc('month', CURRENT_DATE)
  GROUP BY so.store_id
)
SELECT c.store_id, c.cons, s.comm, ROUND(s.comm / NULLIF(c.cons, 0) * 100, 2) AS pct
FROM consume c LEFT JOIN sv_comm s ON c.store_id = s.store_id
ORDER BY c.cons DESC LIMIT 5;
-- 期望：pct（服务提成 / 实耗）通常 10-30%；偏离过大 → 检查 commission_amount 是否含 fixed_fee
```

### 5.3 端到端验收

- 微信开发者工具登录 HQ 账号 → 切到 `mgmt-dashboard` 首页 →
  人效区出现"人均提成收入"卡，日 + 月数字真实
- 切换 market / store scope → 数字按 scope 变化
- 切换日期 → 数字按月度变化（today 字段未在 UI 显示但接口已返回）
- `employeeCount = 0` 的极端 scope（如新建空门店）→ 卡片展示 `--`
- 与"人均业绩"、"人均实耗"卡数字共同呈现合理比例（业务方现场确认）

---

## 6 风险与权衡

| 风险 | 影响 | 缓解 |
|---|---|---|
| 销售提成口径选择"对齐业绩"vs"对齐 sale_allocations 全集" | 报表数字差异大（回款单是否计入） | 已选"对齐业绩"=`sale_order_type IN ('销售单','转换单')`，与 metrics.md「业绩」一致；如业务方未来要"全部分配单"再加 1 项辅助指标，不影响本指标 |
| `role_type` 字段历史可能存在 NULL（早期分配未拆角色） | 这部分提成被排除 | §5.2 SQL 抽样确认；如 NULL 比例 > 5% 需另行回填或扩列定义（"其它角色"类） |
| 推广师提成不计入分子，但其工作产出可能贡献了门店业绩 | 派生数字偏低 | 业务定义如此（员工数也只数美容师/养生师），分子分母对称；若未来加"推广师人效"另开 ticket |
| 4 个新查询并行（today × 2 + month × 2）增加 DB 负担 | summary 接口耗时上升 | 现有 21 项已并行，新增 4 项遵循同模式；slow-query 阈值 800ms 已配置（mgmt-dashboard.js:487），实施后观察日志 |
| `service_commissions.commission_amount` 含 fixed_fee + consume_amount，业务方"服务提成"是否含手工费 | 数字偏大或偏小 | 业务方需求文字明确"commissionAmount 中 roleType 为 美容师/养生师 的 commissionAmount" → 直接取该列即可；与 schema 注释一致 |
| 退款单 `sale_allocations.total_amount` 为负数会拉低销售提成总额 | 月初/月末数字波动 | schema 注释明确（"退款业绩 total_amount 为负数"），net 提成本身就是含退款抵销后的结果，业务上正确 |
| sale_items / service_items 历史无 store_id？ | scope 失效 | 项目早已落 store_id 快照（v3.x 后），且 metrics.md scope 表已用 `sale_items.store_id` / `service_orders.store_id`，与现有 7 个查询同源 |

---

## 7 不在本 ticket 范围

- 提成下钻明细（按门店 / 按员工 / 按品类）— 后续 ticket
- 提成环比 / 同比 — 当前 8 卡片均无环比，统一另开 ticket
- 推广师人均提成 — 业务定义不一致（员工数口径不含推广师），需另开 ticket
- 历史 `role_type IS NULL` 数据回填 — §5.2 SQL #1 自检通过前不动；若发现高占比 NULL，单独开 ticket 处理
- 服务提成"仅算消耗部分（不含手工费）"或"仅算手工费"的细分指标 — 业务方诉求未提，本 ticket 直接 SUM `commission_amount`
- "人均销售提成"/"人均服务提成"两个独立派生 — 业务方只要求合并值，未来如需拆开，前端 buildDisplay 再加 2 项即可（接口已具备原始字段）

---

## 8 交付物

- [ ] `fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js`：
  - [ ] 新增 `querySalesCommissionIncome`
  - [ ] 新增 `queryServiceCommissionIncome`
  - [ ] `summary()` `Promise.all` 加 4 项
  - [ ] `ctx.result` 加 `salesCommissionIncome` / `serviceCommissionIncome`
- [ ] `fengyu-staff/miniprogram/pages/mgmt-dashboard/mgmt-dashboard.ts`：
  - [ ] `SummaryData` 接口加 2 字段
  - [ ] `PerEmployeeDisplay` 接口加 `commissionIncome`
  - [ ] `buildDisplay` 计算派生 `commissionIncome.{day, month}`
  - [ ] `perEmpAmount` helper 新增（如尚无金额版人均 helper）
- [ ] `fengyu-staff/miniprogram/pages/mgmt-dashboard/mgmt-dashboard.wxml` 人效区追加 1 卡
- [ ] （如需要）`mgmt-dashboard.wxss` 人效区栅格调整以容纳 1 卡
- [ ] `notes/references/metrics.md` 4 处更新（新区段 + 派生指标 + scope 注释 + 变更记录）
- [ ] `staffApi __tests__/routes/mgmt-dashboard.test.js` 新增用例（值 + SQL 形态）
- [ ] §5.2 数据完整性 SQL #1/#2 抽样跑一次
- [ ] 微信开发者工具端到端验收（§5.3）

---

## 附：调用链速查

```
[业务定义]
人均提成收入 =
  (Σ sale_allocations.total_amount   WHERE 美容师/养生师 ∩ 已支付销售/转换单 ∩ paid_at 月份
 + Σ service_commissions.commission_amount WHERE 美容师/养生师 ∩ 已完成服务单 ∩ service_date 月份)
  / Σ staff_wechat_users    WHERE 在职 ∩ 美容师/养生师技能 ∩ scope

[scope 关联链]
sale_allocations  → sale_items.store_id  → scope 子查询
service_commissions → service_items → service_orders.store_id → scope 子查询
staff_wechat_users.store_id → scope 子查询（同 employeeCount）

[时间关联链]
sale_allocations  → sale_orders.paid_at（月份）
service_commissions → service_orders.service_date（月份）
```
