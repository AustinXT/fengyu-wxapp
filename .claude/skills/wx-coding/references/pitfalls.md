# 常见陷阱与反模式

> 本文档是 `wx-coding` 技能的参考资料，汇总微信小程序 + CloudBase 开发中的常见陷阱。
> 每个陷阱均包含 ❌ 错误代码 + ✅ 正确代码对比。

## 平台陷阱

### iOS Date 解析

iOS 的 `Date` 构造函数不支持 `-` 分隔的日期字符串。

```typescript
// ❌ iOS 上返回 Invalid Date
const date = new Date('2025-01-15 09:30:00')

// ✅ 替换为 /
const date = new Date('2025-01-15 09:30:00'.replace(/-/g, '/'))

// ✅ 或使用 ISO 格式
const date = new Date('2025-01-15T09:30:00')
```

### 页面栈 10 层限制

`wx.navigateTo` 最多打开 10 层页面，超出后调用静默失败。

```typescript
// ❌ 列表→详情→列表→详情… 很快触达上限
wx.navigateTo({ url: '/pages/detail/detail?id=' + id })

// ✅ 适当使用 redirectTo 替代（不增加栈）
wx.redirectTo({ url: '/pages/detail/detail?id=' + id })

// ✅ Tab 页必须用 switchTab
wx.switchTab({ url: '/pages/home/home' })
```

### cover-view 限制

`cover-view` 仅能覆盖原生组件（`canvas`、`video`、`map`），且：
- 只支持嵌套 `cover-view` 和 `cover-image`
- 不支持大部分 CSS 属性（如 `border-radius` 在部分机型无效）

```xml
<!-- ❌ 用 cover-view 做普通遮罩 -->
<cover-view class="modal">...</cover-view>

<!-- ✅ 仅在覆盖原生组件时使用 -->
<video src="...">
  <cover-view class="play-btn">播放</cover-view>
</video>
```

### image mode 默认值

`<image>` 默认 `mode="scaleToFill"`，会拉伸变形。

```xml
<!-- ❌ 不设 mode，图片变形 -->
<image src="{{url}}" />

<!-- ✅ 显式设置 mode -->
<image src="{{url}}" mode="aspectFill" />
<!-- 或 mode="widthFix" 按宽度自适应 -->
```

## CloudID 陷阱

### CloudID 必须在 data 顶层

CloudID 嵌套在 `payload` 或其他对象内时，微信不会执行解密，**静默返回原始字符串而非解密数据**。

```typescript
// ❌ 嵌套在 payload 内 — 解密静默失败
await wx.cloud.callFunction({
  name: 'myApi',
  data: {
    action: 'auth.bindPhone',
    payload: {
      phoneData: wx.cloud.CloudID(cloudID)   // ❌ 无法解密
    }
  }
})

// ✅ 放在 data 顶层
await wx.cloud.callFunction({
  name: 'myApi',
  data: {
    action: 'auth.bindPhone',
    phoneData: wx.cloud.CloudID(cloudID),     // ✅ 正确位置
    payload: {}
  }
})
```

> 这是最隐蔽的陷阱之一：不会报错，只是解密不生效，`event.phoneData` 收到的是未解密的字符串。

## 性能陷阱

### setData 1024KB 上限

单次 `setData` 数据量不得超过 **1024KB**（官方限制）。超出后会报错或静默截断。

```typescript
// ❌ 循环调用 setData
for (const item of items) {
  this.setData({ currentItem: item })  // 每次触发渲染
}

// ✅ 合并为一次调用
this.setData({ items: allItems })
```

```typescript
// ❌ 全量替换大数组
this.setData({ 'bigList': newBigList })  // 可能超 1024KB

// ✅ 路径更新特定项
this.setData({
  'bigList[3].status': 'done',
  'bigList[3].updatedAt': Date.now()
})
```

### 全局组件注册

在 `app.json` 的 `usingComponents` 中注册的组件会在**每个页面**加载，增加启动耗时。

```json
// ❌ 全局注册不常用组件
// app.json
{
  "usingComponents": {
    "van-popup": "@vant/weapp/popup/index",
    "van-calendar": "@vant/weapp/calendar/index"
  }
}

// ✅ 仅在使用页面的 .json 中注册
// pages/booking/booking.json
{
  "usingComponents": {
    "van-calendar": "@vant/weapp/calendar/index"
  }
}
```

## 云函数陷阱

### 冷启动与连接池

云函数实例可能被回收（冷启动），模块级变量会被重置。

```javascript
// ❌ 假设连接池始终存在
const pool = new Pool({ connectionString: process.env.DB_URL })

// ✅ 延迟初始化 + 错误处理
let pool = null
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DB_URL,
      max: 5,
      connectionTimeoutMillis: 2000
    })
    pool.on('error', (err) => console.error('Pool error:', err))
  }
  return pool
}
```

### NoSQL 查询限制

| 限制 | 前端 SDK | 云函数 SDK |
|---|---|---|
| 默认返回条数 | 20 | 100 |
| 最大返回条数 | 20 | 1000 |
| `.set()` vs `.update()` | `.set()` 全量替换 | `.update()` 局部更新 |

```javascript
// ❌ 期望返回全部数据
const { data } = await db.collection('items').get()
// 前端最多 20 条，云函数最多 100 条

// ✅ 显式设置 limit 并分页
const { data } = await db.collection('items').limit(1000).get()
// 超过 1000 需分批查询
```

### 聚合查询语法

```javascript
// ❌ 聚合查询用 .get()
const result = await db.collection('items')
  .aggregate().group({ _id: '$category' }).get()

// ✅ 聚合查询用 .end()
const result = await db.collection('items')
  .aggregate().group({ _id: '$category' }).end()
```

### 环境变量覆盖

```javascript
// ❌ 直接设置，丢失已有变量
await updateFunctionConfig({
  envVariables: { NEW_VAR: 'value' }
})

// ✅ 先读后合并
const current = (await getFunctionDetail({ functionName })).EnvVariables || {}
await updateFunctionConfig({
  envVariables: { ...current, NEW_VAR: 'value' }
})
```

### 运行时不可变更

创建云函数时的 `runtime` 一旦设定，**无法修改**。错误选择只能删除重建。

---

## 业务逻辑陷阱

### Auth 缓存过期

Auth 中间件有 5 分钟内存缓存。写操作（如 `bindPhone`、`bindStore`）后不清缓存，后续请求在缓存过期前返回旧数据。

```javascript
// ❌ 绑定手机号后未清缓存 → 5 分钟内 ctx.auth.phone 仍为 null
exports.bindPhone = async (ctx) => {
  await auth(ctx, async () => {
    await pg.query('UPDATE users SET phone = $1 WHERE openid = $2', [phone, OPENID])
    ctx.result = { success: true }
  })
}

// ✅ 写操作后立即清除缓存
const { auth, invalidateAuthCache } = require('../middleware/auth')

exports.bindPhone = async (ctx) => {
  await auth(ctx, async () => {
    await pg.query('UPDATE users SET phone = $1 WHERE openid = $2', [phone, OPENID])
    invalidateAuthCache(OPENID)   // ✅ 立即清除
    ctx.result = { success: true }
  })
}
```

### onLoad vs navigateBack

`wx.navigateBack()` 返回上一页时**不触发 onLoad**，只触发 `onShow`。列表页如果只在 `onLoad` 中加载数据，用户从详情页返回后看到的仍是旧数据。

```typescript
// ❌ 仅 onLoad 加载 → navigateBack 返回后数据不刷新
Page({
  onLoad() { this.loadData() },
})

// ✅ onLoad + onShow 双加载
Page({
  onLoad() { this.loadData() },
  onShow() { this.loadData() },  // navigateBack 返回时也触发
})
```

---

## 交付自检清单

发布前逐项确认：

| # | 检查项 | 说明 |
|---|---|---|
| 1 | iOS Date 兼容 | 所有 `new Date()` 使用 `/` 或 ISO 格式 |
| 2 | setData 合并 | 无循环 setData、无超 1024KB 单次传输 |
| 3 | 页面栈管理 | 深层导航使用 redirectTo/reLaunch |
| 4 | CloudID 顶层 | 敏感数据 CloudID 在 data 顶层 |
| 5 | image mode | 所有 `<image>` 显式设置 mode |
| 6 | wx:key | 所有 `wx:for` 设置 wx:key |
| 7 | 连接池释放 | 数据库 client 在 finally 中 release |
| 8 | 环境变量合并 | 更新 envVariables 先读后合并 |
| 9 | 错误处理 | 云函数 try/catch、前端 showToast 兜底 |
| 10 | NoSQL limit | 前端查询显式设置 limit |
| 11 | TypeScript | 所有 .ts 文件，无 .js |
| 12 | 组件按需注册 | 组件在页面级 .json 注册，非 app.json |
| 13 | Auth 缓存 | 写操作后调用 invalidateAuthCache(OPENID) |
| 14 | onShow 刷新 | Tab/列表页在 onShow 中也加载数据 |
