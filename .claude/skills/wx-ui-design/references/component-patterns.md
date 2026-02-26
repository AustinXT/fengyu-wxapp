# 组件开发模式

WXML 原生组件用法、样式隔离、自定义组件完整示例、Vant 集成决策与事件通信模式。

主文件：[SKILL.md](../SKILL.md)

---

## 条件渲染

```xml
<!-- wx:if / wx:elif / wx:else -->
<view wx:if="{{status === 'paid'}}">
  <text class="status-paid">已支付</text>
</view>
<view wx:elif="{{status === 'pending'}}">
  <text class="status-pending">待支付</text>
</view>
<view wx:else>
  <text class="status-other">{{status}}</text>
</view>

<!-- hidden（频繁切换时使用，避免重复创建） -->
<view hidden="{{!showPanel}}">面板内容</view>
```

**wx:if vs hidden 选择**：`wx:if` 条件为 false 时组件不渲染（懒加载），`hidden` 始终渲染但隐藏（display:none）。频繁切换用 `hidden`，条件少变用 `wx:if`。

## 列表渲染

```xml
<!-- wx:for + wx:key -->
<view class="list">
  <view class="list-item" wx:for="{{dataList}}" wx:key="id">
    <text class="item-name">{{item.name}}</text>
    <text class="item-value">{{item.value}}</text>
  </view>
</view>

<!-- block 包装器（不渲染 DOM） -->
<block wx:for="{{items}}" wx:key="id">
  <view>{{item.name}}</view>
  <view>{{item.desc}}</view>
</block>
```

## 数据绑定

```xml
<!-- 单向绑定 -->
<text>{{userName}}</text>
<image src="{{avatarUrl}}" mode="aspectFill" />

<!-- 双向绑定（基础库 2.9.3+） -->
<input model:value="{{inputValue}}" />

<!-- 属性绑定 -->
<view class="item {{isActive ? 'active' : ''}}">
  <text style="color: {{themeColor}};">文本</text>
</view>
```

---

## R4.1 样式隔离规范 [关键]

微信小程序自定义组件默认启用样式隔离。理解隔离模式是组件开发的关键。

### styleIsolation 模式

在组件 `.json` 或 `Component()` 构造器中配置：

```json
{
  "component": true,
  "styleIsolation": "isolated"
}
```

| 模式 | 行为 | 适用场景 |
|---|---|---|
| `isolated`（默认） | 组件内外样式互不影响 | 独立组件，不需要外部样式 |
| `apply-shared` | 页面/app.wxss 样式可进入组件，组件样式不外泄 | 需要继承全局主题的组件 |
| `shared` | 组件和页面样式互相影响 | 页面级组件，与页面紧密耦合 |

### 组件 WXSS 选择器限制

组件样式中**只能使用**：

```css
/* [正确] 类选择器 */
.my-component { }
.my-component .title { }

/* [正确] 伪元素 */
.my-component::before { }

/* [正确] :host 设置组件默认样式 */
:host {
  display: block;
  color: var(--color-text-primary);
}
```

**不能使用**（会被忽略或表现不稳定）：

```css
/* [错误] ID 选择器 */
#my-id { }

/* [错误] 属性选择器 */
[data-type="active"] { }

/* [错误] 标签名选择器 */
view { }
text { }
```

### externalClasses 外部样式类

允许组件使用者从外部传入样式类：

```typescript
// info-card.ts
Component({
  externalClasses: ['card-class', 'title-class'],
  // ...
})
```

```xml
<!-- info-card.wxml -->
<view class="info-card card-class">
  <text class="title title-class">{{title}}</text>
</view>
```

```xml
<!-- 使用时 -->
<info-card card-class="custom-card" title-class="custom-title" />
```

### virtualHost 虚拟节点

默认情况下，自定义组件有一个包裹节点，可能影响 flex 布局。启用虚拟节点可让组件"消失"：

```json
{
  "component": true,
  "virtualHost": true
}
```

适用场景：组件在 flex 容器中作为子项，不希望多一层 wrapper 影响布局。

---

## R4.2 多 Slot 模式 [高]

默认组件只支持一个 `<slot>`。启用多 slot：

### 组件配置

```typescript
// info-card.ts
Component({
  options: {
    multipleSlots: true
  },
  properties: {
    title: String,
    subtitle: String
  }
})
```

### 组件模板

```xml
<!-- info-card.wxml -->
<view class="info-card">
  <view class="card-header">
    <view class="header-left">
      <text class="title">{{title}}</text>
      <text wx:if="{{subtitle}}" class="subtitle">{{subtitle}}</text>
    </view>
    <slot name="header-extra"></slot>
  </view>
  <view class="card-body">
    <slot></slot>
  </view>
  <view class="card-footer">
    <slot name="footer"></slot>
  </view>
</view>
```

### 使用

```xml
<info-card title="卡片标题" subtitle="副标题">
  <!-- 默认 slot -->
  <view>卡片主要内容</view>

  <!-- 命名 slot -->
  <view slot="header-extra">
    <van-tag type="success">标签</van-tag>
  </view>
  <view slot="footer">
    <van-button size="small">操作</van-button>
  </view>
</info-card>
```

---

## 自定义组件完整示例：info-card

一个通用的信息卡片组件，展示标题/副标题/状态/值/操作槽位。

### 目录结构

```
components/
└── info-card/
    ├── info-card.wxml
    ├── info-card.wxss
    ├── info-card.ts
    └── info-card.json
```

### info-card.json

```json
{
  "component": true,
  "styleIsolation": "apply-shared"
}
```

### info-card.ts

```typescript
Component({
  options: {
    multipleSlots: true
  },

  externalClasses: ['card-class'],

  properties: {
    title: {
      type: String,
      value: ''
    },
    subtitle: {
      type: String,
      value: ''
    },
    status: {
      type: String,
      value: ''
    },
    statusType: {
      type: String,
      value: 'default'  // default | success | warning | danger
    },
    value: {
      type: String,
      value: ''
    }
  },

  lifetimes: {
    attached() {
      // 组件创建
    },
    detached() {
      // 组件销毁，清理定时器等
    }
  },

  methods: {
    handleTap() {
      this.triggerEvent('tap', { title: this.data.title })
    }
  }
})
```

### info-card.wxml

```xml
<view class="info-card card-class" bindtap="handleTap">
  <view class="card-header">
    <view class="header-info">
      <text class="card-title">{{title}}</text>
      <text wx:if="{{subtitle}}" class="card-subtitle">{{subtitle}}</text>
    </view>
    <van-tag wx:if="{{status}}" type="{{statusType}}">{{status}}</van-tag>
    <slot name="header-extra"></slot>
  </view>

  <view class="card-body">
    <slot></slot>
  </view>

  <view wx:if="{{value}}" class="card-value">
    <text>{{value}}</text>
  </view>

  <view class="card-footer">
    <slot name="footer"></slot>
  </view>
</view>
```

### info-card.wxss

```css
.info-card {
  background: var(--color-bg-card, #ffffff);
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
}

.card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}

.header-info {
  flex: 1;
  min-width: 0;
}

.card-title {
  font-size: 30rpx;
  font-weight: 600;
  color: var(--color-text-primary, #333333);
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-subtitle {
  font-size: 24rpx;
  color: var(--color-text-secondary, #666666);
  margin-top: 4rpx;
  display: block;
}

.card-body {
  margin-top: 16rpx;
}

.card-value {
  font-size: 36rpx;
  font-weight: 700;
  color: var(--color-primary);
  margin-top: 12rpx;
}

.card-footer {
  margin-top: 16rpx;
}
```

### 使用组件

```json
// pages/list/list.json
{
  "usingComponents": {
    "info-card": "/components/info-card/info-card"
  }
}
```

```xml
<!-- pages/list/list.wxml -->
<info-card
  wx:for="{{items}}"
  wx:key="id"
  title="{{item.title}}"
  subtitle="{{item.subtitle}}"
  status="{{item.statusText}}"
  statusType="{{item.statusType}}"
  value="{{item.displayValue}}"
  bind:tap="handleItemTap"
>
  <view slot="footer">
    <van-button size="small" type="primary">详情</van-button>
  </view>
</info-card>
```

性能提示：全局注册的组件（在 `app.json` 的 `usingComponents` 中声明）会影响所有页面的启动性能。仅将高频使用的公共组件注册为全局组件，其他组件在页面级 `page.json` 中按需注册。

---

## Vant Weapp + 原生组件决策表

| 场景 | 选择 | 原因 |
|---|---|---|
| 容器、布局 | 原生 `view` | 最轻量，无额外开销 |
| 文本展示 | 原生 `text` | 支持长按选中，纯展示无需组件 |
| 图片 | 原生 `image` | 原生就够，Vant 无 image 组件 |
| 按钮 | `van-button` | 样式丰富，loading/disabled 内建 |
| 输入框 | `van-field` | 统一的表单样式 + label + 错误提示 |
| 弹窗/面板 | `van-popup` | 原生无弹窗组件，必须用 Vant |
| 选择器 | `van-picker` + `van-popup` | 移动端交互规范 |
| Toast/Dialog | `van-toast` / `van-dialog` | 比 `wx.showToast` 更灵活可控 |
| 标签页 | `van-tabs` | sticky/swipe 等高级功能 |
| 空状态 | `van-empty` | 内置插图 + 描述 + 操作按钮 |
| 列表项 | `van-cell` | 统一高度/箭头/icon，含分组 |
| 简单分隔/间距 | 原生 `view` + CSS | 不需要引入组件 |
| 滚动容器 | 原生 `scroll-view` | Vant 无替代 |

**原则**：纯布局和文本用原生，交互组件和复杂 UI 模式用 Vant。

---

## 事件通信

```typescript
// 子组件触发事件
this.triggerEvent('confirm', { id: this.data.selectedId })

// 父页面监听事件
// <info-card bind:confirm="handleConfirm" />
handleConfirm(e: WechatMiniprogram.CustomEvent) {
  const { id } = e.detail
}
```

### 事件冒泡控制

```xml
<!-- bind: 冒泡 -->
<view bind:tap="handleTap">会冒泡</view>

<!-- catch: 阻止冒泡 -->
<view catch:tap="handleTap">阻止冒泡</view>

<!-- mut-bind: 互斥事件绑定（基础库 2.8.2+） -->
<view mut-bind:tap="handleTap">互斥</view>
```

### 事件对象关键属性

```typescript
handleTap(e: WechatMiniprogram.CustomEvent) {
  e.target        // 触发事件的源组件
  e.currentTarget // 绑定事件的当前组件
  e.detail        // 自定义事件携带的数据
  e.currentTarget.dataset  // data-xxx 属性集合
  e.mark          // mark:xxx 属性集合（基础库 2.7.1+）
}
```

---

## R4.3 组件开发检查清单 [高]

新建自定义组件时逐项确认：

- [ ] `.json` 中声明了 `"component": true`
- [ ] 选择了合适的 `styleIsolation` 模式
- [ ] `properties` 定义了类型和默认值
- [ ] `lifetimes.detached` 中清理了定时器/监听器
- [ ] 需要多 slot 时配置了 `options.multipleSlots: true`
- [ ] 在 flex 容器中使用时考虑了 `virtualHost`
- [ ] 事件使用 `triggerEvent` 而非直接操作父组件
- [ ] 在页面 `page.json` 的 `usingComponents` 中注册（非全局）
- [ ] 组件 WXSS 只使用了类选择器（无 ID/属性/标签名选择器）
- [ ] 使用 `externalClasses` 或 CSS 变量暴露可定制样式
