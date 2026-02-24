# 组件开发模式

WXML 原生组件用法、自定义组件完整示例与事件通信模式。

主文件：[SKILL.md](../SKILL.md)

---

## 条件渲染

```xml
<!-- wx:if / wx:elif / wx:else -->
<view wx:if="{{status === '已支付'}}">
  <text class="status-paid">已支付</text>
</view>
<view wx:elif="{{status === '待支付'}}">
  <text class="status-pending">待支付</text>
</view>
<view wx:else>
  <text class="status-other">{{status}}</text>
</view>

<!-- hidden（频繁切换时使用，避免重复创建） -->
<view hidden="{{!showPanel}}">面板内容</view>
```

## 列表渲染

```xml
<!-- wx:for + wx:key -->
<view class="list">
  <view class="list-item" wx:for="{{orderList}}" wx:key="_id">
    <text class="item-name">{{item.customerName}}</text>
    <text class="item-price">¥{{item.totalAmount}}</text>
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

## 自定义组件完整示例：order-card

### 目录结构

```
components/
└── order-card/
    ├── order-card.wxml
    ├── order-card.wxss
    ├── order-card.ts
    └── order-card.json
```

### order-card.json

```json
{
  "component": true,
  "usingComponents": {}
}
```

### order-card.ts

```typescript
Component({
  properties: {
    order: {
      type: Object,
      value: {}
    },
    showActions: {
      type: Boolean,
      value: true
    }
  },

  observers: {
    'order.status': function(status) {
      this.setData({
        statusText: this.getStatusText(status)
      })
    }
  },

  data: {
    statusText: ''
  },

  lifetimes: {
    attached() {
      // 组件创建
    },
    detached() {
      // 组件销毁
    }
  },

  methods: {
    getStatusText(status: string): string {
      const map: Record<string, string> = {
        '待支付': '等待付款',
        '已支付': '已完成支付',
        '已取消': '订单已取消'
      }
      return map[status] || status
    },

    handleTap() {
      this.triggerEvent('tap', { orderId: this.data.order._id })
    }
  }
})
```

### order-card.wxml

```xml
<view class="order-card" bindtap="handleTap">
  <view class="card-header">
    <text class="order-no">{{order.orderNo}}</text>
    <text class="status">{{statusText}}</text>
  </view>
  <view class="card-body">
    <text class="customer">{{order.customerName}}</text>
    <text class="amount">¥{{order.totalAmount}}</text>
  </view>
  <view wx:if="{{showActions}}" class="card-footer">
    <slot></slot>
  </view>
</view>
```

### 使用组件

```json
// pages/orders/orders.json
{
  "usingComponents": {
    "order-card": "/components/order-card/order-card"
  }
}
```

```xml
<!-- pages/orders/orders.wxml -->
<order-card
  wx:for="{{orders}}"
  wx:key="_id"
  order="{{item}}"
  bind:tap="handleOrderTap"
/>
```

性能提示：全局注册的组件（在 `app.json` 的 `usingComponents` 中声明）会影响所有页面的启动性能。仅将高频使用的公共组件注册为全局组件，其他组件在页面级 `page.json` 中按需注册。

---

## 事件通信

```typescript
// 子组件触发事件
this.triggerEvent('confirm', { id: this.data.order._id })

// 父页面监听事件
// <order-card bind:confirm="handleConfirm" />
handleConfirm(e: WechatMiniprogram.CustomEvent) {
  const { id } = e.detail
}
```
