# Ticket 4: 管理层数据中心首页（mgmt-dashboard `dashboard` tab）

> 生成日期：2026-04-25
> 严重级别：P1（管理层 hub 第一个真实业务页面）
> 端：fengyu-staff（小程序前端页面）
> 影响面：替换 `pages/mgmt-dashboard/mgmt-dashboard` 的 `dashboard` tab 占位
> 前置：**Ticket 1**（快照字段）+ **Ticket 2**（summary 接口）+ **Ticket 3**（scope-picker 组件）
> 并行：无（串在最后）
>
> **一句话目标**：把当前 `dashboard` tab 的 `placeholder-page` 替换成完整可用的"数据中心首页"，
> 顶部含日历选择器（默认当天）+ 市场/门店二级筛选器，
> 下方 8 张卡片（4 大 + 4 小）展示业绩 / 实耗 / 客流 / 客量 / 新会员 / 项目数。

---

## 0 一句话背景

`pages/mgmt-dashboard.wxml` 中 `activeTab === 'dashboard'` 当前是：

```xml
<placeholder-page page-title="数据中心" subtitle="功能建设中..." icon="chart-trending-o" ... />
```

页面骨架（4 tab 切换、mgmt-navbar）已存在，本 ticket 只关心 dashboard tab 内部内容。
设计参考截图：日历选择器 + 二级筛选器 → 4 张大卡片（每张 3 行：今日/本月/月店均）→ 4 张小卡片（每张 2 行：今日/本月）。

---

## 1 布局

### 1.1 截图所示布局

```
+------------------------------------------+
| [日历选择器: 2026-04-25 ▾]                |
| [全部市场 ▾]                              |
+------------------------------------------+
|                                          |
|  +---------------+  +---------------+    |
|  | 门店业绩      |  | 生美业绩      |    |
|  |  今日: 25000  |  |  今日: 15000  |    |
|  |  本月: 1.2M   |  |  本月: 1.5M   |    |
|  |  月店均: 30k  |  |  月店均: 37.5k|    |
|  +---------------+  +---------------+    |
|                                          |
|  +---------------+  +---------------+    |
|  | 门店实耗      |  | 生美实耗      |    |
|  |  ...          |  |  ...          |    |
|  +---------------+  +---------------+    |
|                                          |
|  +-----+ +-----+ +-----+ +-----+         |
|  |客流 | |客量 | |新会员| |项目数|         |
|  |今日:| |今日:| |今日:| |今日:|          |
|  |本月:| |本月:| |本月:| |本月:|          |
|  +-----+ +-----+ +-----+ +-----+         |
+------------------------------------------+
| [mgmt-navbar: 首页 / 排行榜 / 顾客 / 我的] |
+------------------------------------------+
```

### 1.2 我的布局选择

- 大卡片：2 列 × 2 行，**flex 平分宽度**，间距 16rpx，圆角 16rpx，浅灰底
- 小卡片：4 列 × 1 行，**flex 平分**，间距 8rpx，圆角 12rpx，**纵向排版**：标题 → 今日 → 本月
- 在小屏（<360px）下小卡片可降级为 2 列 × 2 行（用 `wx.getSystemInfoSync().windowWidth` 判断或纯 CSS 媒体查询）
- 数据未加载时显示 `--`（不是 0，避免与真实 0 混淆）

### 1.3 数字格式化

- 金额（业绩/实耗/月店均）：千分位 + 2 位小数；超过 10000 折叠为"万"（"1.2 万"）
- 计数（客流/客量/新会员/项目数）：纯整数；超过 10000 折叠为"万"
- 复用 `utils/number.ts` 的 `formatAmount()` / `formatCount()`，不存在则在本 ticket 同时新建

---

## 2 实现要点

### 2.1 mgmt-dashboard.json 引入组件

```json
{
  "navigationBarTitleText": "管理层",
  "usingComponents": {
    "van-icon": "@vant/weapp/icon/index",
    "van-calendar": "@vant/weapp/calendar/index",
    "placeholder-page": "../../components/placeholder-page/placeholder-page",
    "mgmt-navbar": "../../components/mgmt-navbar/mgmt-navbar",
    "mgmt-scope-picker": "../../components/mgmt-scope-picker/mgmt-scope-picker"
  }
}
```

### 2.2 mgmt-dashboard.ts 数据/逻辑

```ts
import { canAccessManagement } from '../../utils/role'
import { callStaffApi } from '../../utils/cloud'
import { formatAmount, formatCount } from '../../utils/number'

const app = getApp<IAppOption>()

interface ScopeValue {
  scopeType: 'all' | 'market' | 'store'
  scopeId: string | null
  scopeName: string
}

interface SummaryData {
  storeRevenue: { today: number; month: number; monthlyAvgPerStore: number }
  shengmeiRevenue: { today: number; month: number; monthlyAvgPerStore: number }
  storeConsume: { today: number; month: number; monthlyAvgPerStore: number }
  shengmeiConsume: { today: number; month: number; monthlyAvgPerStore: number }
  footfall: { today: number; month: number }
  headcount: { today: number; month: number }
  newMembers: { today: number; month: number }
  projectCount: { today: number; month: number }
}

Page({
  data: {
    activeTab: 'dashboard',
    canSwitchStore: false,
    staffName: '',
    phone: '',
    position: '',
    staffLevelLabel: '',
    staffLevel: '',

    // 数据中心新增
    selectedDate: '',                   // 'YYYY-MM-DD'
    showCalendar: false,
    scope: { scopeType: 'all', scopeId: null, scopeName: '全部市场' } as ScopeValue,
    defaultScope: { ... },              // 由 onLoad 计算
    summary: null as SummaryData | null,
    loading: false,

    // 展示用（格式化后的字符串）
    display: null as Record<string, { today: string; month: string; monthlyAvgPerStore?: string }> | null,
  },

  onLoad(options) { /* 现有 4 tab 逻辑保留 */ ... },

  onShow() {
    if (!canAccessManagement()) { wx.reLaunch({ url: '/pages/workbench/workbench' }); return }
    // ... 现有 staffName/phone/... 设值

    // 数据中心初始化
    if (this.data.activeTab === 'dashboard' && !this.data.selectedDate) {
      this.initDashboard()
    }
  },

  initDashboard() {
    const today = new Date().toISOString().slice(0, 10)
    const defaultScope = this.computeDefaultScope()
    this.setData({ selectedDate: today, scope: defaultScope, defaultScope })
    this.loadSummary()
  },

  computeDefaultScope(): ScopeValue {
    // headquarters → all；market → 自己 market
    const { staffLevel, roleBindings } = app.globalData
    if (staffLevel === 'headquarters') return { scopeType: 'all', scopeId: null, scopeName: '全部市场' }
    const marketBinding = (roleBindings || []).find((b: any) => b.scopeType === '市场')
    if (marketBinding) return {
      scopeType: 'market',
      scopeId: marketBinding.scopeId,
      scopeName: marketBinding.scopeName || '我的市场',
    }
    // 兜底（理论上不会到这里，因为 canAccessManagement 已拦截）
    return { scopeType: 'all', scopeId: null, scopeName: '全部市场' }
  },

  onCalendarOpen()  { this.setData({ showCalendar: true }) },
  onCalendarClose() { this.setData({ showCalendar: false }) },
  onCalendarConfirm(e: WechatMiniprogram.CustomEvent<Date>) {
    const d = e.detail
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    this.setData({ selectedDate: date, showCalendar: false })
    this.loadSummary()
  },

  onScopeChange(e: WechatMiniprogram.CustomEvent<ScopeValue>) {
    this.setData({ scope: e.detail })
    this.loadSummary()
  },

  async loadSummary() {
    if (!this.data.selectedDate) return
    this.setData({ loading: true })
    try {
      const summary = await callStaffApi<SummaryData>('mgmtDashboard.summary', {
        date: this.data.selectedDate,
        scopeType: this.data.scope.scopeType,
        scopeId: this.data.scope.scopeId,
      })
      this.setData({ summary, display: this.buildDisplay(summary), loading: false })
    } catch (err) {
      this.setData({ loading: false })
      wx.showToast({ icon: 'none', title: '加载失败，请重试' })
    }
  },

  buildDisplay(s: SummaryData) {
    return {
      storeRevenue:    { today: formatAmount(s.storeRevenue.today),    month: formatAmount(s.storeRevenue.month),    monthlyAvgPerStore: formatAmount(s.storeRevenue.monthlyAvgPerStore) },
      shengmeiRevenue: { today: formatAmount(s.shengmeiRevenue.today), month: formatAmount(s.shengmeiRevenue.month), monthlyAvgPerStore: formatAmount(s.shengmeiRevenue.monthlyAvgPerStore) },
      storeConsume:    { today: formatAmount(s.storeConsume.today),    month: formatAmount(s.storeConsume.month),    monthlyAvgPerStore: formatAmount(s.storeConsume.monthlyAvgPerStore) },
      shengmeiConsume: { today: formatAmount(s.shengmeiConsume.today), month: formatAmount(s.shengmeiConsume.month), monthlyAvgPerStore: formatAmount(s.shengmeiConsume.monthlyAvgPerStore) },
      footfall:    { today: formatCount(s.footfall.today),    month: formatCount(s.footfall.month) },
      headcount:   { today: formatCount(s.headcount.today),   month: formatCount(s.headcount.month) },
      newMembers:  { today: formatCount(s.newMembers.today),  month: formatCount(s.newMembers.month) },
      projectCount:{ today: '--',                              month: '--' },  // 占位
    }
  },

  // ... 现有 onTabChange / onSwitchToStore / onLogout 不动
})
```

### 2.3 mgmt-dashboard.wxml dashboard tab 内部

```xml
<block wx:if="{{activeTab === 'dashboard'}}">
  <view class="mgmt-dash">
    <!-- 顶部筛选栏 -->
    <view class="mgmt-dash-filters">
      <view class="filter-row">
        <view class="filter-trigger" bindtap="onCalendarOpen">
          <text>{{ selectedDate || '请选择日期' }}</text>
          <van-icon name="arrow-down" size="24rpx" color="#999" />
        </view>
        <mgmt-scope-picker
          staff-level="{{ staffLevel }}"
          default-scope="{{ defaultScope }}"
          bind:change="onScopeChange"
        />
      </view>
    </view>

    <!-- 大卡片：2×2 -->
    <view class="mgmt-dash-grid-large">
      <view class="dash-card dash-card--large">
        <view class="dash-card-title">门店业绩</view>
        <view class="dash-card-row"><text class="lbl">今日：</text><text class="val">{{ display.storeRevenue.today }}</text></view>
        <view class="dash-card-row"><text class="lbl">本月：</text><text class="val">{{ display.storeRevenue.month }}</text></view>
        <view class="dash-card-row"><text class="lbl">月店均：</text><text class="val">{{ display.storeRevenue.monthlyAvgPerStore }}</text></view>
      </view>
      <view class="dash-card dash-card--large">
        <view class="dash-card-title">生美业绩</view>
        <view class="dash-card-row"><text class="lbl">今日：</text><text class="val">{{ display.shengmeiRevenue.today }}</text></view>
        <view class="dash-card-row"><text class="lbl">本月：</text><text class="val">{{ display.shengmeiRevenue.month }}</text></view>
        <view class="dash-card-row"><text class="lbl">月店均：</text><text class="val">{{ display.shengmeiRevenue.monthlyAvgPerStore }}</text></view>
      </view>
      <view class="dash-card dash-card--large">
        <view class="dash-card-title">门店实耗</view>
        <view class="dash-card-row"><text class="lbl">今日：</text><text class="val">{{ display.storeConsume.today }}</text></view>
        <view class="dash-card-row"><text class="lbl">本月：</text><text class="val">{{ display.storeConsume.month }}</text></view>
        <view class="dash-card-row"><text class="lbl">月店均：</text><text class="val">{{ display.storeConsume.monthlyAvgPerStore }}</text></view>
      </view>
      <view class="dash-card dash-card--large">
        <view class="dash-card-title">生美实耗</view>
        <view class="dash-card-row"><text class="lbl">今日：</text><text class="val">{{ display.shengmeiConsume.today }}</text></view>
        <view class="dash-card-row"><text class="lbl">本月：</text><text class="val">{{ display.shengmeiConsume.month }}</text></view>
        <view class="dash-card-row"><text class="lbl">月店均：</text><text class="val">{{ display.shengmeiConsume.monthlyAvgPerStore }}</text></view>
      </view>
    </view>

    <!-- 小卡片：4×1 -->
    <view class="mgmt-dash-grid-small">
      <view class="dash-card dash-card--small">
        <view class="dash-card-title">客流</view>
        <view class="dash-card-row"><text class="lbl">今日：</text><text class="val">{{ display.footfall.today }}</text></view>
        <view class="dash-card-row"><text class="lbl">本月：</text><text class="val">{{ display.footfall.month }}</text></view>
      </view>
      <view class="dash-card dash-card--small">
        <view class="dash-card-title">客量</view>
        <view class="dash-card-row"><text class="lbl">今日：</text><text class="val">{{ display.headcount.today }}</text></view>
        <view class="dash-card-row"><text class="lbl">本月：</text><text class="val">{{ display.headcount.month }}</text></view>
      </view>
      <view class="dash-card dash-card--small">
        <view class="dash-card-title">新会员</view>
        <view class="dash-card-row"><text class="lbl">今日：</text><text class="val">{{ display.newMembers.today }}</text></view>
        <view class="dash-card-row"><text class="lbl">本月：</text><text class="val">{{ display.newMembers.month }}</text></view>
      </view>
      <view class="dash-card dash-card--small">
        <view class="dash-card-title">项目数</view>
        <view class="dash-card-row"><text class="lbl">今日：</text><text class="val">--</text></view>
        <view class="dash-card-row"><text class="lbl">本月：</text><text class="val">--</text></view>
      </view>
    </view>

    <!-- 空态：未加载或加载中 -->
    <view wx:if="{{ loading && !display }}" class="dash-loading">加载中...</view>

    <!-- 日历弹窗 -->
    <van-calendar
      show="{{ showCalendar }}"
      bind:close="onCalendarClose"
      bind:confirm="onCalendarConfirm"
      max-date="{{ Date.now() }}"
      default-date="{{ Date.now() }}"
    />
  </view>
</block>
```

### 2.4 mgmt-dashboard.wxss 样式

```css
.mgmt-dash {
  padding: 24rpx;
  padding-bottom: 140rpx;  /* 给 mgmt-navbar 留位 */
}
.mgmt-dash-filters {
  display: flex;
  flex-direction: column;
  gap: 16rpx;
  padding-bottom: 24rpx;
}
.filter-row {
  display: flex;
  flex-direction: column;
  gap: 12rpx;
}
.filter-trigger {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16rpx 24rpx;
  background: #fff;
  border-radius: 12rpx;
  font-size: 28rpx;
}

.mgmt-dash-grid-large {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16rpx;
}
.mgmt-dash-grid-small {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8rpx;
  margin-top: 16rpx;
}
.dash-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
}
.dash-card--small { padding: 16rpx 12rpx; }
.dash-card-title { font-size: 28rpx; color: #C0322A; margin-bottom: 12rpx; font-weight: 600; }
.dash-card-row { display: flex; justify-content: space-between; font-size: 26rpx; line-height: 1.8; }
.dash-card--small .dash-card-row { font-size: 22rpx; flex-direction: column; align-items: flex-start; }
.dash-card-row .lbl { color: #999; }
.dash-card-row .val { color: #333; font-weight: 600; }

.dash-loading { text-align: center; padding: 60rpx 0; color: #999; }

@media (max-width: 360px) {
  .mgmt-dash-grid-small { grid-template-columns: 1fr 1fr; }
}
```

---

## 3 数据加载 / Tab 切换策略

- **首次进入 dashboard tab**：初始化 selectedDate=今天 + scope=defaultScope，立即调一次 summary
- **切到其他 tab 再切回**：保留之前的 selectedDate / scope，**不重新加载**
- **切换日期 / scope**：自动调一次 summary
- **下拉刷新**：暂不支持（需要手动改日期或切 scope 才会刷新）；**首版不加 onPullDownRefresh**，体验上"切日期"更明确

---

## 4 测试

### 4.1 手动验收

1. HQ 账号进入数据中心 → 默认日期为今天，scope 为"全部市场"，8 卡片有数据
2. 点日历改成昨天 → 8 卡片刷新；"今日"显示昨天的数；"本月"维持本月（昨天和今天同一月）
3. 改成上月某天 → "本月"对应那个月份的累计；"月店均"也是那个月份的
4. 切到某市场 → 数据收窄；"月店均"分母 = 该市场下门店数
5. 切到某门店 → 数据进一步收窄；"月店均"= 本月数据本身（分母=1）
6. 项目数始终显示 "--"
7. **市场账号**进入：默认 scope = 自己市场；scope-picker 不显示"全部市场"
8. **网络异常**：toast "加载失败，请重试"；卡片保留旧值不变（避免闪空）

### 4.2 截图基准对比

部署后用真实账号截一张图，与设计稿（截图）布局对照：
- 大卡片间距、字体、对齐方式
- 小卡片在常规屏 4 列、小屏 2 列
- 红色主色仅用于卡片标题，金额数字保持深灰

---

## 5 风险

| 风险 | 缓解 |
|---|---|
| van-calendar 在小程序里未"构建 npm" 时不可用 | DevTools 内执行"构建 npm"；CLAUDE.md 已强调 |
| 切换 tab 后数据不刷（需求是不刷新还是要刷？） | 当前设计：不刷。若运营反馈"切回看到旧数据"，加一个 `lastLoadedAt` 检查，超过 5 分钟才刷 |
| 8 卡片在小屏下拥挤 | §1.2 已加小屏降级 + §2.4 媒体查询 |
| 接口失败时 display=null 导致 wxml 报错 | wxml 用 `display.foo.today` 形式，初始 display=null 会报；改为 `wx:if="{{display}}"` 包整段，加载中显示 loading |

---

## 6 不在本 ticket 范围

- 项目数指标的实际计算
- 排行榜 / 顾客 / 我的 三个 tab 的实现（占位仍保留）
- 时间维度扩展到"上月 / 任意区间"
- 卡片下钻（点门店业绩 → 看明细）
- 卡片间对比（环比 / 同比）

---

## 7 交付物

- [ ] `pages/mgmt-dashboard/mgmt-dashboard.json` 引入 van-calendar + mgmt-scope-picker
- [ ] `pages/mgmt-dashboard/mgmt-dashboard.ts` 新增 §2.2 的数据/方法
- [ ] `pages/mgmt-dashboard/mgmt-dashboard.wxml` dashboard tab 替换为 §2.3
- [ ] `pages/mgmt-dashboard/mgmt-dashboard.wxss` §2.4 样式
- [ ] `utils/number.ts` 含 `formatAmount` / `formatCount`（如不存在则新建）
- [ ] 手动验收 §4.1 全通
- [ ] 与截图（§1.1）布局基本一致
