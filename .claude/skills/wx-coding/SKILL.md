---
name: wx-coding
description: >
  用于编写微信小程序 Page/Component、开发 CloudBase 云函数（Action 路由）、
  集成微信认证与错误处理。适用于所有编码实现任务，不含 UI 设计和 Schema 设计。
metadata:
  title: 微信小程序编码规范
  description_zh: 微信小程序 Page/Component 开发规范、CloudBase 云函数 Action 路由模板、TypeScript 规范、认证集成与错误处理
  version: 1.0.0
  author: opc
---

## 如何使用此技能

收到编码任务时，按以下决策流程定位到对应区块：

```text
编码任务
├─ 新页面 → §Page({}) 模板 / §Component({}) 模板
├─ 新云函数 → §简单模式 或 §生产模式：Action 路由
├─ 数据库变更 → 使用 wx-database-design 技能
├─ UI / 样式 → 使用 wx-ui-design 技能
├─ 认证相关 → §认证集成
├─ 错误排查 → §常见陷阱速查 + references/pitfalls.md
└─ 部署上线 → 使用 cloudbase-deploy 技能
```

> 编码前请先了解 `.42cog/real.md`（业务约束）和 `.42cog/cog.md`（认知模型）。

## 何时使用 / 不适用

**使用场景：**
- 编写小程序页面逻辑（Page / Component）
- 开发 CloudBase 云函数
- 集成微信认证（OPENID / UNIONID）
- 调用 wx.cloud API（数据库、存储、敏感数据）
- 错误处理与调试

**不适用：**
- UI 设计和布局 → `wx-ui-design`
- 数据库表结构设计 → `wx-database-design`
- 系统架构规划 → `wx-system-architecture`
- Vant 组件使用 → `vant-weapp`

---

## Page({}) 模板

```typescript
interface IPageData {
  isLoading: boolean
  list: IItem[]
}

Page<IPageData, WechatMiniprogram.Page.CustomOption>({
  data: {
    isLoading: true,
    list: [] as IItem[],
  },

  onLoad(options) {
    this.loadData(options)
  },

  onShow() {
    // 页面显示时刷新状态（如从详情页返回）
  },

  onPullDownRefresh() {
    this.loadData().finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    // 触底加载更多 → 见 references/frontend-patterns.md
  },

  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent {
    return { title: '分享标题', path: '/pages/index/index' }
  },

  // === 业务方法 ===

  async loadData(options?: Record<string, string>) {
    try {
      this.setData({ isLoading: true })
      const res = await wx.cloud.callFunction({
        name: 'myApi',
        data: { action: 'item.list', payload: { id: options?.id } }
      })
      const result = (res as any).result
      if (result.code !== 0) throw new Error(result.message)
      this.setData({ list: result.data, isLoading: false })
    } catch (err) {
      console.error('loadData failed:', err)
      this.setData({ isLoading: false })
      wx.showToast({ title: '加载失败', icon: 'error' })
    }
  },
})
```

### Page 生命周期速查

| 方法 | 必须 | 用途 |
|---|---|---|
| `onLoad(options)` | 是 | 接收参数，初始化数据 |
| `onShow()` | 是 | 页面显示时刷新（返回、Tab 切换） |
| `onReady()` | 否 | 首次渲染完成，可操作 DOM/Canvas |
| `onHide()` | 否 | 页面隐藏（清理定时器、暂停播放） |
| `onUnload()` | 否 | 页面销毁（取消监听、清理资源） |
| `onPullDownRefresh()` | 否 | 下拉刷新（需 json 启用） |
| `onReachBottom()` | 否 | 触底加载更多 |
| `onPageScroll({ scrollTop })` | 否 | 页面滚动（避免频繁 setData） |
| `onShareAppMessage()` | 推荐 | 分享配置（未设置则不可分享） |
| `onShareTimeline()` | 否 | 分享到朋友圈（需基础库 2.11.3+） |
| `onAddToFavorites()` | 否 | 收藏配置 |

---

## Component({}) 模板

```typescript
Component({
  // 外部属性
  properties: {
    itemId: { type: String, value: '' },
    showAction: { type: Boolean, value: true },
  },

  // 内部数据
  data: {
    detail: null as IItem | null,
  },

  // 组件生命周期
  lifetimes: {
    attached() {
      // 组件挂载，可发起请求
      this.loadDetail()
    },
    detached() {
      // 组件销毁，清理资源
    },
  },

  // 所在页面的生命周期
  pageLifetimes: {
    show() {
      // 页面显示时触发
    },
    hide() {
      // 页面隐藏时触发
    },
  },

  // 数据监听器
  observers: {
    'itemId'(newId: string) {
      if (newId) this.loadDetail()
    },
  },

  methods: {
    async loadDetail() {
      const res = await wx.cloud.callFunction({
        name: 'myApi',
        data: { action: 'item.detail', payload: { id: this.data.itemId } }
      })
      this.setData({ detail: (res as any).result.data })
    },

    handleAction() {
      // 向父组件发送事件
      this.triggerEvent('action', { id: this.data.itemId })
    },
  },
})
```

### 组件注册方式

```json
// 页面 .json 中注册（推荐按需注册，避免 app.json 全局注册）
{
  "usingComponents": {
    "item-card": "/components/item-card/item-card"
  }
}
```

```xml
<!-- 使用组件 -->
<item-card item-id="{{item.id}}" bind:action="onItemAction" />
```

### Behaviors（组件复用）

```typescript
// behaviors/pagination.ts — 可被多个组件共享
export const paginationBehavior = Behavior({
  data: { page: 1, hasMore: true },
  methods: {
    nextPage() { this.setData({ page: this.data.page + 1 }) },
    resetPage() { this.setData({ page: 1, hasMore: true }) },
  },
})
// 使用：Component({ behaviors: [paginationBehavior], ... })
```

---

## setData 规范

**官方限制：单次 setData 数据量不超过 1024KB。**

```typescript
// ✅ 路径更新特定字段（高效）
this.setData({ 'list[0].status': 'done' })

// ✅ 批量合并为一次调用
this.setData({
  isLoading: false,
  list: newList,
  'pagination.page': 2,
})

// ❌ 循环调用（每次触发渲染）
for (const item of items) {
  this.setData({ currentItem: item })
}

// ❌ 传递不参与渲染的大对象
this.setData({ rawResponse: hugeObject })
// ✅ 仅 setData 视图所需数据，其余存 this._rawData = hugeObject
```

---

## 事件处理

### 事件绑定类型对比

| 写法 | 冒泡 | 捕获 | 说明 |
|---|---|---|---|
| `bindtap` | 冒泡 | — | 默认绑定 |
| `catchtap` | 阻止冒泡 | — | 阻止事件继续向上 |
| `mut-bind:tap` | 互斥冒泡 | — | 同一冒泡链仅触发一个 mut-bind |
| `capture-bind:tap` | — | 捕获阶段 | 从外到内捕获 |
| `capture-catch:tap` | — | 捕获+中断 | 捕获阶段阻止 |

### dataset vs mark

```xml
<!-- dataset：绑定在当前节点，通过 e.currentTarget.dataset 获取 -->
<view bindtap="handleTap" data-id="{{item.id}}" data-name="{{item.name}}">

<!-- mark：沿事件冒泡路径合并，通过 e.mark 获取 -->
<view mark:section="list">
  <view bindtap="handleTap" mark:id="{{item.id}}">
```

```typescript
handleTap(e: WechatMiniprogram.TouchEvent) {
  const id = e.currentTarget.dataset.id   // dataset
  const id2 = e.mark?.id                  // mark（合并冒泡路径）
  wx.navigateTo({ url: `/pages/detail/detail?id=${id}` })
}
```

---

## TypeScript 规范

- 小程序**仅允许 `.ts` 文件**，禁止 `.js`
- `project.config.json` 中启用：`"setting": { "useCompilerPlugins": ["typescript"] }`
- 推荐 `tsconfig.json`：`{ "compilerOptions": { "strict": true, "target": "ES2017", "module": "CommonJS" } }`
- **注意**：同目录下不可同时存在同名 `.ts` 和 `.js` 文件，会导致编译冲突

---

## 命名规范

| 类型 | 规范 | 示例 |
|---|---|---|
| 页面目录 | kebab-case | `pages/order-detail/` |
| 组件目录 | kebab-case | `components/order-card/` |
| TS 文件 | kebab-case | `utils/date-helper.ts` |
| 类型接口 | I + PascalCase | `IOrder`, `IOrderItem` |
| 页面数据 | camelCase | `isLoading`, `orderList` |
| 事件处理 | handle + 动作 | `handleSubmit`, `handleTap` |
| 云函数 action | module.method | `order.create`, `auth.login` |

---

## App 初始化模式

推荐双阶段模式：缓存恢复（快速展示）→ 服务端同步（数据最新）。

```typescript
// app.ts
App({
  globalData: { userInfo: null as IUserInfo | null },
  onLaunch() {
    wx.cloud.init({ env: 'your-env-id', traceUser: true })
    // 阶段1：缓存恢复
    try {
      const cached = wx.getStorageSync('userInfo')
      if (cached) this.globalData.userInfo = cached
    } catch {}
    // 阶段2：服务端同步
    wx.cloud.callFunction({
      name: 'myApi', data: { action: 'auth.login' }
    }).then((res: any) => {
      if (res.result.code === 0) {
        this.globalData.userInfo = res.result.data
        wx.setStorageSync('userInfo', res.result.data)
      }
    }).catch((err: Error) => console.error('sync failed:', err))
  },
})
```

---

## 简单模式：单函数

适用于简单场景（1-3 个操作的独立函数）：

```javascript
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()

  try {
    const { itemId } = event
    if (!itemId) return { code: -1, message: '参数不完整' }

    // 业务逻辑...
    return { code: 0, message: 'success', data: result }
  } catch (error) {
    console.error(`[${context.functionName}]`, error)
    return { code: -1, message: error.message || '服务器内部错误' }
  }
}
```

---

## 生产模式：Action 路由

适用于多模块 API 网关，一个云函数承载多个路由：

```javascript
const routes = {
  'auth.login':     () => require('./routes/auth').login,
  'order.create':   () => require('./routes/order').create,
  'product.list':   () => require('./routes/product').list,
}

exports.main = async (event, context) => {
  const { action, payload = {} } = event
  const routeLoader = routes[action]
  if (!routeLoader) return { code: -1, message: `未知操作: ${action}` }

  const ctx = {
    event: { ...event, payload },
    context,
    wxContext: cloud.getWXContext(),
    auth: null, result: null,
  }

  try {
    const handler = routeLoader()
    await handler(ctx)
    return { code: 0, message: 'success', data: ctx.result }
  } catch (err) {
    console.error(JSON.stringify({ action, error: err.message }))
    return { code: -1, message: err.message || '服务器内部错误' }
  }
}
```

**核心要点：**
- `action` 格式：`module.method`（如 `order.create`）
- 路由 lazy load：`() => require(...)` 优化冷启动
- 中间件链：auth → validate → handler（详见 [cloud-function-patterns.md](references/cloud-function-patterns.md)）

> 完整模板（含目录结构、中间件、连接池）→ [references/cloud-function-patterns.md](references/cloud-function-patterns.md)

---

## 认证集成

微信小程序认证是**自动的** — 用户打开小程序即完成认证，调用云函数时微信自动注入 OPENID。**无需显式登录流程，禁止生成登录页面。**

```javascript
// 云函数中获取身份
const { OPENID, APPID, UNIONID } = cloud.getWXContext()
// OPENID  — 始终可用，用户在该小程序的唯一标识
// UNIONID — 需绑定微信开放平台，跨应用识别同一用户
```

### 所有权校验

```javascript
const { OPENID } = cloud.getWXContext()
if (OPENID !== event.resourceOwnerId) {
  throw new Error('UNAUTHORIZED: 无权操作')
}
```

> 认证架构参考 `wx-system-architecture` 技能。

---

## 错误处理与响应格式

### 标准响应结构

```typescript
interface ICloudResult<T = any> {
  code: number     // 0=成功, 负数=错误
  message: string  // 人类可读消息
  data?: T         // 返回数据
}
```

### 错误前缀表

| 前缀 | 含义 | 建议 code |
|---|---|---|
| `UNAUTHORIZED` | 身份未验证 | -401 |
| `PERMISSION_DENIED` | 无权限 | -403 |
| `INVALID_PARAMS` | 参数错误 | -400 |
| `PHONE_REQUIRED` | 需绑定手机 | -403 |
| `NOT_FOUND` | 资源不存在 | -404 |
| （无前缀） | 通用错误 | -1 |

### 前端错误链

```typescript
try {
  const res = await wx.cloud.callFunction({ name: 'myApi', data })
  const result = (res as any).result as ICloudResult
  if (result.code !== 0) {
    // 业务错误（参数、权限等）
    wx.showToast({ title: result.message, icon: 'error' })
    return
  }
  // 成功处理...
} catch (err) {
  // 网络/系统级错误
  console.error('callFunction error:', err)
  wx.showToast({ title: '网络异常，请重试', icon: 'error' })
}
```

---

## 常见陷阱速查

| # | 陷阱 | 后果 | 修复 |
|---|---|---|---|
| 1 | iOS `new Date('2025-01-15')` | Invalid Date | 替换 `-` 为 `/` |
| 2 | 页面栈超 10 层 | 导航静默失败 | 用 redirectTo / reLaunch |
| 3 | CloudID 嵌套在 payload 内 | 解密静默失败 | 放 data 顶层 |
| 4 | setData 超 1024KB | 报错或截断 | 路径更新、拆分数据 |
| 5 | 循环 setData | 卡顿掉帧 | 合并为一次调用 |
| 6 | NoSQL 前端 limit 默认 20 | 数据不全 | 显式 `.limit()`；云函数端最大 1000 |
| 7 | 环境变量直接覆盖 | 丢失已有变量 | 先读后合并 |
| 8 | 全局注册组件 | 启动耗时增加 | 页面级 .json 注册 |
| 9 | image 未设 mode | 图片拉伸 | 显式 `mode="aspectFill"` |
| 10 | 云函数运行时 | 创建后不可更改 | 首次选 Nodejs18.15 |

> 每个陷阱的 ❌/✅ 代码对比 → [references/pitfalls.md](references/pitfalls.md)

---

## 参考资源

### 技能内参考文档

| 文件 | 内容 |
|---|---|
| [cloud-function-patterns.md](references/cloud-function-patterns.md) | Action 路由模板、中间件链、连接池、定时触发器、结构化日志 |
| [frontend-patterns.md](references/frontend-patterns.md) | callApi 封装、下拉刷新、无限滚动、EventChannel、CloudID、WXS、AI 模型 |
| [pitfalls.md](references/pitfalls.md) | 平台/性能/云函数陷阱的 ❌/✅ 代码对比 + 交付自检清单 |

### 关联技能

| 技能 | 用途 |
|---|---|
| `wx-ui-design` | WXML/WXSS 布局与样式 |
| `vant-weapp` | Vant Weapp 组件注册与使用 |
| `wx-database-design` | 数据库 Schema 设计 |
| `wx-system-architecture` | 系统架构规划、平台配置、认证模型 |
| `cloudbase-deploy` | 部署工作流与 MCP 工具 |
