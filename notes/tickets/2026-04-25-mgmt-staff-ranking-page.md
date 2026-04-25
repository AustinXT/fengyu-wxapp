# Ticket 2: 管理层员工排行榜前端 sub-toggle（mgmt-dashboard `ranking` tab）

> 生成日期：2026-04-25
> 严重级别：P1（管理层 hub `ranking` tab 当前仅含门店排行榜，缺员工排行榜）
> 端：fengyu-staff（小程序前端）
> 影响面：`pages/mgmt-dashboard/mgmt-dashboard.{ts,wxml,wxss}` 改造（在已落地的门店排行榜上方加 sub-toggle，复用同一布局）
> 前置：
> 1. [Ticket 1](./2026-04-25-mgmt-staff-ranking-api.md)（`mgmtDashboard.staffRanking` 接口）
> 2. [门店排行榜 page ticket](./2026-04-25-mgmt-store-ranking-page.md)（必须先合并；本 ticket 在其基础上加 sub-toggle）
> 并行：可与 T1 同步开发，但联调依赖 T1 部署
>
> **一句话目标**：在 `pages/mgmt-dashboard` 的 `ranking` tab 顶部新增"门店 / 员工" sub-toggle，
> 切到"员工"时调用 `mgmtDashboard.staffRanking`，复用时间 chip + 6 指标按钮 + 列表布局，
> 默认显示"门店 + 本月 + 业绩"。

---

## 0 一句话背景

门店排行榜 ticket 已规划在 `ranking` tab 落地完整布局（时间 chip + 6 按钮 + 列表）。员工排行榜与之 95% 同形，仅数据源不同 → 在该布局**上方**加一个 sub-toggle 切换两个子视图（详见 [INDEX §决策 D7](./2026-04-25-mgmt-staff-ranking-INDEX.md)），不引入新页面、不引入新 nav tab。

---

## 1 视图设计

### 1.1 顶部 sub-toggle（本 ticket 新增）

```
┌─────────────────────────────────────────────┐
│  ┌───────┬───────┐                          │
│  │ 门店  │ 员工  │  ← sub-toggle（默认门店）│
│  └───────┴───────┘                          │
│  [本月] [上月] [本年]                        │  ← 共享时间 chip
│  [业绩榜单] [实耗榜单] [...]                │  ← 共享指标按钮
│  ─────────── 排行榜 ───────────              │
│  ...                                         │
└─────────────────────────────────────────────┘
```

实现方案：自绘 segment 控件（2 段），不复用 vant tabs（vant tabs 视觉过重；2 段 segment 更轻盈）。

**默认值**：`dimension = 'store'`（门店），与原门店排行榜默认行为一致。

### 1.2 切换 toggle 的 UX 行为

- **保留时间 chip 与 metric 按钮的选中状态**：用户切换"门店 ↔ 员工"时不期望重置筛选
- **6 个 metric 按钮在两个维度下含义略有不同**：
  - 门店维度可用：业绩 / 实耗 / 保有会员 / 新会员 / 项目数 / 客流（与原门店排行榜一致）
  - 员工维度可用：业绩 / 实耗 / 新会员 / 客流 / 项目数 / 收入（与门店维度差异：去掉"保有会员"，增加"收入"）
  - 切换 dimension 时若当前 metric 在新维度不存在 → fallback 到该维度的默认 metric（详见 §1.3 metric 兼容映射）

### 1.3 metric 兼容映射（dimension 切换时）

| 切换前 dimension | metric 选中 | 切换后 dimension | metric 落点 |
|------------------|-------------|------------------|-------------|
| store → staff | retainedMember | staff | revenue（fallback 到员工默认） |
| store → staff | revenue / consume / newMember / projectCount / footfall | staff | 同名（直接保留） |
| staff → store | income | store | revenue（fallback；income 是员工独有概念，门店没有对应） |
| staff → store | revenue / consume / newMember / projectCount / footfall | store | 同名（直接保留） |

> **共有 5 个 metric**（revenue / consume / newMember / projectCount / footfall）切换 dimension 时不变；
> **store 独有**：retainedMember；
> **staff 独有**：income。

### 1.4 列表表头（按 dimension 切换）

| dimension | 列 1 | 列 2 | 列 3 | 列 4 |
|-----------|------|------|------|------|
| store | 排名 | 店名 | 所属市场 | 数据 |
| staff | 排名 | 员工姓名 | 所属门店 | 数据 |

数据列右下小字仍展示当前 metric 的 unitLabel（业绩 / 实耗 / 收入 / ...）。

### 1.5 配色与样式

- sub-toggle 选中态背景：`#FFC85F`（与 metric 按钮选中态一致），未选中 `#f5f5f5`
- 列表行布局保持原门店排行榜的 grid template（80rpx 1fr 1fr 200rpx）
- staff 维度下"员工姓名"加粗，下方"所属门店"灰字小号 → 与设计稿截图一致

---

## 2 代码改动

### 2.1 数据结构

在 `mgmt-dashboard.ts` 顶部追加类型：

```ts
type RankingDimension = 'store' | 'staff'
type StaffRankingMetric =
  | 'revenue' | 'consume' | 'newMember'
  | 'footfall' | 'projectCount' | 'income'

interface StaffRankingRow {
  rank: number
  employeeId: string
  employeeName: string
  storeId: string | null
  storeName: string
  value: number
}

interface StaffRankingDisplayRow extends StaffRankingRow {
  valueText: string
}

interface StaffRankingResp {
  period: RankingPeriod
  metric: StaffRankingMetric
  unit: 'amount' | 'count'
  rows: StaffRankingRow[]
}
```

> 复用门店排行榜 ticket 已定义的 `RankingPeriod` / `RankingMetric`（store metric 集合）/ `RankingRow`。
> 新增 `RankingDimension` / `StaffRankingMetric` / `StaffRankingRow` 三个员工专用类型。

`Page.data.ranking` 扩展：

```ts
ranking: {
  dimension: 'store' as RankingDimension,
  period: 'month' as RankingPeriod,
  metric: 'revenue' as RankingMetric | StaffRankingMetric,  // 联合类型
  loading: false,
  storeRows: [] as RankingDisplayRow[],            // 门店维度的数据
  staffRows: [] as StaffRankingDisplayRow[],       // 员工维度的数据
  unit: 'amount' as 'amount' | 'count',
},
```

> 两个维度的 rows 分开缓存，切换 toggle 时不必重新请求（除非已 invalidate）。

### 2.2 配置常量

在原 `RANKING_METRICS`（门店）下追加 `STAFF_RANKING_METRICS`：

```ts
const STAFF_RANKING_METRICS: { key: StaffRankingMetric; label: string; unitLabel: string }[] = [
  { key: 'revenue',      label: '业绩榜单',   unitLabel: '业绩' },
  { key: 'consume',      label: '实耗榜单',   unitLabel: '实耗' },
  { key: 'newMember',    label: '新会员排名', unitLabel: '新会员' },
  { key: 'footfall',     label: '客流榜单',   unitLabel: '客流' },
  { key: 'projectCount', label: '项目数榜单', unitLabel: '项目数' },
  { key: 'income',       label: '收入榜单',   unitLabel: '收入' },
]

const RANKING_DIMENSIONS: { key: RankingDimension; label: string }[] = [
  { key: 'store', label: '门店' },
  { key: 'staff', label: '员工' },
]
```

`onLoad` 时 `setData` 暴露给 wxml：

```ts
this.setData({
  rankingDimensions: RANKING_DIMENSIONS,
  rankingPeriods: RANKING_PERIODS,
  rankingMetrics: RANKING_METRICS,             // 门店指标（原有）
  staffRankingMetrics: STAFF_RANKING_METRICS,  // 员工指标（本 ticket 新增）
})
```

### 2.3 加载逻辑

```ts
async loadRanking() {
  const { dimension, period, metric } = this.data.ranking
  this.setData({ 'ranking.loading': true })

  try {
    if (dimension === 'store') {
      const resp = await callStaffApi<RankingResp>('mgmtDashboard.storeRanking', {
        period,
        metric,
      })
      const formatter = resp.unit === 'amount' ? formatAmount : formatCount
      const rows = resp.rows.map((r) => ({ ...r, valueText: formatter(r.value) }))
      this.setData({
        'ranking.storeRows': rows,
        'ranking.unit': resp.unit,
        'ranking.loading': false,
      })
    } else {
      const resp = await callStaffApi<StaffRankingResp>('mgmtDashboard.staffRanking', {
        period,
        metric,
      })
      const formatter = resp.unit === 'amount' ? formatAmount : formatCount
      const rows = resp.rows.map((r) => ({ ...r, valueText: formatter(r.value) }))
      this.setData({
        'ranking.staffRows': rows,
        'ranking.unit': resp.unit,
        'ranking.loading': false,
      })
    }
  } catch {
    this.setData({ 'ranking.loading': false })
    wx.showToast({ icon: 'none', title: '排行榜加载失败' })
  }
},
```

### 2.4 切换 dimension / period / metric

```ts
onRankingDimensionTap(e: WechatMiniprogram.BaseEvent) {
  const dimension = (e.currentTarget.dataset as { dimension?: RankingDimension }).dimension
  if (!dimension || dimension === this.data.ranking.dimension) return

  // metric 兼容映射（详见 §1.3）
  const currentMetric = this.data.ranking.metric
  const validInTarget = (dimension === 'store')
    ? RANKING_METRICS.some((m) => m.key === currentMetric)
    : STAFF_RANKING_METRICS.some((m) => m.key === currentMetric)
  const newMetric = validInTarget ? currentMetric : 'revenue'

  this.setData({
    'ranking.dimension': dimension,
    'ranking.metric': newMetric,
  })

  // 已有缓存则不重新请求
  const hasCache = (dimension === 'store')
    ? this.data.ranking.storeRows.length > 0 && newMetric === currentMetric
    : this.data.ranking.staffRows.length > 0 && newMetric === currentMetric

  if (!hasCache) this.loadRanking()
},

onRankingPeriodTap(e: WechatMiniprogram.BaseEvent) {
  const period = (e.currentTarget.dataset as { period?: RankingPeriod }).period
  if (!period || period === this.data.ranking.period) return
  this.setData({
    'ranking.period': period,
    'ranking.storeRows': [],   // 切 period 清空两个维度缓存（数据已变）
    'ranking.staffRows': [],
  })
  this.loadRanking()
},

onRankingMetricTap(e: WechatMiniprogram.BaseEvent) {
  const metric = (e.currentTarget.dataset as { metric?: RankingMetric | StaffRankingMetric }).metric
  if (!metric || metric === this.data.ranking.metric) return
  this.setData({ 'ranking.metric': metric })
  this.loadRanking()
},
```

### 2.5 wxml 改造（在原门店排行榜布局**上方**加 sub-toggle，并按 dimension 切换列表 / metric 按钮组）

替换 `<block wx:elif="{{activeTab === 'ranking'}}">` 内容：

```xml
<block wx:elif="{{activeTab === 'ranking'}}">
  <view class="mgmt-ranking">
    <!-- sub-toggle: 门店 / 员工 -->
    <view class="ranking-dimensions">
      <view
        wx:for="{{rankingDimensions}}"
        wx:key="key"
        class="ranking-dimension {{ranking.dimension === item.key ? 'active' : ''}}"
        data-dimension="{{item.key}}"
        bindtap="onRankingDimensionTap"
      >{{item.label}}</view>
    </view>

    <!-- 时间 chip（共享） -->
    <view class="ranking-periods">
      <view
        wx:for="{{rankingPeriods}}"
        wx:key="key"
        class="ranking-period {{ranking.period === item.key ? 'active' : ''}}"
        data-period="{{item.key}}"
        bindtap="onRankingPeriodTap"
      >{{item.label}}</view>
    </view>

    <!-- 6 指标按钮（按 dimension 切换） -->
    <view class="ranking-metrics" wx:if="{{ranking.dimension === 'store'}}">
      <view
        wx:for="{{rankingMetrics}}"
        wx:key="key"
        class="ranking-metric {{ranking.metric === item.key ? 'active' : ''}}"
        data-metric="{{item.key}}"
        bindtap="onRankingMetricTap"
      >{{item.label}}</view>
    </view>
    <view class="ranking-metrics" wx:else>
      <view
        wx:for="{{staffRankingMetrics}}"
        wx:key="key"
        class="ranking-metric {{ranking.metric === item.key ? 'active' : ''}}"
        data-metric="{{item.key}}"
        bindtap="onRankingMetricTap"
      >{{item.label}}</view>
    </view>

    <!-- 排行榜表格 -->
    <view class="ranking-table">
      <view class="ranking-table-title">排行榜</view>

      <!-- 门店维度表头 -->
      <view class="ranking-table-header" wx:if="{{ranking.dimension === 'store'}}">
        <view class="col col-rank">排名</view>
        <view class="col col-name">店名</view>
        <view class="col col-market">所属市场</view>
        <view class="col col-value">数据</view>
      </view>
      <!-- 员工维度表头 -->
      <view class="ranking-table-header" wx:else>
        <view class="col col-rank">排名</view>
        <view class="col col-name">员工姓名</view>
        <view class="col col-market">所属门店</view>
        <view class="col col-value">数据</view>
      </view>

      <view wx:if="{{ranking.loading}}" class="ranking-loading">加载中…</view>

      <!-- 门店行 -->
      <block wx:elif="{{ranking.dimension === 'store'}}">
        <view wx:if="{{ranking.storeRows.length === 0}}" class="ranking-empty">暂无排行数据</view>
        <view wx:for="{{ranking.storeRows}}" wx:key="storeId" class="ranking-row">
          <view class="col col-rank">{{item.rank}}</view>
          <view class="col col-name">{{item.storeName}}</view>
          <view class="col col-market">{{item.marketName}}</view>
          <view class="col col-value">
            <text class="val-num">{{item.valueText}}</text>
            <text class="val-unit">{{rankingMetricLabelMap[ranking.metric]}}</text>
          </view>
        </view>
      </block>

      <!-- 员工行 -->
      <block wx:else>
        <view wx:if="{{ranking.staffRows.length === 0}}" class="ranking-empty">暂无排行数据</view>
        <view wx:for="{{ranking.staffRows}}" wx:key="employeeId" class="ranking-row">
          <view class="col col-rank">{{item.rank}}</view>
          <view class="col col-name">{{item.employeeName || '未命名员工'}}</view>
          <view class="col col-market">{{item.storeName || '—'}}</view>
          <view class="col col-value">
            <text class="val-num">{{item.valueText}}</text>
            <text class="val-unit">{{staffRankingMetricLabelMap[ranking.metric]}}</text>
          </view>
        </view>
      </block>
    </view>
  </view>
</block>
```

> `rankingMetricLabelMap` / `staffRankingMetricLabelMap` 是各自 metric 数组转 `Record<key, unitLabel>` 的派生数据，在 `onLoad` 时一起 `setData`。

### 2.6 wxss（追加 sub-toggle 样式；原门店排行榜样式保留）

```css
/* sub-toggle */
.ranking-dimensions {
  display: flex;
  background: #f5f5f5;
  border-radius: 8rpx;
  padding: 4rpx;
  margin-bottom: 24rpx;
}
.ranking-dimension {
  flex: 1;
  text-align: center;
  padding: 16rpx 0;
  font-size: 28rpx;
  color: #333;
  border-radius: 6rpx;
}
.ranking-dimension.active {
  background: #fff;
  font-weight: 600;
  color: #C0322A;
  box-shadow: 0 1rpx 4rpx rgba(0,0,0,0.06);
}
```

> sub-toggle 用 iOS-style segmented control 配色（白底 + 阴影），与 metric 按钮的黄色高亮态作区分（避免视觉冲突）。
> 字色用品牌主色 `#C0322A` 而非黄色，强调"维度切换"是主操作，metric 是次操作。

### 2.7 mgmt-navbar tab 文案（不改）

原门店排行榜 ticket 计划把"排行榜" → "门店排行榜"。**本 ticket 推翻该计划**：保留 mgmt-navbar 的 `ranking` 文案为 **"排行榜"**，因为它现在承载两个子视图（门店 + 员工）。

实施方法：
- 如门店排行榜 page ticket 已合并并改了 navbar 文案 → 本 ticket 同步回改
- 如门店排行榜 page ticket 还未合并 → 协调，page ticket 不动 navbar，由本 ticket 接手

---

## 3 取舍 / 边界

### 3.1 缓存策略

- **dimension 切换**：保留两个维度的 rows 缓存；同一 period+metric 下切回不重新请求
- **period 切换**：清空两个维度的 rows（数据已变）；按当前 dimension 重新请求
- **metric 切换**：仅当前 dimension 重新请求；另一维度的缓存仍保留
- **首次进入 ranking tab**：触发当前 dimension（默认 store）的首次请求

### 3.2 metric 兼容（详见 §1.3）

切 dimension 时如当前 metric 在新维度不存在（store↔staff 各有 1 个独有 metric）→ 落到 `revenue` 默认值，不弹 toast，不报错（用户切换是主动操作，自动选默认更顺手）。

### 3.3 列表行 tap 暂不响应

设计稿无下钻交互；员工排行榜行点击**暂不响应**（不跳员工绩效页，避免与"我的"tab 中已有员工绩效入口重复）。

### 3.4 staff 维度下 storeId 缺失

边界：若员工 store_id IS NULL（数据异常）→ storeName 显示 "—"，仍参与排行；监控里关注是否常态。

### 3.5 收入榜单 = 业绩榜单 + 服务提成

UX 上"业绩"和"收入"两个按钮排名相近时用户可能困惑。**首版不加额外说明文案**（避免视觉噪音），如用户反馈再加一行小字 "= 销售业绩 + 服务提成"。

---

## 4 测试

### 4.1 真机/模拟器手工测试

| 场景 | 期望 |
|------|------|
| 首次进入 ranking tab | 默认 dimension=store + period=month + metric=revenue，门店列表渲染 |
| 切换 dimension → "员工" | 员工列表渲染，metric=revenue 保留（共有），表头变"员工姓名/所属门店" |
| 员工维度切 metric=收入 | 列表重新加载，列右下小字变"收入" |
| 员工维度切 metric=收入，再切 dimension → "门店" | metric 自动 fallback 到 revenue（门店没"income"），表头切回"店名/所属市场" |
| 门店维度选 metric=保有会员，切 dimension → "员工" | metric 自动 fallback 到 revenue（员工没"retainedMember"） |
| 切 period → "上月" | 两个维度缓存清空；当前 dimension 重新请求 |
| 切 dimension 来回（store ↔ staff），同 period/metric | 不重复请求，瞬间切换 |
| 网络失败（断网） | toast "排行榜加载失败"；loading 退出 |
| 员工维度某员工 storeName 为空 | 显示 "—" 不溢出 |
| 员工维度某员工 employeeName 为空 | 显示"未命名员工" |

### 4.2 单元测试（mgmt-dashboard.test.ts）

可选；至少覆盖：

- `loadRanking` 在 dimension=staff 时调用 `mgmtDashboard.staffRanking`（mock callStaffApi）
- 切换 dimension 时 metric 兼容映射正确（revenue 共享；retainedMember/income 互不兼容时 fallback）
- 切 period 清空两个维度缓存
- 同 period+metric 切回 dimension 不触发请求

### 4.3 视觉

- 在不同分辨率（iPhone SE / iPhone 14 Pro Max）确认 sub-toggle + 6 指标按钮 + 列表布局不挤压
- 长员工名（≥4 个字）+ 长门店名（≥6 个字）不溢出，按必要 `text-overflow: ellipsis`

---

## 5 风险

| 风险 | 缓解 |
|------|------|
| sub-toggle 黄色与 metric 按钮黄色冲突 | sub-toggle 用白底+品牌红高亮，与 metric 黄色高亮区分 |
| 员工列表数据较多（200 行）渲染卡顿 | wxml `wx:for` 200 行无压力；如真有性能问题改 scroll-view + virtual-list |
| metric 切换时 fallback 让用户疑惑（"我刚选了保有会员怎么变成业绩了？"） | 切换 dimension 是主动操作，fallback 行为符合直觉；如反馈强烈，改成切换时禁用不可用 metric 而非 fallback |
| 门店排行榜 page ticket 改了 navbar 文案，本 ticket 需要回改 | 实施时检查 navbar 当前文案；如已改为"门店排行榜"则在本 ticket 改回"排行榜" |
| 员工 storeId IS NULL 实际发生率不可预知 | UI 有兜底；建议同步建一个监控查询统计 NULL 占比 |

---

## 6 不在本 ticket 范围

- T1 后端接口实现
- 顾客 / 商品等其他维度排行
- 行点击下钻员工绩效页
- 推广师独立排行
- 排行榜导出 / 对比 / 滚动加载
- mgmt-navbar 增加第 5 tab "员工"（已否决，详见 INDEX §决策 D7）

---

## 7 交付物

- [ ] `pages/mgmt-dashboard/mgmt-dashboard.ts` 追加 dimension state + handler + staff 加载分支
- [ ] `pages/mgmt-dashboard/mgmt-dashboard.wxml` 加 sub-toggle + 按 dimension 切换 metric 按钮组 / 表头 / 列表
- [ ] `pages/mgmt-dashboard/mgmt-dashboard.wxss` 追加 `.ranking-dimensions` 样式
- [ ] `components/mgmt-navbar` 文案保持 "排行榜"（如门店 page ticket 改成 "门店排行榜" 则本 ticket 同步回改）
- [ ] `STAFF_RANKING_METRICS` / `RANKING_DIMENSIONS` 常量声明 + setData 暴露
- [ ] 真机/模拟器手工测试 §4.1 全部场景
- [ ] 联调 T1 接口（部署后端后切真实数据）
