# Ticket 1: 门店排行榜接口（mgmtDashboard.storeRanking）

> 生成日期：2026-04-25
> 严重级别：P1（管理层 hub `ranking` tab 核心数据接口）
> 端：staffApi 云函数
> 影响面：新增 1 个 action：`mgmtDashboard.storeRanking`
> 前置：无
> 并行：可与 [Ticket 2 前端 page](./2026-04-25-mgmt-store-ranking-page.md) 同步推进（前端 mock 联调）
>
> **一句话目标**：实现 `mgmtDashboard.storeRanking(period, metric)`，
> 返回所选时间段、所选指标下、当前账号有权见的全部门店的排行榜
> （`[{ rank, storeId, storeName, marketName, value }]`），按 value 降序。

---

## 0 一句话背景

需求页面是 `pages/mgmt-dashboard` 的 `ranking` tab。视图结构：

- 顶部 3 个时间 chip：本月 / 上月 / 本年（默认本月）
- 6 个指标按钮：业绩 / 实耗 / 保有会员 / 新客量 / 项目数 / 客流（默认业绩）
- 表格列：排名、店名、所属市场、数据值（含单位标签）

详细需求与 6 个指标对应口径见 [INDEX](./2026-04-25-mgmt-store-ranking-INDEX.md) §"需求复述"。

现有 `mgmtDashboard.summary` 是按所选 scope **聚合一个数**，而本接口需要**按门店分组**返回 N 行数据，语义不同 → 新建独立 action。

---

## 1 接口规格

### 1.1 入参

```ts
// payload
{
  period: 'month' | 'lastMonth' | 'year',  // 必填，时间维度
  metric: 'revenue' | 'consume' | 'retainedMember'
        | 'newMember' | 'projectCount' | 'footfall',  // 必填，6 选 1
}
```

### 1.2 返回

```ts
{
  period: 'month' | 'lastMonth' | 'year',
  metric: 'revenue' | ...,
  unit: 'amount' | 'count',     // 'amount'=金额（业绩/实耗）；'count'=人数/计数
  rows: [
    { rank: 1, storeId: 'S001', storeName: '南昌旭辉店', marketName: '南昌市场', value: 10000 },
    ...
  ],
  computedAt: 'ISO timestamp',
}
```

- `rows` 永远包含**全部当前账号有权见的门店**（即使 value=0 也要返回，用于"垫底"展示）
- `rank` 后端计算，同值并列（采用 `RANK()` 而非 `ROW_NUMBER()`）；二级排序按 `store_name ASC`
- 选 `metric='retainedMember'`：按 period 末的 refDate 实时计算（详见 §2.5），month/year 在本月内 refDate 同为今天 → 数值相同，lastMonth 反映上月底快照
- 选 `metric='projectCount'`：按 metrics.md 真实公式（`SUM(session_used)` ∩ `sales_category IN ('自销自耗','他销自耗')`），不再占位
- `unit` 由后端给出，前端用来选择格式化函数（`formatAmount` vs `formatCount`）

### 1.3 权限

- `requireManagementLevel`（与 `summary` 一致）
- 不接收 `scopeType/scopeId`：账号 staffLevel 决定可见门店
  - `headquarters` → 全部门店
  - `market` → 仅 `auth.scopeStoreIds`（自动展开自己 market 下的门店）

---

## 2 SQL 设计

### 2.1 时间窗口构造（与 summary 共享 helper）

在 `routes/mgmt-dashboard.js` 中**追加**两个 helper：`timeWindowPeriod`（业绩/实耗/客流/新会员/项目数用）和 `getRefDateExpr`（保有会员用）：

```js
/**
 * 落 period 区间（用于业绩/实耗/客流/新会员/项目数）
 * @param {string} col 列引用（含别名）
 * @param {'month'|'lastMonth'|'year'} period
 * @param {boolean} isDateColumn col 本身是 date 类型则不必再 ::date
 */
function timeWindowPeriod(col, period, _isDateColumn) {
  // 用 NOW() 而非外部传 date 参数：排行榜默认锚定"今天"所在的月/年
  if (period === 'month') {
    return `date_trunc('month', ${col}) = date_trunc('month', NOW()::date)`
  }
  if (period === 'lastMonth') {
    return `date_trunc('month', ${col}) = date_trunc('month', NOW()::date - INTERVAL '1 month')`
  }
  // year
  return `date_trunc('year', ${col}) = date_trunc('year', NOW()::date)`
}

/**
 * 保有会员（方案 B）的 refDate SQL 表达式
 * - month / year：本月或本年还未结束 → 用 NOW()::date
 * - lastMonth：上月最后一天
 */
function getRefDateExpr(period) {
  if (period === 'lastMonth') {
    return `(date_trunc('month', NOW()::date) - INTERVAL '1 day')::date`
  }
  return `NOW()::date`
}
```

> **决策：锚点用 NOW()，不接收 date 参数**。设计稿无日历组件，时间维度只有 3 个固定相对值。
> 若后续需求加入"任意月份选择"，再扩展 period 为 `'2026-03'` 等绝对值（向后兼容）。

### 2.2 共用：账号可见门店 store_id 列表

```js
function getVisibleStoreIds(auth) {
  if (auth.staffLevel === 'headquarters') return null  // null = 不过滤
  return auth.scopeStoreIds || []  // market：仅自己市场下的门店
}
```

SQL 拼接：

```js
function buildStoreFilter(visibleStoreIds, alias, startIdx) {
  if (!visibleStoreIds) return { sql: 'TRUE', params: [] }
  if (visibleStoreIds.length === 0) {
    // 市场账号但 scopeStoreIds 为空（异常情况）→ 直接返回空集
    return { sql: 'FALSE', params: [] }
  }
  return {
    sql: `${alias}.store_id = ANY($${startIdx}::text[])`,
    params: [visibleStoreIds],
  }
}
```

### 2.3 1️⃣ 业绩排名

```sql
SELECT
  s.store_id,
  s.store_name,
  o.name AS market_name,
  COALESCE(SUM(so.paid_amount::numeric), 0) AS value
FROM stores s
JOIN org_nodes o_store ON s.org_node_id = o_store.id  -- store 节点
JOIN org_nodes o ON o_store.parent_id = o.id           -- market 节点
LEFT JOIN sale_orders so
  ON so.store_id = s.store_id
  AND so.sale_order_type IN ('销售单','转换单')
  AND so.status = '已支付'
  AND ${timeWindowPeriod('so.paid_at', period, false)}
WHERE ${storeFilter}      -- 注意此处 alias 为 's'
GROUP BY s.store_id, s.store_name, o.name
ORDER BY value DESC, s.store_name ASC
```

> **左联接 stores**：保证 value=0 的门店（无任何订单）也参与排行；不能用 INNER JOIN。

### 2.4 2️⃣ 实耗排名

```sql
SELECT
  s.store_id, s.store_name, o.name AS market_name,
  COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS value
FROM stores s
JOIN org_nodes o_store ON s.org_node_id = o_store.id
JOIN org_nodes o ON o_store.parent_id = o.id
LEFT JOIN service_orders so2
  ON so2.store_id = s.store_id
  AND so2.status = '已完成'
  AND ${timeWindowPeriod('so2.service_date', period, true)}
LEFT JOIN service_items sit ON sit.service_order_id = so2.service_order_id
WHERE ${storeFilter}
GROUP BY s.store_id, s.store_name, o.name
ORDER BY value DESC, s.store_name ASC
```

### 2.5 3️⃣ 保有会员排名（方案 B 实时计算）

> 复用 [`metrics-date-alignment.md` §3.5 T5](./2026-04-25-mgmt-dashboard-metrics-date-alignment.md) 方案 B 公式：
> "$refDate 那天已是会员客（`became_member_at::date <= refDate`） ∩ refDate 前 90 天有 service_orders 已完成单"。
> 排行榜按 `c.bound_store_id` 分组聚合。

```sql
-- ${refDate} 由 getRefDateExpr(period) 生成；下面 SQL 直接内联
SELECT
  s.store_id,
  s.store_name,
  o.name AS market_name,
  COUNT(DISTINCT c.user_id) AS value
FROM stores s
JOIN org_nodes o_store ON s.org_node_id = o_store.id
JOIN org_nodes o ON o_store.parent_id = o.id
LEFT JOIN client_wechat_users c
  ON c.bound_store_id = s.store_id
  AND c.became_member_at IS NOT NULL
  AND c.became_member_at::date <= ${refDate}
  AND EXISTS (
    SELECT 1 FROM service_orders so
    WHERE so.client_user_id = c.user_id
      AND so.status = '已完成'
      AND so.service_date BETWEEN (${refDate} - INTERVAL '90 days') AND ${refDate}
  )
WHERE ${storeFilter}
GROUP BY s.store_id, s.store_name, o.name
ORDER BY value DESC, s.store_name ASC
```

> **关于 `customer_status` 列**：方案 B 不依赖 `customer_status` 列，因为它是当前快照不可历史化（详见 T5 决策）。
>
> **行为**：
> - period=lastMonth → refDate = 上月最后一天 → 反映上月底的保有快照
> - period=month / year → refDate = 今天（本月/本年还未结束）→ 数值相同，反映当下保有快照

### 2.6 4️⃣ 新会员排名

```sql
SELECT
  s.store_id, s.store_name, o.name AS market_name,
  COUNT(c.client_user_id) AS value
FROM stores s
JOIN org_nodes o_store ON s.org_node_id = o_store.id
JOIN org_nodes o ON o_store.parent_id = o.id
LEFT JOIN client_wechat_users c
  ON c.bound_store_id = s.store_id
  AND c.old_member_level IS NULL
  AND c.member_level IS NOT NULL
  AND ${timeWindowPeriod('c.member_level_upgraded_at', period, false)}
WHERE ${storeFilter}
GROUP BY s.store_id, s.store_name, o.name
ORDER BY value DESC, s.store_name ASC
```

### 2.7 5️⃣ 项目数排名

> metrics.md 已落定公式（2026-04-25 变更）：`SUM(service_items.session_used)` JOIN service_orders；`status='已完成'` ∩ `service_items.sales_category IN ('自销自耗','他销自耗')` ∩ `service_date` 落入 period。

```sql
SELECT
  s.store_id,
  s.store_name,
  o.name AS market_name,
  COALESCE(SUM(sit.session_used), 0) AS value
FROM stores s
JOIN org_nodes o_store ON s.org_node_id = o_store.id
JOIN org_nodes o ON o_store.parent_id = o.id
LEFT JOIN service_orders so2
  ON so2.store_id = s.store_id
  AND so2.status = '已完成'
  AND ${timeWindowPeriod('so2.service_date', period, true)}
LEFT JOIN service_items sit
  ON sit.service_order_id = so2.service_order_id
  AND sit.sales_category IN ('自销自耗','他销自耗')
WHERE ${storeFilter}
GROUP BY s.store_id, s.store_name, o.name
ORDER BY value DESC, s.store_name ASC
```

> **快照字段前置**：`service_items.sales_category` 已在 schema/service.ts:64 落库，`service.create` 已写入快照（service.js:195-210）。
> **历史数据自检**：T1 实施前先跑 `SELECT COUNT(*) FROM service_items WHERE sales_category IS NULL`；若有 NULL，写一次性回填脚本（按 sale_items 反查）。

### 2.8 6️⃣ 客流排名

```sql
SELECT
  s.store_id, s.store_name, o.name AS market_name,
  COUNT(DISTINCT so2.client_user_id) AS value
FROM stores s
JOIN org_nodes o_store ON s.org_node_id = o_store.id
JOIN org_nodes o ON o_store.parent_id = o.id
LEFT JOIN service_orders so2
  ON so2.store_id = s.store_id
  AND so2.status = '已完成'
  AND so2.client_user_id IS NOT NULL
  AND ${timeWindowPeriod('so2.service_date', period, true)}
WHERE ${storeFilter}
GROUP BY s.store_id, s.store_name, o.name
ORDER BY value DESC, s.store_name ASC
```

### 2.9 排名计算

后端用 SQL `RANK() OVER (ORDER BY value DESC)` 或在 JS 层遍历计算（更直观）：

```js
function assignRanks(rows) {
  let rank = 0
  let lastValue = null
  rows.forEach((row, idx) => {
    if (row.value !== lastValue) {
      rank = idx + 1
      lastValue = row.value
    }
    row.rank = rank
  })
  return rows
}
```

> 同值并列：[100, 100, 80] → 排名 [1, 1, 3]（标准 RANK 语义，跳号）。

---

## 3 实现要点

### 3.1 文件组织

直接在 `staffApi/routes/mgmt-dashboard.js` 中**追加** `storeRanking` 函数（与现有 `summary` / `scopeOptions` 同文件）。理由：

- 三者共享 `timeWindow` / `buildXxxScope` helper
- 都是管理层数据中心相关查询，集中维护

```js
module.exports = {
  scopeOptions,
  summary,
  storeRanking,   // 新增
  __resetMarketsCache,
}
```

### 3.2 路由注册

`staffApi/index.js` 追加：

```js
'mgmtDashboard.storeRanking': () => require('./routes/mgmt-dashboard').storeRanking,
```

### 3.3 函数骨架

```js
async function storeRanking(ctx) {
  await requireManagementLevel()(ctx, async () => {})
  const { period, metric } = ctx.event.payload || {}

  const VALID_PERIODS = ['month', 'lastMonth', 'year']
  const VALID_METRICS = ['revenue', 'consume', 'retainedMember', 'newMember', 'projectCount', 'footfall']

  if (!VALID_PERIODS.includes(period)) {
    throw new Error('INVALID_PARAMS: period must be month/lastMonth/year')
  }
  if (!VALID_METRICS.includes(metric)) {
    throw new Error('INVALID_PARAMS: metric must be one of: ' + VALID_METRICS.join('/'))
  }

  const visibleStoreIds = getVisibleStoreIds(ctx.auth)
  const storeFilter = buildStoreFilter(visibleStoreIds, 's', 1)

  const t0 = Date.now()
  const rawRows = await runMetricQuery(metric, period, storeFilter)

  // unit + rank
  const unit = (metric === 'revenue' || metric === 'consume') ? 'amount' : 'count'
  const rows = assignRanks(rawRows.map((r) => ({
    storeId: r.store_id,
    storeName: r.store_name,
    marketName: r.market_name,
    value: Number(r.value || 0),
  })))

  const elapsed = Date.now() - t0
  if (elapsed > 800) {
    console.warn(`[mgmtDashboard.storeRanking] slow: ${elapsed}ms`, { period, metric })
  }

  ctx.result = { period, metric, unit, rows, computedAt: new Date().toISOString() }
}
```

`runMetricQuery(metric, period, storeFilter)` 内部按 metric 分发到具体 SQL（§2.3–2.8）。

### 3.4 性能与索引

排行榜每次请求执行 1 条聚合 SQL（按门店 GROUP BY）。门店数 ≤30，聚合行数小，性能瓶颈在 LEFT JOIN 大表的扫描：

| 指标 | 主表 | 关键索引 | 备注 |
|------|------|----------|------|
| revenue | sale_orders | `idx_sale_orders_store_paid_at` | 已有 |
| consume / footfall | service_orders | `idx_svc_orders_store_date` | 已有 |
| consume / projectCount | service_items | `idx_svc_items_order` | 已有 |
| retainedMember | client_wechat_users + service_orders | `(bound_store_id, became_member_at)` + `service_orders(client_user_id, service_date) WHERE status='已完成'` | ⚠️ 与 T5 共享，T5 已规划同款索引；T5 合并后无需重复加 |
| newMember | client_wechat_users | `(bound_store_id, member_level_upgraded_at)` | ⚠️ 检查；无则加部分索引 |
| projectCount | service_items | `(service_order_id, sales_category)` 部分索引 | ⚠️ 检查 |

如需要补索引：

```sql
-- 保有会员（与 T5 一致；如 T5 已合并则跳过）
CREATE INDEX IF NOT EXISTS idx_cwu_bound_became_member
  ON client_wechat_users (bound_store_id, became_member_at)
  WHERE became_member_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_svc_orders_completed_date_client
  ON service_orders (service_date, client_user_id)
  WHERE status = '已完成' AND client_user_id IS NOT NULL;

-- 新会员
CREATE INDEX IF NOT EXISTS idx_cwu_bound_level_upgrade
  ON client_wechat_users (bound_store_id, member_level_upgraded_at)
  WHERE old_member_level IS NULL AND member_level IS NOT NULL;

-- 项目数（自销自耗/他销自耗 是少数派，部分索引体积小）
CREATE INDEX IF NOT EXISTS idx_svc_items_order_self_consume
  ON service_items (service_order_id, sales_category)
  WHERE sales_category IN ('自销自耗','他销自耗');
```

部署后跑 `EXPLAIN ANALYZE`，P95 > 500ms 才考虑加索引。

### 3.5 metrics.md 时间窗口扩展（必做）

在 `notes/references/metrics.md` 的"时间窗口缩写约定"章节追加：

```md
| `[paid_at_period]` | 按 period 维度命中（`month`/`lastMonth`/`year`） |
| `[service_date_period]` | 同上 |
| `[member_level_upgraded_at_period]` | 同上 |

- 「本月」= `date_trunc('month', col) = date_trunc('month', NOW()::date)`
- 「上月」= `date_trunc('month', col) = date_trunc('month', NOW()::date - INTERVAL '1 month')`
- 「本年」= `date_trunc('year', col) = date_trunc('year', NOW()::date)`
```

并在变更记录追加：

```md
| 2026-04-?? | 追加 period 时间窗口缩写（month/lastMonth/year）；为 storeRanking 接口服务 |
```

---

## 4 测试

### 4.1 单元测试（`routes/mgmt-dashboard.test.js` 追加 case）

构造 1 个 market + 3 个 store + 跨月份数据，断言：

- **基础排序**：3 店业绩 [200, 100, 50] → rows[0].storeId = 业绩 200 的店；rank 依次 1/2/3
- **同值并列**：3 店业绩 [100, 100, 50] → rank 依次 1/1/3
- **value=0 也返回**：某店本月无销售 → 仍出现在结果中，value=0、排末位
- **二级排序稳定**：同值时 store_name ASC（避免数据库随机返回）
- **period=lastMonth**：仅命中上月数据；本月数据不计入
- **period=year**：当年所有月数据聚合
- **metric=retainedMember + period=lastMonth**：refDate=上月最后一天；过滤 became_member_at <= refDate；过滤 service_date 在 refDate 前 90 天内
- **metric=retainedMember + period=month/year**：refDate=今天；与 lastMonth 不同（除非数据极端巧合）
- **metric=retainedMember 边界**：顾客 became_member_at = refDate 当天 → 算入；became_member_at = refDate+1 → 不算入
- **metric=retainedMember 90 天边界**：唯一一次到店 service_date = refDate-89 → 算入；service_date = refDate-91 → 不算入
- **metric=projectCount**：仅 sales_category IN ('自销自耗','他销自耗') 的 service_items 计入；'他销他耗' / '生态合作' 不计入
- **metric=projectCount session_used**：value = SUM(session_used)，不是 COUNT(*)（防止误用）
- **metric=newMember**：按 member_level_upgraded_at 命中 period；old_member_level IS NULL ∧ member_level IS NOT NULL
- **权限 headquarters**：返回所有 market 下的全部店
- **权限 market**：仅返回 auth.scopeStoreIds 内的店；其他 market 的店不出现
- **权限 market 且 scopeStoreIds 为空**：返回 rows=[]（不报错）
- **参数校验**：非法 period / metric → 抛 `INVALID_PARAMS`

### 4.2 联调

部署后用 staff devtools（headquarters 账号）：

```js
wx.cloud.callFunction({
  name: 'staffApi',
  data: { action: 'mgmtDashboard.storeRanking', payload: { period: 'month', metric: 'revenue' } }
})
```

人工对一个已知月份的业绩排行（与 admin 后台导出的销售报表对比），确保口径一致。

### 4.3 性能

- 单次请求 P95 < 500ms（单条聚合 SQL，门店数 ≤30 量级）
- 加 `console.time` 日志，慢于 800ms 时打 warning（已写入 §3.3）

---

## 5 风险

| 风险 | 缓解 |
|------|------|
| `client_wechat_users` 个别店缺索引导致全表扫描 | §3.4 部分索引按需添加；EXPLAIN ANALYZE 验证 |
| 上月切月时 `NOW()::date - INTERVAL '1 month'` 边界（每月 31 号问题） | 用 `date_trunc('month', ...)` 锚定，不会受到天数边界影响 |
| 保有会员 method=B 与 T5 实现漂移 | T5 是同时段姐妹 ticket；本 ticket SQL 与 T5 §3.5 公式严格一致；T5 合并后抽 helper（如 `queryRetainedAtRefDate`） |
| 保有会员 month/year 数值相同让用户疑惑 | 这是方案 B 的本质（refDate 都是今天）；如业务想要"period 内活跃过的会员"是另一指标，需另开 ticket（INDEX 已说明） |
| 项目数 `service_items.sales_category` 历史数据为 NULL | T1 实施前跑数据自检 SQL；缺失则补一次性回填脚本（按 sale_items 反查） |
| `LEFT JOIN` 大表（service_items × service_orders）造成笛卡儿积 | service_items 与 service_orders 是 1-N 关系；GROUP BY 后 SUM 正确 |
| 同店多个 market 节点（理论上 1 店只挂 1 个 market） | 前置约束保证；如出现多市场归属，业务上是数据问题，需先修 |

---

## 6 不在本 ticket 范围

- 前端 ranking tab UI / 调用 / 渲染（在 [Ticket 2](./2026-04-25-mgmt-store-ranking-page.md)）
- 员工排行榜（mgmt-navbar 中另一个 tab）
- 排行榜导出 / 下钻 / 对比
- T5 保有会员历史化（独立 ticket，详见 [`metrics-date-alignment.md` §3.5](./2026-04-25-mgmt-dashboard-metrics-date-alignment.md)）；本 ticket 与 T5 共享公式但各自独立落地

---

## 7 交付物

- [ ] `staffApi/routes/mgmt-dashboard.js` 追加 `storeRanking` 函数 + 6 个 metric 查询子函数（含方案 B 保有会员、真实公式项目数）
- [ ] `staffApi/index.js` 路由注册 `mgmtDashboard.storeRanking`
- [ ] `staffApi/CLAUDE.md` 路由表追加 `storeRanking`
- [ ] `notes/references/metrics.md` 追加 period 时间窗口缩写定义 + 变更记录
- [ ] T1 实施前跑 `SELECT COUNT(*) FROM service_items WHERE sales_category IS NULL`；缺失则补一次性回填脚本
- [ ] `routes/mgmt-dashboard.test.js` 追加 §4.1 全部 case
- [ ] 部署后联调验证 6 个指标 × 3 个时间维度（共 18 组）
- [ ] P95 < 500ms（云函数日志确认）
- [ ] （按需）补充 §3.4 部分索引
