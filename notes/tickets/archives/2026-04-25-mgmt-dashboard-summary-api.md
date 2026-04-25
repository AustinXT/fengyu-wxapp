# Ticket 2: 管理层数据中心 8 卡片统计接口（staff.dashboardSummary）

> 生成日期：2026-04-25
> 严重级别：P1（首页核心数据接口）
> 端：staffApi 云函数
> 影响面：新增 1 个 action：`staff.dashboardSummary`
> 前置：**Ticket 1**（3 个快照字段必须先落库）
> 并行：可与 Ticket 3（筛选器组件）并行开发
>
> **一句话目标**：实现 `staff.dashboardSummary(date, scopeType, scopeId)`，
> 一次性返回管理层数据中心首页所需的 8 张卡片数据
> （门店业绩 / 生美业绩 / 门店实耗 / 生美实耗 / 客流 / 客量 / 新会员 / 项目数），
> 每张卡含"今日 / 本月 / 月店均"或"今日 / 本月"双值。

---

## 0 一句话背景

需求页面是 `pages/mgmt-dashboard` 的 `dashboard` tab，顶部含两个筛选器：

- **日历选择器**（默认当天，单日）
- **市场/门店二级筛选器**：3 种取值
  - "全部市场"（管理层视角下的全公司）
  - 单个市场（含市场下所有门店聚合）
  - 单个门店

8 张卡片的统计口径在所选日期 + 筛选范围下计算。"今日"=所选日期；"本月"=所选日期所在自然月；"月店均"=本月数据 / 该筛选口径下的门店数。

现有的 `staff.dashboard` action 只服务于工作台个人视角（按自己 / 整店），管理层多店聚合 + "月店均" + "市场维度过滤" 都不支持。
本 ticket 新建一个独立 action，**不复用 `staff.dashboard`**，避免单接口承担两个完全不同语义。

---

## 1 接口规格

### 1.1 入参

```ts
// payload
{
  date: 'YYYY-MM-DD',           // 必填，所选日期；同时定位"今日"和"本月"
  scopeType: 'all' | 'market' | 'store',  // 必填
  scopeId?: string,             // scopeType=market 时为 org_node_id；store 时为 store_id；all 时省略
}
```

### 1.2 返回

```ts
{
  date: 'YYYY-MM-DD',
  scope: { type, id, name },    // 回传给前端展示

  // 4 张大卡片（含月店均）
  storeRevenue: {     today: number, month: number, monthlyAvgPerStore: number },
  shengmeiRevenue: {  today: number, month: number, monthlyAvgPerStore: number },
  storeConsume: {     today: number, month: number, monthlyAvgPerStore: number },
  shengmeiConsume: {  today: number, month: number, monthlyAvgPerStore: number },

  // 4 张小卡片（仅今日 + 本月）
  footfall:    { today: number, month: number },  // 客流
  headcount:   { today: number, month: number },  // 客量
  newMembers:  { today: number, month: number },  // 新会员
  projectCount: { today: number, month: number }, // 项目数（占位：先返 0/0）

  // 元信息
  storeCount: number,             // 该 scope 下门店数（"月店均"分母）
  computedAt: 'ISO timestamp',
}
```

### 1.3 权限

- 必须 `requireManagementLevel`（staffLevel ∈ {headquarters, market} 且 loginLevel='management'，见 `staffApi/CLAUDE.md`）
- `scopeType` 校验：
  - 总部账号：可选 'all' / 'market' / 'store'
  - 市场账号：仅可选自己所属 market 或下属 store；选 'all' 或越权 market 时返回 `PERMISSION_DENIED`

---

## 2 SQL 设计

> **指标公式 / 口径 / 时间窗口约定**统一参考 [`notes/references/metrics.md`](../references/metrics.md)。本节只保留 SQL 实现样板。

### 2.1 共用：scope 过滤条件（按表分别构造）

```js
// 销售类表（sale_orders）按 store_id 过滤
function buildSaleScope(scopeType, scopeId) {
  if (scopeType === 'all')    return { sql: 'TRUE', params: [] }
  if (scopeType === 'store')  return { sql: 'so.store_id = $X', params: [scopeId] }
  if (scopeType === 'market') return {
    // org_nodes 树查所有该 market 下的 store
    sql: 'so.store_id IN (SELECT id FROM org_nodes WHERE type = \'store\' AND parent_id = $X)',
    params: [scopeId],
  }
}

// 服务类表（service_orders）有 marketName 快照，可直接命中市场维度
function buildServiceScope(scopeType, scopeId) {
  if (scopeType === 'all')    return { sql: 'TRUE', params: [] }
  if (scopeType === 'store')  return { sql: 'so.store_id = $X', params: [scopeId] }
  // market 也走 store_id 子查询，保持口径与 sale 一致
  if (scopeType === 'market') return {
    sql: 'so.store_id IN (SELECT id FROM org_nodes WHERE type = \'store\' AND parent_id = $X)',
    params: [scopeId],
  }
}
```

> **决策**：market 维度统一通过 `store_id IN (subquery)` 实现，**不**用 `service_orders.market_name` 文本匹配。
> 理由：org_nodes 是真实关系来源，market_name 只是快照、可能因 market 改名漂移。

### 2.2 1️⃣ 门店业绩（销售单 + 转换单的 paid_amount SUM）

```sql
-- 今日
SELECT COALESCE(SUM(so.paid_amount::numeric), 0) AS revenue
FROM sale_orders so
WHERE ${saleScope}
  AND so.sale_order_type IN ('销售单', '转换单')
  AND so.status = '已支付'
  AND so.paid_at::date = $1;

-- 本月：把 ::date = $1 替换为 date_trunc('month', so.paid_at) = date_trunc('month', $1::date)
```

> **paid_amount 口径**：`sale_orders.paid_amount` 是订单层金额，含付款方式聚合（现金 + 储值卡 + ...）。
> 选 paid_amount 而不是 SUM(sale_items.received) 的原因：转换单/回款单的 received 已经在 sale_items 拆分；
> 如果直接 SUM items 会重复计入（转换单会同时出现 convert_in / convert_out 两行）。

### 2.3 2️⃣ 生美业绩（sale_items.is_shengmei = true 的 received SUM）

```sql
SELECT COALESCE(SUM(si.received::numeric), 0) AS revenue
FROM sale_orders so
JOIN sale_items si ON si.sale_order_id = so.sale_order_id
WHERE ${saleScope}
  AND so.sale_order_type IN ('销售单', '转换单')
  AND so.status = '已支付'
  AND si.is_shengmei = TRUE
  AND so.paid_at::date = $1;
```

> 这里用 `received` SUM（而非 `paid_amount`），因为 paid_amount 是订单层、无法按 sku 维度过滤生美。
> 转换单的 sale_items 包含 `convert_in`（正 received）和 `convert_out`（负 received），相加自然抵消，得到的是"净生美业绩"。

### 2.4 3️⃣ 门店实耗（service_items.unit_real_price * session_used SUM）

```sql
SELECT COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS consume
FROM service_orders so
JOIN service_items sit ON sit.service_order_id = so.service_order_id
WHERE ${serviceScope}
  AND so.status = '已完成'
  AND so.service_date = $1;
```

> 服务实耗按 `service_date` 而非 `completed_at` 过滤；与现有 `staff.dashboard` 口径一致。

### 2.5 4️⃣ 生美实耗（service_items.is_shengmei = true 的 unit_real_price * session_used SUM）

```sql
SELECT COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS consume
FROM service_orders so
JOIN service_items sit ON sit.service_order_id = so.service_order_id
WHERE ${serviceScope}
  AND so.status = '已完成'
  AND sit.is_shengmei = TRUE
  AND so.service_date = $1;
```

### 2.6 5️⃣ 客流（service_orders 中 client_user_id unique）

```sql
SELECT COUNT(DISTINCT so.client_user_id) AS footfall
FROM service_orders so
WHERE ${serviceScope}
  AND so.status = '已完成'
  AND so.service_date = $1
  AND so.client_user_id IS NOT NULL;
```

### 2.7 6️⃣ 客量（service_orders 数量）

```sql
SELECT COUNT(*) AS headcount
FROM service_orders so
WHERE ${serviceScope}
  AND so.status = '已完成'
  AND so.service_date = $1;
```

> 与"客流"差异：客流去重 client_user_id，客量计单子数；同一顾客一天有 2 笔服务单 → 客流 1、客量 2。

### 2.8 7️⃣ 新会员（client_wechat_users.member_level_upgraded_at + old_member_level IS NULL）

> 依赖 Ticket 1 已落库 `old_member_level`。

```sql
-- 客户口径过滤：用 bound_store_id（顾客绑定的门店）过滤
SELECT COUNT(*) AS new_members
FROM client_wechat_users c
WHERE ${clientScope}
  AND c.old_member_level IS NULL
  AND c.member_level IS NOT NULL
  AND c.member_level_upgraded_at::date = $1;
```

> `clientScope` 按 `c.bound_store_id` 构造（与 sale/service 不同）。market 维度同样走 store_id 子查询。
> all 视角下不过滤 bound_store_id（含未绑店但已升级的客户）。

### 2.9 8️⃣ 项目数（占位）

返回 `{ today: 0, month: 0 }`，等业务方明确口径后另开 ticket 实现。
**先在代码里放一个 TODO 注释 + 空查询**，避免前端做任何空值兜底。

### 2.10 storeCount（"月店均"分母）

```sql
-- all：全部 type='store' 节点
-- market：该 market 下所有 store
-- store：1
SELECT COUNT(*) FROM org_nodes WHERE type = 'store' [AND parent_id = $X]
```

> 月店均 = month / storeCount；storeCount = 0 时返回 0（防除零）。

---

## 3 实现要点

### 3.1 单查询并发

8 张卡 × 3 个值（部分 2 个），约 14 条 SQL。**用 `Promise.all` 并发**，单次接口耗时控制在 1s 内。

```js
async function dashboardSummary(ctx) {
  await requireManagementLevel()(ctx, async () => {})
  const { date, scopeType, scopeId } = ctx.event.payload || {}

  // 校验
  validateScopeOrThrow(ctx.auth, scopeType, scopeId)

  // 构造各表 scope
  const saleScope = buildSaleScope(scopeType, scopeId)
  const serviceScope = buildServiceScope(scopeType, scopeId)
  const clientScope = buildClientScope(scopeType, scopeId)

  // 并发执行
  const [
    storeRevToday, storeRevMonth,
    shengmeiRevToday, shengmeiRevMonth,
    storeConsToday, storeConsMonth,
    shengmeiConsToday, shengmeiConsMonth,
    footfallToday, footfallMonth,
    headcountToday, headcountMonth,
    newMemToday, newMemMonth,
    storeCount,
  ] = await Promise.all([
    queryStoreRevenue(saleScope, date, 'day'),
    queryStoreRevenue(saleScope, date, 'month'),
    queryShengmeiRevenue(saleScope, date, 'day'),
    queryShengmeiRevenue(saleScope, date, 'month'),
    queryStoreConsume(serviceScope, date, 'day'),
    queryStoreConsume(serviceScope, date, 'month'),
    queryShengmeiConsume(serviceScope, date, 'day'),
    queryShengmeiConsume(serviceScope, date, 'month'),
    queryFootfall(serviceScope, date, 'day'),
    queryFootfall(serviceScope, date, 'month'),
    queryHeadcount(serviceScope, date, 'day'),
    queryHeadcount(serviceScope, date, 'month'),
    queryNewMembers(clientScope, date, 'day'),
    queryNewMembers(clientScope, date, 'month'),
    queryStoreCount(scopeType, scopeId),
  ])

  // 月店均 = month / storeCount（storeCount=0 时为 0）
  const avg = (m) => storeCount > 0 ? Math.round((m / storeCount) * 100) / 100 : 0

  ctx.result = {
    date, scope: { type: scopeType, id: scopeId, name: ... },
    storeRevenue:    { today: storeRevToday, month: storeRevMonth, monthlyAvgPerStore: avg(storeRevMonth) },
    shengmeiRevenue: { today: shengmeiRevToday, month: shengmeiRevMonth, monthlyAvgPerStore: avg(shengmeiRevMonth) },
    storeConsume:    { today: storeConsToday, month: storeConsMonth, monthlyAvgPerStore: avg(storeConsMonth) },
    shengmeiConsume: { today: shengmeiConsToday, month: shengmeiConsMonth, monthlyAvgPerStore: avg(shengmeiConsMonth) },
    footfall:    { today: footfallToday, month: footfallMonth },
    headcount:   { today: headcountToday, month: headcountMonth },
    newMembers:  { today: newMemToday, month: newMemMonth },
    projectCount: { today: 0, month: 0 },  // TODO: 待业务定义
    storeCount,
    computedAt: new Date().toISOString(),
  }
}
```

### 3.2 抽函数

避免 `dashboard.js` 写成一坨 700 行；建议在 `staffApi/routes/` 里**新建独立文件**：

```
staffApi/routes/mgmt-dashboard.js
  ├─ exports.summary = dashboardSummary
  └─ 后续 ticket（排行榜等）可在此追加
```

或者就在现有 `staff.js` 末尾追加，看哪种风格更契合现有惯例。**建议新建文件**，因为后续管理层 hub 的 4 个 tab 都会有自己的接口（排行榜/顾客/我的），集中放一个 module 更清晰。

### 3.3 路由注册

`staffApi/index.js` 里把新模块加入路由表（懒加载即可）：

```js
const moduleMap = {
  ...,
  'mgmtDashboard': () => require('./routes/mgmt-dashboard'),
}
```

action 命名：`mgmtDashboard.summary`。前端调用：
```ts
callStaffApi('mgmtDashboard.summary', { date, scopeType, scopeId })
```

> 与 `staff.dashboard` 的命名区别：避免和现有"个人视角看板"混淆。

### 3.4 性能与索引

现有索引覆盖：

- `sale_orders.store_id + paid_at`：✅ 已有 `idx_sale_orders_store_paid_at`（查 grep 确认；若无，加）
- `service_orders.store_id + service_date`：✅ `idx_svc_orders_store_date`
- `client_wechat_users.bound_store_id + member_level_upgraded_at`：⚠️ 可能缺；看实际执行计划再加

如果实际查询慢（>500ms），加复合索引：

```sql
CREATE INDEX IF NOT EXISTS idx_sale_items_order_shengmei
  ON sale_items (sale_order_id, is_shengmei) WHERE is_shengmei = TRUE;

CREATE INDEX IF NOT EXISTS idx_svc_items_order_shengmei
  ON service_items (service_order_id, is_shengmei) WHERE is_shengmei = TRUE;
```

> 部分索引（partial index），仅生美行入索引，体积小、命中精确。

---

## 4 测试

### 4.1 单元测试（建议在 `routes/mgmt-dashboard.test.js` 新建）

构造 1 个 market + 2 个 store + 各类历史订单/服务单/会员升级数据，断言：

- `scopeType: 'all'` 时聚合所有 store
- `scopeType: 'market'` 时仅聚合该 market 的 2 个 store
- `scopeType: 'store'` 时仅一个 store
- "今日" / "本月" 切换日期时数值变化符合 SQL 语义
- "月店均" = month / storeCount（手算对得上）
- 生美/非生美的 sale_items 区分
- 新会员仅命中 old_member_level IS NULL 的行
- storeCount = 0（用一个空 market）时 monthlyAvgPerStore 返回 0 而非 NaN
- 权限校验：市场账号传 `scopeType='all'` → 抛 PERMISSION_DENIED

### 4.2 联调

部署后用 staff devtools 真实账号（headquarters）调用：

```js
wx.cloud.callFunction({
  name: 'staffApi',
  data: { action: 'mgmtDashboard.summary', payload: { date: '2026-04-25', scopeType: 'all' } }
})
```

人工对一个已知日期的"今日 / 本月"金额，确保口径一致。

### 4.3 性能

- 单次请求 P95 < 800ms（14 个并发查询）
- 加 `console.time` / `console.timeEnd` 日志，部署后观察云函数耗时

---

## 5 风险

| 风险 | 缓解 |
|---|---|
| `paid_amount` 与 `sale_items.received` SUM 在历史数据上不一致 | 部署后跑一次比对 SQL：`SELECT SUM(paid_amount), SUM(received) FROM ...`；偏差 > 1% 找 dev 复盘 |
| `service_orders.market_name` 不再用作 market 过滤，可能与历史业务理解不一致 | PR 描述里说明决策；保留 market_name 字段不删 |
| `Promise.all` 中任何一条查询挂掉会让整个接口失败 | 默认行为可接受（前端展示报错 toast 比"部分卡片显示空"更明确） |
| 大表全 SCAN（half year + range） | 必要时加 §3.4 部分索引 |

---

## 6 不在本 ticket 范围

- 项目数指标的真实实现（占位返 0）
- 前端调用 / 渲染（在 Ticket 4 实现）
- 排行榜 / 顾客 / 我的 三个 tab 的接口（后续 ticket）
- 时间维度扩展到"上月 / 任意区间"（首版只有"今日 + 本月"）

---

## 7 交付物

- [ ] `staffApi/routes/mgmt-dashboard.js` 新建，含 summary action
- [ ] `staffApi/index.js` 路由注册 `mgmtDashboard.summary`
- [ ] `staffApi/CLAUDE.md` 路由表追加一行
- [ ] 单元测试覆盖 §4.1 的 8 个 case
- [ ] 部署后联调验证今日 / 本月 / 月店均（与人工对一份历史数据）
- [ ] P95 < 800ms（云函数日志确认）
