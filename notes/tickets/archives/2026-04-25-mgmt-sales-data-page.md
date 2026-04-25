# Ticket — 销售数据页前端（fengyu-staff `pages/sales-data`）

> 前置：[salesData-api T1](./2026-04-25-mgmt-sales-data-api.md)
> 后置：无

## 目标

1. 新建 `fengyu-staff/miniprogram/pages/sales-data/` 页面
2. 修改 `mgmt-dashboard.ts` 中 `onEntryTap` 的 `'sales'` 分支，从 Toast 改为页面跳转
3. 实现设计稿的两个区域：业绩与实耗（分客型矩阵）+ 业绩与品项（三维汇总）

## 文件清单

| 文件 | 操作 |
|------|------|
| `pages/sales-data/sales-data.ts` | 新建 |
| `pages/sales-data/sales-data.wxml` | 新建 |
| `pages/sales-data/sales-data.wxss` | 新建 |
| `pages/sales-data/sales-data.json` | 新建 |
| `app.json` | 追加路由 `"pages/sales-data/sales-data"` |
| `pages/mgmt-dashboard/mgmt-dashboard.ts` | 修改 `onEntryTap` 中 `'sales'` 分支 |

## 页面路由

```
/pages/sales-data/sales-data
```

入口（mgmt-dashboard.ts）：

```ts
case 'sales':
  wx.navigateTo({ url: '/pages/sales-data/sales-data' })
  break
```

## 数据模型（Page.data）

```ts
{
  period: 'month' | 'lastMonth' | 'year',   // 默认 'month'
  loading: boolean,

  // 业绩与实耗
  totalRevenue: string,
  xiaomeiRevenue: string,
  newMemberRevenue: string,
  oldMemberRevenue: string,

  totalConsume: string,
  xiaomeiProjectConsume: string,
  newMemberProjectConsume: string,
  oldMemberProjectConsume: string,

  xiaomeiProductOut: string,
  newMemberProductOut: string,
  oldMemberProductOut: string,

  // 品项维度汇总
  bySalesCategory: Array<{ label: string, value: string }>,
  byProductKind: Array<{ label: string, value: string }>,
  byCategoryName: Array<{ label: string, value: string }>,

  // 展开/收起状态
  expandedSection: '' | 'salesCategory' | 'productKind' | 'categoryName'
}
```

## WXML 结构

```xml
<!-- 顶部时间 chip -->
<view class="sd-period-tabs">
  <view class="sd-period-tab {{period==='month'?'active':''}}" data-period="month" bindtap="onPeriodChange">本月</view>
  <view class="sd-period-tab {{period==='lastMonth'?'active':''}}" data-period="lastMonth" bindtap="onPeriodChange">上月</view>
  <view class="sd-period-tab {{period==='year'?'active':''}}" data-period="year" bindtap="onPeriodChange">本年</view>
  <view class="sd-period-placeholder"></view>  <!-- 自定义日期范围占位 -->
</view>

<!-- 业绩与实耗区 -->
<view class="sd-section">
  <view class="sd-section-title">业绩与实耗</view>

  <!-- 业绩卡片（4列） -->
  <view class="sd-matrix-card">
    <view class="sd-matrix-cell">
      <text class="sd-cell-label">总业绩</text>
      <text class="sd-cell-value">{{totalRevenue}}</text>
    </view>
    <view class="sd-matrix-cell">
      <text class="sd-cell-label">小美客业绩</text>
      <text class="sd-cell-value">{{xiaomeiRevenue}}</text>
    </view>
    <view class="sd-matrix-cell">
      <text class="sd-cell-label">新增会员业绩</text>
      <text class="sd-cell-value">{{newMemberRevenue}}</text>
    </view>
    <view class="sd-matrix-cell">
      <text class="sd-cell-label">老会员业绩</text>
      <text class="sd-cell-value">{{oldMemberRevenue}}</text>
    </view>
  </view>

  <!-- 实耗卡片（左大值 + 右3×2矩阵） -->
  <view class="sd-consume-card">
    <view class="sd-consume-total">
      <text class="sd-cell-label">总实耗</text>
      <text class="sd-cell-value">{{totalConsume}}</text>
    </view>
    <view class="sd-consume-breakdown">
      <view class="sd-consume-row">
        <view class="sd-consume-cell">
          <text class="sd-cell-label">小美客项目实耗</text>
          <text class="sd-cell-value">{{xiaomeiProjectConsume}}</text>
        </view>
        <view class="sd-consume-cell">
          <text class="sd-cell-label">新增会员实耗</text>
          <text class="sd-cell-value">{{newMemberProjectConsume}}</text>
        </view>
        <view class="sd-consume-cell">
          <text class="sd-cell-label">老会员实耗</text>
          <text class="sd-cell-value">{{oldMemberProjectConsume}}</text>
        </view>
      </view>
      <view class="sd-consume-row">
        <view class="sd-consume-cell">
          <text class="sd-cell-label">小美客产品出库</text>
          <text class="sd-cell-value">{{xiaomeiProductOut}}</text>
        </view>
        <view class="sd-consume-cell">
          <text class="sd-cell-label">新增会员产品出库</text>
          <text class="sd-cell-value">{{newMemberProductOut}}</text>
        </view>
        <view class="sd-consume-cell">
          <text class="sd-cell-label">老会员产品出库</text>
          <text class="sd-cell-value">{{oldMemberProductOut}}</text>
        </view>
      </view>
    </view>
  </view>
</view>

<!-- 业绩与品项区 -->
<view class="sd-section">
  <view class="sd-section-title">业绩与品项</view>

  <!-- 三维汇总条目（可展开） -->
  <view class="sd-breakdown-item" bindtap="onToggleSection" data-section="salesCategory">
    <text class="sd-breakdown-label">按经营类型汇总</text>
    <text class="sd-breakdown-arrow">{{expandedSection==='salesCategory'?'▲':'▼'}}</text>
  </view>
  <view class="sd-breakdown-list" wx:if="{{expandedSection==='salesCategory'}}">
    <view class="sd-breakdown-row" wx:for="{{bySalesCategory}}" wx:key="label">
      <text class="sd-breakdown-name">{{item.label}}</text>
      <text class="sd-breakdown-value">{{item.value}}</text>
    </view>
  </view>

  <view class="sd-breakdown-item" bindtap="onToggleSection" data-section="productKind">
    <text class="sd-breakdown-label">按一级品项汇总</text>
    <text class="sd-breakdown-arrow">{{expandedSection==='productKind'?'▲':'▼'}}</text>
  </view>
  <view class="sd-breakdown-list" wx:if="{{expandedSection==='productKind'}}">
    <view class="sd-breakdown-row" wx:for="{{byProductKind}}" wx:key="label">
      <text class="sd-breakdown-name">{{item.label}}</text>
      <text class="sd-breakdown-value">{{item.value}}</text>
    </view>
  </view>

  <view class="sd-breakdown-item" bindtap="onToggleSection" data-section="categoryName">
    <text class="sd-breakdown-label">按二级品项汇总</text>
    <text class="sd-breakdown-arrow">{{expandedSection==='categoryName'?'▲':'▼'}}</text>
  </view>
  <view class="sd-breakdown-list" wx:if="{{expandedSection==='categoryName'}}">
    <view class="sd-breakdown-row" wx:for="{{byCategoryName}}" wx:key="label">
      <text class="sd-breakdown-name">{{item.label}}</text>
      <text class="sd-breakdown-value">{{item.value}}</text>
    </view>
  </view>
</view>
```

## TypeScript 逻辑（关键片段）

```ts
Page({
  data: {
    period: 'month' as 'month' | 'lastMonth' | 'year',
    loading: false,
    // ... 各指标初始值 '0.00'
    expandedSection: '' as '' | 'salesCategory' | 'productKind' | 'categoryName',
    // bySalesCategory / byProductKind / byCategoryName 初始 []
  },

  onLoad() {
    this.loadData()
  },

  onPeriodChange(e: WechatMiniprogram.BaseEvent) {
    const period = (e.currentTarget.dataset as { period: string }).period as 'month' | 'lastMonth' | 'year'
    this.setData({ period }, () => this.loadData())
  },

  onToggleSection(e: WechatMiniprogram.BaseEvent) {
    const section = (e.currentTarget.dataset as { section: string }).section
    this.setData({
      expandedSection: this.data.expandedSection === section ? '' : section
    } as any)
  },

  async loadData() {
    this.setData({ loading: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'staffApi',
        data: {
          action: 'mgmtDashboard.salesData',
          payload: { period: this.data.period }
        }
      })
      const d = (res.result as any)?.data
      if (d) {
        this.setData({
          totalRevenue: d.totalRevenue,
          xiaomeiRevenue: d.xiaomeiRevenue,
          newMemberRevenue: d.newMemberRevenue,
          oldMemberRevenue: d.oldMemberRevenue,
          totalConsume: d.totalConsume,
          xiaomeiProjectConsume: d.xiaomeiProjectConsume,
          newMemberProjectConsume: d.newMemberProjectConsume,
          oldMemberProjectConsume: d.oldMemberProjectConsume,
          xiaomeiProductOut: d.xiaomeiProductOut,
          newMemberProductOut: d.newMemberProductOut,
          oldMemberProductOut: d.oldMemberProductOut,
          bySalesCategory: d.bySalesCategory || [],
          byProductKind: d.byProductKind || [],
          byCategoryName: d.byCategoryName || [],
        })
      }
    } catch (err) {
      wx.showToast({ icon: 'none', title: '数据加载失败' })
    } finally {
      this.setData({ loading: false })
    }
  }
})
```

## WXSS 关键样式规范

- 品牌色 `#C0322A`（chip active 状态下划线/高亮）
- 卡片背景 `#fff`，`border-radius: 8rpx`，`box-shadow: 0 2rpx 8rpx rgba(0,0,0,0.06)`
- 4 列业绩卡：`display: grid; grid-template-columns: repeat(4, 1fr)`，文字小于 24rpx 时允许换行
- 实耗卡：左侧总实耗宽度 ~25%，右侧 3×2 矩阵占 75%
- 品项汇总展开列表：`label` 靠左，`value` 靠右，`display: flex; justify-content: space-between`
- loading 状态：全页骨架屏或 `wx:if="{{!loading}}"` 控制内容显示

## JSON（导航栏）

```json
{
  "navigationBarTitleText": "销售数据",
  "navigationBarBackgroundColor": "#C0322A",
  "navigationBarTextStyle": "white"
}
```

## 验收标准

- [ ] 切换本月/上月/本年，数据随 chip 变化
- [ ] 上月数据的 endDate 是上月最后一天（非今天）
- [ ] 点击品项汇总条目展开/收起列表
- [ ] 加载中显示 loading 状态，失败提示 Toast
- [ ] mgmt-dashboard 入口点击可正常跳转（不再 Toast "页面开发中"）
- [ ] 无顾客时金额全显示 `0.00`（不显示 `--`）
- [ ] 空品项汇总时不渲染 breakdown-list
