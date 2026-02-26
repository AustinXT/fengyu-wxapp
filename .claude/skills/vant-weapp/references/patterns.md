# Vant Weapp 复合模式完整模板

> 每个模式包含 WXML、TypeScript、JSON 注册和 WXSS 骨架，可直接复制使用。
> 精简版见 [SKILL.md](../SKILL.md)。

---

## 模式 1：加载三态（Skeleton → Empty → Content）

页面数据加载的标准三态切换：骨架屏 → 空状态 → 实际内容。

### JSON

```json
{
  "usingComponents": {
    "van-skeleton": "@vant/weapp/skeleton/index",
    "van-empty": "@vant/weapp/empty/index"
  }
}
```

### WXML

```xml
<!-- 状态一：加载中 -->
<van-skeleton title row="3" loading="{{ loading }}">
  <!-- 状态二：空数据 -->
  <van-empty
    wx:if="{{ !list.length }}"
    description="暂无数据"
    image="search"
  >
    <van-button
      slot="bottom"
      round
      type="primary"
      size="small"
      bind:click="onRetry"
    >
      重新加载
    </van-button>
  </van-empty>

  <!-- 状态三：有数据 -->
  <view wx:else class="list">
    <view wx:for="{{ list }}" wx:key="id" class="list-item">
      {{ item.name }}
    </view>
  </view>
</van-skeleton>
```

### TypeScript

```typescript
interface ListItem {
  id: string
  name: string
}

Page({
  data: {
    loading: true,
    list: [] as ListItem[],
  },

  onLoad() {
    this.fetchData()
  },

  async fetchData() {
    this.setData({ loading: true })
    try {
      const list = await this.requestList()
      this.setData({ list, loading: false })
    } catch {
      this.setData({ list: [], loading: false })
    }
  },

  onRetry() {
    this.fetchData()
  },

  async requestList(): Promise<ListItem[]> {
    // 替换为实际请求
    return []
  },
})
```

### WXSS

```css
.list {
  padding: 24rpx;
}
.list-item {
  padding: 20rpx 0;
  border-bottom: 1rpx solid #ebedf0;
}
```

---

## 模式 2：Tab 筛选列表（sticky + swipeable + named tabs）

顶部标签切换不同列表，支持粘性定位和手势滑动。

### JSON

```json
{
  "usingComponents": {
    "van-tabs": "@vant/weapp/tabs/index",
    "van-tab": "@vant/weapp/tab/index",
    "van-skeleton": "@vant/weapp/skeleton/index",
    "van-empty": "@vant/weapp/empty/index"
  }
}
```

### WXML

```xml
<van-tabs
  active="{{ activeTab }}"
  sticky
  swipeable
  bind:change="onTabChange"
>
  <van-tab
    wx:for="{{ tabs }}"
    wx:key="name"
    title="{{ item.title }}"
    name="{{ item.name }}"
  >
    <van-skeleton title row="3" loading="{{ item.loading }}">
      <van-empty
        wx:if="{{ !item.list.length }}"
        description="暂无数据"
      />
      <view wx:else class="tab-content">
        <view
          wx:for="{{ item.list }}"
          wx:for-item="record"
          wx:key="id"
          class="record-item"
        >
          {{ record.name }}
        </view>
      </view>
    </van-skeleton>
  </van-tab>
</van-tabs>
```

### TypeScript

```typescript
interface TabItem {
  name: string
  title: string
  loading: boolean
  list: Array<{ id: string; name: string }>
  loaded: boolean // 是否已首次加载
}

Page({
  data: {
    activeTab: 'all',
    tabs: [
      { name: 'all', title: '全部', loading: false, list: [], loaded: false },
      { name: 'pending', title: '待处理', loading: false, list: [], loaded: false },
      { name: 'done', title: '已完成', loading: false, list: [], loaded: false },
    ] as TabItem[],
  },

  onLoad() {
    this.loadTab('all')
  },

  onTabChange(e: WechatMiniprogram.CustomEvent<{ name: string }>) {
    const name = e.detail.name
    this.setData({ activeTab: name })

    // 首次切换时加载数据
    const idx = this.data.tabs.findIndex((t) => t.name === name)
    if (idx >= 0 && !this.data.tabs[idx].loaded) {
      this.loadTab(name)
    }
  },

  async loadTab(name: string) {
    const idx = this.data.tabs.findIndex((t) => t.name === name)
    if (idx < 0) return

    this.setData({ [`tabs[${idx}].loading`]: true })
    try {
      const list = await this.requestList(name)
      this.setData({
        [`tabs[${idx}].list`]: list,
        [`tabs[${idx}].loading`]: false,
        [`tabs[${idx}].loaded`]: true,
      })
    } catch {
      this.setData({ [`tabs[${idx}].loading`]: false })
    }
  },

  async requestList(_status: string) {
    // 替换为实际请求
    return []
  },
})
```

### WXSS

```css
.tab-content {
  padding: 24rpx;
}
.record-item {
  padding: 24rpx 0;
  border-bottom: 1rpx solid #ebedf0;
}
```

---

## 模式 3：Popup 底部选择器（自定义列表 + bindtap + data-*）

底部弹出层展示自定义选项列表，点击选中后关闭。适用于不使用 Picker 的场景（如带图标、多行内容的选择）。

### JSON

```json
{
  "usingComponents": {
    "van-popup": "@vant/weapp/popup/index",
    "van-cell": "@vant/weapp/cell/index",
    "van-icon": "@vant/weapp/icon/index"
  }
}
```

### WXML

```xml
<!-- 触发按钮 -->
<van-cell
  title="选择类型"
  value="{{ selectedLabel || '请选择' }}"
  is-link
  bind:click="onOpenPicker"
/>

<!-- 底部选择器 -->
<van-popup
  show="{{ showPicker }}"
  position="bottom"
  round
  safe-area-inset-bottom
  bind:close="onClosePicker"
>
  <view class="picker-header">
    <text class="picker-title">选择类型</text>
  </view>
  <view class="picker-options">
    <view
      wx:for="{{ options }}"
      wx:key="value"
      class="picker-option {{ selected === item.value ? 'picker-option--active' : '' }}"
      data-value="{{ item.value }}"
      data-label="{{ item.label }}"
      bindtap="onSelectOption"
    >
      <text>{{ item.label }}</text>
      <van-icon wx:if="{{ selected === item.value }}" name="success" color="#07c160" />
    </view>
  </view>
</van-popup>
```

### TypeScript

```typescript
interface OptionItem {
  value: string
  label: string
}

Page({
  data: {
    showPicker: false,
    selected: '',
    selectedLabel: '',
    options: [
      { value: 'type_a', label: '类型 A' },
      { value: 'type_b', label: '类型 B' },
      { value: 'type_c', label: '类型 C' },
    ] as OptionItem[],
  },

  onOpenPicker() {
    this.setData({ showPicker: true })
  },

  onClosePicker() {
    this.setData({ showPicker: false })
  },

  onSelectOption(e: WechatMiniprogram.CustomEvent) {
    const { value, label } = e.currentTarget.dataset as { value: string; label: string }
    this.setData({
      selected: value,
      selectedLabel: label,
      showPicker: false,
    })
  },
})
```

### WXSS

```css
.picker-header {
  padding: 32rpx;
  text-align: center;
  border-bottom: 1rpx solid #ebedf0;
}
.picker-title {
  font-size: 32rpx;
  font-weight: 500;
}
.picker-options {
  max-height: 60vh;
  overflow-y: auto;
}
.picker-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 28rpx 32rpx;
  font-size: 28rpx;
}
.picker-option--active {
  color: #07c160;
}
```

---

## 模式 4：Radio-in-Cell 排他选择

单选列表，使用 radio-group + cell + icon slot 实现选中态。

### JSON

```json
{
  "usingComponents": {
    "van-radio": "@vant/weapp/radio/index",
    "van-radio-group": "@vant/weapp/radio-group/index",
    "van-cell": "@vant/weapp/cell/index",
    "van-cell-group": "@vant/weapp/cell-group/index"
  }
}
```

### WXML

```xml
<van-radio-group value="{{ selected }}" bind:change="onRadioChange">
  <van-cell-group>
    <van-cell
      wx:for="{{ options }}"
      wx:key="value"
      title="{{ item.label }}"
      clickable
      data-value="{{ item.value }}"
      bind:click="onCellClick"
    >
      <van-radio
        slot="right-icon"
        name="{{ item.value }}"
        checked-color="#07c160"
      />
    </van-cell>
  </van-cell-group>
</van-radio-group>
```

### TypeScript

```typescript
Page({
  data: {
    selected: '',
    options: [
      { value: 'option_a', label: '选项 A' },
      { value: 'option_b', label: '选项 B' },
      { value: 'option_c', label: '选项 C' },
    ],
  },

  onRadioChange(e: WechatMiniprogram.CustomEvent<string>) {
    this.setData({ selected: e.detail })
  },

  // 点击 Cell 也能触发选中
  onCellClick(e: WechatMiniprogram.CustomEvent) {
    const value = e.currentTarget.dataset.value as string
    this.setData({ selected: value })
  },
})
```

### WXSS

```css
/* 通常无需额外样式，Cell 默认布局即可 */
```

---

## 模式 5：Checkbox-in-Cell 行内勾选

多选列表，使用 checkbox-group 配合 cell 实现行内勾选。

### JSON

```json
{
  "usingComponents": {
    "van-checkbox": "@vant/weapp/checkbox/index",
    "van-checkbox-group": "@vant/weapp/checkbox-group/index",
    "van-cell": "@vant/weapp/cell/index",
    "van-cell-group": "@vant/weapp/cell-group/index"
  }
}
```

### WXML

```xml
<van-checkbox-group value="{{ selectedList }}" bind:change="onCheckboxChange">
  <van-cell-group>
    <van-cell
      wx:for="{{ options }}"
      wx:key="value"
      title="{{ item.label }}"
      clickable
      data-value="{{ item.value }}"
      bind:click="onToggle"
    >
      <van-checkbox
        slot="right-icon"
        name="{{ item.value }}"
        checked-color="#07c160"
      />
    </van-cell>
  </van-cell-group>
</van-checkbox-group>
```

### TypeScript

```typescript
Page({
  data: {
    selectedList: [] as string[],
    options: [
      { value: 'item_a', label: '选项 A' },
      { value: 'item_b', label: '选项 B' },
      { value: 'item_c', label: '选项 C' },
    ],
  },

  onCheckboxChange(e: WechatMiniprogram.CustomEvent<string[]>) {
    this.setData({ selectedList: e.detail })
  },

  // 点击 Cell 切换勾选
  onToggle(e: WechatMiniprogram.CustomEvent) {
    const value = e.currentTarget.dataset.value as string
    const list = [...this.data.selectedList]
    const idx = list.indexOf(value)
    if (idx >= 0) {
      list.splice(idx, 1)
    } else {
      list.push(value)
    }
    this.setData({ selectedList: list })
  },
})
```

### WXSS

```css
/* 通常无需额外样式 */
```

---

## 模式 6：SwipeCell 左滑删除

列表项左滑露出操作按钮，点击执行删除等操作。

### JSON

```json
{
  "usingComponents": {
    "van-swipe-cell": "@vant/weapp/swipe-cell/index",
    "van-cell": "@vant/weapp/cell/index"
  }
}
```

### WXML

```xml
<view class="list">
  <van-swipe-cell
    wx:for="{{ list }}"
    wx:key="id"
    right-width="{{ 130 }}"
  >
    <!-- 主内容 -->
    <van-cell title="{{ item.name }}" value="{{ item.desc }}" />

    <!-- 右侧操作按钮 -->
    <view slot="right" class="swipe-actions">
      <view
        class="swipe-btn swipe-btn--edit"
        data-id="{{ item.id }}"
        bindtap="onEdit"
      >
        编辑
      </view>
      <view
        class="swipe-btn swipe-btn--delete"
        data-id="{{ item.id }}"
        bindtap="onDelete"
      >
        删除
      </view>
    </view>
  </van-swipe-cell>
</view>
```

### TypeScript

```typescript
import Dialog from '@vant/weapp/dialog/dialog'

interface ListItem {
  id: string
  name: string
  desc: string
}

Page({
  data: {
    list: [
      { id: '1', name: '项目一', desc: '描述信息' },
      { id: '2', name: '项目二', desc: '描述信息' },
    ] as ListItem[],
  },

  onEdit(e: WechatMiniprogram.CustomEvent) {
    const id = e.currentTarget.dataset.id as string
    wx.navigateTo({ url: `/pages/edit/index?id=${id}` })
  },

  async onDelete(e: WechatMiniprogram.CustomEvent) {
    const id = e.currentTarget.dataset.id as string
    try {
      await Dialog.confirm({ title: '提示', message: '确定删除该项目？' })
      const list = this.data.list.filter((item) => item.id !== id)
      this.setData({ list })
    } catch {
      // 取消删除
    }
  },
})
```

### WXSS

```css
.swipe-actions {
  display: flex;
  height: 100%;
}
.swipe-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 65px; /* right-width 单位为 px，按钮宽度需匹配 */
  height: 100%;
  color: #fff;
  font-size: 26rpx;
}
.swipe-btn--edit {
  background: #07c160;
}
.swipe-btn--delete {
  background: #ee0a24;
}
```

---

## 模式 7：Calendar + Picker 日期时间组合

日历选择日期 + Picker 选择时间，组合得到完整日期时间。

### JSON

```json
{
  "usingComponents": {
    "van-cell": "@vant/weapp/cell/index",
    "van-calendar": "@vant/weapp/calendar/index",
    "van-popup": "@vant/weapp/popup/index",
    "van-picker": "@vant/weapp/picker/index"
  }
}
```

### WXML

```xml
<!-- 日期选择 -->
<van-cell
  title="选择日期"
  value="{{ dateLabel || '请选择' }}"
  is-link
  bind:click="onOpenCalendar"
/>
<van-calendar
  show="{{ showCalendar }}"
  type="single"
  min-date="{{ minDate }}"
  max-date="{{ maxDate }}"
  bind:close="onCloseCalendar"
  bind:confirm="onConfirmDate"
/>

<!-- 时间选择 -->
<van-cell
  title="选择时间"
  value="{{ timeLabel || '请选择' }}"
  is-link
  bind:click="onOpenTimePicker"
/>
<van-popup
  show="{{ showTimePicker }}"
  position="bottom"
  round
  bind:close="onCloseTimePicker"
>
  <van-picker
    columns="{{ timeColumns }}"
    bind:confirm="onConfirmTime"
    bind:cancel="onCloseTimePicker"
    show-toolbar
    title="选择时间"
  />
</van-popup>
```

### TypeScript

```typescript
/** ⚠️ Calendar confirm 返回的是 Date 对象，不是字符串！ */
Page({
  data: {
    showCalendar: false,
    showTimePicker: false,
    dateLabel: '',
    timeLabel: '',
    selectedDate: '', // YYYY-MM-DD
    selectedTime: '', // HH:mm
    minDate: new Date().getTime(),
    maxDate: new Date(Date.now() + 90 * 24 * 3600 * 1000).getTime(),
    timeColumns: [
      {
        values: Array.from({ length: 13 }, (_, i) => String(i + 8).padStart(2, '0')),
      },
      {
        values: ['00', '15', '30', '45'],
      },
    ],
  },

  // --- 日期 ---
  onOpenCalendar() {
    this.setData({ showCalendar: true })
  },
  onCloseCalendar() {
    this.setData({ showCalendar: false })
  },
  onConfirmDate(e: WechatMiniprogram.CustomEvent<Date>) {
    // ⚠️ e.detail 是 Date 对象
    const date = e.detail
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    const dateStr = `${y}-${m}-${d}`

    this.setData({
      selectedDate: dateStr,
      dateLabel: dateStr,
      showCalendar: false,
    })
  },

  // --- 时间 ---
  onOpenTimePicker() {
    this.setData({ showTimePicker: true })
  },
  onCloseTimePicker() {
    this.setData({ showTimePicker: false })
  },
  onConfirmTime(e: WechatMiniprogram.CustomEvent<{ value: string[]; index: number[] }>) {
    const [hour, minute] = e.detail.value
    const timeStr = `${hour}:${minute}`
    this.setData({
      selectedTime: timeStr,
      timeLabel: timeStr,
      showTimePicker: false,
    })
  },
})
```

### WXSS

```css
/* 通常无需额外样式，Cell 默认布局即可 */
```

### Gotcha

- **Calendar `bind:confirm` 返回 Date 对象**，不是字符串。必须手动格式化。
- **Calendar `min-date`/`max-date` 需要时间戳**（毫秒），不是 Date 对象。
- **Picker `bind:confirm` 的 `e.detail.value`** 是选中值数组（多列时），不是单个值。

---

## 模式 8：侧边栏 + 商品网格（van-sidebar + scroll-view）

左侧固定分类侧边栏 + 右侧可滚动商品网格，常用于商品分类浏览页。

### JSON

```json
{
  "usingComponents": {
    "van-sidebar": "@vant/weapp/sidebar/index",
    "van-sidebar-item": "@vant/weapp/sidebar-item/index",
    "van-card": "@vant/weapp/card/index"
  }
}
```

### WXML

```xml
<view class="category-page">
  <!-- 左侧分类 -->
  <view class="category-sidebar">
    <van-sidebar active-key="{{ activeCategory }}" bind:change="onCategoryChange">
      <van-sidebar-item
        wx:for="{{ categories }}"
        wx:key="id"
        title="{{ item.name }}"
      />
    </van-sidebar>
  </view>

  <!-- 右侧商品 -->
  <scroll-view
    class="category-content"
    scroll-y
    enhanced
    show-scrollbar="{{ false }}"
  >
    <view class="product-grid">
      <view
        wx:for="{{ currentProducts }}"
        wx:key="id"
        class="product-item"
        data-id="{{ item.id }}"
        bindtap="onProductTap"
      >
        <image class="product-img" src="{{ item.image }}" mode="aspectFill" />
        <text class="product-name">{{ item.name }}</text>
        <text class="product-price">¥{{ item.price }}</text>
      </view>
    </view>
  </scroll-view>
</view>
```

### WXSS

```css
.category-page {
  display: flex;
  height: 100vh;
}
.category-sidebar {
  width: 160rpx;
  flex-shrink: 0;
}
.category-content {
  flex: 1;
  height: 100vh;
}
.product-grid {
  display: flex;
  flex-wrap: wrap;
  padding: 16rpx;
  gap: 16rpx;
}
.product-item {
  width: calc(50% - 8rpx);
  background: #fff;
  border-radius: 12rpx;
  overflow: hidden;
}
.product-img {
  width: 100%;
  height: 200rpx;
}
.product-name {
  display: block;
  padding: 8rpx 12rpx 0;
  font-size: 26rpx;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.product-price {
  display: block;
  padding: 4rpx 12rpx 12rpx;
  font-size: 28rpx;
  color: var(--color-primary);
  font-weight: 600;
}
```

### TypeScript

```typescript
Page({
  data: {
    activeCategory: 0,
    categories: [] as Array<{ id: string; name: string }>,
    productsByCategory: {} as Record<string, any[]>,
    currentProducts: [] as any[],
  },

  onCategoryChange(e: WechatMiniprogram.CustomEvent<number>) {
    const idx = e.detail
    this.setData({ activeCategory: idx })
    this.loadCategoryProducts(idx)
  },

  loadCategoryProducts(idx: number) {
    const catId = this.data.categories[idx]?.id
    const products = this.data.productsByCategory[catId] || []
    this.setData({ currentProducts: products })
  },

  onProductTap(e: WechatMiniprogram.CustomEvent) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/product-detail/product-detail?id=${id}` })
  },
})
```

**关键点：**
- 左侧 `van-sidebar` 固定宽度 `160rpx`，右侧 `flex: 1` 填充剩余空间
- 右侧用 `scroll-view` 独立滚动，不与左侧联动
- 商品网格使用 `flex-wrap` 实现两列布局

---

## 通用交互陷阱

### stopPropagation 嵌套列表按钮

在 `van-cell` / `van-card` 等列表项内嵌操作按钮时，按钮点击会冒泡触发卡片的点击事件。用 `catchtap`（替代 `bindtap`）阻止冒泡：

```xml
<!-- ❌ bindtap 会冒泡，点击按钮同时触发 onCardTap -->
<van-cell bindtap="onCardTap" data-id="{{ item.id }}">
  <van-button slot="right-icon" size="small" bindtap="onDelete" data-id="{{ item.id }}">
    删除
  </van-button>
</van-cell>

<!-- ✅ catchtap 阻止冒泡 -->
<van-cell bindtap="onCardTap" data-id="{{ item.id }}">
  <van-button slot="right-icon" size="small" catchtap="onDelete" data-id="{{ item.id }}">
    删除
  </van-button>
</van-cell>
```

**JS 中也可以用 `stopPropagation`：**

```typescript
onDelete(e: WechatMiniprogram.CustomEvent) {
  // 如果用 bindtap 而非 catchtap，可在 handler 中手动阻止
  // 但 catchtap 更简洁直接
  const id = e.currentTarget.dataset.id
  // ... 删除逻辑
}
```

**常见场景：**
- 列表项右侧的编辑/删除按钮
- 卡片内的收藏/分享图标
- SwipeCell 展开状态下的操作按钮与卡片整体点击冲突
