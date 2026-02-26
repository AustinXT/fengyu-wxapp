# 设计系统详细规范

配色方案、主题体系、状态色、价格排版、动效策略、空间构图的完整参考。

主文件：[SKILL.md](../SKILL.md)

---

## R2.1 CSS 变量主题体系 [关键]

### 完整变量定义模板

在 `app.wxss` 中集中管理所有设计令牌：

```css
page {
  /* === 品牌色（按项目替换） === */
  --color-primary: <your-brand-color>;
  --color-primary-light: <your-brand-light>;   /* 品牌色低饱和，用于背景 */
  --color-primary-dark: <your-brand-dark>;     /* 品牌色深色，用于点击态 */
  --color-accent: <your-accent-color>;         /* 强调色，少量点缀 */

  /* === 语义色 === */
  --color-success: #52C41A;
  --color-warning: #FAAD14;
  --color-error: #FF4D4F;
  --color-info: #1890FF;

  /* === 中性色阶梯 === */
  --color-text-primary: #333333;
  --color-text-secondary: #666666;
  --color-text-hint: #999999;
  --color-border: #E8E8E8;
  --color-divider: #F0F0F0;
  --color-bg-page: #F6F6F6;
  --color-bg-card: #FFFFFF;

  /* === 间距系统 === */
  --spacing-xs: 8rpx;
  --spacing-sm: 16rpx;
  --spacing-md: 24rpx;
  --spacing-lg: 32rpx;
  --spacing-xl: 48rpx;

  /* === 圆角 === */
  --radius-sm: 8rpx;
  --radius-md: 16rpx;
  --radius-lg: 24rpx;
  --radius-round: 999rpx;
}
```

### Vant Weapp 主题覆盖

Vant 组件使用自己的 CSS 变量。在 `app.wxss` 中映射品牌色到 Vant 变量：

```css
page {
  /* 按钮 */
  --button-primary-background-color: var(--color-primary);
  --button-primary-border-color: var(--color-primary);

  /* Tab */
  --tabs-bottom-bar-color: var(--color-primary);

  /* 开关 */
  --switch-on-background-color: var(--color-primary);

  /* 步骤条 */
  --step-active-color: var(--color-primary);

  /* 标签 */
  --tag-primary-color: var(--color-primary);

  /* 复选框/单选框 */
  --checkbox-checked-icon-color: var(--color-primary);
  --radio-checked-icon-color: var(--color-primary);

  /* 滑块 */
  --slider-active-background-color: var(--color-primary);
}
```

> 完整 Vant 变量列表参考 `vant-weapp` 技能。此处只列出最常需要覆盖的品牌色映射。

---

## R2.2 状态色系统 [高]

业务状态需要一套统一的视觉语义。以下提供通用模板：

### 状态色定义

```css
page {
  --status-pending: #FAAD14;      /* 待处理：橙黄 */
  --status-active: #1890FF;       /* 进行中：蓝 */
  --status-completed: #52C41A;    /* 已完成：绿 */
  --status-cancelled: #999999;    /* 已取消：灰 */
  --status-error: #FF4D4F;        /* 异常/失败：红 */
}
```

### 状态标签用法

```xml
<!-- 用 van-tag 展示状态 -->
<van-tag type="warning" wx:if="{{status === 'pending'}}">待处理</van-tag>
<van-tag type="primary" wx:elif="{{status === 'active'}}">进行中</van-tag>
<van-tag type="success" wx:elif="{{status === 'completed'}}">已完成</van-tag>
<van-tag type="default" wx:elif="{{status === 'cancelled'}}">已取消</van-tag>
<van-tag type="danger" wx:else>异常</van-tag>
```

### 自定义状态样式（当 van-tag 不够用时）

```css
.status-badge {
  display: inline-block;
  padding: 4rpx 16rpx;
  border-radius: var(--radius-sm);
  font-size: 22rpx;
}
.status-badge--pending {
  color: var(--status-pending);
  background: rgba(250, 173, 20, 0.1);
}
.status-badge--active {
  color: var(--status-active);
  background: rgba(24, 144, 255, 0.1);
}
.status-badge--completed {
  color: var(--status-completed);
  background: rgba(82, 196, 26, 0.1);
}
```

---

## R2.3 价格展示模式 [高]

价格排版需要分离符号、整数、小数部分，使用不同字号和字重创造层次。

### WXML

```xml
<!-- 标准价格展示 -->
<view class="price">
  <text class="price-symbol">¥</text>
  <text class="price-integer">{{priceInt}}</text>
  <text class="price-decimal">.{{priceDec}}</text>
</view>

<!-- 原价 + 现价组合 -->
<view class="price-group">
  <view class="price price--current">
    <text class="price-symbol">¥</text>
    <text class="price-integer">{{currentPriceInt}}</text>
    <text class="price-decimal">.{{currentPriceDec}}</text>
  </view>
  <text class="price--original">¥{{originalPrice}}</text>
</view>
```

### WXSS

```css
.price {
  display: inline-flex;
  align-items: baseline;
  color: var(--color-primary);
}
.price-symbol {
  font-size: 24rpx;
  font-weight: 600;
}
.price-integer {
  font-size: 40rpx;
  font-weight: 700;
  line-height: 1;
}
.price-decimal {
  font-size: 24rpx;
  font-weight: 400;
}

.price--original {
  font-size: 24rpx;
  color: var(--color-text-hint);
  text-decoration: line-through;
  margin-left: 8rpx;
}
```

### 价格格式化工具函数

```typescript
function formatPrice(price: number): { int: string; dec: string } {
  const fixed = price.toFixed(2)
  const [int, dec] = fixed.split('.')
  return { int, dec }
}
```

---

## R2.4 动画策略 [中]

### CSS Transition（首选）

适用于简单状态切换，性能好，代码简洁：

```css
/* 按钮点击反馈 */
.btn-press {
  transition: transform 100ms ease, opacity 100ms ease;
}
.btn-press:active {
  transform: scale(0.97);
  opacity: 0.85;
}

/* 状态切换 */
.status-transition {
  transition: background-color 200ms ease, color 200ms ease;
}
```

### CSS Animation（入场动画）

适用于页面加载时的元素入场：

```css
.fade-in {
  animation: fadeIn 300ms ease-out;
}
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(20rpx); }
  to { opacity: 1; transform: translateY(0); }
}

/* 交错入场（列表项依次出现） */
.stagger-item {
  animation: fadeIn 300ms ease-out both;
}
.stagger-item:nth-child(1) { animation-delay: 0ms; }
.stagger-item:nth-child(2) { animation-delay: 60ms; }
.stagger-item:nth-child(3) { animation-delay: 120ms; }
```

### 微信关键帧动画 API（基础库 2.9.0+）

适用于 JS 控制的复杂动画，性能优于 `wx.createAnimation`：

```typescript
// this.animate(selector, keyframes, duration, callback)
this.animate('.ball', [
  { offset: 0, transform: 'translateY(0)', opacity: 1 },
  { offset: 0.5, transform: 'translateY(-60rpx)', opacity: 0.8 },
  { offset: 1, transform: 'translateY(0)', opacity: 1 }
], 500, () => {
  // 动画完成回调
})

// 清除动画
this.clearAnimation('.ball')
```

### 滚动驱动动画（基础库 2.9.0+）

适用于下拉刷新自定义动画、视差滚动等场景：

```typescript
// 创建滚动时间线
this.animate('.header', [
  { offset: 0, opacity: 1, transform: 'scale(1)' },
  { offset: 1, opacity: 0.5, transform: 'scale(0.9)' }
], 300, {
  scrollSource: '#scroller',
  timeRange: 300,
  startScrollOffset: 0,
  endScrollOffset: 150
})
```

### 动画原则

- 一个精心设计的入场动画 > 满屏分散的微交互
- 聚焦关键时刻（页面加载、操作完成反馈），不为每个元素都加动画
- 优先 CSS transition → CSS animation → `this.animate` → `wx.createAnimation`（最后选择）
- 动画时长：微交互 100-200ms，入场 200-400ms，页面切换 300-500ms

---

## 配色正确/错误示例

```css
/* [错误] AI 模板紫色渐变 */
.banner {
  background: linear-gradient(135deg, #7C3AED, #EC4899);
}

/* [正确] 品牌色渐变 */
.banner {
  background: linear-gradient(135deg, var(--color-primary), var(--color-accent));
}

/* [正确] 柔和粉彩 */
.banner {
  background: linear-gradient(135deg, #FADADD, #F5E6CC);
}

/* [正确] 奢华深色 */
.banner {
  background: linear-gradient(135deg, #2C2C2C, #1A1A1A);
  color: var(--color-primary);
}
```

---

## 空间构图

避免所有页面千篇一律的垂直居中堆叠：

```css
/* [错误] 千篇一律 */
.page {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.card {
  width: 686rpx;
  margin: 16rpx auto;
  background: #fff;
  border-radius: 16rpx;
  box-shadow: 0 4rpx 12rpx rgba(0,0,0,0.08);
}

/* [正确] 有节奏感的布局 */
.hero-section {
  padding: 48rpx 32rpx 32rpx;
  background: var(--color-bg-card);
}
.info-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20rpx;
  padding: 24rpx 32rpx;
}
.highlight-card {
  margin: 24rpx 32rpx;
  padding: 32rpx;
  border-left: 6rpx solid var(--color-primary);
  background: var(--color-bg-card);
}
```

构图技巧：

- 用不同背景色区分内容区域，制造视觉节奏
- 适当使用左侧色条、顶部色带等装饰性元素增加辨识度
- 关键数字或状态使用大字号突出
- 留白是设计的一部分，不要塞满每一寸空间

---

## 背景与视觉细节

```css
/* 卡片微妙的投影层次 */
.card-elevated {
  background: #ffffff;
  border-radius: 16rpx;
  box-shadow: 0 2rpx 8rpx rgba(0,0,0,0.04),
              0 8rpx 24rpx rgba(0,0,0,0.06);
}

/* 渐变背景营造氛围 */
.page-header {
  background: linear-gradient(180deg, var(--color-primary-light) 0%, var(--color-bg-page) 100%);
  padding: 48rpx 32rpx 32rpx;
}

/* 装饰性圆形（奢华风格）— 使用品牌色低透明度 */
.deco-circle {
  position: absolute;
  width: 300rpx;
  height: 300rpx;
  border-radius: 50%;
  background: rgba(var(--color-primary-rgb, 0, 0, 0), 0.08);
  /* 若 CSS 变量不支持 rgba 拆分，直接写品牌色 + opacity */
  opacity: 0.08;
  background: var(--color-primary);
  top: -100rpx;
  right: -60rpx;
}
```
