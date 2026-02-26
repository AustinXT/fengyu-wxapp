# 布局模式参考

从实际小程序开发中提炼的高频页面布局模式。主文件：[SKILL.md](../SKILL.md)

---

## R3.1 三态视图模式 [关键]

几乎所有数据页面都需要处理三种状态：**加载中 → 空态 → 内容态**。使用 `wx:if` / `wx:elif` / `wx:else` 严格互斥。

### WXML

```xml
<!-- 加载态：骨架屏 -->
<view wx:if="{{loading}}" class="skeleton">
  <view class="skeleton-header"></view>
  <view class="skeleton-line" wx:for="{{3}}" wx:key="*this"></view>
</view>

<!-- 空态 -->
<van-empty wx:elif="{{!list.length}}" description="暂无数据" />

<!-- 内容态 -->
<view wx:else class="content">
  <view class="list-item" wx:for="{{list}}" wx:key="id">
    <text>{{item.name}}</text>
  </view>
</view>
```

### WXSS（骨架屏）

```css
.skeleton-header {
  width: 200rpx;
  height: 40rpx;
  background: #f0f0f0;
  border-radius: 8rpx;
  margin-bottom: 24rpx;
}
.skeleton-line {
  width: 100%;
  height: 28rpx;
  background: #f0f0f0;
  border-radius: 8rpx;
  margin-bottom: 16rpx;
}
.skeleton-line:last-child {
  width: 60%;
}
```

### DO / DON'T

| DO | DON'T |
|---|---|
| 使用 `wx:if` 三态互斥切换 | 用 `hidden` 导致三态同时存在于 DOM |
| 骨架屏模拟真实布局结构 | 只放一个 van-loading 在页面正中央 |
| `van-empty` 提供操作引导（按钮） | 空态只显示文字"暂无数据"无任何操作 |

---

## R3.2 底部固定栏 + 安全区 [关键]

底部操作栏（按钮、TabBar、价格栏等）需同时处理 **固定定位** 和 **iPhone 安全区**。

### WXML

```xml
<view class="page-content">
  <!-- 主内容 -->
  <view class="content-scroll">
    <!-- ...页面内容... -->
  </view>

  <!-- 底部占位（防止内容被遮挡） -->
  <view class="bottom-placeholder"></view>
</view>

<!-- 底部固定栏 -->
<view class="bottom-bar">
  <view class="bottom-bar-inner">
    <view class="price-info">
      <text class="label">合计</text>
      <text class="price">¥{{totalPrice}}</text>
    </view>
    <van-button type="primary" round bind:click="handleSubmit">提交</van-button>
  </view>
</view>
```

### WXSS

```css
.bottom-placeholder {
  height: calc(120rpx + env(safe-area-inset-bottom));
}

.bottom-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: #ffffff;
  box-shadow: 0 -2rpx 12rpx rgba(0, 0, 0, 0.06);
  padding-bottom: env(safe-area-inset-bottom);
  z-index: 100;
}

.bottom-bar-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16rpx 32rpx;
  height: 120rpx;
  box-sizing: border-box;
}
```

### DO / DON'T

| DO | DON'T |
|---|---|
| 用 `env(safe-area-inset-bottom)` 适配安全区 | 写死 `padding-bottom: 68rpx` 只适配特定机型 |
| 内容区预留 `bottom-placeholder` 高度 | 底部栏遮住最后一项内容 |
| `position: fixed` + `z-index` 确保置顶 | 用 `sticky` 导致部分安卓机不生效 |

---

## R3.3 Tab 筛选列表 [高]

Tab + 动态列表是最常见的管理页面布局。使用 `van-tabs` 的 sticky 模式固定 Tab 栏。

### WXML

```xml
<van-tabs
  active="{{activeTab}}"
  bind:change="onTabChange"
  sticky
  color="var(--color-primary)"
  title-active-color="var(--color-primary)"
>
  <van-tab title="全部" name="all" />
  <van-tab title="进行中" name="active" />
  <van-tab title="已完成" name="completed" />
</van-tabs>

<!-- 列表区域（三态视图） -->
<view class="list-container">
  <view wx:if="{{loading}}" class="skeleton">
    <!-- 骨架屏 -->
  </view>
  <van-empty wx:elif="{{!filteredList.length}}" description="暂无{{tabName}}数据" />
  <view wx:else>
    <view class="list-item" wx:for="{{filteredList}}" wx:key="id">
      <!-- 列表项内容 -->
    </view>
  </view>
</view>
```

### WXSS

```css
.list-container {
  padding: 24rpx 32rpx;
  /* 确保 Tab sticky 时列表不被遮挡 */
  min-height: calc(100vh - 88rpx);
}

.list-item {
  background: var(--color-bg-card);
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
}
```

### 注意事项

- `van-tabs` 的 `sticky` 属性需要页面有足够滚动高度才会生效
- Tab 切换时应重置 loading 状态并重新拉取数据（或前端过滤）
- 每个 Tab 下的列表均需独立的三态视图处理

---

## R3.4 底部弹出面板 [高]

`van-popup` + `van-picker` 是移动端最常见的选择交互。注意两者组合时的事件陷阱。

### WXML

```xml
<!-- 触发器 -->
<van-cell
  title="选择分类"
  value="{{selectedLabel || '请选择'}}"
  is-link
  bind:click="showPicker"
/>

<!-- 弹出面板 -->
<van-popup
  show="{{pickerVisible}}"
  position="bottom"
  round
  bind:close="hidePicker"
>
  <van-picker
    columns="{{columns}}"
    show-toolbar
    bind:confirm="onPickerConfirm"
    bind:cancel="hidePicker"
  />
</van-popup>
```

### TS

```typescript
Page({
  data: {
    pickerVisible: false,
    selectedLabel: '',
    columns: ['分类A', '分类B', '分类C']
  },

  showPicker() {
    this.setData({ pickerVisible: true })
  },

  hidePicker() {
    this.setData({ pickerVisible: false })
  },

  onPickerConfirm(e: WechatMiniprogram.CustomEvent) {
    const { value, index } = e.detail
    this.setData({
      selectedLabel: value,
      pickerVisible: false
    })
  }
})
```

### 陷阱警告

| 陷阱 | 说明 |
|---|---|
| **不要在 van-popup 上加 `closeable`** | 会显示关闭按钮覆盖 picker 的 toolbar，用 `bind:close` 即可 |
| **confirm 事件的 detail 结构** | 单列是 `{ value, index }`，多列是 `{ value: [], index: [] }` |
| **关闭时机** | confirm 和 cancel 回调中都要手动 `setData({ pickerVisible: false })` |

---

## R3.5 表单布局 [高]

使用 `van-cell-group` + `van-field` 实现统一的表单布局。Picker 类字段用 `van-cell` + `van-popup` 组合。

### WXML

```xml
<van-cell-group title="基本信息" inset>
  <!-- 文本输入 -->
  <van-field
    label="名称"
    value="{{form.name}}"
    placeholder="请输入名称"
    bind:change="onFieldChange"
    data-field="name"
    required
  />

  <!-- 数字输入 -->
  <van-field
    label="金额"
    value="{{form.amount}}"
    type="digit"
    placeholder="请输入金额"
    bind:change="onFieldChange"
    data-field="amount"
  />

  <!-- Picker 选择字段 -->
  <van-cell
    title="分类"
    value="{{form.categoryLabel || '请选择'}}"
    is-link
    required
    bind:click="showCategoryPicker"
  />

  <!-- 日期选择字段 -->
  <van-cell
    title="日期"
    value="{{form.dateLabel || '请选择'}}"
    is-link
    bind:click="showDatePicker"
  />
</van-cell-group>

<van-cell-group title="备注" inset>
  <van-field
    label="备注"
    value="{{form.remark}}"
    type="textarea"
    placeholder="请输入备注"
    autosize
    bind:change="onFieldChange"
    data-field="remark"
  />
</van-cell-group>

<!-- 提交按钮 -->
<view class="form-footer">
  <van-button type="primary" block round bind:click="handleSubmit">
    提交
  </van-button>
</view>
```

### WXSS

```css
.form-footer {
  padding: 40rpx 32rpx;
  padding-bottom: calc(40rpx + env(safe-area-inset-bottom));
}
```

### 统一处理函数模式

```typescript
onFieldChange(e: WechatMiniprogram.CustomEvent) {
  const field = e.currentTarget.dataset.field
  this.setData({
    [`form.${field}`]: e.detail
  })
}
```

### 注意事项

- `van-field` 的 `bind:change` 回调 `e.detail` 直接是值（string），不是 `{ value }`
- Picker 类字段不用 `van-field`，用 `van-cell` + `is-link` 触发弹窗
- `required` 属性只显示红色星号，不做校验逻辑，需自行实现

---

## R3.6 横滑卡片列表 [中]

水平滚动适用于分类导航、推荐卡片等场景。使用原生 `scroll-view`。

### WXML

```xml
<scroll-view
  scroll-x
  class="scroll-row"
  enhanced
  show-scrollbar="{{false}}"
>
  <view class="scroll-content">
    <view class="scroll-card" wx:for="{{cardList}}" wx:key="id">
      <image src="{{item.image}}" class="card-image" mode="aspectFill" />
      <text class="card-title">{{item.title}}</text>
    </view>
  </view>
</scroll-view>
```

### WXSS

```css
.scroll-row {
  width: 100%;
  /* scroll-view 必须有明确宽度 */
}

.scroll-content {
  display: flex;  /* 或 inline-block 子项 */
  padding: 0 32rpx;
  gap: 20rpx;
}

.scroll-card {
  flex-shrink: 0;
  width: 240rpx;
}

.card-image {
  width: 240rpx;
  height: 180rpx;
  border-radius: 12rpx;
}

.card-title {
  font-size: 24rpx;
  margin-top: 12rpx;
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

### DO / DON'T

| DO | DON'T |
|---|---|
| `scroll-view` 设置明确宽度（通常 `width: 100%`） | 不设宽度导致无法滚动 |
| 子项 `flex-shrink: 0` 防止被压缩 | 子项被 flex 压缩到一行 |
| `show-scrollbar="{{false}}"` 隐藏滚动条 | 默认滚动条影响美观 |
| 最后一个子项右侧留 padding | 最后一个卡片贴边 |

---

## R3.7 选择 UI [中]

Grid 布局 + active 状态切换，适用于时段选择、标签选择、规格选择等场景。

### WXML

```xml
<view class="select-grid">
  <view
    class="select-item {{selectedId === item.id ? 'active' : ''}} {{item.disabled ? 'disabled' : ''}}"
    wx:for="{{options}}"
    wx:key="id"
    bindtap="onSelect"
    data-id="{{item.id}}"
  >
    <text class="select-label">{{item.label}}</text>
    <text wx:if="{{item.subLabel}}" class="select-sub">{{item.subLabel}}</text>
  </view>
</view>
```

### WXSS

```css
.select-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);  /* 一行 3 列，按需调整 */
  gap: 16rpx;
  padding: 24rpx 32rpx;
}

.select-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 20rpx 12rpx;
  border-radius: 12rpx;
  border: 2rpx solid var(--color-border);
  background: var(--color-bg-card);
  transition: all 200ms ease;
}

.select-item.active {
  border-color: var(--color-primary);
  background: var(--color-primary-light);
  color: var(--color-primary);
}

.select-item.disabled {
  opacity: 0.4;
  pointer-events: none;
}

.select-label {
  font-size: 28rpx;
  font-weight: 500;
}

.select-sub {
  font-size: 22rpx;
  color: var(--color-text-hint);
  margin-top: 4rpx;
}
```

### TS

```typescript
onSelect(e: WechatMiniprogram.CustomEvent) {
  const id = e.currentTarget.dataset.id
  const item = this.data.options.find((o: any) => o.id === id)
  if (item?.disabled) return
  this.setData({ selectedId: id })
}
```

### 变体

- **多选**：将 `selectedId` 改为 `selectedIds: string[]`，用 `includes` 判断 active
- **一行两列**：`grid-template-columns: repeat(2, 1fr)`
- **自适应宽度**：改用 `display: flex; flex-wrap: wrap;` + 子项 `padding: 16rpx 32rpx`
