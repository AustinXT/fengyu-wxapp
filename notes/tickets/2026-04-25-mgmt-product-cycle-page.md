# Ticket: 管理层品项数据子页（mgmt-dashboard 入口"品项数据"）

> 生成日期：2026-04-25
> 严重级别：P1（mgmt-dashboard 首页"品项数据"入口当前 onEntryTap 仅 toast"开发中"）
> 端：fengyu-staff（小程序前端 + staffApi 云函数）
> 影响面：
>   - 新增页面：`fengyu-staff/miniprogram/pages/mgmt-product-cycle/`
>   - 改造：`pages/mgmt-dashboard/mgmt-dashboard.ts` `onEntryTap` 入口跳转（`entry === 'products'`）
>   - 新增云函数路由：`staffApi/routes/mgmt-product.js`
>   - metrics.md 已同步追加品项顾客周期子页指标定义（详见 `notes/references/metrics.md` "品项顾客周期子页"章节）
> 关联：
>   - [`mgmt-traffic-stats-page`](./2026-04-25-mgmt-traffic-stats-page.md) — 同期管理层 hub 子页（参考视图风格）
>   - [`mgmt-store-ranking-page`](./2026-04-25-mgmt-store-ranking-page.md) — scope 传参、chip 风格参考
>
> **一句话目标**：把 mgmt-dashboard 首页"品项数据"入口替换为完整的品项数据子页，
> 包含 Section「品项-顾客周期」（持卡人数 / 体验情况 / 新增情况 / 复购情况）+ 时间筛选 chip（本月/上月/本年）
> + scope 继承 hub。

---

## 0 背景

`pages/mgmt-dashboard/mgmt-dashboard.ts:338-347` 的 `onEntryTap` 当前 4 个入口全部 toast"开发中"。
`entry === 'products'` 对应"品项数据"。会议纪要 `notes/meetings/meeting-20260417/article.md` 第六节
定义了品项板块的核心指标：**持卡人数**（按品项疗程卡持有数）/ **复购人数 / 业绩**，
并明确一级品项现为 `护理项目 / 家居产品 / 充值卡 / 体验卡`（后续拆为招牌/王牌/明星/家居产品/充值卡/体验卡，
本 ticket 数据层已兼容，前端文案按 `product_kind` 值展示，无需硬编码品项名）。

---

## 1 视图设计

### 1.1 顶部筛选

```
┌──────────────────────────────────────────────┐
│ [ 本月 ]  [ 上月 ]  [ 本年 ]    （scope 显示） │
└──────────────────────────────────────────────┘
```

- 3 个 chip（默认 `本月` 高亮），与 mgmt-traffic-stats 同风格（自绘 view）。
- scope 继承上层 hub，不重复出 scope-picker；路由参数 `scopeId` / `scopeType` 从 hub 传入。

### 1.2 主体 — Section「品项-顾客周期」

本 Section 按一级品项（`product_kind`）各展一行，共 4 个子区块。

```
─── 品项-顾客周期 ───

### 持卡人数（持卡人数 ÷ 总会员人数）[截面快照，不随 period 变化]

┌────────────────┬──────────┬──────────┐
│ 品项           │ 持卡人数 │   占比   │
├────────────────┼──────────┼──────────┤
│ 护理项目       │  2,000   │  33.33%  │
│ 家居产品       │  1,000   │  16.67%  │
│ 充值卡         │  1,000   │  16.67%  │
│ 体验卡         │    500   │   8.33%  │
└────────────────┴──────────┴──────────┘

### 体验情况（区间内：在该品项消费但从未达标的顾客）

┌────────────────┬──────────┬──────────────┬──────────┐
│ 品项           │   人数   │    业绩      │  客单价  │
├────────────────┼──────────┼──────────────┼──────────┤
│ 护理项目       │   50人   │  18,000.00   │ 2,000.00 │
│ 家居产品       │   40人   │  30,000.00   │ 3,000.00 │
│ …              │          │              │          │
└────────────────┴──────────┴──────────────┴──────────┘

### 新增情况（区间内：首次在该品项消费达标的顾客 = 品项进入总人数）

┌────────────────┬──────────┬──────────────┬──────────┐
│ 品项           │   人数   │    业绩      │  客单价  │
├────────────────┼──────────┼──────────────┼──────────┤
│ 护理项目       │    9人   │  18,000.00   │ 2,000.00 │
│ 家居产品       │   10人   │  30,000.00   │ 3,000.00 │
│ …              │          │              │          │
└────────────────┴──────────┴──────────────┴──────────┘

### 复购情况（区间内：已进入该品项、在不同于首购日再次达标的顾客）

┌────────────────┬──────────┬──────────────┬──────────┐
│ 品项           │   人数   │    业绩      │  客单价  │
├────────────────┼──────────┼──────────────┼──────────┤
│ 护理项目       │    9人   │  18,000.00   │ 2,000.00 │
│ 家居产品       │   10人   │  30,000.00   │ 3,000.00 │
│ …              │          │              │          │
└────────────────┴──────────┴──────────────┴──────────┘
```

> **持卡人数**为截面快照（当前时刻），切换 period chip 不影响此数据，区域内加角标「截面」提示。
> **新增 ∩ 复购 可共存**：同一 period 内，某顾客在第 1 天首次达标（新增）且在第 5 天再次达标（复购），
> 则同时出现在两个统计中。这是正常的业务现象，前端不需要去重处理。

### 1.3 加载 / 空态

- 切换 chip → loading=true，重拉接口；保留旧 display 防闪屏。
- 接口失败 → 顶部 toast + 各单元格显示 `--`。
- 空数据（某 product_kind 无购买记录）直接显示 `0` 人数 + `--` 客单价（防除零规则）。

---

## 2 时间口径

与 sales-data 页完全一致（metrics.md "时间窗口补充（sales-data 页专用口径）"）：

| chip | period 入参 | period_start | period_end |
|------|-------------|-------------|------------|
| 本月 | `month` | `date_trunc('month', NOW()::date)` | `NOW()::date` |
| 上月 | `lastMonth` | `date_trunc('month', NOW()::date - INTERVAL '1 month')` | `date_trunc('month', NOW()::date) - INTERVAL '1 day'` |
| 本年 | `year` | `date_trunc('year', NOW()::date)` | `NOW()::date` |

> 持卡人数为截面，不使用 period_start / period_end 过滤。

---

## 3 指标计算逻辑

详见 `notes/references/metrics.md` "品项顾客周期子页"章节。

关键规则摘要：
- **达标日（qualifying day）**：`SUM(si.received)` 在 `(client_user_id, store_id, product_kind, paid_at::date)` 分组下 ≥ `new_member_threshold`（动态读取 `system_configs` 表，工具函数 `getMemberThreshold()`）。
- **entry_date（首次进入日）**：该 client 在该 product_kind 下全历史中最早的达标日（截至 $endDate）。
- **新增**：entry_date 落在 `[startDate, endDate]` 内。
- **复购**：在 `[startDate, endDate]` 内有达标日，且该日 ≠ entry_date。
- **体验**：在 `[startDate, endDate]` 内有购买，但全历史（截至 endDate）从未有达标日。
- **持卡人数**：`sale_items.remaining_sessions > 0` ∩ `product_type IN ('疗程卡','单品')`（含单次卡），当前快照（NOW()），不随 period 变化。

---

## 4 代码改动

### 4.1 入口跳转

**`fengyu-staff/miniprogram/pages/mgmt-dashboard/mgmt-dashboard.ts`** `onEntryTap`（第 338 行起）：

```ts
onEntryTap(e: WechatMiniprogram.BaseEvent) {
  const entry = (e.currentTarget.dataset as { entry?: string }).entry
  if (entry === 'traffic') { /* 已有逻辑 */ return }
  if (entry === 'products') {
    const { selectedScopeId, selectedScopeType } = this.data
    wx.navigateTo({
      url: `/packageMgmt/mgmt-product-cycle/mgmt-product-cycle?scopeId=${selectedScopeId || ''}&scopeType=${selectedScopeType || ''}`,
    })
    return
  }
  // sales / customers 仍 toast，分别独立 ticket
  ...
}
```

### 4.2 新页面骨架

**`fengyu-staff/miniprogram/pages/mgmt-product-cycle/`**（4 文件 ts/wxml/wxss/json）：

**data 结构**：

```ts
type Period = 'month' | 'lastMonth' | 'year'

interface ProductKindRow {
  productKind: string                  // e.g. '护理项目'
  count: number
  revenue: number
  avgTicket: number | null             // null → UI 显示 '--'
}

interface CardHolderRow {
  productKind: string
  count: number
  rate: number | null                  // 持卡人数 / 总会员人数；null → '--'
}

interface ProductCycleData {
  cardHolders: CardHolderRow[]         // 持卡人数（截面，不随 period 变化）
  trial: ProductKindRow[]              // 体验情况
  newEntry: ProductKindRow[]           // 新增情况
  repurchase: ProductKindRow[]         // 复购情况
}
```

**页面逻辑**：
- `onLoad(query)` 读 `scopeId` / `scopeType` → `setData`；同时拉接口。
- 持卡人数**仅在 onLoad 时拉取一次**（截面），不随 period chip 重拉。
- `onPeriodChange` 切 chip → 重拉体验/新增/复购 3 个指标（持卡人数复用已有数据）。
- 后台数据返回后 `setData({ display: data })`，前端仅做格式化（`formatAmount` / `formatCount`）。

### 4.3 后端云函数

**新文件**：`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-product.js`

`index.js` 路由表追加：

```js
mgmtProduct: {
  cardHolders: require('./routes/mgmt-product').cardHolders,  // 截面，无 period
  cycleStats:  require('./routes/mgmt-product').cycleStats,   // 体验/新增/复购，有 period
}
```

**`cardHolders(payload, ctx)`**：
- `requireManagementLevel()` 守卫。
- 入参：`{ scopeId?: string, scopeType?: '市场' | '门店' }`。
- SQL：`sale_items JOIN sale_orders JOIN product_skus JOIN product_categories WHERE product_type='疗程卡' AND remaining_sessions > 0`，按 `product_kind` GROUP BY DISTINCT `client_user_id`。
- 同时查 `memberCount`（`client_wechat_users WHERE customer_type='会员客'`）用于计算占比。
- 返回 `{ cardHolders: CardHolderRow[], memberCount: number }`。

**`cycleStats(payload, ctx)`**：
- `requireManagementLevel()` 守卫。
- 入参：`{ period: 'month' | 'lastMonth' | 'year', scopeId?: string, scopeType?: '市场' | '门店' }`。
- 内部解析 `period` → `[startDate, endDate]`，同步读取 `new_member_threshold`（`getMemberThreshold()`）。
- 核心 CTE 链：`daily_agg → qualifying_days → first_entry → period_agg → xinzeng / fugou / tiyan`（完整 SQL 见 metrics.md）。
- 3 段聚合（体验/新增/复购）可在同一 WITH 块内完成，**单次 SQL 调用**即可。
- 返回 `{ trial: ProductKindRow[], newEntry: ProductKindRow[], repurchase: ProductKindRow[] }`。

> **slow warn 阈值**：`cycleStats` 含全历史扫描（`paid_at <= $endDate`，无下界），数据量随运营时长增长。
> 建议追加索引 `idx_so_client_paid(client_user_id, paid_at, status)` 加速。
> 800ms slow warn，超过时记录并告警（与其他 mgmt 路由一致）。

### 4.4 测试

**`__tests__/routes/mgmt-product.test.js`** 新增：

- `cardHolders`：product_type='疗程卡' ∩ remaining_sessions>0 SQL 形态断言；memberCount 查询独立。
- `cycleStats`：
  - `daily_agg` GROUP BY 包含 `client_user_id, store_id, product_kind, paid_at::date`。
  - `qualifying_days` 使用 `>= $threshold` 不等式（而非 `= threshold`）。
  - `first_entry` 使用 `MIN(purchase_date)`。
  - `fugou` 排除 `purchase_date = entry_date`。
  - `tiyan` 使用 NOT EXISTS 子查询排除有 entry 的顾客。
  - scope 三档（全部/市场/门店）WHERE 拼接断言。
  - 防除零：avgTicket 在 count=0 时返回 null。
  - `$threshold` 值来自 `getMemberThreshold()` mock（返回 1990）。

---

## 5 决策点（已全部拍板，2026-04-25）

| 编号 | 议题 | 结论 |
|------|------|------|
| **D-cardholder-period** | 持卡人数时态 | **截面快照**（NOW()，remaining_sessions > 0），不随 period 变化；UI 加"截面"角标 |
| **D-cardholder-definition** | "持卡"范围 | **`product_type IN ('疗程卡','单品')`**（含单次卡），remaining_sessions > 0；院装产品不计；不限定 item_direction |
| **D-fugou-revenue** | 复购业绩口径 | **全部购买**：复购客群在 period 内该品项 SUM(received)（与体验/新增口径统一） |
| **D-cross-store-entry** | entry_date 是否跨店 | **跨店合并**：entry_date 为顾客在任意门店（scope 范围内）的最早达标日；first_entry GROUP BY (client_user_id, product_kind) 不含 store_id |
| **D-package-path** | 新页面分包 | **packageMgmt**（与 mgmt-traffic-stats 同分包，新建） |

---

## 6 测试与验收

### 6.1 后端

- `mgmt-product.test.js` 全绿（SQL 形态 + scope 拼接 + 防除零 + threshold mock）。
- dev 环境 `_testOpenid` 命中总部账号，调用 `cardHolders` + `cycleStats`（3 period × 3 scope = 9 次）。

### 6.2 前端

- 微信开发者工具登录 HQ → mgmt-dashboard → 品项数据 → 子页正确渲染 4 个子区块。
- 切换 period chip → 体验/新增/复购数据刷新；持卡人数不变。
- scope 在 hub 切换后进入子页 → 数据按新 scope 刷新。
- 接口失败 → toast + 单元格 `--`。
- 空数据品项行：人数显示 `0`，客单价显示 `--`（不显示 `0.00`）。
- 数字格式：金额 2 位小数 + 千分位；人数整数 + 千分位；占比 2 位小数 + `%`。

### 6.3 数据自检 SQL

```sql
-- 验证新增+体验互斥：同一 product_kind 中，有 entry_date 的 client 不应出现在体验
-- （以下应返回 0 行）
WITH first_entry AS (
  SELECT so.client_user_id, pc.product_kind
  FROM sale_items si
  JOIN sale_orders so ON si.sale_order_id = so.sale_order_id
  JOIN product_skus sk ON si.sku_id = sk.sku_id
  JOIN product_categories pc ON sk.category_id = pc.category_id
  WHERE so.sale_order_type IN ('销售单','转换单') AND so.status='已支付'
  GROUP BY so.client_user_id, so.store_id, pc.product_kind, so.paid_at::date
  HAVING SUM(si.received) >= 1990
)
SELECT 'ERROR: 体验客应无 entry_date' AS check_name
FROM (
  SELECT DISTINCT pa_client, pa_kind FROM ... /* period_agg 体验集合 */
  INTERSECT
  SELECT client_user_id, product_kind FROM first_entry
) x;  -- 应返回 0 行

-- 验证复购客户必有 entry_date（应返回 0 行）
SELECT 'ERROR: 复购客应有 entry_date' AS check_name
FROM fugou_clients f
WHERE NOT EXISTS (
  SELECT 1 FROM first_entry fe
  WHERE fe.client_user_id = f.client_user_id AND fe.product_kind = f.product_kind
);
```

---

## 7 不在本 ticket 范围

- `护理项目` → `招牌/王牌/明星` 的拆分落地（本 ticket SQL 兼容，前端只展示 `product_kind` 值，无需改造）。
- 各品项下的"二级分类"汇总（`category_name` 维度，与此为并列 section，独立 ticket）。
- 销售数据 / 顾客档案 2 个 mgmt-dashboard 入口（独立 ticket）。
- 历史化改造（entry_date 当前依赖全历史扫描，若后续性能压力可改为增量更新物化列）。

---

## 8 工程量预估

- 前端页面 + 入口跳转：M（1 天，含样式 + 两接口联动）
- 后端 SQL（CTE 链较深）+ 路由 + 单测：L（1.5 天）
- 联调 + 决策点澄清：S（半天）
- **合计**：~3 天

---

## 9 交付物清单

- [ ] `pages/mgmt-product-cycle/{ts,wxml,wxss,json}` 4 文件
- [ ] `app.json` 注册新页面（`packageMgmt` 分包，与 mgmt-traffic-stats 并列）
- [ ] `pages/mgmt-dashboard/mgmt-dashboard.ts` `onEntryTap` 品项数据入口跳转改造
- [ ] `cloudfunctions/staffApi/routes/mgmt-product.js` 新建（`cardHolders` + `cycleStats`）
- [ ] `cloudfunctions/staffApi/index.js` 路由表追加 `mgmtProduct.cardHolders / cycleStats`
- [ ] `cloudfunctions/staffApi/__tests__/routes/mgmt-product.test.js` 新建
- [ ] `notes/references/metrics.md` 已同步（PR 内同 commit）
- [ ] 微信开发者工具端到端验收 + 数据自检 SQL 通过
