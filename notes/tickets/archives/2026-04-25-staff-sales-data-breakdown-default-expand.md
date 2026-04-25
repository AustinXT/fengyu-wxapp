# Ticket: staff 管理层「销售数据」页 — 业绩与品项三个汇总默认展开并填入数据

> 生成日期：2026-04-25
> 严重级别：P3（管理层视图体验优化，不影响业务正确性）
> 端：fengyu-staff（员工端小程序，**仅前端改造**，后端无变更）
> 影响面：
> - 修改：`fengyu-staff/miniprogram/pages/sales-data/sales-data.wxml`
> - 修改：`fengyu-staff/miniprogram/pages/sales-data/sales-data.ts`
> - 修改：`fengyu-staff/miniprogram/pages/sales-data/sales-data.wxss`（视觉微调）
> 前置：无；后端 `mgmtDashboard.salesData` 已经返回完整字段，**后端零改动**
> 并行：与其他 staff 页面 ticket 互不干扰
>
> **一句话目标**：把销售数据页底部「业绩与品项」三个汇总（按经营类型 / 按一级品项 / 按二级品项）从「默认折叠 + 点击展开 + 互斥」改为「默认全部展开、直接铺出明细」，与上方「业绩与实耗」一致的呈现密度。

---

## 0 一句话背景

`pages/sales-data` 是管理层数据中心 hub（`pages/mgmt-dashboard`）下钻页之一，由 `mgmt-dashboard` 通过路由透传 `scopeType` / `scopeId` 进入，本月/上月/本年三档时间筛选，展示四类：

1. **业绩与实耗**（已是直接铺出 — 顶部「业绩矩阵 4 列」+「实耗 25/75 + 3×2」两张卡），默认全展示
2. **按经营类型汇总**（来自 `bySalesCategory`，`sale_items.sales_category` GROUP BY） — 当前折叠
3. **按一级品项汇总**（来自 `byProductKind`，`product_categories.product_kind` GROUP BY） — 当前折叠
4. **按二级品项汇总**（来自 `byCategoryName`，`product_categories.category_name` GROUP BY） — 当前折叠

后端 `cloudfunctions/staffApi/routes/mgmt-dashboard.js::salesData` 在同一次调用里已经返回三个分组（`SQL 6/7/8`），前端 `IData` 也已经接收并保存到 `bySalesCategory` / `byProductKind` / `byCategoryName` 三个数组字段。

**问题**：三个区块当前必须用户点击表头条 `sd-breakdown-item` 才会展开，且 `expandedSection: ExpandedSection` 字段把展开状态约束为单值（互斥），导致：

- 用户必须逐个点击才能看完，与上方业绩/实耗区**呈现密度不一致**
- 想对比"经营类型"和"一级品项"分布时必须反复切换
- "业绩与品项"作为同区段的并列子集，没有需要折叠的语义合理性（不是层级钻取关系）

**用户原话**：「下面的三个模块也需要像前面一样展开，填入具体的数据。」

---

## 1 设计决策

### 1.1 改造方向：彻底去掉折叠交互，三个分组直接铺平

**决策**：默认全部展开、不保留点击折叠能力。

**否决方案**：
- ❌ "默认全部展开 + 仍可点击折叠"：保留 `onToggleSection` + `expandedSection` 字段一来增加状态复杂度（需要支持多选展开），二来与"和上面区段一样直接铺"的诉求不符（上面没有折叠按钮）
- ❌ "默认折叠但用户可全展开"：用户已经表达"像前面一样展开"，再加一个全展开开关纯属加交互
- ❌ "保留单选互斥但默认展开第一个"：仍然不能同时看三个

**选择"彻底去掉折叠"的边界**：
- 删除 `expandedSection` 字段、`onToggleSection` 方法、wxml 中的 `bindtap` / `▼/▲` 箭头
- 三个分组下的明细永远渲染（前提：数组非空）
- 表头条只作为"小标题"存在（保留 `sd-breakdown-label` 样式），删去交互态（`:active` 也保留即可，但移除 `bindtap` 后实际不会触发）

### 1.2 空数据处理

**决策**：分组为空数组时，仍然显示标题条，但下方显示一行「暂无数据」占位。

理由：
- 上方"业绩与实耗"在数值为 0 时仍然显示 `0.00`，结构稳定
- 三个分组若某月所有经营类型业绩都为零（`paid_amount > 0` 全过滤掉），`toList(rows)` 已经过滤掉 `value <= 0` 的条目，可能整组为空数组
- 如果直接隐藏整个区块，用户会以为"接口挂了"或"页面没渲染完整"

实现方式：在 wxml 用 `wx:if="{{bySalesCategory.length > 0}}"` 渲染列表，`wx:else` 渲染一个统一的 `sd-breakdown-empty` 占位。

### 1.3 视觉处理：三个分组之间的分隔

**决策**：三个分组在视觉上保持明显分隔，但不再用「卡片表头条 + 阴影列表」这种突出可点击的样式。

具体调整：
- 表头条 `sd-breakdown-label` 字号从 `28rpx` 提到 `26rpx` 但加 padding-bottom，变为更紧凑的"小节标题"
- 删除 `sd-breakdown-arrow` 元素（▼/▲ 箭头无意义）
- `sd-breakdown-item` 的 `:active` 态保留无害（移除 bindtap 后不会触发，但不必删 CSS）
- `sd-breakdown-list` 的 `margin-bottom` 提到 `16rpx`，让三组之间的空隙跟"业绩矩阵 vs 实耗卡"的 `16rpx` 一致

### 1.4 性能影响：零

后端已经返回完整数据。前端从"渲染 N 行" 变为 "渲染 N1+N2+N3 行"，对于一个月的数据量（按经营类型 ~5 类、一级品项 ~4 类、二级品项 ~30~50 类），最坏情况 ≈ 60 行渲染，完全无压力。

**唯一关注点**：`byCategoryName` 二级品项行数可能较多（大几十）。若日后某月 SKU 类目暴涨到 200+，可能需要二级折叠/分页 — 当前阶段不预判，等出现性能问题再说。

### 1.5 路由兼容

不涉及。`mgmt-dashboard` 跳转 `sales-data` 的 URL 参数（`scopeType` / `scopeId`）不变。后端 action 与 payload 不变。

---

## 2 目标产物

### 2.1 修改清单（仅 3 个文件）

| 文件 | 改动 |
|------|------|
| `fengyu-staff/miniprogram/pages/sales-data/sales-data.ts` | 删除 `ExpandedSection` 类型 / `expandedSection` 字段 / `onToggleSection` 方法 |
| `fengyu-staff/miniprogram/pages/sales-data/sales-data.wxml` | 三个分组永远渲染明细；删 `bindtap`/`data-section`/箭头；新增空状态占位 |
| `fengyu-staff/miniprogram/pages/sales-data/sales-data.wxss` | `sd-breakdown-label` 微调；新增 `sd-breakdown-empty` 占位样式 |

### 2.2 不变的部分

- 后端 `cloudfunctions/staffApi/routes/mgmt-dashboard.js::salesData` 完全不动
- 路由参数 `scopeType` / `scopeId` 不变
- `loadData()` 调用方式不变
- 时间 chip（本月/上月/本年）和顶部「业绩与实耗」整块不动

---

## 3 实现步骤

### 3.1 STEP A：sales-data.ts 移除折叠状态

`fengyu-staff/miniprogram/pages/sales-data/sales-data.ts`：

```diff
 type Period = 'month' | 'lastMonth' | 'year'
 type ScopeType = 'all' | 'market' | 'store'
-type ExpandedSection = '' | 'salesCategory' | 'productKind' | 'categoryName'

 interface BreakdownItem {
   label: string
   value: string
 }

 interface SalesDataResp { ... 不变 ... }

 interface IData {
   period: Period
   scopeType: ScopeType
   scopeId: string | null
   loading: boolean

   // ... 业绩 / 实耗字段 ... 不变

   bySalesCategory: BreakdownItem[]
   byProductKind: BreakdownItem[]
   byCategoryName: BreakdownItem[]
-
-  expandedSection: ExpandedSection
 }

 Page<IData, WechatMiniprogram.IAnyObject>({
   data: {
     period: 'month',
     // ...
     bySalesCategory: [],
     byProductKind: [],
     byCategoryName: [],
-
-    expandedSection: '',
   },

   onLoad(query) { ... 不变 ... },
   onPeriodChange(e) { ... 不变 ... },
-
-  onToggleSection(e: WechatMiniprogram.BaseEvent) {
-    const section = (e.currentTarget.dataset as { section?: ExpandedSection }).section
-    if (!section) return
-    const next: ExpandedSection = this.data.expandedSection === section ? '' : section
-    this.setData({ expandedSection: next })
-  },

   async loadData() { ... 不变 ... },
 })
```

### 3.2 STEP B：sales-data.wxml 三组永久展开

`fengyu-staff/miniprogram/pages/sales-data/sales-data.wxml` 把「业绩与品项」整段（约 90~160 行）替换为：

```xml
<!-- 业绩与品项区 -->
<view class="sd-section">
  <view class="sd-section-title">业绩与品项</view>

  <!-- 1. 按经营类型汇总 -->
  <view class="sd-breakdown-group">
    <view class="sd-breakdown-item">
      <text class="sd-breakdown-label">按经营类型汇总</text>
    </view>
    <view class="sd-breakdown-list" wx:if="{{bySalesCategory.length > 0}}">
      <view class="sd-breakdown-row" wx:for="{{bySalesCategory}}" wx:key="label">
        <text class="sd-breakdown-name">{{item.label}}</text>
        <text class="sd-breakdown-value">{{item.value}}</text>
      </view>
    </view>
    <view class="sd-breakdown-empty" wx:else>暂无数据</view>
  </view>

  <!-- 2. 按一级品项汇总 -->
  <view class="sd-breakdown-group">
    <view class="sd-breakdown-item">
      <text class="sd-breakdown-label">按一级品项汇总</text>
    </view>
    <view class="sd-breakdown-list" wx:if="{{byProductKind.length > 0}}">
      <view class="sd-breakdown-row" wx:for="{{byProductKind}}" wx:key="label">
        <text class="sd-breakdown-name">{{item.label}}</text>
        <text class="sd-breakdown-value">{{item.value}}</text>
      </view>
    </view>
    <view class="sd-breakdown-empty" wx:else>暂无数据</view>
  </view>

  <!-- 3. 按二级品项汇总 -->
  <view class="sd-breakdown-group">
    <view class="sd-breakdown-item">
      <text class="sd-breakdown-label">按二级品项汇总</text>
    </view>
    <view class="sd-breakdown-list" wx:if="{{byCategoryName.length > 0}}">
      <view class="sd-breakdown-row" wx:for="{{byCategoryName}}" wx:key="label">
        <text class="sd-breakdown-name">{{item.label}}</text>
        <text class="sd-breakdown-value">{{item.value}}</text>
      </view>
    </view>
    <view class="sd-breakdown-empty" wx:else>暂无数据</view>
  </view>
</view>
```

要点：
- 每组用 `sd-breakdown-group` 容器包裹（标题 + 列表 + 空态作为一组）
- 标题条 `sd-breakdown-item` 移除 `bindtap` / `data-section`
- 移除 `sd-breakdown-arrow` ▼/▲ 箭头
- 列表的 `wx:if` 不再带 `expandedSection` 判断，仅检查数组长度
- 空态新增 `sd-breakdown-empty` 占位

### 3.3 STEP C：sales-data.wxss 视觉微调

`fengyu-staff/miniprogram/pages/sales-data/sales-data.wxss` 增量：

```diff
+.sd-breakdown-group {
+  margin-bottom: 16rpx;
+}
+.sd-breakdown-group:last-child {
+  margin-bottom: 0;
+}

 /* 品项汇总条目（标题条） */
 .sd-breakdown-item {
   display: flex;
-  justify-content: space-between;
   align-items: center;
-  padding: 24rpx 28rpx;
+  padding: 16rpx 28rpx;
   background: #fff;
-  border-radius: 8rpx;
-  margin-bottom: 8rpx;
-  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);
+  border-radius: 8rpx 8rpx 0 0;        /* 与下方列表合体：仅顶部圆角 */
+  border-bottom: 1rpx solid #f0f0f0;
 }

-.sd-breakdown-item:active {
-  background: #f7f7f7;
-}

 .sd-breakdown-label {
   font-size: 28rpx;
-  color: #333;
+  color: var(--color-primary);
   font-weight: 500;
 }

-.sd-breakdown-arrow {
-  font-size: 24rpx;
-  color: #999;
-}

 .sd-breakdown-list {
   background: #fff;
-  border-radius: 8rpx;
-  margin-bottom: 12rpx;
+  border-radius: 0 0 8rpx 8rpx;        /* 与上方标题条合体：仅底部圆角 */
   padding: 8rpx 0;
   box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);
 }

+.sd-breakdown-empty {
+  background: #fff;
+  border-radius: 0 0 8rpx 8rpx;
+  text-align: center;
+  font-size: 24rpx;
+  color: #bbb;
+  padding: 32rpx 0;
+  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.06);
+}
```

视觉效果：
- 标题条与列表合体为一张卡片（标题条仅顶部圆角，列表/空态仅底部圆角）
- 标题用主色（#C0322A）做小节强调，与上方区段标题 `sd-section-title` 风格统一
- 三组之间间距 `16rpx`，与"业绩矩阵卡"和"实耗卡"之间的 `16rpx` 一致
- 空态文案居中、灰色、字号小，不抢视觉

---

## 4 测试策略

### 4.1 编译/类型自检

```bash
# 在 fengyu-staff/miniprogram 目录下（如果有独立 tsconfig）
# 或直接在微信开发者工具中 Ctrl+S 触发编译
```

要点：
- `expandedSection` 删除后，确保没有别处引用（grep 全仓）
- `ExpandedSection` 类型别名删除后无悬挂引用

```bash
grep -rn "expandedSection\|ExpandedSection\|onToggleSection" \
  /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/
```

预期输出：仅命中本 ticket 修改前的源文件，修改后应零命中。

### 4.2 微信开发者工具手动验证（推荐 4 个最小用例）

打开 `fengyu-staff/miniprogram/`，登录管理层账号，从 mgmt-dashboard 点进销售数据页：

| 用例 | 操作 | 期望 |
|---|---|---|
| 1. 默认进入（本月） | 直接打开页面 | 三个分组全部直接展示，**无需点击** |
| 2. 切换到「上月」 | 点上月 chip | 三个分组同步刷新，仍然全部展开 |
| 3. 切换到「本年」 | 点本年 chip | 同上；二级品项可能有数十行，滚动可见全部 |
| 4. 全部空数据 | 选一个无数据的 scope（或测试期间的零数据月份） | 三个分组下都展示「暂无数据」灰色占位 |

### 4.3 静态视觉对比

- 上方"业绩与实耗"区无折叠按钮 → 下方"业绩与品项"区也应无折叠按钮（视觉一致性）
- 标题条 + 列表合并为单卡片视觉效果（中间无明显接缝）
- 三组之间间距与上方区段间距一致（`16rpx`）

### 4.4 不需要做的测试

- 后端 `salesData` 返回值结构未变 → **不需要新增/修改后端测试**
- `mgmtDashboard.salesData` 现有路由测试（如有）应继续通过

---

## 5 风险与缓解

| 风险 | 缓解 |
|---|---|
| 二级品项列表过长导致滚动疲劳（目前估算 30~50 行） | 当前数据量可接受；若未来超 100 行再开新 ticket 加二级折叠或分页 |
| WXML 中删 `bindtap` 后 ts 仍保留 `onToggleSection` 会有未引用方法 | 必须同步删 `onToggleSection` 方法（STEP A 已包含） |
| 残留 `data-section` 属性 | wxml 替换时整段重写，避免残留 |
| 全部展开后页面变长，原"折叠以减少初屏"动机失效 | 与用户诉求一致（用户主动要求展开），不是问题 |

---

## 6 不在本 ticket 范围

- 三个分组的指标口径变更（仍用 `received` 求和，与现有一致）
- 后端新增字段或聚合维度
- 三个分组的可视化（例如条形图、占比环），仅文本列表
- 二级折叠/分页能力
- mgmt-dashboard hub 页本身的展示改造

---

## 7 交付物清单

### 7.1 修改

- [ ] `fengyu-staff/miniprogram/pages/sales-data/sales-data.ts`：删 `ExpandedSection` 类型 / `expandedSection` 字段 / `onToggleSection` 方法
- [ ] `fengyu-staff/miniprogram/pages/sales-data/sales-data.wxml`：三个分组永久展开渲染；新增空态占位；移除 `bindtap` / `data-section` / 箭头
- [ ] `fengyu-staff/miniprogram/pages/sales-data/sales-data.wxss`：标题条与列表卡片合体；新增 `sd-breakdown-empty` 与 `sd-breakdown-group` 样式

### 7.2 验证

- [ ] `grep -rn "expandedSection\|ExpandedSection\|onToggleSection" fengyu-staff/` 零命中
- [ ] 微信开发者工具中页面打开默认显示三组完整数据
- [ ] 切换三档时间 chip 后三组都同步刷新，仍然全部展开
- [ ] 空数据用例显示「暂无数据」占位
- [ ] 视觉与上方「业绩与实耗」呈现密度一致（无折叠按钮）

### 7.3 不需要

- 后端无变更
- 数据库无变更
- 路由参数兼容性无变更
