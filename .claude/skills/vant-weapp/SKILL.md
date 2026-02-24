---
name: vant-weapp
description: 用于指导 Vant Weapp 微信小程序 UI 组件库的正确使用。当用户请求使用 Vant 组件开发小程序页面、表单、列表、弹窗等 UI 时激活，确保组件注册、样式定制和 API 调用符合规范。
metadata:
  author: 42ailab
  version: '1.0'
  title: Vant Weapp 组件规范
---

# Vant Weapp 组件规范

## 概述

Vant Weapp 是有赞开源的轻量级微信小程序 UI 组件库。本技能确保正确使用 Vant 组件，避免常见的注册遗漏、样式冲突和 API 误用。

## 何时使用

- 开发小程序页面需要使用 Vant UI 组件
- 创建表单（Field、Picker、DatetimePicker）
- 构建列表/卡片布局（Cell、Card、Grid）
- 弹窗交互（Dialog、ActionSheet、Popup、Toast）
- 导航结构（Tab、Navbar、Sidebar）

## 不适用场景

- 纯原生组件开发（无 Vant 依赖）
- 使用其他 UI 库（如 WeUI）

## 快速参考

### 安装

```bash
npm i @vant/weapp -S --production
```

安装后在微信开发者工具中：**工具 → 构建 npm**。

### 组件注册（必须步骤）

每个使用 Vant 组件的页面/组件，必须在对应 `.json` 中声明：

```json
{
  "usingComponents": {
    "van-button": "@vant/weapp/button/index",
    "van-cell": "@vant/weapp/cell/index",
    "van-cell-group": "@vant/weapp/cell-group/index",
    "van-field": "@vant/weapp/field/index",
    "van-icon": "@vant/weapp/icon/index"
  }
}
```

**路径格式**: `@vant/weapp/{组件名}/index`

### 常用组件注册速查

| 组件 | 注册路径 | 用途 |
|------|----------|------|
| Button | `@vant/weapp/button/index` | 按钮 |
| Cell / CellGroup | `cell/index`, `cell-group/index` | 单元格列表 |
| Field | `@vant/weapp/field/index` | 输入框 |
| Popup | `@vant/weapp/popup/index` | 弹出层 |
| Dialog | `@vant/weapp/dialog/index` | 对话框 |
| Toast | `@vant/weapp/toast/index` | 轻提示 |
| ActionSheet | `@vant/weapp/action-sheet/index` | 动作面板 |
| Tab / Tabs | `@vant/weapp/tab/index`, `tabs/index` | 标签页 |
| NavBar | `@vant/weapp/nav-bar/index` | 导航栏 |
| Card | `@vant/weapp/card/index` | 商品卡片 |
| Grid / GridItem | `grid/index`, `grid-item/index` | 宫格 |
| Tag | `@vant/weapp/tag/index` | 标签 |
| SubmitBar | `@vant/weapp/submit-bar/index` | 提交订单栏 |
| Picker | `@vant/weapp/picker/index` | 选择器 |
| DatetimePicker | `@vant/weapp/datetime-picker/index` | 日期时间选择 |
| Search | `@vant/weapp/search/index` | 搜索 |
| Stepper | `@vant/weapp/stepper/index` | 步进器 |
| SwipeCell | `@vant/weapp/swipe-cell/index` | 滑动单元格 |
| NoticeBar | `@vant/weapp/notice-bar/index` | 通知栏 |
| Calendar | `@vant/weapp/calendar/index` | 日历 |
| Empty | `@vant/weapp/empty/index` | 空状态 |
| Skeleton | `@vant/weapp/skeleton/index` | 骨架屏 |
| ConfigProvider | `@vant/weapp/config-provider/index` | 主题配置 |

## 主题定制

### 方式一：全局 CSS 变量（推荐）

在 `app.wxss` 中定义：

```css
page {
  --button-border-radius: 10rpx;
  --button-default-color: #f2f3f5;
  --cell-large-title-font-size: 32rpx;
}
```

### 方式二：局部样式覆盖

```xml
<van-button class="my-button">按钮</van-button>
```

```css
.my-button {
  --button-border-radius: 10rpx;
  --button-default-color: #f2f3f5;
}
```

### 方式三：ConfigProvider 组件

```xml
<van-config-provider theme-vars="{{ themeVars }}">
  <van-cell-group>
    <van-field label="评分">
      <view slot="input" style="width: 100%">
        <van-rate model:value="{{ rate }}" />
      </view>
    </van-field>
  </van-cell-group>
  <view style="margin: 16px">
    <van-button round block type="primary">提交</van-button>
  </view>
</van-config-provider>
```

```javascript
Page({
  data: {
    themeVars: {
      rateIconFullColor: '#07c160',
      sliderBarHeight: '4px',
      buttonPrimaryBorderColor: '#07c160',
      buttonPrimaryBackgroundColor: '#07c160',
    }
  }
});
```

### 方式四：动态切换主题

```xml
<van-button style="{{ buttonStyle }}">按钮</van-button>
```

```javascript
Page({
  data: {
    buttonStyle: '--button-border-radius: 10rpx; --button-default-color: green;'
  }
});
```

## 核心组件用法

### Field 输入框

```xml
<van-cell-group>
  <!-- 基础用法 + 双向绑定（基础库 >= 2.9.3） -->
  <van-field model:value="{{ username }}" label="用户名" placeholder="请输入用户名" required clearable />

  <!-- 密码输入 -->
  <van-field model:value="{{ password }}" type="password" label="密码" placeholder="请输入密码" required />

  <!-- 多行文本 -->
  <van-field model:value="{{ message }}" type="textarea" label="留言" placeholder="请输入留言"
    rows="3" autosize show-word-limit maxlength="200" />

  <!-- 带按钮插槽 -->
  <van-field value="{{ sms }}" center clearable label="验证码" placeholder="请输入验证码" use-button-slot>
    <van-button slot="button" size="small" type="primary">发送验证码</van-button>
  </van-field>

  <!-- 错误提示 -->
  <van-field value="{{ email }}" label="邮箱" placeholder="请输入邮箱"
    required error="{{ emailError }}" error-message="{{ emailErrorMsg }}" />
</van-cell-group>
```

### Toast 轻提示

```javascript
import Toast from '@vant/weapp/toast/toast';

// 页面中必须放置 toast 节点
// <van-toast id="van-toast" />

Toast('提示内容');
Toast.success('成功');
Toast.fail('失败');
Toast.loading({ message: '加载中...', forbidClick: true });
Toast.clear();
```

### Dialog 对话框

```javascript
import Dialog from '@vant/weapp/dialog/dialog';

// 页面中必须放置 dialog 节点
// <van-dialog id="van-dialog" />

Dialog.alert({ title: '标题', message: '内容' }).then(() => { /* 确认 */ });
Dialog.confirm({ title: '标题', message: '确定删除？' })
  .then(() => { /* 确认 */ })
  .catch(() => { /* 取消 */ });
```

### Popup 弹出层

```xml
<van-popup show="{{ showPopup }}" position="bottom" round closeable bind:close="onClosePopup">
  <view class="popup-content">
    <!-- 自定义内容 -->
  </view>
</van-popup>
```

### Tab 标签页

```xml
<van-tabs active="{{ activeTab }}" bind:change="onTabChange">
  <van-tab title="全部">内容一</van-tab>
  <van-tab title="待支付">内容二</van-tab>
  <van-tab title="已完成">内容三</van-tab>
</van-tabs>
```

### Card 商品卡片

```xml
<van-card
  num="2"
  price="10.00"
  title="商品标题"
  desc="描述信息"
  thumb="{{ imageUrl }}"
>
  <view slot="footer">
    <van-button size="mini" round type="danger">购买</van-button>
  </view>
</van-card>
```

### SubmitBar 提交订单栏

```xml
<van-submit-bar
  price="{{ totalPrice }}"
  button-text="提交订单"
  bind:submit="onSubmit"
  tip="{{ true }}"
>
  <van-tag type="primary">标签</van-tag>
</van-submit-bar>
```

## 关键规则

### 1. 组件节点必须存在

Toast、Dialog、Notify 等命令式组件，必须在 WXML 中放置对应节点：

```xml
<van-toast id="van-toast" />
<van-dialog id="van-dialog" />
```

### 2. 事件绑定用 bind: 前缀

```xml
<!-- Vant 事件命名 -->
<van-button bind:click="onClick">按钮</van-button>
<van-field bind:change="onChange" bind:blur="onBlur" />
<van-tabs bind:change="onTabChange" />
<van-popup bind:close="onClose" />
```

### 3. 插槽使用 slot 属性

```xml
<van-field use-button-slot>
  <van-button slot="button" size="small" type="primary">发送</van-button>
</van-field>

<van-card>
  <view slot="footer">
    <van-button size="mini">操作</van-button>
  </view>
</van-card>
```

### 4. 样式隔离注意事项

Vant 组件默认启用样式隔离，外部样式无法直接穿透。使用以下方式覆盖：
- CSS 变量（推荐）
- `external-classes` 属性（部分组件支持）
- 组件 `custom-class`、`title-class` 等外部样式类

```xml
<van-cell custom-class="my-cell" title-class="my-cell-title" title="标题" />
```

### 5. 与 rpx 布局协同

Vant 组件内部使用 `px`，自定义样式仍须遵循项目 `rpx` 规范。通过 CSS 变量覆盖 Vant 尺寸时使用 `rpx`：

```css
page {
  --cell-large-title-font-size: 32rpx;
  --cell-line-height: 48rpx;
}
```

## 常见错误

| 错误 | 原因 | 修正 |
|------|------|------|
| Toast/Dialog 无反应 | 缺少 WXML 节点 | 添加 `<van-toast id="van-toast" />` |
| 组件不显示 | 未在 JSON 中注册 | 在页面 `.json` 的 `usingComponents` 中添加 |
| 样式不生效 | 样式隔离 | 用 CSS 变量或 `custom-class` |
| 构建报错找不到模块 | 未构建 npm | 微信开发者工具 → 工具 → 构建 npm |
| `model:value` 无效 | 基础库版本低 | 需要基础库 >= 2.9.3，否则用 `value` + `bind:change` |

## 参考资源

- 组件 API 速查：[references/components.md](references/components.md)
- TypeScript 类型声明：[references/typescript.md](references/typescript.md)
