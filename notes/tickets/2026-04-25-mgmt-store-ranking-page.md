# Ticket 2: 管理层门店排行榜前端 tab（mgmt-dashboard `ranking`）

> 生成日期：2026-04-25
> 严重级别：P1（管理层 hub `ranking` tab 当前还是 placeholder）
> 端：fengyu-staff（小程序前端）
> 影响面：`pages/mgmt-dashboard/mgmt-dashboard.{ts,wxml,wxss}` 改造（替换 ranking tab placeholder）
> 前置：[Ticket 1](./2026-04-25-mgmt-store-ranking-api.md)（`mgmtDashboard.storeRanking` 接口）
> 并行：可与 T1 同步开发，但联调依赖 T1 部署
>
> **一句话目标**：把 `pages/mgmt-dashboard` 当前的 `ranking` tab placeholder 替换为
> "时间维度 chip + 6 指标按钮 + 门店排行榜列表"，调用 `mgmtDashboard.storeRanking`，
> 默认显示"本月 + 业绩排名"。

---

## 0 一句话背景

`pages/mgmt-dashboard.wxml` 第 200–208 行当前 ranking tab 仍是：

```xml
<placeholder-page page-title="排行榜" subtitle="功能建设中，敬请期待" icon="medal-o" .../>
```

需替换成实际功能。视图结构与默认值见 [INDEX](./2026-04-25-mgmt-store-ranking-INDEX.md)。

---

## 1 视图设计

### 1.1 顶部 — 时间维度 chip

3 个并排按钮（默认 `本月` 高亮），点击切换：

```
[ 本月 ]  [ 上月 ]  [ 本年 ]
```

实现：自定义 view 加样式，不复用 vant tab（vant tab 视觉过重；这里只是 3 个小按钮，自绘更轻）。

### 1.2 中部 — 6 指标按钮

3×2 网格布局，每个卡片宽度 calc((100% - 32rpx) / 3)：

```
[ 业绩排名  ]  [ 实耗排名  ]  [ 保有会员排名 ]
[ 新客量排名 ]  [ 项目数排名 ]  [ 客流排名     ]
```

- 选中态：背景 `#FFC85F`（截图中黄色）+ 字体加粗
- 默认选中：业绩排名

### 1.3 底部 — 排行榜表格

```
─────────── 排行榜 ───────────
排名   店名         所属市场      数据
 1     南昌旭辉店    南昌市场     10000.00 业绩
 2     南昌云锦店    南昌市场     10000.00 业绩
 ...
```

- 表头一行：排名 / 店名 / 所属市场 / 数据
- 数据值右下小字标注当前指标名（如"业绩"/"实耗"/"客流"）
- 数据为金额时（unit=amount）保留 2 位小数 + 千分位；为计数时（unit=count）整数 + 千分位（用 `utils/number.ts`）
- value=0 时仍展示 `0` 或 `0.00`（不显示 `--`，与首页"防除零→`--`"语义不同）
- 当 `metric=projectCount` 时，全部行 value=0 → 可以选择显示"功能开发中"占位文案替代列表

---

## 2 代码改动

### 2.1 数据结构

在 `mgmt-dashboard.ts` 顶部追加类型：

```ts
type RankingPeriod = 'month' | 'lastMonth' | 'year'
type RankingMetric =
  | 'revenue' | 'consume' | 'retainedMember'
  | 'newMember' | 'projectCount' | 'footfall'

interface RankingRow {
  rank: number
  storeId: string
  storeName: string
  marketName: string
  value: number
}

interface RankingDisplayRow extends RankingRow {
  valueText: string  // 已格式化（金额或计数）
}

interface RankingResp {
  period: RankingPeriod
  metric: RankingMetric
  unit: 'amount' | 'count'
  rows: RankingRow[]
}
```

`Page.data` 追加：

```ts
ranking: {
  period: 'month' as RankingPeriod,
  metric: 'revenue' as RankingMetric,
  loading: false,
  rows: [] as RankingDisplayRow[],
  unit: 'amount' as 'amount' | 'count',
},
```

### 2.2 配置常量（页面顶部、引入区下面）

```ts
const RANKING_PERIODS: { key: RankingPeriod; label: string }[] = [
  { key: 'month',     label: '本月' },
  { key: 'lastMonth', label: '上月' },
  { key: 'year',      label: '本年' },
]

const RANKING_METRICS: { key: RankingMetric; label: string; unitLabel: string }[] = [
  { key: 'revenue',        label: '业绩排名',     unitLabel: '业绩' },
  { key: 'consume',        label: '实耗排名',     unitLabel: '实耗' },
  { key: 'retainedMember', label: '保有会员排名', unitLabel: '保有会员' },
  { key: 'newMember',      label: '新客量排名',   unitLabel: '新客量' },
  { key: 'projectCount',   label: '项目数排名',   unitLabel: '项目数' },
  { key: 'footfall',       label: '客流排名',     unitLabel: '客流' },
]
```

把 `rankingPeriods` / `rankingMetrics` 通过 `setData` 暴露给 wxml（让 wxml 直接 wx:for）：

```ts
this.setData({
  rankingPeriods: RANKING_PERIODS,
  rankingMetrics: RANKING_METRICS,
})
```

### 2.3 进入 ranking tab 的初始化

`onTabChange` 里，切到 ranking 且首次进入时触发首次加载：

```ts
onTabChange(e) {
  const key = e.detail?.key
  if (!key || key === this.data.activeTab) return
  this.setData({ activeTab: key })
  if (key === 'ranking' && this.data.ranking.rows.length === 0) {
    this.loadRanking()
  }
},
```

### 2.4 加载逻辑

```ts
async loadRanking() {
  const { period, metric } = this.data.ranking
  this.setData({ 'ranking.loading': true })
  try {
    const resp = await callStaffApi<RankingResp>('mgmtDashboard.storeRanking', { period, metric })
    const formatter = resp.unit === 'amount' ? formatAmount : formatCount
    const rows: RankingDisplayRow[] = resp.rows.map((r) => ({
      ...r,
      valueText: formatter(r.value),
    }))
    this.setData({
      'ranking.rows': rows,
      'ranking.unit': resp.unit,
      'ranking.loading': false,
    })
  } catch {
    this.setData({ 'ranking.loading': false })
    wx.showToast({ icon: 'none', title: '排行榜加载失败' })
  }
},
```

### 2.5 切换 period / metric

```ts
onRankingPeriodTap(e: WechatMiniprogram.BaseEvent) {
  const period = (e.currentTarget.dataset as { period?: RankingPeriod }).period
  if (!period || period === this.data.ranking.period) return
  this.setData({ 'ranking.period': period })
  this.loadRanking()
},

onRankingMetricTap(e: WechatMiniprogram.BaseEvent) {
  const metric = (e.currentTarget.dataset as { metric?: RankingMetric }).metric
  if (!metric || metric === this.data.ranking.metric) return
  this.setData({ 'ranking.metric': metric })
  this.loadRanking()
},
```

### 2.6 wxml 改造

替换 `<block wx:elif="{{activeTab === 'ranking'}}">` 内容：

```xml
<block wx:elif="{{activeTab === 'ranking'}}">
  <view class="mgmt-ranking">
    <!-- 时间维度 chip -->
    <view class="ranking-periods">
      <view
        wx:for="{{rankingPeriods}}"
        wx:key="key"
        class="ranking-period {{ranking.period === item.key ? 'active' : ''}}"
        data-period="{{item.key}}"
        bindtap="onRankingPeriodTap"
      >{{item.label}}</view>
    </view>

    <!-- 6 指标按钮 -->
    <view class="ranking-metrics">
      <view
        wx:for="{{rankingMetrics}}"
        wx:key="key"
        class="ranking-metric {{ranking.metric === item.key ? 'active' : ''}}"
        data-metric="{{item.key}}"
        bindtap="onRankingMetricTap"
      >{{item.label}}</view>
    </view>

    <!-- 排行榜表格 -->
    <view class="ranking-table">
      <view class="ranking-table-title">排行榜</view>
      <view class="ranking-table-header">
        <view class="col col-rank">排名</view>
        <view class="col col-name">店名</view>
        <view class="col col-market">所属市场</view>
        <view class="col col-value">数据</view>
      </view>

      <view wx:if="{{ranking.loading}}" class="ranking-loading">加载中…</view>

      <block wx:elif="{{ranking.rows.length === 0}}">
        <view class="ranking-empty">暂无排行数据</view>
      </block>

      <block wx:else>
        <view class="ranking-row" wx:for="{{ranking.rows}}" wx:key="storeId">
          <view class="col col-rank">{{item.rank}}</view>
          <view class="col col-name">{{item.storeName}}</view>
          <view class="col col-market">{{item.marketName}}</view>
          <view class="col col-value">
            <text class="val-num">{{item.valueText}}</text>
            <text class="val-unit">{{rankingMetricLabelMap[ranking.metric]}}</text>
          </view>
        </view>
      </block>
    </view>
  </view>
</block>
```

`rankingMetricLabelMap` 是 `RANKING_METRICS` 转 `Record<key, unitLabel>` 的派生数据，在 `onLoad` 时 `setData`。

### 2.7 wxss（关键样式）

仅列样式骨架：

```css
.mgmt-ranking { padding: 24rpx; padding-bottom: calc(120rpx + env(safe-area-inset-bottom)); }

/* 时间 chip */
.ranking-periods { display: flex; gap: 16rpx; margin-bottom: 24rpx; }
.ranking-period {
  padding: 8rpx 32rpx;
  border: 1rpx solid #ddd;
  border-radius: 8rpx;
  font-size: 26rpx;
  color: #333;
  background: #fff;
}
.ranking-period.active { background: #FFC85F; border-color: #FFC85F; color: #fff; font-weight: 600; }

/* 6 指标按钮 */
.ranking-metrics {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16rpx;
  margin-bottom: 32rpx;
}
.ranking-metric {
  padding: 24rpx 0;
  text-align: center;
  background: #f5f5f5;
  border-radius: 8rpx;
  font-size: 26rpx;
  color: #333;
}
.ranking-metric.active { background: #FFC85F; color: #fff; font-weight: 600; }

/* 表格 */
.ranking-table { background: #fff; border-radius: 12rpx; overflow: hidden; }
.ranking-table-title { text-align: center; padding: 20rpx 0; color: #999; font-size: 24rpx; }
.ranking-table-header,
.ranking-row {
  display: grid;
  grid-template-columns: 80rpx 1fr 1fr 200rpx;
  align-items: center;
  padding: 24rpx 16rpx;
  font-size: 28rpx;
}
.ranking-table-header { color: #999; font-size: 24rpx; }
.ranking-row { border-top: 1rpx solid #f0f0f0; }
.col-name { font-weight: 600; }
.col-market { color: #999; font-size: 24rpx; }
.col-value { text-align: right; }
.val-num { font-weight: 600; }
.val-unit { display: block; color: #999; font-size: 22rpx; }
.ranking-loading,
.ranking-empty { padding: 80rpx 0; text-align: center; color: #999; font-size: 26rpx; }
```

> 颜色 `#FFC85F` 是设计稿中黄色高亮态，与品牌主色 `#C0322A` 不同（设计稿如此）。

### 2.8 navbar tab 文案对齐

设计稿中底部 tab 是"门店排行榜"，但当前 `mgmt-navbar` 中的 key 是 `ranking`，label 见 `components/mgmt-navbar`。**核对该处 label 文案**，若是"排行榜"则改成"门店排行榜"，与设计稿一致（顺手做）。

---

## 3 取舍 / 边界

### 3.1 排行榜不需要日历选择器

- 设计稿中 ranking tab 顶部**没有日历**，仅 3 个时间 chip
- dashboard tab 的 `selectedDate` 状态与 ranking tab **完全独立**，互不干扰

### 3.2 不复用 mgmt-scope-picker

- 排行榜对象就是门店，不需要"市场/门店"切换
- 权限过滤后端按 staffLevel 自动应用（market 账号自动只看自己市场）

### 3.3 切 tab 缓存策略

- 首次切到 ranking 才请求；切回 dashboard 不清空 ranking.rows
- 切换 period 或 metric 重新请求；同 period+metric 不重复请求（按需可加缓存，**首版不做**，每次都重新请求保证数据新鲜度，因为门店数据日内变化频繁）

### 3.4 项目数排名占位

- T1 接口返回每店 value=0
- 前端展示效果：所有行 value 都是 `0`，rank 全为 1，排序按店名升序（接口已处理）
- 不额外加"开发中"提示文案；保持简洁；后续 T1 完整实现后无需改前端

### 3.5 保有会员选时间维度

- 接口返回值与 period 无关
- 前端**不禁用**时间 chip（用户切换不会报错，只是数据相同）
- **不加额外提示文案**（避免视觉噪音）；后续如有用户反馈再加

---

## 4 测试

### 4.1 真机/模拟器手工测试

| 场景 | 期望 |
|------|------|
| 首次进入 mgmt-dashboard，点击 ranking tab | 展示"本月 + 业绩排名"列表，rank=1 的店在最上 |
| 切换"上月" | 列表重新加载，数据变化 |
| 切换"实耗排名" | 列表重新加载，列右下小字变成"实耗" |
| 切换"保有会员排名" → 切"上月" / "本年" | 列表数据保持不变（截面快照） |
| 切换"项目数排名" | 全部 value=0，按店名升序 |
| 切回 dashboard tab → 再切回 ranking | 不重新请求，展示之前的数据（保留状态） |
| 网络失败（断网） | toast "排行榜加载失败"；loading 退出 |

### 4.2 单元测试（mgmt-dashboard.test.ts）

可选；现有 mgmt-dashboard 的 ts 测试若不密集，本 ticket 至少覆盖：

- `loadRanking` 的 success / failure 分支（mock callStaffApi）
- 切换 period / metric 时是否正确触发请求
- 同 period/metric 重复点击不触发请求

### 4.3 视觉

- 在不同分辨率（iPhone SE / iPhone 14 Pro Max）确认 6 指标按钮 3 列布局不挤压换行
- 长店名（≥6 个字）不溢出，按必要 `text-overflow: ellipsis`
- 数据值千分位 + 2 位小数 / 整数都正确

---

## 5 风险

| 风险 | 缓解 |
|------|------|
| 6 指标按钮长文案"保有会员排名"5 字在小屏挤行 | wxss 用 `font-size: 24rpx` + `white-space: nowrap`；必要时简化为"保有会员"4 字（去掉"排名"后缀） |
| 用户期望"本月"是按"自然月起始-今天"的 MTD，但接口返的是整月（已聚合所有当月已发生数据） | 与 metrics.md 定义一致；如需 MTD 概念另加 period 选项（'mtd'） |
| 切 tab 缓存让用户觉得"不刷新" | 顶部加下拉刷新（`scroll-view enable-back-to-top`）；本 ticket 暂不做，待用户反馈再加 |
| `#FFC85F` 黄色与品牌色 `#C0322A` 红色冲突 | 设计稿主张如此，先按设计稿实现；如设计师有变，单纯改 wxss 颜色 |

---

## 6 不在本 ticket 范围

- T1 后端接口实现
- 员工排行榜（mgmt-navbar 中另一个 tab，placeholder 保留）
- 排行榜下钻、对比、导出
- 项目数指标的真实显示（占位与 T1 一致）
- 下拉刷新、滚动加载、缓存策略

---

## 7 交付物

- [ ] `pages/mgmt-dashboard/mgmt-dashboard.ts` 追加 ranking 相关 state + handler + loadRanking
- [ ] `pages/mgmt-dashboard/mgmt-dashboard.wxml` 替换 ranking tab block
- [ ] `pages/mgmt-dashboard/mgmt-dashboard.wxss` 追加 ranking 区块样式
- [ ] `components/mgmt-navbar` 文案核对（"排行榜" → "门店排行榜"，按设计稿）
- [ ] 真机/模拟器手工测试 §4.1 全部场景
- [ ] 联调 T1 接口（部署后端后切真实数据）
