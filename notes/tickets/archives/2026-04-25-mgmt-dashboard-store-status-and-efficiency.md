# Ticket 5: 数据中心首页追加「门店状况 + 人效数据 + 入口区」

> 生成日期：2026-04-25
> 严重级别：P1（管理层 hub 第二批可视化区域）
> 端：staffApi 云函数（扩 1 个接口）+ fengyu-staff（追加 3 个区块到现有页面）
> 影响面：
> - `mgmtDashboard.summary` 返回体新增 3 字段（memberCount / retainedMemberCount / employeeCount）
> - `pages/mgmt-dashboard/mgmt-dashboard.{wxml,ts,wxss}` 在现有 8 卡片之后追加：A 门店状况区、B 人效数据区、C 入口区
> 前置（已归档至 `archives/`）：
> - [snapshot-fields](./archives/2026-04-25-mgmt-dashboard-snapshot-fields.md) — `is_shengmei` / `old_member_level` 等快照字段已落库
> - [summary-api](./archives/2026-04-25-mgmt-dashboard-summary-api.md) — `mgmtDashboard.summary` 已实现，本 ticket 在其上扩 3 字段
> - [home-page](./archives/2026-04-25-mgmt-dashboard-home-page.md) — `pages/mgmt-dashboard/dashboard` tab 已实现 8 卡片，本 ticket 在其布局尾部追加
> - [scope-picker](./archives/2026-04-25-mgmt-dashboard-scope-picker.md) — 顶部 scope 筛选器已实现，本 ticket 直接复用，**不引入第二组筛选**
>
> **一句话目标**：在现有 8 卡片下方追加两个新区块（"门店状况" 3 卡 / "人效数据" 8 卡）和 4 个跳转入口（客量/销售/品项/顾客档案），
> 三块的统计口径与上方 8 卡完全共享同一份 scope（市场/门店）+ 日期筛选；
> 新增 3 个原始计数（会员数 / 保有会员数 / 员工数），其余皆为派生（除法）字段。

---

## 0 一句话背景

参考截图（用户在本对话提供，已 import 到 ticket 描述）：

```
┌─────────────────── 门店状况 ───────────────────┐
│  会员数量: 12,000   保有会员: 4,000  占比: 33.33%│
│                                                │
│  门店数: 40        员工数: 600                  │
│  店均会员: 300     人均会员数: 20               │
│  店均保有会员: 100 人均会员数: 200              │
└────────────────────────────────────────────────┘
（截图中两个"人均会员数"按字面渲染同值，**数据不要求对得上**截图，
 设计稿数字仅示意排版位置）

┌─────────────────── 人效数据 ───────────────────┐
│  人均收入(月): 8000     ← ❌ 取消（用户指明）   │
│                                                │
│  人均业绩  人均生美业绩  人均实耗  人均生美实耗 │
│  日均/月均  日均/月均   日均/月均  日均/月均    │
│                                                │
│  人均客流  人均客量    人均新客   人均项目数    │
│  日均/月均  日均/月均   日均/月均  日均/月均    │
└────────────────────────────────────────────────┘

[查看客量数据 >]   [查看销售数据 >]
[查看品项数据 >]   [查看顾客档案 >]
```

- **筛选口径完全沿用现有顶部筛选器**（日历 + scope-picker）；不引入第二组筛选
- "今日"= 所选日期；"本月"= 所选日期所在自然月；与前置 [summary-api](./archives/2026-04-25-mgmt-dashboard-summary-api.md) §0 完全一致
- "门店状况"和"人效数据"出现的是**截面 + 滚动统计**：会员/保有会员是当前快照（不随日历日期变化），门店/员工是 scope 截面；人效里的"日均/月均"复用上方 8 卡的 today/month 再除以员工数

---

## 1 字段与公式

> 公式登记到 [`notes/references/metrics.md`](../references/metrics.md) 后再实现，**新增指标必须先入档**。

### 1.1 新增 3 个原始计数

| 指标 | 公式 | 数据源 | scope 过滤列 |
|------|------|--------|----------|
| 会员数（memberCount） | `COUNT(*)` | `client_wechat_users` | `customer_type = '会员客'` ∩ `bound_store_id` 在 scope 内 |
| 保有会员数（retainedMemberCount） | `COUNT(*)` | `client_wechat_users` | `customer_status IN ('保有会员-稳定','保有会员-有效')` ∩ `bound_store_id` 在 scope 内 |
| 员工数（employeeCount） | `COUNT(*)` | `staff_wechat_users` | `skills && ARRAY['美容师','养生师']` ∩ `is_resigned=FALSE` ∩ `store_id` 在 scope 内 |

**3 项均为"当前快照"，不与日历日期挂钩**。理由：会员/保有/员工是结构性数据，反映的是"看的时候的状态"，不是"那一天的状态"。如果产品后续要"那一天的会员数"，需另设审计字段（与 `old_member_level` 同思路），属另开 ticket 范围。

### 1.2 派生指标（前端计算，不在接口返回）

| 指标 | 公式 | 防除零 |
|------|------|--------|
| 占比（memberRetainRate） | `retainedMemberCount / memberCount × 100%` | `memberCount=0 → '--'` |
| 店均会员（avgMembersPerStore） | `memberCount / storeCount` | `storeCount=0 → '--'` |
| 店均保有会员（avgRetainedPerStore） | `retainedMemberCount / storeCount` | 同上 |
| 人均会员数（avgMembersPerEmp） | `memberCount / employeeCount` | `employeeCount=0 → '--'` |
| 人均会员数（截图右下重复位） | `memberCount / employeeCount`（与上一行同值，按字面渲染） | 同上 |
| 人均业绩 日/月 | `storeRevenue.today / employeeCount` 与 `.month / employeeCount` | 同上 |
| 人均生美业绩 日/月 | `shengmeiRevenue.today/.month / employeeCount` | 同上 |
| 人均实耗 日/月 | `storeConsume.today/.month / employeeCount` | 同上 |
| 人均生美实耗 日/月 | `shengmeiConsume.today/.month / employeeCount` | 同上 |
| 人均客流 日/月 | `footfall.today/.month / employeeCount` | 同上 |
| 人均客量 日/月 | `headcount.today/.month / employeeCount` | 同上 |
| 人均新客 日/月 | `newMembers.today/.month / employeeCount` | 同上 |
| 人均项目数 日/月 | `projectCount.today/.month / employeeCount` | 占位（projectCount 本身仍是 `--`） |

> "新会员"在 metrics.md 中对应字段名 `newMembers`，截图中称"人均新客" — UI 文案以截图为准（**新客** = 新会员），代码字段名沿用 `newMembers`。

### 1.3 数字格式化规则（统一约束）

> 用户明确：**数据不要求与截图对得上**；只约束格式。

| 类别 | 规则 | 示例 |
|------|------|------|
| 人数 / 计数 / 单数 | 整数 + 千分位 `,` | `12,000`、`4,000`、`600`、`40` |
| 金额（业绩 / 实耗 / 人均业绩 / 人均实耗 等） | **保留 2 位小数** + 千分位 `,` | `1,234,567.89`、`8,000.00`、`0.00` |
| 占比 | 保留 2 位小数 + `%` | `33.33%` |
| 防除零 / 数据缺失 | 一律 `--`（不显示 0） | — |

**实现要求**：
- `utils/number.ts` 中 `formatCount(n)`：`Math.round(n).toLocaleString('en-US')`，确保千分位
- `utils/number.ts` 中 `formatAmount(n)`：`n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })`，确保 2 位小数 + 千分位
- **不再使用** "超过 10000 折叠为'万'" 的旧规则（如 `home-page` ticket §1.3 写过的 `1.2 万` 表达） — 本批次统一用千分位长格式
- 若 `home-page` 已实现的 `formatAmount` / `formatCount` 包含"万"折叠逻辑，本 ticket **要顺手改掉它**（影响范围：8 个旧卡片金额会从 `1.2 万` 变成 `12,345.67`，运营 / 产品需要知会一声但不需要单独 ticket）
- 若业务后续给出明确语义，另开 patch ticket 调整；不在本 ticket 范围猜测口径

> 替代方案（更激进）：UI 层只渲染一个"人均会员数"，第二个位置留 `--` 占位 + 注释 "待业务定义"。**采用这个方案**，避免上线后两个相同数字让用户疑惑。

### 1.4 scope 过滤的列差异

| 表 | scope 过滤列 |
|---|---|
| `client_wechat_users` | `bound_store_id`（与新会员一致；all 视角不过滤） |
| `staff_wechat_users` | `store_id`（员工所属门店；all 视角不过滤） |

> market 过滤一律走 `IN (SELECT id FROM org_nodes WHERE type='store' AND parent_id=$X)`，与 [summary-api](./archives/2026-04-25-mgmt-dashboard-summary-api.md) §2.1 一致，**不**用 `position_name` / `org_node_id` 文本匹配。

### 1.5 storeCount 复用

`storeCount` 由 [summary-api](./archives/2026-04-25-mgmt-dashboard-summary-api.md) 已返回（"月店均"分母），本 ticket "门店状况"区直接消费同一个值，**不再单独 SQL**。

---

## 2 接口扩展

### 2.1 修改位置

`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js`（前置 ticket [summary-api](./archives/2026-04-25-mgmt-dashboard-summary-api.md) 已建），在 `summary` action 内追加 3 条 SQL（与现有 14 条并发）。

### 2.2 SQL

```sql
-- 会员数
SELECT COUNT(*) AS member_count
FROM client_wechat_users c
WHERE ${clientScope}
  AND c.customer_type = '会员客';

-- 保有会员数
SELECT COUNT(*) AS retained_count
FROM client_wechat_users c
WHERE ${clientScope}
  AND c.customer_status IN ('保有会员-稳定', '保有会员-有效');

-- 员工数（美容师 + 养生师 ∪，去重；in-place 后由 PG && 操作符去重）
SELECT COUNT(*) AS employee_count
FROM staff_wechat_users s
WHERE ${staffScope}
  AND s.is_resigned = FALSE
  AND s.skills && ARRAY['美容师','养生师']::text[];
```

> `&&` 是 PG 数组**任一相交**操作符（"skills 数组与 ['美容师','养生师'] 有交集"）。如果一个员工同时有"美容师"+"养生师"，COUNT 仍记 1，符合预期。

### 2.3 staff scope 构造

新建 `buildStaffScope`（与 `buildClientScope` 平行）：

```js
function buildStaffScope(scopeType, scopeId) {
  if (scopeType === 'all')   return { sql: 'TRUE', params: [] }
  if (scopeType === 'store') return { sql: 's.store_id = $X', params: [scopeId] }
  if (scopeType === 'market') return {
    sql: 's.store_id IN (SELECT id FROM org_nodes WHERE type=\'store\' AND parent_id = $X)',
    params: [scopeId],
  }
}
```

### 2.4 返回体新增字段

```ts
{
  // ... 现有 8 卡 + storeCount + computedAt 不变
  memberCount: number,            // 会员客 客户数（scope 内）
  retainedMemberCount: number,    // 保有会员客户数（scope 内）
  employeeCount: number,          // 美容师∪养生师 在职员工数（scope 内）
}
```

接口契约不增加单独 action，**复用 `mgmtDashboard.summary`**。前端调用方完全无变化（仅多读 3 个字段）。

### 2.5 性能

- 3 条 SQL 加入现有 `Promise.all`，共 17 条并发
- 索引依赖：
  - `client_wechat_users (bound_store_id, customer_type)` — 现有 `idx_client_users_bound_store_id` 已可命中第一段；如查询慢可加复合索引
  - `client_wechat_users (bound_store_id, customer_status)` — 同上
  - `staff_wechat_users (store_id, is_resigned)` — 已有 `idx_staff_users_store_resigned` ✅
- skills 数组的 `&&` 走 GIN 索引最快；预期全公司员工数 < 1000，**首版不加索引**，部署后看 EXPLAIN 决定

---

## 3 前端追加

### 3.1 修改位置

`fengyu-staff/miniprogram/pages/mgmt-dashboard/mgmt-dashboard.{wxml,wxss,ts}`，在 `block wx:if="{{ display }}"` 内的现有 8 卡片之后**追加**两个区块和入口区。**不动**现有 8 卡片。

### 3.2 buildDisplay 扩展

`mgmt-dashboard.ts` 的 `buildDisplay(s: SummaryData)` 增加新字段：

```ts
buildDisplay(s: SummaryData) {
  const emp = s.employeeCount
  const stores = s.storeCount
  const safeDiv = (n: number, d: number, formatter: (v: number) => string) =>
    d > 0 ? formatter(n / d) : '--'
  const perEmp = (n: number) => safeDiv(n, emp, formatAmount)        // 金额型
  const perEmpCount = (n: number) => safeDiv(n, emp, formatCount)    // 计数型

  return {
    // ... 现有 8 卡 display 不变 ...

    // 门店状况
    storeStatus: {
      memberCount:           formatCount(s.memberCount),
      retainedMemberCount:   formatCount(s.retainedMemberCount),
      retainRate:            s.memberCount > 0
        ? (s.retainedMemberCount / s.memberCount * 100).toFixed(2) + '%'
        : '--',
      storeCount:            formatCount(s.storeCount),
      employeeCount:         formatCount(s.employeeCount),
      avgMembersPerStore:    safeDiv(s.memberCount, stores, formatCount),
      avgRetainedPerStore:   safeDiv(s.retainedMemberCount, stores, formatCount),
      avgMembersPerEmp:      safeDiv(s.memberCount, emp, formatCount),
      // 截图右下重复位：与上一行同口径，按字面渲染
      avgMembersPerEmp2:     safeDiv(s.memberCount, emp, formatCount),
    },

    // 人效数据
    perEmployee: {
      revenue:        { day: perEmp(s.storeRevenue.today),    month: perEmp(s.storeRevenue.month) },
      shengmeiRev:    { day: perEmp(s.shengmeiRevenue.today), month: perEmp(s.shengmeiRevenue.month) },
      consume:        { day: perEmp(s.storeConsume.today),    month: perEmp(s.storeConsume.month) },
      shengmeiCons:   { day: perEmp(s.shengmeiConsume.today), month: perEmp(s.shengmeiConsume.month) },
      footfall:       { day: perEmpCount(s.footfall.today),   month: perEmpCount(s.footfall.month) },
      headcount:      { day: perEmpCount(s.headcount.today),  month: perEmpCount(s.headcount.month) },
      newMembers:     { day: perEmpCount(s.newMembers.today), month: perEmpCount(s.newMembers.month) },
      projectCount:   { day: '--',                            month: '--' },
    },
  }
}
```

> 派生计算放在前端的好处：避免接口频繁因为"加一个派生字段"而改动；统一在 buildDisplay 一处变更。

### 3.3 wxml 追加片段

在 `mgmt-dash-grid-small` 之后追加：

```xml
<!-- A. 门店状况 -->
<view class="dash-section-title">门店状况</view>

<view class="dash-status-row1">
  <view class="status-cell">
    <text class="lbl">会员数量：</text>
    <text class="val">{{ display.storeStatus.memberCount }}</text>
  </view>
  <view class="status-cell">
    <text class="lbl">保有会员：</text>
    <text class="val">{{ display.storeStatus.retainedMemberCount }}</text>
  </view>
  <view class="status-cell">
    <text class="lbl">占比：</text>
    <text class="val">{{ display.storeStatus.retainRate }}</text>
  </view>
</view>

<view class="dash-status-row2">
  <view class="status-block">
    <view class="status-line"><text class="lbl">门店数：</text><text class="val">{{ display.storeStatus.storeCount }}</text></view>
    <view class="status-line"><text class="lbl">店均会员：</text><text class="val">{{ display.storeStatus.avgMembersPerStore }}</text></view>
    <view class="status-line"><text class="lbl">店均保有会员：</text><text class="val">{{ display.storeStatus.avgRetainedPerStore }}</text></view>
  </view>
  <view class="status-block">
    <view class="status-line"><text class="lbl">员工数：</text><text class="val">{{ display.storeStatus.employeeCount }}</text></view>
    <view class="status-line"><text class="lbl">人均会员数：</text><text class="val">{{ display.storeStatus.avgMembersPerEmp }}</text></view>
    <view class="status-line"><text class="lbl">人均会员数：</text><text class="val">{{ display.storeStatus.avgMembersPerEmp2 }}</text></view>
    <!-- 与上一行同口径，按截图字面渲染 -->
  </view>
</view>

<!-- B. 人效数据 -->
<view class="dash-section-title">人效数据</view>

<view class="mgmt-dash-grid-small">
  <view class="dash-card dash-card--small">
    <view class="dash-card-title">人均业绩</view>
    <view class="dash-card-row"><text class="lbl">日均：</text><text class="val">{{ display.perEmployee.revenue.day }}</text></view>
    <view class="dash-card-row"><text class="lbl">月均：</text><text class="val">{{ display.perEmployee.revenue.month }}</text></view>
  </view>
  <view class="dash-card dash-card--small">
    <view class="dash-card-title">人均生美业绩</view>
    <view class="dash-card-row"><text class="lbl">日均：</text><text class="val">{{ display.perEmployee.shengmeiRev.day }}</text></view>
    <view class="dash-card-row"><text class="lbl">月均：</text><text class="val">{{ display.perEmployee.shengmeiRev.month }}</text></view>
  </view>
  <view class="dash-card dash-card--small">
    <view class="dash-card-title">人均实耗</view>
    <view class="dash-card-row"><text class="lbl">日均：</text><text class="val">{{ display.perEmployee.consume.day }}</text></view>
    <view class="dash-card-row"><text class="lbl">月均：</text><text class="val">{{ display.perEmployee.consume.month }}</text></view>
  </view>
  <view class="dash-card dash-card--small">
    <view class="dash-card-title">人均生美实耗</view>
    <view class="dash-card-row"><text class="lbl">日均：</text><text class="val">{{ display.perEmployee.shengmeiCons.day }}</text></view>
    <view class="dash-card-row"><text class="lbl">月均：</text><text class="val">{{ display.perEmployee.shengmeiCons.month }}</text></view>
  </view>
</view>

<view class="mgmt-dash-grid-small">
  <view class="dash-card dash-card--small">
    <view class="dash-card-title">人均客流</view>
    <view class="dash-card-row"><text class="lbl">日均：</text><text class="val">{{ display.perEmployee.footfall.day }}</text></view>
    <view class="dash-card-row"><text class="lbl">月均：</text><text class="val">{{ display.perEmployee.footfall.month }}</text></view>
  </view>
  <view class="dash-card dash-card--small">
    <view class="dash-card-title">人均客量</view>
    <view class="dash-card-row"><text class="lbl">日均：</text><text class="val">{{ display.perEmployee.headcount.day }}</text></view>
    <view class="dash-card-row"><text class="lbl">月均：</text><text class="val">{{ display.perEmployee.headcount.month }}</text></view>
  </view>
  <view class="dash-card dash-card--small">
    <view class="dash-card-title">人均新客</view>
    <view class="dash-card-row"><text class="lbl">日均：</text><text class="val">{{ display.perEmployee.newMembers.day }}</text></view>
    <view class="dash-card-row"><text class="lbl">月均：</text><text class="val">{{ display.perEmployee.newMembers.month }}</text></view>
  </view>
  <view class="dash-card dash-card--small">
    <view class="dash-card-title">人均项目数</view>
    <view class="dash-card-row"><text class="lbl">日均：</text><text class="val">{{ display.perEmployee.projectCount.day }}</text></view>
    <view class="dash-card-row"><text class="lbl">月均：</text><text class="val">{{ display.perEmployee.projectCount.month }}</text></view>
  </view>
</view>

<!-- C. 入口区 -->
<view class="dash-entries">
  <view class="dash-entry-row" bindtap="onEntryTap" data-entry="traffic">
    <text>查看客量数据</text><van-icon name="arrow" size="24rpx" color="#999" />
  </view>
  <view class="dash-entry-row" bindtap="onEntryTap" data-entry="sales">
    <text>查看销售数据</text><van-icon name="arrow" size="24rpx" color="#999" />
  </view>
  <view class="dash-entry-row" bindtap="onEntryTap" data-entry="products">
    <text>查看品项数据</text><van-icon name="arrow" size="24rpx" color="#999" />
  </view>
  <view class="dash-entry-row" bindtap="onEntryTap" data-entry="customers">
    <text>查看顾客档案</text><van-icon name="arrow" size="24rpx" color="#999" />
  </view>
</view>
```

### 3.4 wxss 追加

```css
.dash-section-title {
  font-size: 30rpx;
  font-weight: 600;
  color: #C0322A;
  text-align: center;
  margin: 32rpx 0 16rpx;
  padding-top: 16rpx;
  border-top: 2rpx solid #f0f0f0;
}

/* 门店状况 - 第一行 */
.dash-status-row1 {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  background: #fff;
  border-radius: 12rpx;
  padding: 24rpx 16rpx;
  margin-bottom: 16rpx;
  gap: 8rpx;
}
.status-cell { display: flex; flex-direction: column; align-items: flex-start; gap: 4rpx; }
.status-cell .lbl { font-size: 24rpx; color: #999; }
.status-cell .val { font-size: 28rpx; color: #333; font-weight: 600; }

/* 门店状况 - 第二行（左右两个 block） */
.dash-status-row2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16rpx;
}
.status-block {
  background: #fff;
  border-radius: 12rpx;
  padding: 20rpx 24rpx;
  display: flex;
  flex-direction: column;
  gap: 8rpx;
}
.status-line {
  display: flex;
  justify-content: space-between;
  font-size: 26rpx;
}
.status-line .lbl { color: #999; }
.status-line .val { color: #333; font-weight: 600; }

/* 入口区 */
.dash-entries {
  margin-top: 32rpx;
  display: flex;
  flex-direction: column;
  gap: 12rpx;
}
.dash-entry-row {
  background: #fff;
  border-radius: 12rpx;
  padding: 28rpx 24rpx;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 28rpx;
  color: #333;
}
.dash-entry-row:active { opacity: 0.7; }
```

### 3.5 入口跳转占位

```ts
// mgmt-dashboard.ts
onEntryTap(e: WechatMiniprogram.BaseEvent) {
  const entry = (e.currentTarget.dataset as any).entry as 'traffic' | 'sales' | 'products' | 'customers'
  // TODO: 4 个目的页待规划，先 toast 占位
  const labelMap = { traffic: '客量数据', sales: '销售数据', products: '品项数据', customers: '顾客档案' }
  wx.showToast({ icon: 'none', title: `${labelMap[entry]} 页面开发中` })
}
```

> 4 个跳转目的页**不在本 ticket 实现**，统一另开 ticket（每个目的页都是一个二级数据中心，有自己的筛选/明细，复杂度独立）。

### 3.6 SummaryData 类型扩展

在 `mgmt-dashboard.ts` 顶部更新：

```ts
interface SummaryData {
  // ... 原有 8 卡 + storeCount + computedAt
  memberCount: number
  retainedMemberCount: number
  employeeCount: number
}
```

---

## 4 测试

### 4.1 后端单元测试

`routes/mgmt-dashboard.test.js`（前置 ticket [summary-api](./archives/2026-04-25-mgmt-dashboard-summary-api.md) 已建）补 case：

- 构造 1 market + 2 store + 30 个 client_wechat_users（10 个 customer_type='会员客' / 5 个 customer_status='保有会员-稳定'） + 10 个 staff_wechat_users（5 个 skills 含'美容师'，3 个含'养生师'，2 个 skills=null）
- 断言：
  - `scopeType:'all'` → memberCount=10, retainedMemberCount=5, employeeCount=8
  - `scopeType:'market'` → 仅聚合该市场下 2 store 的客户/员工
  - `scopeType:'store'` → 仅一店
  - 离职员工 `is_resigned=true` 不计
  - skills=null 的员工不计
  - skills=['推广师'] 的员工不计
  - skills=['美容师','养生师'] 的员工只计 1（COUNT(*) 是行级，不是技能级）

### 4.2 前端展示测试

部署后用 HQ 账号验收：

1. 进入数据中心 → 滚动 → 看到现有 8 卡 → 看到"门店状况"标题分割 → 看到 3 卡（含占比）+ 2 列 status-block → 看到"人效数据"标题 → 看到 8 个人均小卡 → 看到 4 个入口
2. 切换日历日期：会员数 / 保有会员 / 员工数 / 门店数 **不变**（截面）；人均日/月均**变化**（除数不变，被除数变）
3. 切换 scope：所有数据**全变**
4. **格式校验**（§1.3 规则）：
   - 人数 / 计数 / 单数渲染为整数 + 千分位（如 `12,000`、`600`、`40`）
   - 金额渲染为 2 位小数 + 千分位（如 `1,234,567.89`、`8,000.00`）；包括 4 个大卡 + 4 个人均业绩/实耗类小卡
   - 占比 = `33.33%`（2 位小数 + `%`，非 `33.3 %` 也非 `33%`）
   - 旧 8 卡的金额一并按新格式渲染（`1.2 万` → `12,345.67`）
5. **冗余 UI**：右侧 status-block 的两个"人均会员数"显示同值（按字面渲染，与截图一致）
6. memberCount=0 时，占比显示 `--`、店均会员 `--`、人均会员 `--`，不出现 NaN/Infinity
7. employeeCount=0 时，所有"人效"卡和两个"人均会员"显示 `--`
8. 4 个入口点击 → toast 提示"开发中"

### 4.3 数据完整性 SQL（部署后跑一次）

```sql
-- 1. 会员客的 bound_store_id 覆盖率
SELECT
  COUNT(*) FILTER (WHERE customer_type='会员客') AS member_total,
  COUNT(*) FILTER (WHERE customer_type='会员客' AND bound_store_id IS NOT NULL) AS member_with_store
FROM client_wechat_users;
-- 期望：member_with_store / member_total > 95%；否则 scope 过滤会大量漏算
-- 若覆盖率低，决策：scope=all 时不过滤 bound_store_id；scope=market/store 时过滤（已是当前设计）

-- 2. 美容师 / 养生师 员工总数
SELECT
  COUNT(*) FILTER (WHERE NOT is_resigned AND skills && ARRAY['美容师','养生师']::text[]) AS active_emp,
  COUNT(*) FILTER (WHERE NOT is_resigned) AS active_total
FROM staff_wechat_users;
-- 期望：active_emp / active_total > 70%；过低说明 skills 标签未维护，需要业务方补录

-- 3. 保有会员对会员的比例（合理性检查）
SELECT
  COUNT(*) FILTER (WHERE customer_type='会员客') AS member_total,
  COUNT(*) FILTER (WHERE customer_status IN ('保有会员-稳定','保有会员-有效')) AS retained_total;
-- 直观对比：保有会员"应"是会员的子集；如果 retained_total > member_total 说明 customer_status 维护和 customer_type 不同步
```

---

## 5 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 旧 `formatAmount` 含"万"折叠会被本 ticket 改为长格式千分位 | 已上线的 8 个旧卡片金额显示形态变化 | 部署前在群里同步给运营/产品；属预期变化、不需要单独 ticket |
| skills 标签覆盖率低（员工没维护） | employeeCount 偏小 → 人均偏大 | §4.3 第 2 条 SQL 跑一次；如 < 70% 走"用 position_name 兜底"或要求业务方补录（决策落到 follow-up） |
| `bound_store_id` 为 null 的会员客户 | scope=market/store 时被漏算 | §4.3 第 1 条 SQL 跑一次；如严重，向业务确认是否在 all 之外也要 IS NULL OR ... |
| `customer_type` / `customer_status` 由 cronTask 异步更新 | 数据延迟 T+1 | 与 cronTask 现有节奏一致，业务可接受 |
| Promise.all 17 条并发对 PG 连接池压力 | 连接池 max=5（CLAUDE.md），并发会被限流 | 实测耗时；必要时将 3 条新 SQL 串到现有 query 中（如 client_wechat_users 的两条 COUNT 合并为一条 CASE WHEN） |
| 17 条 SQL 中任一失败导致整页黑屏 | 用户体验差 | 与 [summary-api](./archives/2026-04-25-mgmt-dashboard-summary-api.md) §3.1 决策一致，前端 toast；后续可考虑 `Promise.allSettled` + 单卡显示 ❌ |

---

## 6 关键决策

1. **派生字段（占比 / 店均 / 人均）放前端计算，不进接口**：避免接口频繁因 "加一个派生" 改动；统一在 `buildDisplay` 一处变更
2. **会员/保有/员工是截面，不随日历变化**：与 8 卡片"今日 + 本月"语义不同，UI 上无 today/month 双值
3. **第二个"人均会员数"按字面同值渲染**：用户已明确"数据不要求对得上"截图，不再猜口径、不留 `--`；上线后若业务方提出真实指标再 patch
4. **数字格式化统一长格式千分位（金额 2 位小数）**：废弃旧"万"折叠规则；运营和产品视觉上从 `1.2 万` 变 `12,345.67`，需提前同步
5. **4 个入口仅做 toast 占位**：每个目的页本身是独立页面，需要独立的筛选/字段/查询，硬塞本 ticket 会让范围爆炸
6. **复用 `mgmtDashboard.summary` 不新增 action**：3 个新字段语义上属同一查询的延伸，新建 action 反而割裂

---

## 7 不在本 ticket 范围

- 4 个入口的目的页（客量/销售/品项/顾客档案）→ 各自一个 ticket
- "人均收入(月)"指标 → 用户已明确取消
- 项目数本身的真实统计逻辑（仍占位，与 [summary-api](./archives/2026-04-25-mgmt-dashboard-summary-api.md) 一致）
- skills 标签覆盖率治理（如果 §4.3 SQL 显示低覆盖率，另开数据治理 ticket）
- 第二个"人均会员数"的真实口径（如业务方后续给出，另开 patch ticket）

---

## 8 交付物

- [ ] `notes/references/metrics.md` 追加 §1.1 的 3 个原始指标 + §1.2 的 11 个派生指标定义
- [ ] `staffApi/routes/mgmt-dashboard.js` 在 `summary` 内追加 3 条 SQL + 加 `buildStaffScope` 函数
- [ ] `routes/mgmt-dashboard.test.js` 补 §4.1 的 7 个 case
- [ ] `pages/mgmt-dashboard/mgmt-dashboard.ts` 扩展 `SummaryData` 类型 + `buildDisplay` 增 storeStatus/perEmployee + `onEntryTap` 占位
- [ ] `pages/mgmt-dashboard/mgmt-dashboard.wxml` 现有 8 卡之后追加 §3.3 三个区块
- [ ] `pages/mgmt-dashboard/mgmt-dashboard.wxss` §3.4 样式
- [ ] `utils/number.ts` 的 `formatAmount` / `formatCount` 改为 §1.3 规则（金额 2 位小数 + 千分位；人数整数 + 千分位；废弃"万"折叠）
- [ ] §4.3 数据完整性 SQL 全部跑过 + 结果记录到本 ticket 末尾
