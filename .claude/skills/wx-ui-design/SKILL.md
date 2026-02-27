---
name: wx-ui-design
description: >-
  Use this skill to design and implement WeChat Mini Program UI pages and custom
  components. Covers design-thinking workflow, 750rpx layout system, WXSS
  selector rules, Vant Weapp theme integration, component patterns with style
  isolation, and icon resource management. Invoke when building, reviewing, or
  refactoring any miniprogram page or component.
metadata:
  author: nvoyager
  version: 1.0.2
  description_zh: 微信小程序原生 UI 设计与实现指南，覆盖设计思维、750rpx 布局、WXSS 规范、Vant Weapp 集成、组件模式与图标资源管理。
---

## 何时使用此技能

在进行 **微信小程序 UI 设计与实现** 时使用，包括：

- 页面布局与样式编写（WXML + WXSS）
- 750rpx 适配规范
- 原生组件使用与标签映射
- 配色方案与字体选择
- 审美方向与视觉风格
- 页面配置与导航模式
- 自定义组件开发
- 图标与资源管理

**不适用于：**

- Vant 组件 API 细节、事件签名 → 使用 `vant-weapp`
- 页面逻辑与云函数 → 使用 `wx-coding`
- 数据库设计 → 使用 `wx-database-design`

---

## 参考文件路由表

| 文件 | 编号范围 | 关键模式 |
|---|---|---|
| [design-system.md](references/design-system.md) | R2.x | CSS 变量主题、Vant 主题覆盖、状态色、价格排版、动画 |
| [layout-patterns.md](references/layout-patterns.md) | R3.x | 三态视图、底部安全区、Tab 列表、弹窗面板、表单、横滑、选择 UI |
| [component-patterns.md](references/component-patterns.md) | R4.x | 样式隔离、多 slot、info-card 示例、Vant+原生决策表 |
| [anti-patterns.md](references/anti-patterns.md) | R5.x | AI 模板检测、12 个实战踩坑、DO/DON'T、WXSS 陷阱、交付清单 |

---

# R1 设计思维

你是一位专业的小程序前端工程师，擅长创建具有独特审美风格的高保真界面。你的主要职责是将需求转化为可开发的小程序页面——功能完整且视觉令人难忘。

## R1.1 强制性的设计前检查 [关键]

**在编写任何页面代码之前，你必须明确输出此分析：**

```text
设计规范
====================
1. 目的声明：[关于问题/用户/背景的 2-3 句话]
2. 审美方向：[从列表中选择一个，禁止："modern"、"clean"、"simple"]
3. 配色方案：[列出 3-5 个具体颜色及十六进制代码]
   禁用颜色：紫色 (#800080-#9370DB)、紫罗兰 (#8B00FF-#EE82EE)、靛蓝 (#4B0082-#6610F2)、紫红 (#FF00FF-#FF77FF)、蓝紫渐变 — 这些是过度使用的 AI 模板色
4. 字体策略：[指定中文字体栈偏好与字重搭配]
5. 布局策略：[描述视觉层次、节奏感、留白方式]
   禁止：所有页面千篇一律的居中卡片堆叠
```

### 审美方向选项

| 方向 | 适用场景 | 小程序表现手法 |
|---|---|---|
| 极度简约 | 工具类、效率类 | 大留白、克制配色、精准间距 |
| 奢华精致 | 高端服务、会所 | 深色底、金色点缀、精致描边 |
| 柔和粉彩 | 美容、女性用户 | 低饱和暖色、圆角、柔光阴影 |
| 有机自然 | 健康、养生、茶饮 | 自然色系、不规则形状、纹理背景 |
| 杂志编辑 | 内容展示、品牌 | 大字重对比、错落排版、留白呼吸感 |
| 工业实用 | 管理后台、B 端 | 紧凑信息密度、网格对齐、低彩度 |
| 装饰艺术 | 品牌调性强 | 几何图案、对称装饰、金属质感 |
| 复古未来 | 创意类、潮流品牌 | 霓虹色 + 暗底、网格线、等宽字体 |
| 趣味玩具 | 儿童、游戏化、社交 | 高饱和色块、大圆角、插画风图标 |

### 上下文感知推荐

- **面向消费者（C 端）**：奢华精致 / 柔和粉彩 / 有机自然 — 体验导向
- **面向管理者（B 端）**：工业实用 / 极度简约 — 效率导向

### 触发词检测器

**如果你发现自己正在写这些，立即停止并重新阅读设计规范：**

- 配色使用了紫色/紫罗兰/靛蓝/紫红/蓝紫渐变（AI 模板色）
- 所有页面一模一样的白底灰卡片
- 没有明确风格方向就开始写样式
- 用 emoji 字符当图标

**操作**：返回设计规范 → 选择替代方案 → 继续

## 设计流程

1. **用户体验分析**：分析页面的核心功能和用户需求，确定交互逻辑
2. **界面规划**：定义关键区域、信息架构和视觉层次
3. **审美方向确定**：基于设计规范，确定清晰的视觉语言
4. **高保真设计**：使用 WXML + WXSS 实现符合设计标准的界面
5. **真实感增强**：使用真实数据填充、合理的状态展示（加载/空态/数据态）

---

# R1.2 设计系统基础

## 设计原则

- **原生优先**：遵循微信小程序设计规范，不生搬 Web 思维
- **一致性**：全局配色、字体、间距保持统一
- **响应式**：750rpx 基准适配所有设备
- **有辨识度**：避免通用模板感，体现品牌调性

## 全局样式（app.wxss）

```css
/* app.wxss — 全局样式基础 */
page {
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue',
               'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: 28rpx;
  line-height: 1.5;
  color: #333333;
  background-color: #f6f6f6;
}

/* 安全区适配 */
.safe-area-bottom {
  padding-bottom: env(safe-area-inset-bottom);
}
```

> **关于字体**：小程序无法像 Web 一样加载自定义字体文件。通过**字重对比**（regular vs bold vs light）、**字号层次**（36rpx 标题 / 28rpx 正文 / 24rpx 辅助）和**颜色深浅**来创造排版层次感，而非依赖不同字体族。

---

# 配色与视觉风格

完整配色方案、动效策略、空间构图详见 [references/design-system.md](references/design-system.md)。

## 配色禁忌

| 禁用 | 原因 |
|---|---|
| 紫色系 (#800080 ~ #9370DB) | 过度使用的 AI 模板色 |
| 紫罗兰系 (#8B00FF ~ #EE82EE) | 同上 |
| 靛蓝系 (#4B0082 ~ #6610F2) | 同上 |
| 紫红系 (#FF00FF ~ #FF77FF) | 同上 |
| 蓝紫渐变 | 最典型的 AI 模板感 |

## CSS 变量快速参考

```css
page {
  /* === 品牌色（按项目替换） === */
  --color-primary: <your-brand-color>;         /* 主色 */
  --color-primary-light: <your-brand-light>;   /* 主色亮 */
  --color-primary-dark: <your-brand-dark>;     /* 主色暗 */
  --color-accent: <your-accent-color>;         /* 强调色 */

  /* === 语义色（通用） === */
  --color-success: #52C41A;
  --color-warning: #FAAD14;
  --color-error: #FF4D4F;

  /* === 中性色（通用） === */
  --color-text-primary: #333333;
  --color-text-secondary: #666666;
  --color-text-hint: #999999;
  --color-border: #E8E8E8;
  --color-bg-page: #F6F6F6;
  --color-bg-card: #FFFFFF;
}
```

## 字体层次

| 层级 | 字号 | 字重 | 颜色 | 用途 |
|---|---|---|---|---|
| 大标题 | 40rpx | bold (700) | --color-text-primary | 页面主标题 |
| 标题 | 34rpx ~ 36rpx | bold (600) | --color-text-primary | 区块标题 |
| 正文 | 28rpx | normal (400) | --color-text-primary | 主体文本 |
| 辅助 | 24rpx | normal (400) | --color-text-secondary | 副标题、说明 |
| 小提示 | 20rpx | normal (400) | --color-text-hint | 时间、备注 |
| 金额 | 36rpx ~ 48rpx | bold (700) | --color-primary | 价格展示 |

---

# R1.3 750rpx 布局系统

## 核心规则

小程序设计稿统一按 **iPhone 6（750px 宽度）** 为基准：

- **优先使用 `rpx`**：布局宽度、高度、边距、字体大小
- **避免使用**：`rem`（小程序不支持）
- **允许例外**：`1px` 用于细边框（`1rpx` 在部分设备渲染异常）、`%` 用于 `width: 100%` 等相对布局场景
- **转换公式**：设计稿 1px = 1rpx

```css
/* [错误] */
.container { width: 375px; font-size: 14px; padding: 10px; }

/* [正确] */
.container { width: 750rpx; font-size: 28rpx; padding: 20rpx; }

/* 允许：细边框使用 px（1rpx 在部分高清屏上渲染异常） */
.card { border: 1px solid #e8e8e8; border-radius: 16rpx; }
```

## 常用尺寸参考

| 元素 | 推荐尺寸 |
|---|---|
| 页面两侧间距 | 32rpx |
| 卡片内间距 | 24rpx |
| 列表项高度 | 88rpx ~ 120rpx |
| 按钮高度 | 88rpx |
| 导航栏标题字号 | 34rpx |
| 正文字号 | 28rpx |
| 辅助文字 | 24rpx |
| 小提示 | 20rpx |
| 图标大小 | 40rpx ~ 48rpx |

---

# R1.4 WXML 原生组件规范

**严禁**使用任何 HTML 标签，必须使用原生组件：

| HTML（严禁） | 小程序原生组件 | 备注 |
|---|---|---|
| `<div>`, `<section>` | `<view>` | 基础容器 |
| `<span>`, `<i>`, `<em>` | `<text>` | 行内文本，支持长按选中 |
| `<img>` | `<image>` | 图片组件 |
| `<a>` | `<navigator>` | 页面跳转 |
| `<input type="button">` | `<button>` | 按钮 |
| `<ul>/<li>` | `<view>` + `wx:for` | 列表渲染 |
| `<input>` | `<input>` | 小程序原生 input |
| `<textarea>` | `<textarea>` | 小程序原生 textarea |
| `<select>` | `<picker>` | 选择器组件 |

> 如果生成的代码中包含 `<div>` 或 `<span>`，视为**严重错误**。

条件渲染、列表渲染、数据绑定的完整用法详见 [references/component-patterns.md](references/component-patterns.md)。

---

# R1.5 WXSS 选择器规范

## 支持的选择器

| 选择器 | 示例 | 说明 |
|---|---|---|
| `.class` | `.intro` | 类选择器 |
| `#id` | `#firstname` | ID 选择器（仅页面级可用） |
| `element` | `view` | 标签选择器（仅页面级可用） |
| `::before` | `view::before` | 伪元素 |
| `::after` | `view::after` | 伪元素 |
| `:host` | `:host` | 组件默认样式（组件内使用） |

## 样式导入

```css
/* 使用相对路径 @import 导入 */
@import "./common.wxss";
@import "../styles/theme.wxss";
```

## 全局 vs 局部样式

- `app.wxss` 为全局样式，作用于所有页面
- 页面 `.wxss` 会覆盖 `app.wxss` 中的同名选择器
- 组件 `.wxss` 默认隔离，不受页面和全局样式影响（详见 [component-patterns.md](references/component-patterns.md) R4.1）

## 内联样式注意

```xml
<!-- 动态样式用 style 绑定 -->
<view style="color: {{dynamicColor}}; font-size: {{size}}rpx;">动态</view>

<!-- 静态样式写在 class 中，不要放 style 里（影响渲染速度） -->
<view class="static-style">正确</view>
```

---

# 页面配置与生命周期

## page.json 推荐配置

```json
{
  "navigationBarTitleText": "页面标题",
  "enablePullDownRefresh": false,
  "usingComponents": {}
}
```

推荐：每个新页面的 JSON 配置应包含 `navigationBarTitleText`，避免留空或仅 `{}`。（官方文档中此字段为可选，默认空字符串）

## 生命周期规范

### Page 推荐包含

```typescript
Page({
  onLoad(options) {
    // 接收参数，初始化数据
  },
  onShow() {
    // 页面显示时刷新
  },
  onShareAppMessage() {
    // 推荐：防止页面无法分享
    return {
      title: '分享标题',
      path: '/pages/index/index'
    }
  }
})
```

### Component 推荐包含

```typescript
Component({
  lifetimes: {
    attached() {
      // 组件进入页面节点树
    },
    detached() {
      // 组件移除，清理定时器等
    }
  }
})
```

## 导航模式

```typescript
// 普通跳转（新页面入栈）
wx.navigateTo({ url: '/pages/detail/detail?id=123' })

// 重定向（替换当前页）
wx.redirectTo({ url: '/pages/result/result' })

// 跳转 Tab 页（只能跳 tabBar 页面）
wx.switchTab({ url: '/pages/home/home' })

// 返回上一页
wx.navigateBack({ delta: 1 })
```

---

# 页面结构模板

## 标准页面容器

```xml
<!-- page.wxml -->
<view class="container">
  <!-- 头部区域 -->
  <view class="header">
    <text class="title">页面标题</text>
  </view>

  <!-- 内容区域（三态视图，详见 R3.1） -->
  <view class="content">
    <view wx:if="{{loading}}" class="skeleton">
      <!-- 骨架屏 -->
    </view>
    <van-empty wx:elif="{{!list.length}}" description="暂无数据" />
    <view wx:else class="list">
      <view class="list-item" wx:for="{{list}}" wx:key="id">
        <text>{{item.name}}</text>
      </view>
    </view>
  </view>
</view>
```

---

# 图标与资源管理

## R1.6 图标方案优先级

按优先级选择图标方案：

| 优先级 | 方案 | 适用场景 |
|---|---|---|
| 1 | `van-icon` | Vant 内置图标，最方便 |
| 2 | Icons8 图片图标 | 需要更丰富的图标库 |
| 3 | 本地 SVG/PNG | 自定义图标、品牌图标 |
| 4 | Iconfont（下载到本地） | 团队自有图标库 |

### Icons8 图片图标

URL 格式：`https://img.icons8.com/{style}/{size}/{color}/{icon-name}.png`

| 参数 | 值 | 说明 |
|---|---|---|
| `style` | `ios` / `ios-filled` | 线框 / 填充 |
| `size` | `100` | 推荐 100px（< 5KB） |
| `color` | 十六进制（不带 #） | 如 `8E8E93`、`D4A574` |
| `icon-name` | 图标名 | 如 `checked--v1` |

```text
未选中（灰色线框）：https://img.icons8.com/ios/100/8E8E93/checked--v1.png
已选中（品牌色填充）：https://img.icons8.com/ios-filled/100/<brand-hex>/checked--v1.png
```

### 下载流程

使用 `downloadRemoteFile` MCP 工具下载图标到项目 `images/` 目录。生成代码时引用了图标**必须同时下载**，避免构建错误。

### 图标禁忌

| 禁止 | 替代方案 |
|---|---|
| Emoji 字符作为图标 | van-icon / Icons8 图片 / 本地 SVG |
| Web 字体图标 CDN（FontAwesome `<i>` 标签等） | 本地图片资源 |
| 远程 URL 直接引用（不下载） | 下载到本地 `images/` 目录 |

**图标一致性**：同一项目的所有图标使用相同 style（统一 `ios` 或统一 `ios-filled`），保持视觉连贯。

---

# 自定义组件开发

组件结构为 4 文件（`.wxml`、`.wxss`、`.ts`、`.json`），使用 `Component({})` API。完整示例（含 info-card 组件代码、样式隔离与事件通信）详见 [references/component-patterns.md](references/component-patterns.md)。

核心要点：

- `.json` 文件中声明 `"component": true`
- 通过 `properties` 接收外部数据，`data` 管理内部状态
- 使用 `lifetimes.attached/detached` 管理生命周期
- 通过 `this.triggerEvent('eventName', detail)` 向父组件通信
- 在页面 `page.json` 的 `usingComponents` 中按需注册，避免全局注册影响性能
- 样式隔离模式选择详见 R4.1
