# 反模式与交付清单

AI 模板检测、实战踩坑指南、DO/DON'T 对照表、WXSS 陷阱与代码提交前自检清单。

主文件：[SKILL.md](../SKILL.md)

---

## R5.1 AI 模板检测 [关键]

以下 8 项是 AI 生成代码的典型特征。**命中 3 项或以上，必须重新设计。**

| # | 检测项 | 症状 |
|---|---|---|
| 1 | 千篇一律白卡片 | 每个页面都是白底 + 圆角 + box-shadow 的卡片堆叠 |
| 2 | 蓝色按钮综合症 | 所有按钮 `#1890FF` / `#409EFF`，无品牌色 |
| 3 | 紫色渐变背景 | `linear-gradient(135deg, #7C3AED, #EC4899)` 或类似蓝紫渐变 |
| 4 | 无状态考虑 | 只有数据态，缺少 loading/empty/error 处理 |
| 5 | 居中对称强迫症 | 所有元素居中，无层次、无错落、无视觉重心 |
| 6 | 通用占位文案 | "Lorem ipsum"、"这是描述文字"、"用户名称" |
| 7 | 过度阴影 | 每个容器都有 `box-shadow`，层次感靠阴影而非结构 |
| 8 | 无品牌调性 | 去掉 logo 后无法辨别是哪个产品 |

### 自检流程

```text
AI 模板检测
====================
□ 白卡片堆叠：[是/否]
□ 默认蓝按钮：[是/否]
□ 紫色渐变：[是/否]
□ 缺少状态：[是/否]
□ 全部居中：[是/否]
□ 通用文案：[是/否]
□ 过度阴影：[是/否]
□ 无品牌感：[是/否]
命中数：___（≥3 必须重新设计）
```

---

## R5.2 实战踩坑指南 [关键]

从实际小程序开发中总结的 12 个高频陷阱：

### Vant 组件陷阱

| # | 陷阱 | 说明 | 解决方案 |
|---|---|---|---|
| 1 | **van-popup + van-picker closeable 冲突** | 在 `van-popup` 上加 `closeable` 会显示关闭按钮覆盖 picker 的 toolbar | 不要在含 picker 的 popup 上加 `closeable`，用 `bind:close` |
| 2 | **van-search 事件值** | `bind:change` 的 `e.detail` 直接是字符串值，不是 `{ value }` 对象 | `const keyword = e.detail`（不是 `e.detail.value`） |
| 3 | **van-field bind:change 值** | 同上，`e.detail` 直接是值（string） | 注意与原生 input 的 `e.detail.value` 区分 |
| 4 | **van-toast 节点缺失** | 使用 `Toast()` 前必须在 WXML 中放置 `<van-toast id="van-toast" />` | 在页面 WXML 底部添加 toast 节点 |
| 5 | **van-dialog 节点缺失** | 同 Toast，需要 `<van-dialog id="van-dialog" />` | 在页面 WXML 底部添加 dialog 节点 |

### 平台陷阱

| # | 陷阱 | 说明 | 解决方案 |
|---|---|---|---|
| 6 | **switchTab 无法传参** | `wx.switchTab` 的 url 不支持 query 参数 | 用 globalData / getApp() / EventChannel 传递 |
| 7 | **1rpx 渲染问题** | `1rpx` 在部分高清屏上渲染为 0px 或 2px | 细边框用 `1px` 代替 `1rpx` |
| 8 | **构建 npm** | 引入 Vant 后必须在微信开发者工具中点击"构建 npm" | 新增/更新 npm 包后必须重新构建 |
| 9 | **TS 编译白屏** | TypeScript 语法错误不会阻止编译但导致页面白屏 | 检查控制台错误，确认 tsconfig 配置正确 |
| 10 | **scroll-view 需明确高度** | `scroll-view` 的 `scroll-y` 需要设置明确的 height 或 max-height | 用 `height: calc(100vh - xxxrpx)` 或 flex 布局 |
| 11 | **setData 大小限制** | 单次 `setData` 数据量不超过 1024KB | 分批更新、只更新变化的字段 |
| 12 | **image mode 选择** | 默认 `scaleToFill` 会拉伸变形 | 常用 `aspectFill`（裁剪）或 `aspectFit`（留白） |

---

## R5.3 DO / DON'T 对照表 [高]

| 场景 | DON'T | DO |
|---|---|---|
| **布局容器** | `<div class="wrapper">` | `<view class="wrapper">` |
| **文本显示** | `<span>价格</span>` | `<text>价格</text>` |
| **图标** | Emoji 字符 / FontAwesome CDN | van-icon / Icons8 本地图片 |
| **单位** | `width: 375px; font-size: 14px;` | `width: 750rpx; font-size: 28rpx;` |
| **细边框** | `border: 1rpx solid #eee;`（可能消失） | `border: 1px solid #eee;` |
| **配色** | `background: #7C3AED;`（紫色 AI 模板色） | `background: var(--color-primary);` |
| **状态页面** | 只有数据态，loading 时空白 | 三态视图：loading → empty → content（R3.1） |
| **底部操作栏** | `padding-bottom: 68rpx;`（硬编码） | `padding-bottom: env(safe-area-inset-bottom);` |

---

## R5.4 WXSS 陷阱 [高]

来自微信官方文档的关键限制：

### 组件内选择器限制

```css
/* [错误] 组件 WXSS 中使用 ID 选择器 — 不生效 */
#my-button { color: red; }

/* [错误] 组件 WXSS 中使用属性选择器 — 不生效 */
[data-active] { background: blue; }

/* [错误] 组件 WXSS 中使用标签名选择器 — 不生效 */
view { padding: 10rpx; }

/* [正确] 只使用类选择器 */
.my-button { color: red; }
.active { background: blue; }
.container { padding: 10rpx; }
```

### 内联样式性能

```xml
<!-- [不推荐] 静态样式写在 style 中，影响渲染速度 -->
<view style="color: #333; font-size: 28rpx; padding: 20rpx;">内容</view>

<!-- [推荐] 静态样式写在 class 中 -->
<view class="content-text">内容</view>

<!-- [允许] style 只用于动态值 -->
<view class="base-style" style="color: {{themeColor}};">内容</view>
```

### @import 路径

```css
/* [正确] 相对路径 */
@import "./common.wxss";
@import "../shared/theme.wxss";

/* [错误] 绝对路径或无扩展名 */
@import "/styles/common.wxss";  /* 不同平台行为不一致 */
@import "./common";             /* 必须带 .wxss */
```

### 其他限制

- 不支持 CSS 预处理器（Sass/Less），除非使用构建工具转译
- 不支持 `@media` 查询中的 `rpx` 单位（需用 `px`）
- `calc()` 中混用 `rpx` 和 `px` 需谨慎，部分低版本不支持

---

## R5.5 交付质量清单 [关键]

生成代码前必须自检。每个页面/组件提交前逐项确认：

### 原生规范

- [ ] **R5.5.1** 无 HTML 标签（`<div>` / `<span>` → `<view>` / `<text>`）
- [ ] **R5.5.2** 样式单位优先使用 `rpx`（细边框可用 `1px`）
- [ ] **R5.5.3** 代码为原生写法，非 React/Vue 语法
- [ ] **R5.5.4** `.ts` 文件（非 `.js`），无 TypeScript 编译错误

### Vant 集成

- [ ] **R5.5.5** 使用的 Vant 组件已在 `page.json` 的 `usingComponents` 注册
- [ ] **R5.5.6** 使用 `Toast()` / `Dialog()` 的页面包含对应 WXML 节点
- [ ] **R5.5.7** Vant 主题色变量已在 `app.wxss` 中覆盖（R2.1）

### 三态视图

- [ ] **R5.5.8** 数据页面包含 loading 态（骨架屏或 loading 指示器）
- [ ] **R5.5.9** 列表页面包含空态（`van-empty` 或自定义空态）
- [ ] **R5.5.10** loading → empty → content 使用 `wx:if` 互斥（R3.1）

### 安全区与布局

- [ ] **R5.5.11** 底部固定栏包含 `env(safe-area-inset-bottom)` 适配
- [ ] **R5.5.12** 底部栏上方内容区预留了占位高度（R3.2）

### 样式隔离

- [ ] **R5.5.13** 自定义组件选择了合适的 `styleIsolation` 模式
- [ ] **R5.5.14** 组件 WXSS 只使用类选择器

### 设计规范

- [ ] **R5.5.15** 编码前输出了设计规范（R1.1）
- [ ] **R5.5.16** 配色避开了禁用色（紫色系/蓝紫渐变）
- [ ] **R5.5.17** 页面有清晰的视觉层次和节奏感
- [ ] **R5.5.18** 通过 AI 模板检测（R5.1 命中 < 3）

### 资源完整性

- [ ] **R5.5.19** 引用的图标资源已下载到本地
- [ ] **R5.5.20** 图标风格全局统一（同一 style）
- [ ] **R5.5.21** 未使用 emoji 字符当图标

### 页面配置

- [ ] **R5.5.22** `page.json` 包含 `navigationBarTitleText`（推荐）
- [ ] **R5.5.23** Page 包含 `onShareAppMessage`（推荐）

如果任何检查失败 → 修正后再提交
