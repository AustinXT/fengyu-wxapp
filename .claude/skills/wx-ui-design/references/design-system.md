# 设计系统详细规范

配色方案、字体层次、动效策略、空间构图的完整参考。

主文件：[SKILL.md](../SKILL.md)

---

## 配色 CSS 变量定义

在 `app.wxss` 中集中管理：

```css
page {
  /* 主色 — 品牌色，用于主按钮、关键操作、选中态 */
  --color-primary: #D4A574;
  /* 主色变体 */
  --color-primary-light: #F0E0CC;
  --color-primary-dark: #B8895A;

  /* 强调色 — 少量点缀，用于徽标、标签、高亮 */
  --color-accent: #C97B5A;

  /* 语义色 */
  --color-success: #52C41A;
  --color-warning: #FAAD14;
  --color-error: #FF4D4F;

  /* 中性色阶梯 */
  --color-text-primary: #333333;
  --color-text-secondary: #666666;
  --color-text-hint: #999999;
  --color-border: #E8E8E8;
  --color-bg-page: #F6F6F6;
  --color-bg-card: #FFFFFF;
}
```

## 配色正确/错误示例

```css
/* ❌ 糟糕：AI 模板紫色渐变 */
.banner {
  background: linear-gradient(135deg, #7C3AED, #EC4899);
}

/* ✅ 好的：温暖的美业品牌色 */
.banner {
  background: linear-gradient(135deg, var(--color-primary), var(--color-accent));
}

/* ✅ 好的：柔和粉彩 */
.banner {
  background: linear-gradient(135deg, #FADADD, #F5E6CC);
}

/* ✅ 好的：奢华深色 */
.banner {
  background: linear-gradient(135deg, #2C2C2C, #1A1A1A);
  color: #D4A574;
}
```

## 动效策略

小程序支持 CSS transition 和 animation，但需克制使用：

```css
/* 页面元素入场 */
.fade-in {
  animation: fadeIn 300ms ease-out;
}
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(20rpx); }
  to { opacity: 1; transform: translateY(0); }
}

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

原则：一个精心设计的入场动画 > 满屏分散的微交互。聚焦关键时刻（页面加载、操作完成反馈），不为每个元素都加动画。

## 空间构图

避免所有页面千篇一律的垂直居中堆叠：

```css
/* ❌ 糟糕：千篇一律 */
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

/* ✅ 好的：有节奏感的布局 */
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
  background: linear-gradient(180deg, #FFF8F0 0%, #F6F6F6 100%);
  padding: 48rpx 32rpx 32rpx;
}

/* 装饰性圆形（奢华风格） */
.deco-circle {
  position: absolute;
  width: 300rpx;
  height: 300rpx;
  border-radius: 50%;
  background: rgba(212, 165, 116, 0.08);
  top: -100rpx;
  right: -60rpx;
}
```
