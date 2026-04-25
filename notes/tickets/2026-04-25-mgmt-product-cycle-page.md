# Ticket: 管理层品项数据子页（mgmt-dashboard 入口"品项数据"）

> 生成日期：2026-04-25
> **实施状态：✅ 已落地**（前端 + 后端 + 38 测试 cases 全部完成）
> 端：fengyu-staff（小程序前端 + staffApi 云函数）
> 实施位置：
>   - 前端：[`fengyu-staff/miniprogram/packageMgmt/mgmt-product-cycle/`](../../fengyu-staff/miniprogram/packageMgmt/mgmt-product-cycle/) 4 文件
>   - 入口跳转：`pages/mgmt-dashboard/mgmt-dashboard.ts:405-413`
>   - 云函数路由：[`staffApi/routes/mgmt-product.js`](../../fengyu-staff/cloudfunctions/staffApi/routes/mgmt-product.js)
>   - 路由表注册：`staffApi/index.js:111-112`
>   - 单元测试：[`staffApi/__tests__/routes/mgmt-product.test.js`](../../fengyu-staff/cloudfunctions/staffApi/__tests__/routes/mgmt-product.test.js)（38 cases）
>   - 指标定义：[`notes/references/metrics.md`](../references/metrics.md) "品项顾客周期子页" 章节
> 关联：
>   - [`mgmt-traffic-stats-page`](./2026-04-25-mgmt-traffic-stats-page.md) — 同期管理层 hub 子页（参考视图风格）
>   - [`mgmt-store-ranking-page`](./2026-04-25-mgmt-store-ranking-page.md) — scope 传参、chip 风格参考
>
> **一句话目标**：mgmt-dashboard 首页"品项数据"入口的子页落地，含 Section「品项-顾客周期」
> （持卡人数 / 体验情况 / 新增情况 / 复购情况）+ period chip（本月/上月/本年）+ scope 继承 hub。

---

## 0 背景

`pages/mgmt-dashboard/mgmt-dashboard.ts` 的 `onEntryTap` 4 个入口中，
`entry === 'products'` 对应"品项数据"子页（已实施）；`sales` / `customers` 仍 toast"开发中"。

会议纪要 `notes/meetings/meeting-20260417/article.md` 第六节定义品项板块核心指标：
**持卡人数**（按品项疗程卡持有数）/ **复购人数 / 业绩**。
一级品项当前为 `护理项目 / 家居产品 / 充值卡 / 体验卡`；后续将拆为 `招牌/王牌/明星 + 家居产品 + 充值卡 + 体验卡`，
本子页数据层已兼容（前端按 `product_kind` 值动态展示，无硬编码品项名）。

---

## 1 视图设计

### 1.1 顶部筛选

```
┌──────────────────────────────────────────────┐
│ [ 本月 ]  [ 上月 ]  [ 本年 ]                  │
└──────────────────────────────────────────────┘
```

- 3 个 chip（默认 `本月` 高亮），自绘 view，与 mgmt-traffic-stats 同风格。
- scope 继承上层 hub，**不重复出 scope-picker**；路由参数 `scopeType` / `scopeId` 从 hub 传入。

### 1.2 主体 — Section「品项-顾客周期」

按一级品项（`product_kind`）各展一行，共 4 个子区块。

```
─── 品项-顾客周期 ───

### 持卡人数（持卡人数 ÷ 总会员人数）[截面快照]

┌────────────────┬──────────┬──────────┐
│ 品项           │ 持卡人数 │   占比   │
├────────────────┼──────────┼──────────┤
│ 护理项目       │  2,000   │  33.33%  │
│ 家居产品       │  1,000   │  16.67%  │
│ 充值卡         │  1,000   │  16.67%  │
│ 体验卡         │    500   │   8.33%  │
└────────────────┴──────────┴──────────┘

### 体验情况（区间内：在该品项消费但全历史从未达标的顾客）

┌────────────────┬──────────┬──────────────┬──────────┐
│ 品项           │   人数   │    业绩      │  客单价  │
└────────────────┴──────────┴──────────────┴──────────┘

### 新增情况（区间内：首次在该品项消费达标的顾客 = 品项进入总人数）

┌────────────────┬──────────┬──────────────┬──────────┐
│ 品项           │   人数   │    业绩      │  客单价  │
└────────────────┴──────────┴──────────────┴──────────┘

### 复购情况（区间内：已进入该品项、在不同于首购日再次达标的顾客）

┌────────────────┬──────────┬──────────────┬──────────┐
│ 品项           │   人数   │    业绩      │  客单价  │
└────────────────┴──────────┴──────────────┴──────────┘
```

> **持卡人数**为截面快照（NOW()）；切换 period chip 不影响此数据，区域标题加角标「截面」提示。
> **新增 ∩ 复购 可共存**：同一 period 内，某顾客在第 1 天首次达标（新增）且在第 5 天再次达标（复购），
> 同时出现在两个统计中（COUNT(DISTINCT) 各自计一次，前端不去重）。

### 1.3 加载 / 空态

- 切换 chip → `loading=true`，重拉 `cycleStats`（持卡不重拉）；保留旧 display 防闪屏。
- 接口失败 → toast；持卡子区块单独 fail 不影响其他三块。
- 空数据品项行：`人数=0`、`业绩=0.00`、`客单价=--`（避免显示 `0.00` 误导客单价为 0）。
- 当返回的列表为空（无任何 product_kind 出数）→ 子区块统一显示「暂无数据」占位。

---

## 2 时间口径

与 sales-data 页一致，详见 metrics.md "时间窗口补充（sales-data 页专用口径）"：

| chip | period 入参 | period_start | period_end |
|------|-------------|-------------|------------|
| 本月 | `month` | `date_trunc('month', NOW()::date)` | `NOW()::date` |
| 上月 | `lastMonth` | `date_trunc('month', NOW()::date - INTERVAL '1 month')` | `date_trunc('month', NOW()::date) - INTERVAL '1 day'` |
| 本年 | `year` | `date_trunc('year', NOW()::date)` | `NOW()::date` |

实现位置：`mgmt-product.js:95-112` `getSalesDataPeriod()`。

> 持卡人数为截面，无 period_start/end，仅用 `NOW()` 时刻的 remaining_sessions。

---

## 3 指标计算逻辑

权威定义见 `notes/references/metrics.md` "品项顾客周期子页" 章节。摘要：

- **达标日**（qualifying day）：`SUM(si.received)` 在 `(client_user_id, store_id, product_kind, paid_at::date)` 分组下 ≥ `new_member_threshold`（动态读取 `system_configs`，工具函数 `getMemberThreshold()`，默认 1990，缓存 5 分钟）。
- **entry_date**（首次进入日）：当前 scope 范围内全历史最早的达标日（**scope 范围内跨店合并**：scope=全部时全店面合并、scope=市场时市场内合并、scope=门店时即本店历史）。
- **新增**：entry_date 落在 `[startDate, endDate]` 内。
- **复购**：在 `[startDate, endDate]` 内有达标日，且该日 `<>` entry_date。
- **体验**：在 `[startDate, endDate]` 内有购买，但 scope 范围内全历史从未有达标日。
- **持卡人数**：`sale_items.remaining_sessions > 0` ∩ `product_type IN ('疗程卡','单品')`（含单次卡），院装产品不计；当前快照（NOW()），不随 period 变化。
- **持卡占比**：`持卡人数 / memberCount × 100%`，保留 2 位小数；分母 0 → null（前端显示 `--`）。

---

## 4 实施现状（代码位置 + 关键差异）

### 4.1 入口跳转 — ✅ 已实施

`pages/mgmt-dashboard/mgmt-dashboard.ts:405-413`：

```ts
if (entry === 'products') {
  const { scope } = this.data
  const params = [
    `scopeType=${scope.scopeType}`,                       // 'all' | 'market' | 'store'
    scope.scopeId ? `scopeId=${encodeURIComponent(scope.scopeId)}` : '',
  ].filter(Boolean).join('&')
  wx.navigateTo({ url: `/packageMgmt/mgmt-product-cycle/mgmt-product-cycle?${params}` })
  return
}
```

> scope 在 hub 是嵌套对象 `this.data.scope = { scopeType, scopeId, scopeName }`，
> 子页通过路由参数读取 → `onLoad(query)` 平铺到 `data.scopeType / scopeId`。

### 4.2 前端页面 — ✅ 已实施

[`packageMgmt/mgmt-product-cycle/`](../../fengyu-staff/miniprogram/packageMgmt/mgmt-product-cycle/) 4 文件：

| 文件 | 行数 | 说明 |
|------|------|------|
| `mgmt-product-cycle.ts` | 163 | Page 数据 + 两接口调用（cardHolders / cycleStats）+ buildDisplay |
| `mgmt-product-cycle.wxml` | 124 | 4 个 pc-subsection（持卡 + 体验 + 新增 + 复购）|
| `mgmt-product-cycle.wxss` | — | 表格样式 + 角标「截面」|
| `mgmt-product-cycle.json` | — | 页面配置 |

`app.json:47-51` 已注册 `packageMgmt` 分包，含 `mgmt-traffic-stats` + `mgmt-product-cycle`。

数据结构与原设计一致（`CardHolderRow` / `ProductKindRow` / `CycleStatsResp`）。
持卡人数仅 `onLoad` 拉一次，period chip 切换只重拉 `cycleStats`。

### 4.3 后端云函数 — ✅ 已实施

[`staffApi/routes/mgmt-product.js`](../../fengyu-staff/cloudfunctions/staffApi/routes/mgmt-product.js)（396 行）：

**`cardHolders`**（`mgmt-product.js:146-215`）：
- `requireManagementLevel()` 守卫 + `validateScope()` 越权防护（headquarters / market / store 三档）。
- 持卡 SQL：`sale_items JOIN sale_orders JOIN product_skus JOIN product_categories`，过滤 `si.product_type IN ('疗程卡','单品') AND si.remaining_sessions > 0` ∩ `so.sale_order_type IN ('销售单','转换单')` ∩ `so.status='已支付'` ∩ scope（`so.store_id`），按 `pc.product_kind` GROUP BY DISTINCT `client_user_id`。
- memberCount SQL：`client_wechat_users WHERE became_member_at IS NOT NULL` ∩ scope（`bound_store_id`），与 metrics.md memberCount T2 历史化口径对齐；持卡为截面，本接口不带 `$date` 守卫。
- 返回：`{ scope: {type,id,name}, memberCount, cardHolders: [{productKind,count,rate}], computedAt }`。

**`cycleStats`**（`mgmt-product.js:239-393`）：
- 同样守卫 + scope 校验。
- `getSalesDataPeriod(period)` → `{ startDate, endDate }`；`getMemberThreshold()` → threshold（动态读 `system_configs`）。
- **单次 SQL** 实现：CTE 链 `daily_agg → qualifying_days → first_entry → period_agg → xinzeng / fugou / tiyan` + **3 段 UNION ALL** 输出 `group_kind ∈ {'trial','new','repurchase'}`，外层按 `group_kind` 分桶。
- 参数顺序：`$1=startDate, $2=endDate, $3=threshold, $4...=scope params`；scope SQL 由 `buildSaleScope()` 拼接。
- avgTicket 计算：`count > 0 ? revenue / count : null`，前端 `null → '--'`。
- 800ms slow warn。

### 4.4 单元测试 — ✅ 已实施（38 cases）

[`__tests__/routes/mgmt-product.test.js`](../../fengyu-staff/cloudfunctions/staffApi/__tests__/routes/mgmt-product.test.js)：

| 描述块 | cases |
|--------|-------|
| `cardHolders 参数与权限校验` | 6（INVALID_PARAMS × 3 + PERMISSION_DENIED × 3）|
| `cardHolders SQL 形态` | 5（product_type IN ... + memberCount + scope 三档）|
| `cardHolders 出数` | 4（rate 计算 + 防除零 + 空 cardRows + 小数舍入）|
| `cycleStats 参数与权限校验` | 6（period × 2 + scopeType × 2 + scopeId + 越权 × 2）|
| `cycleStats SQL 形态` | 11（CTE 链 + UNION ALL + scope 三档 + threshold mock + 时间参数）|
| `cycleStats 出数` | 6（trial/new/repurchase 分桶 + avgTicket 防除零 + 三类共存）|

> Mock pg.query 按 SQL 关键字匹配返回不同 stub；与 mgmt-dashboard.test.js 同思路。

---

## 5 决策点（已全部拍板，2026-04-25）

| 编号 | 议题 | 结论 |
|------|------|------|
| **D-cardholder-period** | 持卡人数时态 | **截面快照**（NOW()，remaining_sessions > 0），不随 period 变化；UI 加"截面"角标 |
| **D-cardholder-definition** | "持卡"范围 | **`product_type IN ('疗程卡','单品')`**（含单次卡）∩ `remaining_sessions > 0`；院装产品不计；不限定 item_direction |
| **D-fugou-revenue** | 复购业绩口径 | **全部购买**：复购客群在 period 内该品项 SUM(received)（与体验/新增口径统一） |
| **D-cross-store-entry** | entry_date 跨店语义 | **scope 范围内跨店合并**：daily_agg 已带 scope，first_entry 在其上 MIN → 自然实现 scope=全部/市场时跨店合并、scope=门店时仅本店 |
| **D-package-path** | 新页面分包 | **packageMgmt**（已存在分包，与 mgmt-traffic-stats 同分包）|

---

## 6 测试与验收

### 6.1 后端 — ✅ 已通过

- `bun test routes/mgmt-product.test.js` → 38/38 PASS
- 覆盖：参数 + 权限 + SQL 形态 + scope 三档 + 防除零 + 出数

### 6.2 前端 — 待人工验收

- 微信开发者工具登录 HQ → mgmt-dashboard → 品项数据卡片 → 子页正确渲染 4 个子区块。
- 切换 period chip → 体验/新增/复购数据刷新；持卡人数不变（角标"截面"）。
- 在 hub 切换 scope 后再进入子页 → 数据按新 scope 刷新。
- 接口失败 → toast；保留旧 display 防闪屏。
- 数字格式：金额 2 位小数 + 千分位；人数整数 + 千分位；占比 2 位小数 + `%`。

### 6.3 数据自检 SQL（可运行版）

> 以"本月"+全部 scope 为例；threshold 从 system_configs 读。

```sql
WITH params AS (
  SELECT
    date_trunc('month', NOW()::date)::date                                AS start_date,
    NOW()::date                                                            AS end_date,
    (SELECT (value)::int FROM system_configs WHERE key='new_member_threshold')
      AS threshold
),
daily_agg AS (
  SELECT so.client_user_id, so.store_id, pc.product_kind,
         so.paid_at::date AS purchase_date,
         SUM(si.received::numeric) AS day_received
    FROM sale_items si
    JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
    JOIN product_skus sk ON sk.sku_id = si.sku_id
    JOIN product_categories pc ON pc.category_id = sk.category_id
    CROSS JOIN params p
   WHERE so.sale_order_type IN ('销售单','转换单')
     AND so.status = '已支付'
     AND so.client_user_id IS NOT NULL
     AND pc.product_kind IS NOT NULL
     AND so.paid_at::date <= p.end_date
   GROUP BY so.client_user_id, so.store_id, pc.product_kind, so.paid_at::date
),
qualifying_days AS (
  SELECT da.* FROM daily_agg da CROSS JOIN params p
   WHERE da.day_received >= p.threshold
),
first_entry AS (
  SELECT client_user_id, product_kind, MIN(purchase_date) AS entry_date
    FROM qualifying_days
   GROUP BY client_user_id, product_kind
),
period_agg AS (
  SELECT da.* FROM daily_agg da CROSS JOIN params p
   WHERE da.purchase_date BETWEEN p.start_date AND p.end_date
),
xinzeng AS (
  SELECT client_user_id, product_kind FROM first_entry, params p
   WHERE entry_date BETWEEN p.start_date AND p.end_date
),
fugou AS (
  SELECT DISTINCT q.client_user_id, q.product_kind
    FROM qualifying_days q
    JOIN first_entry f ON f.client_user_id = q.client_user_id
                      AND f.product_kind   = q.product_kind
    CROSS JOIN params p
   WHERE q.purchase_date BETWEEN p.start_date AND p.end_date
     AND q.purchase_date <> f.entry_date
),
tiyan AS (
  SELECT DISTINCT pa.client_user_id, pa.product_kind
    FROM period_agg pa
   WHERE NOT EXISTS (
     SELECT 1 FROM first_entry f
      WHERE f.client_user_id = pa.client_user_id
        AND f.product_kind   = pa.product_kind
   )
)
-- 自检 1：体验 ∩ 新增 = ∅（应返回 0 行）
SELECT 'CHECK_FAIL: 体验 ∩ 新增 不为空' AS warn,
       COUNT(*) AS bad_rows
  FROM (
    SELECT client_user_id, product_kind FROM tiyan
    INTERSECT
    SELECT client_user_id, product_kind FROM xinzeng
  ) bad
HAVING COUNT(*) > 0
UNION ALL
-- 自检 2：体验 ∩ 复购 = ∅（应返回 0 行）
SELECT 'CHECK_FAIL: 体验 ∩ 复购 不为空',
       COUNT(*)
  FROM (
    SELECT client_user_id, product_kind FROM tiyan
    INTERSECT
    SELECT client_user_id, product_kind FROM fugou
  ) bad
HAVING COUNT(*) > 0
UNION ALL
-- 自检 3：复购客必有 entry_date（应返回 0 行）
SELECT 'CHECK_FAIL: 复购客无 entry_date',
       COUNT(*)
  FROM fugou f
 WHERE NOT EXISTS (
   SELECT 1 FROM first_entry fe
    WHERE fe.client_user_id = f.client_user_id
      AND fe.product_kind   = f.product_kind
 )
HAVING COUNT(*) > 0;
-- 三个 UNION 全部不返回 → 互斥/前提关系成立
```

> 跑库前在 [test 库 5434] 执行；如有任一行返回非零 `bad_rows`，说明 SQL 逻辑有 bug 或数据异常。

---

## 7 已知偏差与待跟进

### 7.1 memberCount 口径 — ✅ 已统一（2026-04-25）

`mgmt-product.js:184-188` 已切到 `c.became_member_at IS NOT NULL`，与 `mgmt-dashboard.js` 及 metrics.md `memberCount` T2 历史化口径一致；测试 mock 与断言（`mgmt-product.test.js:64,167,181,197,216`）同步更新；38/38 tests pass。

> 持卡人数本身是截面（NOW()），切换前后结果等价（`became_member_at` 与 `customer_type='会员客'` 同事务维护）；表达层统一即可。

### 7.2 性能下界缺失

`daily_agg` 的 `paid_at::date <= $endDate` 无下界，全历史扫描随运营时长增长。
当前数据量级（几万行 sale_items）跑得动，未来 50 万行+ 时建议：
- 加索引 `idx_so_client_paid (client_user_id, paid_at, status)`；
- 或物化 `client_product_first_entry` 物化视图（每日 cron 刷新）。

### 7.3 招牌/王牌/明星 拆分

会议纪要 2026-04-17 决定将 `护理项目` 拆为 招牌/王牌/明星。
本子页数据层已兼容（按 `product_kind` 动态展示），DB 改动落地后无需修改本接口。

---

## 8 不在本 ticket 范围

- 各品项下的"二级分类"汇总（`category_name` 维度，独立 ticket）。
- 销售数据 / 顾客档案 2 个 mgmt-dashboard 入口（独立 ticket）。
- entry_date 物化（性能优化，等出现压力再做）。

---

## 9 交付物清单

- [x] `packageMgmt/mgmt-product-cycle/{ts,wxml,wxss,json}` 4 文件
- [x] `app.json` 已注册 `packageMgmt` 分包（含 mgmt-product-cycle）
- [x] `pages/mgmt-dashboard/mgmt-dashboard.ts` `onEntryTap` 品项数据入口跳转
- [x] `cloudfunctions/staffApi/routes/mgmt-product.js`（cardHolders + cycleStats）
- [x] `cloudfunctions/staffApi/index.js` 路由表 `mgmtProduct.cardHolders / cycleStats`
- [x] `cloudfunctions/staffApi/__tests__/routes/mgmt-product.test.js`（38 cases）
- [x] `notes/references/metrics.md` 同步（"品项顾客周期子页" 章节 + 变更记录）
- [x] memberCount 口径统一（7.1，2026-04-25 完成；mgmt-product.js + 测试 + metrics.md 同步）
- [ ] 微信开发者工具端到端验收
- [ ] dev 库自检 SQL 跑通（6.3，待 dev DB 启动）
