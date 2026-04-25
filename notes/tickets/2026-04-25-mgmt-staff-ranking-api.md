# Ticket 1: 员工排行榜接口（mgmtDashboard.staffRanking）

> 生成日期：2026-04-25
> 严重级别：P1（管理层 hub `ranking` tab 「员工」子视图核心数据接口）
> 端：staffApi 云函数
> 影响面：新增 1 个 action：`mgmtDashboard.staffRanking`
> 前置：无（与门店排行榜接口结构一致；如门店排行榜 T1 已合并，复用其 `timeWindowPeriod` helper；否则本 ticket 内联落地）
> 并行：可与 [Ticket 2 前端 page](./2026-04-25-mgmt-staff-ranking-page.md) 同步推进
>
> **一句话目标**：实现 `mgmtDashboard.staffRanking(period, metric)`，
> 返回所选时间段、所选指标下、当前账号有权见的全部产能员工的排行榜
> （`[{ rank, employeeId, employeeName, storeId, storeName, value }]`），按 value 降序。

---

## 0 一句话背景

需求页面是 `pages/mgmt-dashboard` 的 `ranking` tab 内的"员工"子视图（详见 [INDEX](./2026-04-25-mgmt-staff-ranking-INDEX.md)）。

视图结构（与门店排行榜对称）：

- 顶部 sub-toggle：门店 / 员工（默认门店）
- 时间 chip：本月 / 上月 / 本年（默认本月）
- 6 个指标按钮：业绩 / 实耗 / 新会员 / 客流 / 项目数 / 收入（默认业绩）
- 表格列：排名、员工姓名、所属门店、数据值（含单位标签）

现有 `mgmtDashboard.summary` 按 scope 聚合一个数；`mgmtDashboard.storeRanking` 按门店分组返回 N 行；本接口需要**按员工分组**返回 N 行 → 新建独立 action。

---

## 1 接口规格

### 1.1 入参

```ts
// payload
{
  period: 'month' | 'lastMonth' | 'year',  // 必填，时间维度
  metric: 'revenue' | 'consume' | 'newMember'
        | 'footfall' | 'projectCount' | 'income',  // 必填，6 选 1
}
```

> 注意 `metric` 集合与门店排行榜不同：
> - 门店：`revenue / consume / retainedMember / newMember / projectCount / footfall`
> - 员工：`revenue / consume / newMember / footfall / projectCount / income`
>
> 差异：员工无"保有会员排名"（保有会员是顾客状态，归属门店；员工层无对应概念）；员工有"收入排名"（销售提成 + 服务提成合计）。

### 1.2 返回

```ts
{
  period: 'month' | 'lastMonth' | 'year',
  metric: 'revenue' | ...,
  unit: 'amount' | 'count',     // 'amount'=金额（业绩/实耗/收入）；'count'=人数/计数
  rows: [
    {
      rank: 1,
      employeeId: 'EMP001',
      employeeName: '胡蕾',
      storeId: 'S001',
      storeName: '南昌蓝茉店',
      value: 16800,
    },
    ...
  ],
  computedAt: 'ISO timestamp',
}
```

- `rows` 永远包含**全部当前账号有权见的产能员工**（即使 value=0 也要返回，用于"垫底"展示）
- "产能员工"判定（与 metrics.md `employeeCount` 一致）：
  - `is_resigned = FALSE`
  - `skills && ARRAY['美容师','养生师']`
- `rank` 后端计算，同值并列采用 `RANK()` 而非 `ROW_NUMBER()`；二级排序按 `employee_name ASC`，三级 `employee_id ASC`
- 离职员工 / 非美容师养生师员工**不出现**在结果中（即使本期有产出也不出现）
- `unit` 由后端给出，前端用来选择格式化函数（`formatAmount` vs `formatCount`）

### 1.3 权限

- `requireManagementLevel`（与 `summary` / `storeRanking` 一致）
- 不接收 `scopeType/scopeId`：账号 staffLevel 决定可见员工
  - `headquarters` → 全部产能员工
  - `market` → 仅 `auth.scopeStoreIds`（自动展开自己 market 下的门店）下属员工

---

## 2 SQL 设计

### 2.1 时间窗口构造（与 storeRanking 共享 helper）

如果门店排行榜 T1 已合并 → 直接复用 `timeWindowPeriod(col, period, isDateColumn)`；如果未合并，本 ticket 内联同样定义（见 [门店排行榜 T1 §2.1](./2026-04-25-mgmt-store-ranking-api.md)）。

```js
function timeWindowPeriod(col, period) {
  if (period === 'month') {
    return `date_trunc('month', ${col}) = date_trunc('month', NOW()::date)`
  }
  if (period === 'lastMonth') {
    return `date_trunc('month', ${col}) = date_trunc('month', NOW()::date - INTERVAL '1 month')`
  }
  return `date_trunc('year', ${col}) = date_trunc('year', NOW()::date)`
}
```

### 2.2 共用：账号可见 store_id 列表

复用 `getVisibleStoreIds(auth)`（如 storeRanking 已落地则共享）。SQL 拼接同样用 `buildStoreFilter(visibleStoreIds, alias, startIdx)`。

```js
function getVisibleStoreIds(auth) {
  if (auth.staffLevel === 'headquarters') return null  // null = 不过滤
  return auth.scopeStoreIds || []
}

function buildStoreFilter(visibleStoreIds, alias, startIdx) {
  if (!visibleStoreIds) return { sql: 'TRUE', params: [] }
  if (visibleStoreIds.length === 0) {
    return { sql: 'FALSE', params: [] }
  }
  return {
    sql: `${alias}.store_id = ANY($${startIdx}::text[])`,
    params: [visibleStoreIds],
  }
}
```

### 2.3 共用：产能员工基表（`producerEmployees CTE`）

所有 6 个指标的 SQL 都先用 CTE 锁定"当前账号可见的产能员工"，再 LEFT JOIN 各指标聚合，确保 0 值员工也参与排行：

```sql
WITH producer_employees AS (
  SELECT
    sw.employee_id,
    sw.name        AS employee_name,
    sw.store_id,
    s.store_name
  FROM staff_wechat_users sw
  LEFT JOIN stores s ON s.store_id = sw.store_id
  WHERE sw.is_resigned = FALSE
    AND sw.skills && ARRAY['美容师','养生师']
    AND ${storeFilter}        -- alias 'sw'
)
```

> **`store_id IS NULL` 边界**：员工档案 `store_id` 字段允许 null（无门店挂靠员工，如总部职能岗）。
> - 这类员工 `skills` 也通常不含美容师/养生师 → 自动被过滤掉
> - 若发生数据异常（产能员工 store_id 为 null）→ LEFT JOIN stores 会让 store_name 为 null；前端兜底显示 "—"

### 2.4 1️⃣ 业绩排名

```sql
WITH producer_employees AS (...),
revenue_by_emp AS (
  SELECT
    sa.employee_id,
    COALESCE(SUM(sa.total_amount::numeric), 0) AS v
  FROM sale_allocations sa
  JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
  JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
  WHERE sa.is_void = FALSE
    AND sa.role_type IN ('美容师','养生师')
    AND so.sale_order_type IN ('销售单','转换单')
    AND so.status = '已支付'
    AND ${timeWindowPeriod('so.paid_at')}
  GROUP BY sa.employee_id
)
SELECT
  pe.employee_id,
  pe.employee_name,
  pe.store_id,
  pe.store_name,
  COALESCE(r.v, 0) AS value
FROM producer_employees pe
LEFT JOIN revenue_by_emp r ON r.employee_id = pe.employee_id
ORDER BY value DESC, pe.employee_name ASC, pe.employee_id ASC
```

> **退款单 `total_amount` 为负数**：自然抵消，符合"净销售业绩"语义。
> **CTE 内不再过滤 `sa.employee_id` 在 producer_employees 内**：通过最终 LEFT JOIN 自动剔除离职/非产能员工的分配（即使他们曾被分到业绩，也不进员工排行）。

### 2.5 2️⃣ 实耗排名

```sql
WITH producer_employees AS (...),
consume_by_emp AS (
  SELECT
    sit.employee_id,
    COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS v
  FROM service_items sit
  JOIN service_orders so ON so.service_order_id = sit.service_order_id
  WHERE so.status = '已完成'
    AND ${timeWindowPeriod('so.service_date')}
  GROUP BY sit.employee_id
)
SELECT
  pe.employee_id, pe.employee_name, pe.store_id, pe.store_name,
  COALESCE(c.v, 0) AS value
FROM producer_employees pe
LEFT JOIN consume_by_emp c ON c.employee_id = pe.employee_id
ORDER BY value DESC, pe.employee_name ASC, pe.employee_id ASC
```

> 注意 `service_date` 是 date 类型，`timeWindowPeriod` 不需要 `::date` 转换（helper 内的 `date_trunc('month', col)` 对 date 列直接生效）。

### 2.6 3️⃣ 新会员排名

> **判定字段已更新**（详见 [INDEX §决策 D4](./2026-04-25-mgmt-staff-ranking-INDEX.md)）：
> - 用 `client_wechat_users.became_member_at`（首次成为会员客的时间戳）落 period
> - **不再用** `old_member_level IS NULL ∧ member_level IS NOT NULL ∩ member_level_upgraded_at`（旧口径含等级跃迁，语义偏离"新会员"）

```sql
WITH producer_employees AS (...),
new_member_by_emp AS (
  SELECT
    c.bound_employee_id AS employee_id,
    COUNT(*) AS v
  FROM client_wechat_users c
  WHERE c.bound_employee_id IS NOT NULL
    AND c.became_member_at IS NOT NULL
    AND ${timeWindowPeriod('c.became_member_at')}
  GROUP BY c.bound_employee_id
)
SELECT
  pe.employee_id, pe.employee_name, pe.store_id, pe.store_name,
  COALESCE(n.v, 0) AS value
FROM producer_employees pe
LEFT JOIN new_member_by_emp n ON n.employee_id = pe.employee_id
ORDER BY value DESC, pe.employee_name ASC, pe.employee_id ASC
```

> **`bound_employee_id IS NULL` 的新会员不进任何员工统计**（详见 [INDEX §决策 D4](./2026-04-25-mgmt-staff-ranking-INDEX.md)）；
> 这部分总数与"全门店新会员总数"会有差额，差额即"无归属新会员"，本 ticket 不展示，可在监控里关注。
>
> **数据自检（T1 实施前必跑）**：
>
> ```sql
> SELECT
>   COUNT(*) FILTER (WHERE bound_employee_id IS NULL) AS unattributed,
>   COUNT(*)                                            AS total,
>   ROUND(100.0 * COUNT(*) FILTER (WHERE bound_employee_id IS NULL) / NULLIF(COUNT(*), 0), 2) AS pct
> FROM client_wechat_users
> WHERE became_member_at IS NOT NULL
>   AND date_trunc('month', became_member_at) = date_trunc('month', NOW()::date);
> ```
>
> 若 `pct > 30%` → 暂停推进，与业务确认是否切换到 `promoter_employee_id` 或"按首次升级时的服务单 service_items.employee_id"。
>
> **跨 ticket 同步项（实施时需一并处理，避免新旧口径并存）**：
> - 更新 `notes/references/metrics.md` "新会员"行公式 + 时间窗口缩写
> - 更新门店排行榜 ticket [§2.6 新会员排名 SQL](./2026-04-25-mgmt-store-ranking-api.md) 与本 SQL 字段对齐（如门店 ticket 已合并部署，本 T1 顺手提一个修正 PR）
> - 扫描 `staffApi/routes/` 与 `mgmt-dashboard.js` 内所有 "old_member_level / member_level_upgraded_at" 的"新会员"查询，确认是否同步切换到 became_member_at（重点：`mgmtDashboard.summary` 的 `queryNewMembers`）

### 2.7 4️⃣ 客流排名

```sql
WITH producer_employees AS (...),
footfall_by_emp AS (
  SELECT
    sit.employee_id,
    COUNT(DISTINCT so.client_user_id) AS v
  FROM service_items sit
  JOIN service_orders so ON so.service_order_id = sit.service_order_id
  WHERE so.status = '已完成'
    AND so.client_user_id IS NOT NULL
    AND ${timeWindowPeriod('so.service_date')}
  GROUP BY sit.employee_id
)
SELECT
  pe.employee_id, pe.employee_name, pe.store_id, pe.store_name,
  COALESCE(f.v, 0) AS value
FROM producer_employees pe
LEFT JOIN footfall_by_emp f ON f.employee_id = pe.employee_id
ORDER BY value DESC, pe.employee_name ASC, pe.employee_id ASC
```

> **同顾客被多员工服务**：每个员工的 footfall 都+1（员工层去重，跨员工不去重）。例：客户 A 同一天被员工 X 服务 + 员工 Y 服务 → X 客流+1，Y 客流+1。这与"店级客流"（按门店去重）不同，但符合"员工接待了多少不同顾客"的语义。

### 2.8 5️⃣ 项目数排名

```sql
WITH producer_employees AS (...),
project_by_emp AS (
  SELECT
    sit.employee_id,
    COALESCE(SUM(sit.session_used), 0) AS v
  FROM service_items sit
  JOIN service_orders so ON so.service_order_id = sit.service_order_id
  WHERE so.status = '已完成'
    AND sit.sales_category IN ('自销自耗','他销自耗')
    AND ${timeWindowPeriod('so.service_date')}
  GROUP BY sit.employee_id
)
SELECT
  pe.employee_id, pe.employee_name, pe.store_id, pe.store_name,
  COALESCE(p.v, 0) AS value
FROM producer_employees pe
LEFT JOIN project_by_emp p ON p.employee_id = pe.employee_id
ORDER BY value DESC, pe.employee_name ASC, pe.employee_id ASC
```

> 与门店排行榜的"项目数"公式严格一致，仅 GROUP BY 维度由 store_id 改为 employee_id。
> **快照字段 `service_items.sales_category`**：与门店排行榜共用同一个回填要求（schema/service.ts:64 已落库；如未回填历史数据，需补一次性回填）。

### 2.9 6️⃣ 收入排名

```sql
WITH producer_employees AS (...),
sales_comm AS (
  SELECT
    sa.employee_id,
    COALESCE(SUM(sa.total_amount::numeric), 0) AS v
  FROM sale_allocations sa
  JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
  JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
  WHERE sa.is_void = FALSE
    AND sa.role_type IN ('美容师','养生师')
    AND so.sale_order_type IN ('销售单','转换单')
    AND so.status = '已支付'
    AND ${timeWindowPeriod('so.paid_at')}
  GROUP BY sa.employee_id
),
service_comm AS (
  SELECT
    sc.employee_id,
    COALESCE(SUM(sc.commission_amount::numeric), 0) AS v
  FROM service_commissions sc
  JOIN service_items sit ON sit.service_item_id = sc.service_item_id
  JOIN service_orders so ON so.service_order_id = sit.service_order_id
  WHERE sc.is_void = FALSE
    AND sc.role_type IN ('美容师','养生师')
    AND so.status = '已完成'
    AND ${timeWindowPeriod('so.service_date')}
  GROUP BY sc.employee_id
)
SELECT
  pe.employee_id, pe.employee_name, pe.store_id, pe.store_name,
  COALESCE(sc1.v, 0) + COALESCE(sc2.v, 0) AS value
FROM producer_employees pe
LEFT JOIN sales_comm   sc1 ON sc1.employee_id = pe.employee_id
LEFT JOIN service_comm sc2 ON sc2.employee_id = pe.employee_id
ORDER BY value DESC, pe.employee_name ASC, pe.employee_id ASC
```

> **业绩 vs 收入的差异**：销售部分两者公式完全相同（同一个 `sales_comm` CTE）；收入额外加了服务提成（`service_comm`）。
> **退款抵消**：`sale_allocations.total_amount` 退款为负 → 收入榜单的销售部分含净退款效果，符合"实拿口径"。

### 2.10 排名计算

JS 层遍历计算，与门店排行榜共享 `assignRanks(rows)`：

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

---

## 3 实现要点

### 3.1 文件组织

直接在 `staffApi/routes/mgmt-dashboard.js` 中**追加** `staffRanking` 函数，与 `summary` / `storeRanking` 同文件维护：

```js
module.exports = {
  scopeOptions,
  summary,
  storeRanking,    // 门店排行榜（已规划）
  staffRanking,    // 员工排行榜（本 ticket 新增）
  __resetMarketsCache,
}
```

**helper 复用**：
- `timeWindowPeriod` / `getRefDateExpr` / `getVisibleStoreIds` / `buildStoreFilter` / `assignRanks` 全部与 storeRanking 共享
- 如 storeRanking 尚未合并，本 ticket 同步落地这些 helper（与 storeRanking ticket 内定义保持一致；先合并者落地，后者复用）

### 3.2 路由注册

`staffApi/index.js` 追加：

```js
'mgmtDashboard.staffRanking': () => require('./routes/mgmt-dashboard').staffRanking,
```

### 3.3 函数骨架

```js
async function staffRanking(ctx) {
  await requireManagementLevel()(ctx, async () => {})
  const { period, metric } = ctx.event.payload || {}

  const VALID_PERIODS = ['month', 'lastMonth', 'year']
  const VALID_METRICS = ['revenue', 'consume', 'newMember', 'footfall', 'projectCount', 'income']

  if (!VALID_PERIODS.includes(period)) {
    throw new Error('INVALID_PARAMS: period must be month/lastMonth/year')
  }
  if (!VALID_METRICS.includes(metric)) {
    throw new Error('INVALID_PARAMS: metric must be one of: ' + VALID_METRICS.join('/'))
  }

  const visibleStoreIds = getVisibleStoreIds(ctx.auth)
  const storeFilter = buildStoreFilter(visibleStoreIds, 'sw', 1)

  const t0 = Date.now()
  const rawRows = await runStaffMetricQuery(metric, period, storeFilter)

  const unit = (metric === 'revenue' || metric === 'consume' || metric === 'income') ? 'amount' : 'count'
  const rows = assignRanks(rawRows.map((r) => ({
    employeeId: r.employee_id,
    employeeName: r.employee_name || '',
    storeId: r.store_id || null,
    storeName: r.store_name || '',
    value: Number(r.value || 0),
  })))

  const elapsed = Date.now() - t0
  if (elapsed > 800) {
    console.warn(`[mgmtDashboard.staffRanking] slow: ${elapsed}ms`, { period, metric })
  }

  ctx.result = { period, metric, unit, rows, computedAt: new Date().toISOString() }
}
```

`runStaffMetricQuery(metric, period, storeFilter)` 内部按 metric 分发到 §2.4–2.9 的具体 SQL（每个 metric 一段独立 CTE 查询）。

### 3.4 性能与索引

排行榜每次请求执行 1 条 CTE 聚合 SQL（按员工 GROUP BY）。员工数 ≤200，聚合行数小，性能瓶颈在 LEFT JOIN 大表的扫描：

| 指标 | 主表 | 关键索引 | 备注 |
|------|------|----------|------|
| revenue / income.sales_part | sale_allocations + sale_items + sale_orders | `idx_sale_alloc_employee_id`(已有) + `idx_sale_orders_paid_at`(检查) | sa.employee_id 索引已建 |
| consume / footfall / projectCount | service_items + service_orders | `idx_svc_orders_store_date`(已有) + `(service_items.employee_id)` 部分索引 | ⚠️ 检查 service_items.employee_id 索引 |
| income.service_part | service_commissions + service_items + service_orders | `idx_svc_comm_employee_id`(已有) + `idx_svc_orders_store_date` | ✅ 已有 |
| newMember | client_wechat_users | `(bound_employee_id, became_member_at)` 部分索引 | ⚠️ 检查；无则加 |

需要补的索引：

```sql
-- service_items.employee_id（实耗 / 客流 / 项目数 都按此 GROUP BY）
CREATE INDEX IF NOT EXISTS idx_svc_items_employee_id
  ON service_items (employee_id);

-- 项目数（self-consume 是少数派，部分索引体积小）
CREATE INDEX IF NOT EXISTS idx_svc_items_emp_self_consume
  ON service_items (employee_id, sales_category)
  WHERE sales_category IN ('自销自耗','他销自耗');

-- 新会员（按归属员工分组，became_member_at 口径）
CREATE INDEX IF NOT EXISTS idx_cwu_bound_emp_became_member
  ON client_wechat_users (bound_employee_id, became_member_at)
  WHERE bound_employee_id IS NOT NULL
    AND became_member_at IS NOT NULL;
```

**部署后跑 `EXPLAIN ANALYZE`**，P95 > 500ms 才考虑加更多索引。所有索引按需添加（先观察再加）。

### 3.5 metrics.md 扩展（必做）

如门店排行榜 T1 已先合并，则 period 段已存在；本 ticket 仅追加"员工排行榜归属规则"小节即可。

#### 5.3.1 period 时间窗口缩写（可能已由门店排行榜 T1 添加）

```md
| `[paid_at_period]` | 按 period 维度命中（`month`/`lastMonth`/`year`） |
| `[service_date_period]` | 同上 |
| `[member_level_upgraded_at_period]` | 同上 |
```

#### 5.3.2 新增小节"员工排行榜归属规则"

在 metrics.md 适当位置（建议放在"提成"章节之后）追加：

```md
## 员工排行榜归属

> 用于 mgmtDashboard.staffRanking 接口的归属字段约定。

| 指标 | 归属字段 | 备注 |
|------|---------|------|
| 业绩（员工层） | `sale_allocations.employee_id` | role_type IN ('美容师','养生师') ∩ is_void=FALSE |
| 实耗（员工层） | `service_items.employee_id` | 实际服务执行人 |
| 客流（员工层） | `service_items.employee_id` | DISTINCT client_user_id（员工内去重，跨员工不去重） |
| 项目数（员工层） | `service_items.employee_id` | 同 metrics.md "项目数" sales_category 过滤 |
| 新会员（员工层） | `client_wechat_users.bound_employee_id` | 判定字段 = `became_member_at`（首次成为会员客时间）；bound_employee_id IS NULL 的新会员不归属任何员工 |
| 收入（员工层） | 销售=`sale_allocations.employee_id`；服务=`service_commissions.employee_id` | role_type 限定 ∩ is_void=FALSE；销售按 paid_at，服务按 service_date |

> **产能员工范围**（`staff_wechat_users`）：`is_resigned=FALSE` ∩ `skills && ARRAY['美容师','养生师']` ∩ scope（`store_id`），与 employeeCount 一致。
```

并在变更记录追加：

```md
| 2026-04-?? | 追加员工排行榜归属规则小节；6 指标按员工分组的字段映射 |
```

---

## 4 测试

### 4.1 单元测试（`routes/mgmt-dashboard.test.js` 追加 case）

构造 1 个 market + 2 个 store + 4 个员工（其中 1 个推广师 / 1 个离职 / 2 个产能在职）+ 跨月份数据，断言：

**结构 / 排序**：
- **基础排序**：3 员工业绩 [200, 100, 50] → rows[0].employeeId = 业绩 200 的员工；rank 依次 1/2/3
- **同值并列**：3 员工 [100, 100, 50] → rank 依次 1/1/3
- **value=0 也返回**：某员工本月无产出 → 仍出现在结果中，value=0、排末位
- **二级排序稳定**：同值时 employee_name ASC（避免数据库随机返回）
- **三级排序兜底**：同值同名（极端） employee_id ASC

**员工范围过滤**：
- **离职员工不进**：is_resigned=TRUE → 即使本期有产出，也不在结果中
- **推广师不进**：skills 不含美容师/养生师 → 不在结果中
- **离职员工的 sale_allocations 不破坏排行**：离职员工被分配的业绩，CTE LEFT JOIN 自动剔除

**period 切换**：
- **period=lastMonth**：仅命中上月数据；本月数据不计入
- **period=year**：当年所有月数据聚合

**6 个指标**：
- **metric=revenue**：`SUM(sale_allocations.total_amount)`，role_type 过滤生效；推广师业绩不计入
- **metric=consume**：`SUM(unit_real_price × session_used)`；service_items.employee_id 分组
- **metric=newMember**：bound_employee_id 归属；NULL 不计；period 命中 `became_member_at`（旧字段 member_level_upgraded_at 已废弃）
- **metric=footfall**：`COUNT(DISTINCT client_user_id)`；员工内去重，跨员工不去重
- **metric=projectCount**：`SUM(session_used)` ∩ sales_category 过滤
- **metric=income**：sales + service 求和；同员工两边都有 → 求和正确

**权限**：
- **headquarters**：返回所有 market 下全部产能员工
- **market**：仅返回自己 scopeStoreIds 内门店的员工
- **market 且 scopeStoreIds 为空**：返回 rows=[]（不报错）

**参数校验**：非法 period / metric → 抛 `INVALID_PARAMS`

**边界**：
- **员工 store_id IS NULL**（理论上不应发生）：rows 中 storeId=null，storeName=''，前端兜底
- **员工 name IS NULL**（数据问题）：employeeName=''，前端兜底"未命名员工"

### 4.2 联调

部署后用 staff devtools（headquarters 账号）：

```js
wx.cloud.callFunction({
  name: 'staffApi',
  data: { action: 'mgmtDashboard.staffRanking', payload: { period: 'month', metric: 'income' } }
})
```

人工对一个已知员工本月的销售提成 + 服务提成，与员工绩效页（`staff.performanceDetail`）的 totalCommission 对照，确保口径一致（注意 performanceDetail 是单员工，本接口是全员排行）。

### 4.3 性能

- 单次请求 P95 < 500ms（CTE 聚合 SQL，员工数 ≤200 量级）
- 加 `console.time` 日志，慢于 800ms 时打 warning（已写入 §3.3）

### 4.4 数据自检（T1 实施前）

```sql
-- 1. 新会员归属覆盖率（became_member_at 口径）
SELECT
  COUNT(*) FILTER (WHERE bound_employee_id IS NULL) AS unattributed,
  COUNT(*) AS total,
  ROUND(100.0 * COUNT(*) FILTER (WHERE bound_employee_id IS NULL) / NULLIF(COUNT(*), 0), 2) AS pct
FROM client_wechat_users
WHERE became_member_at IS NOT NULL
  AND date_trunc('month', became_member_at) = date_trunc('month', NOW()::date);

-- 2. service_items.sales_category 历史覆盖（与门店排行榜共用）
SELECT COUNT(*) AS null_count FROM service_items WHERE sales_category IS NULL;

-- 3. 产能员工总数（健康度参考）
SELECT COUNT(*) FROM staff_wechat_users
WHERE is_resigned = FALSE AND skills && ARRAY['美容师','养生师'];
```

若 (1) > 30% 或 (2) > 0 → 评估补回填脚本 / 调整归属字段。

---

## 5 风险

| 风险 | 缓解 |
|------|------|
| `bound_employee_id` 覆盖率低导致新会员排行不准 | §4.4 (1) 自检；> 30% 时与业务讨论是否切换归属字段 |
| `service_items.employee_id` 历史索引缺失 | §3.4 添加 `idx_svc_items_employee_id`，按需 EXPLAIN |
| 同一员工跨多店服务（数据可能） | 员工档案 `store_id` 是默认门店，不影响实际服务归属（按 service_items.employee_id 分组）；展示时按员工档案默认门店 |
| 离职员工本月有产出但不进排行 | 与 D1 决策一致；如业务想看"含离职员工的本月产出"，另开 ticket |
| 推广师不进排行让推广师不满 | 与人均口径一致；可考虑为推广师做单独排行 ticket |
| `unit_real_price` 为 NULL 的 service_items | SUM(NULL × session_used) = NULL → COALESCE 兜底 0 |
| service_commissions 与 sale_allocations 重复计算（如某员工同时是销售人和服务人） | 没问题，两者属不同维度收入（销售 vs 服务），求和符合"总收入"语义 |

---

## 6 不在本 ticket 范围

- 前端 ranking tab 加 sub-toggle + 调用 / 渲染（在 [Ticket 2](./2026-04-25-mgmt-staff-ranking-page.md)）
- 顾客 / 商品等其他维度排行
- 排行榜下钻（点击员工查明细）
- 推广师独立排行
- 排行榜导出 / 对比

---

## 7 交付物

- [ ] `staffApi/routes/mgmt-dashboard.js` 追加 `staffRanking` 函数 + 6 个 metric 查询子函数
- [ ] `staffApi/index.js` 路由注册 `mgmtDashboard.staffRanking`
- [ ] `staffApi/CLAUDE.md` 路由表 mgmtDashboard 行追加 `staffRanking`
- [ ] `notes/references/metrics.md` 追加"员工排行榜归属"小节 + 变更记录（period 段如已被门店 ticket 添加则跳过）
- [ ] 数据自检 §4.4 三条 SQL；新会员归属 NULL 比例 > 30% 时暂停（先对齐业务）
- [ ] `routes/mgmt-dashboard.test.js` 追加 §4.1 全部 case
- [ ] 部署后联调验证 6 个指标 × 3 个时间维度（共 18 组）
- [ ] P95 < 500ms（云函数日志确认）
- [ ] （按需）补充 §3.4 索引
