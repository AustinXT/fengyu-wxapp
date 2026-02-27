---
name: vant-weapp
description: >
  提供 Vant Weapp 微信小程序 UI 组件库的复合模式指导与陷阱避坑参考。聚焦高频复合模式 （Popup 选择器、Tab
  列表、Radio/Checkbox-in-Cell 等），包含 TypeScript 事件类型 速查和关键错误对比。当用户请求使用 Vant
  组件开发小程序页面时激活。 请勿用于纯逻辑/后端开发（请使用 wx-coding 技能）。
metadata:
  author: nvoyager
  title: Vant Weapp 模式驱动实战指南
  version: 1.0.2
  description_zh: Vant Weapp 微信小程序 UI 组件库复合模式指南，涵盖 Popup 选择器、Tab 列表、事件类型速查与常见陷阱。
triggers:
  keywords:
    - vant
    - van-button
    - van-dialog
    - van-popup
    - van-cell
    - van-tabs
    - van-field
    - van-picker
    - van-calendar
    - van-radio
    - van-checkbox
    - van-swipe-cell
    - van-submit-bar
    - UI组件
    - 选择器弹窗
    - 底部弹出选择
    - 标签页筛选
    - 滑动删除
    - 提交订单栏
---

# Vant Weapp 模式驱动实战指南

## 概述

Vant Weapp 是有赞开源的微信小程序 UI 组件库。本技能以**复合模式**为核心，指导如何将多个组件组合成实际开发中常用的交互模式，而非逐个介绍单组件 API。

## 何时使用

- 使用 Vant 组件构建小程序页面
- 需要复合交互模式（底部选择器、Tab 筛选列表、行内选择等）
- 自定义 Vant 组件主题样式
- TypeScript 项目中标注 Vant 事件类型

## 不适用场景

- 纯原生组件开发 → 参考 `wx-coding`
- 使用其他 UI 库（WeUI 等）
- UI 设计规范 → 参考 `wx-ui-design`

---

## 快速决策框架

根据交互需求选择组件/模式：

```text
需要什么交互？
├── 用户输入
│   ├── 文本输入 → Field
│   ├── 从固定选项选一个
│   │   ├── 选项 ≤ 5 个 → Radio-in-Cell（模式 4）
│   │   ├── 选项 > 5 个 → Popup 底部选择器（模式 3）
│   │   └── 日期/时间 → Calendar + Picker（模式 7）
│   ├── 从选项选多个 → Checkbox-in-Cell（模式 5）
│   └── 数量调整 → Stepper
├── 数据展示
│   ├── 加载状态 → 加载三态（模式 1）
│   ├── 分类列表 → Tab 筛选列表（模式 2）
│   ├── 可操作列表 → SwipeCell 左滑删除（模式 6）
│   └── 商品信息 → Card
├── 用户操作
│   ├── 确认/取消 → Dialog
│   ├── 多个操作 → ActionSheet
│   └── 轻提示 → Toast
└── 导航
    ├── 顶部分类 → Tabs
    ├── 侧边分类 → Sidebar
    └── 页面导航 → NavBar
```

---

## 必备前置步骤

### 安装

```bash
npm i @vant/weapp -S --production
```

安装后在微信开发者工具中：**工具 → 构建 npm**。

### 组件注册

每个使用 Vant 的页面/组件，必须在 `.json` 中声明。路径格式：`@vant/weapp/{组件名}/index`

```json
{
  "usingComponents": {
    "van-button": "@vant/weapp/button/index",
    "van-cell": "@vant/weapp/cell/index"
  }
}
```

> 完整注册路径表见 [references/components.md](references/components.md)。

### 命令式组件节点（必须！）

Toast、Dialog、Notify 是**命令式调用**，但**必须在 WXML 中放置对应节点**，否则无任何反应：

```xml
<!-- ✅ 正确：WXML 中有节点 -->
<van-toast id="van-toast" />
<van-dialog id="van-dialog" />

<!-- JS/TS 中调用 -->
```

```typescript
import Toast from '@vant/weapp/toast/toast'
import Dialog from '@vant/weapp/dialog/dialog'

Toast('提示内容')
Toast.loading({ message: '加载中...', forbidClick: true })

Dialog.confirm({ title: '提示', message: '确定删除？' })
  .then(() => { /* 确认 */ })
  .catch(() => { /* 取消 */ })
```

对比声明式组件（Popup 等）：不需要 JS import，直接用属性控制：

```xml
<!-- 声明式：用 show 属性控制 -->
<van-popup show="{{ showPopup }}" position="bottom" bind:close="onClose">
  内容
</van-popup>
```

---

## 复合模式

> 以下为精简版。完整可复制代码见 [references/patterns.md](references/patterns.md)。

### 模式 1：加载三态（Skeleton → Empty → Content）

页面加载的标准三态切换。

```xml
<van-skeleton title row="3" loading="{{ loading }}">
  <van-empty wx:if="{{ !list.length }}" description="暂无数据">
    <van-button slot="bottom" round type="primary" size="small" bind:click="onRetry">
      重新加载
    </van-button>
  </van-empty>
  <view wx:else>
    <view wx:for="{{ list }}" wx:key="id">{{ item.name }}</view>
  </view>
</van-skeleton>
```

**要点**：Skeleton 的 `loading` 属性控制骨架屏/内容切换；Empty 在数据为空时展示。

### 模式 2：Tab 筛选列表（sticky + swipeable）

顶部标签切换不同列表，支持粘性定位和手势滑动。

```xml
<van-tabs active="{{ activeTab }}" sticky swipeable bind:change="onTabChange">
  <van-tab wx:for="{{ tabs }}" wx:key="name" title="{{ item.title }}" name="{{ item.name }}">
    <van-skeleton title row="3" loading="{{ item.loading }}">
      <van-empty wx:if="{{ !item.list.length }}" description="暂无数据" />
      <view wx:else>
        <!-- 列表内容 -->
      </view>
    </van-skeleton>
  </van-tab>
</van-tabs>
```

```typescript
onTabChange(e: WechatMiniprogram.CustomEvent<{ name: string }>) {
  const name = e.detail.name
  this.setData({ activeTab: name })
  // 首次切换时加载数据
}
```

**要点**：用 `name` 属性标识 Tab（而非索引），便于维护。每个 Tab 独立维护 loading/list 状态。

### 模式 3：Popup 底部选择器

不使用 Picker 的自定义选择列表（适合带图标、多行的选项）。

```xml
<van-cell title="选择类型" value="{{ selectedLabel || '请选择' }}" is-link bind:click="onOpenPicker" />

<van-popup show="{{ showPicker }}" position="bottom" round safe-area-inset-bottom bind:close="onClosePicker">
  <view class="picker-header">
    <text class="picker-title">选择类型</text>
  </view>
  <view
    wx:for="{{ options }}" wx:key="value"
    class="picker-option {{ selected === item.value ? 'picker-option--active' : '' }}"
    data-value="{{ item.value }}" data-label="{{ item.label }}"
    bindtap="onSelectOption"
  >
    <text>{{ item.label }}</text>
    <van-icon wx:if="{{ selected === item.value }}" name="success" color="#07c160" />
  </view>
</van-popup>
```

```typescript
onSelectOption(e: WechatMiniprogram.CustomEvent) {
  const { value, label } = e.currentTarget.dataset as { value: string; label: string }
  this.setData({ selected: value, selectedLabel: label, showPicker: false })
}
```

**要点**：用 `data-*` 属性传参而非闭包；`bindtap`（原生事件）而非 `bind:click`。

### 模式 4：Radio-in-Cell 排他选择

```xml
<van-radio-group value="{{ selected }}" bind:change="onRadioChange">
  <van-cell-group>
    <van-cell wx:for="{{ options }}" wx:key="value"
      title="{{ item.label }}" clickable
      data-value="{{ item.value }}" bind:click="onCellClick"
    >
      <van-radio slot="right-icon" name="{{ item.value }}" checked-color="#07c160" />
    </van-cell>
  </van-cell-group>
</van-radio-group>
```

**要点**：Cell 的 `clickable` 属性提供点击反馈；同时绑定 Cell `bind:click` 和 RadioGroup `bind:change`，确保点击整行都能选中。

### 模式 5：Checkbox-in-Cell 行内勾选

```xml
<van-checkbox-group value="{{ selectedList }}" bind:change="onCheckboxChange">
  <van-cell-group>
    <van-cell wx:for="{{ options }}" wx:key="value"
      title="{{ item.label }}" clickable
      data-value="{{ item.value }}" bind:click="onToggle"
    >
      <van-checkbox slot="right-icon" name="{{ item.value }}" checked-color="#07c160" />
    </van-cell>
  </van-cell-group>
</van-checkbox-group>
```

**要点**：结构与 Radio-in-Cell 几乎相同，区别是 `value` 为数组、用 `checkbox` 替代 `radio`。Cell `bind:click` 需手动切换数组。也可用 `slot="title"` 把 checkbox 放在标题位置（适合协议勾选等场景）。

### 模式 6：SwipeCell 左滑删除

```xml
<van-swipe-cell wx:for="{{ list }}" wx:key="id" right-width="{{ 130 }}">
  <van-cell title="{{ item.name }}" value="{{ item.desc }}" />
  <view slot="right" class="swipe-actions">
    <view class="swipe-btn swipe-btn--delete" data-id="{{ item.id }}" bindtap="onDelete">
      删除
    </view>
  </view>
</van-swipe-cell>
```

**要点**：`right-width` 单位为 px（不是 rpx）；slot="right" 内用原生 `bindtap`；配合 Dialog.confirm 做二次确认。

### 模式 7：Calendar + Picker 日期时间组合

```xml
<van-cell title="日期" value="{{ dateLabel || '请选择' }}" is-link bind:click="onOpenCalendar" />
<van-calendar show="{{ showCalendar }}" bind:confirm="onConfirmDate" bind:close="onCloseCalendar" />

<van-cell title="时间" value="{{ timeLabel || '请选择' }}" is-link bind:click="onOpenTimePicker" />
<van-popup show="{{ showTimePicker }}" position="bottom" round bind:close="onCloseTimePicker">
  <van-picker columns="{{ timeColumns }}" show-toolbar title="选择时间"
    bind:confirm="onConfirmTime" bind:cancel="onCloseTimePicker" />
</van-popup>
```

```typescript
onConfirmDate(e: WechatMiniprogram.CustomEvent<Date>) {
  // ⚠️ e.detail 是 Date 对象，不是字符串！
  const date = e.detail
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  this.setData({ selectedDate: dateStr, dateLabel: dateStr, showCalendar: false })
}
```

**要点**：Calendar 返回 **Date 对象**；`min-date`/`max-date` 需传**毫秒时间戳**。

---

## 主题定制速查

### CSS 变量（推荐）

在 `app.wxss` 或局部 WXSS 中覆盖：

```css
page {
  --button-border-radius: 10rpx;
  --cell-large-title-font-size: 32rpx;
}
```

### 外部样式类

部分组件支持 `custom-class`、`title-class` 等：

```xml
<van-cell custom-class="my-cell" title-class="my-cell-title" title="标题" />
```

> Vant 组件启用了样式隔离，普通选择器无法穿透。只能通过 CSS 变量或外部样式类覆盖。

---

## TypeScript 事件类型速查

| 组件 | 事件 | e.detail | 类型签名 |
|------|------|----------|----------|
| Tabs | `bind:change` | `{ name, title, index }` | `CustomEvent<{ name: string; title: string; index: number }>` |
| Picker | `bind:confirm` | `{ value, index }` | `CustomEvent<{ value: string \| string[]; index: number \| number[] }>` |
| Calendar | `bind:confirm` | Date 对象 ⚠️ | `CustomEvent<Date>` |
| RadioGroup | `bind:change` | 选中的 name | `CustomEvent<string>` |
| CheckboxGroup | `bind:change` | name 数组 | `CustomEvent<string[]>` |
| Field | `bind:change` | 输入值 | `CustomEvent<string>` |
| Stepper | `bind:change` | 当前值 | `CustomEvent<number>` |
| SwipeCell | `bind:open` | `{ position, name }` | `CustomEvent<{ position: 'left' \| 'right'; name: string }>` |
| ActionSheet | `bind:select` | 选项对象 | `CustomEvent<{ name: string; subname?: string }>` |

> 完整类型声明和工具类型见 [references/typescript.md](references/typescript.md)。

---

## 关键规则与常见错误

### 1. 命令式节点遗漏

```xml
<!-- ❌ 错误：只在 JS 中调用，WXML 无节点 → 无反应 -->
<script>
import Toast from '@vant/weapp/toast/toast'
Toast('提示')
</script>

<!-- ✅ 正确：WXML 中必须有节点 -->
<van-toast id="van-toast" />
```

### 2. SubmitBar 价格单位

```typescript
// ❌ 错误：传入元
this.setData({ price: 99.9 })  // 显示 ¥0.10

// ✅ 正确：传入分
this.setData({ price: 9990 })  // 显示 ¥99.90
```

`price` 属性单位是**分**，不是元。

### 3. Calendar 返回值类型

```typescript
// ❌ 错误：当字符串用
onConfirmDate(e: any) {
  this.setData({ date: e.detail })  // date 是 Date 对象，模板中显示 [object Object]
}

// ✅ 正确：格式化 Date 对象
onConfirmDate(e: WechatMiniprogram.CustomEvent<Date>) {
  const d = e.detail
  this.setData({ date: `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` })
}
```

### 4. model:value 基础库要求

```xml
<!-- ❌ 在低版本基础库中无效 -->
<van-field model:value="{{ name }}" />

<!-- ✅ 兼容写法 -->
<van-field value="{{ name }}" bind:change="onNameChange" />
```

`model:value` 双向绑定需要基础库 >= 2.9.3。

### 5. SwipeCell right-width 单位

```xml
<!-- ❌ 错误：rpx 单位 -->
<van-swipe-cell right-width="{{ 130 }}rpx">

<!-- ✅ 正确：px 单位（数字即可） -->
<van-swipe-cell right-width="{{ 65 }}">
```

`right-width` / `left-width` 单位是 **px**，不是 rpx。

### 6. Popup 底部安全区

```xml
<!-- ❌ 遗漏：iPhone 底部内容被遮挡 -->
<van-popup show="{{ show }}" position="bottom">

<!-- ✅ 正确：加上底部安全区 -->
<van-popup show="{{ show }}" position="bottom" safe-area-inset-bottom>
```

`position="bottom"` 的 Popup 务必加 `safe-area-inset-bottom`。

### 7. 事件前缀混淆

```xml
<!-- ❌ 错误：Vant 事件用了原生前缀 -->
<van-tabs bindchange="onTabChange" />

<!-- ✅ 正确：Vant 事件用 bind: 带冒号 -->
<van-tabs bind:change="onTabChange" />

<!-- 注意：Popup 内自定义元素用原生 bindtap -->
<view bindtap="onSelect">选项</view>
```

Vant 组件事件用 `bind:xxx`（带冒号）；Popup/SwipeCell 内的原生 view 用 `bindtap`（无冒号）。

### 常见错误速查

| 现象 | 原因 | 修正 |
|------|------|------|
| Toast/Dialog 无反应 | WXML 缺节点 | 添加 `<van-toast id="van-toast" />` |
| 组件不显示 | 未注册 | 在 `.json` 的 `usingComponents` 中声明 |
| 样式不生效 | 样式隔离 | 用 CSS 变量或 `custom-class` |
| 构建报错 | 未构建 npm | 微信开发者工具 → 工具 → 构建 npm |
| 价格显示异常 | SubmitBar price 单位为分 | 传入分值（100 = ¥1.00） |
| 日期显示 `[object Object]` | Calendar 返回 Date 对象 | 手动格式化 |

---

## 参考资源

- 复合模式完整代码：[references/patterns.md](references/patterns.md)
- 组件 API 速查：[references/components.md](references/components.md)
- TypeScript 类型声明：[references/typescript.md](references/typescript.md)
