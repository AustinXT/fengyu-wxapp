---
name: wx-coding
description: 用于指导微信小程序 + CloudBase 编码实现，覆盖前端 Page/Component 编码标准、云函数开发与部署、微信认证集成、wx.cloud API 调用模式与错误处理规范。
metadata:
  title: 微信小程序编码规范
  author: fengyu
  version: 1.0.0
---

> 编码前请先了解 `.42cog/real.md`（业务约束）和 `.42cog/cog.md`（认知模型）。

## 何时使用此技能

在进行 **微信小程序编码实现** 时使用，包括：

- 编写小程序页面逻辑（Page/Component）
- 开发 CloudBase 云函数
- 集成微信认证（openid/unionid）
- 调用 wx.cloud API（数据库、存储）
- 错误处理与调试

**不适用于：**
- UI 设计和布局（请使用 `wx-ui-design`）
- 数据库表结构设计（请使用 `wx-database-design`）
- 系统架构规划（请使用 `wx-system-architecture`）

---

# 小程序前端编码标准

## Page({}) 模板

```typescript
Page({
  data: {
    isLoading: true,
    list: [] as IItem[]
  },

  onLoad(options: Record<string, string>) {
    this.initData(options)
  },

  onShow() {
    // 页面显示时刷新状态
  },

  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent {
    return {
      title: '分享标题',
      path: '/pages/index/index'
    }
  },

  // === 业务方法 ===

  async initData(options: Record<string, string>) {
    try {
      this.setData({ isLoading: true })
      const result = await wx.cloud.callFunction({
        name: 'getData',
        data: { id: options.id }
      })
      this.setData({
        list: (result as any).result.data,
        isLoading: false
      })
    } catch (err) {
      console.error('initData failed:', err)
      this.setData({ isLoading: false })
      wx.showToast({ title: '加载失败', icon: 'error' })
    }
  }
})
```

### 必须包含的生命周期

| 方法 | 必须 | 用途 |
|---|---|---|
| `onLoad(options)` | 是 | 接收参数，初始化数据 |
| `onShow()` | 是 | 页面显示时刷新 |
| `onShareAppMessage()` | 项目约定 | 分享配置（防止无法分享） |

## setData 规范

```typescript
// 正确：仅更新需要的字段
this.setData({ 'list[0].name': 'new name' })

// 正确：批量更新
this.setData({
  isLoading: false,
  list: newList,
  'pagination.page': 2
})

// 错误：频繁调用 setData
// for (const item of items) { this.setData({ item }) }  // 禁止
```

**setData 最佳实践：**
- 合并多次更新为一次调用
- 使用路径更新（`'list[0].name'`）代替全量替换
- 避免传递大数据（参考值 >256KB 影响性能，实际限制以官方文档为准）

## 事件处理

```xml
<!-- WXML -->
<view bindtap="handleTap" data-id="{{item.id}}">
  <text>{{item.name}}</text>
</view>
```

```typescript
handleTap(e: WechatMiniprogram.TouchEvent) {
  const id = e.currentTarget.dataset.id
  wx.navigateTo({ url: `/pages/detail/detail?id=${id}` })
}
```

## WXS 模块（视图层运算）

适用于视图层需要频繁运算的场景（如格式化、过滤）：

```xml
<wxs module="fmt">
  module.exports = {
    maskPhone: function(phone) {
      if (!phone || phone.length < 11) return phone
      return phone.substring(0, 3) + '****' + phone.substring(7)
    },
    formatPrice: function(price) {
      return (price / 100).toFixed(2)
    }
  }
</wxs>

<text>{{fmt.maskPhone(item.phone)}}</text>
<text>{{fmt.formatPrice(item.price)}}</text>
```

## 命名规范

| 类型 | 规范 | 示例 |
|---|---|---|
| 页面目录 | kebab-case | `pages/order-detail/` |
| 组件目录 | kebab-case | `components/order-card/` |
| TS/JS 文件 | kebab-case | `utils/date-helper.ts` |
| 类型接口 | IPrefix + PascalCase | `IOrder`, `IOrderItem` |
| 页面数据 | camelCase | `isLoading`, `orderList` |
| 事件处理 | handle + 动作 | `handleSubmit`, `handleTap` |

---

# 云函数开发

## 函数结构

```text
cloudfunctions/
└── createOrder/
    ├── index.js        # 入口：exports.main = async (event, context) => {}
    └── package.json    # 依赖声明（wx-server-sdk 使用 "latest"）
```

### 标准模板

```javascript
// cloudfunctions/createOrder/index.js
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()

  try {
    // 1. 参数校验
    const { storeId, items } = event
    if (!storeId || !items?.length) {
      return { code: -1, message: '参数不完整' }
    }

    // 2. 权限校验
    // ...

    // 3. 业务逻辑
    const result = await db.collection('orders').add({
      data: {
        _openid: OPENID,
        storeId,
        items,
        status: '待支付',
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    })

    return { code: 0, message: 'success', data: { orderId: result._id } }
  } catch (error) {
    console.error('createOrder error:', error)
    return { code: -1, message: error.message }
  }
}
```

## 运行时与部署

新项目统一使用 `Nodejs18.15`。函数创建后运行时无法更改，需删除后重建。

**部署流程：**
1. 新函数：使用 `createFunction` MCP 工具，明确指定 `func.runtime`，使用 `force=true` 覆盖已有同名函数
2. 代码更新：使用 `updateFunctionCode` MCP 工具（仅更新代码，无法改运行时）
3. 配置更新：使用 `updateFunctionConfig` MCP 工具（更新超时、环境变量等）
4. `functionRootPath` 为函数目录的**父目录**（如 `cloudfunctions/`），不包含函数名
5. **不要上传 node_modules**，依赖自动安装

**云函数部署权限注意：** AI 自动部署的云函数可能缺少云调用等特殊权限。建议在微信开发者工具中右键点击云函数，选择「云端安装依赖」。对于需要特殊权限的函数（如步数解密），建议通过开发者工具手动部署一次。

## 函数配置

### 超时设置

通过 `func.timeout` 设置（秒），考虑函数执行时间（如 Workfine 同步可能较慢）：

```javascript
{
  timeout: 30  // 默认因运行时而异，单位秒
}
```

### 定时触发器

通过 `func.triggers` 配置，Cron 表达式为 7 个字段（秒 分 时 日 月 周 年）：

```javascript
{
  triggers: [{
    name: 'syncTimer',
    type: 'timer',
    config: '0 0 2 1 * * *'   // 每月1日凌晨2:00
    // '0 30 9 * * * *'       // 每天早上9:30
    // '0 */30 * * * * *'     // 每30分钟
  }]
}
```

使用 `manageFunctionTriggers` MCP 工具创建或删除触发器。

## 环境变量

```javascript
// 设置（通过 MCP 工具或控制台）
{
  envVariables: {
    "DATABASE_URL": "mssql://...",
    "API_KEY": "<your-api-key>"
  }
}

// 使用
const dbUrl = process.env.DATABASE_URL
```

> **更新环境变量时必须先查询当前配置再合并，否则会覆盖丢失已有变量。** 使用 `getFunctionList` 获取当前配置，合并后再调用 `updateFunctionConfig`。

---

# 认证集成

## 核心原理

微信小程序认证是**自动的**：
- 用户打开小程序即完成认证
- 调用云函数时微信自动注入身份信息
- **无需显式登录，禁止生成登录页面**

## 初始化

```typescript
// app.ts — 仅需一次
App({
  onLaunch() {
    wx.cloud.init({
      env: 'your-env-id',
      traceUser: true   // 推荐：追踪用户访问
    })
  }
})
```

## 云函数中获取身份

```javascript
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = async (event, context) => {
  const { OPENID, APPID, UNIONID } = cloud.getWXContext()

  // OPENID — 始终可用，用户在该小程序的唯一标识
  // APPID  — 小程序的应用 ID
  // UNIONID — 可选，需绑定微信开放平台，可用于跨小程序/公众号识别同一用户

  return { openid: OPENID }
}
```

## 授权模式

```javascript
// 模式 1：基于 OPENID 的所有权验证
const { OPENID } = cloud.getWXContext()
if (OPENID !== event.resourceOwnerId) {
  return { code: -1, message: '未授权' }
}

// 模式 2：基于角色的权限校验（如店长判定）
// 从 Workfine 查询：UDF_S_1161='门店经理' AND UDF_S_1624='否'
```

---

# wx.cloud API 模式

## callFunction — 调用云函数

```typescript
const res = await wx.cloud.callFunction({
  name: 'createOrder',
  data: {
    storeId: 'store-001',
    items: [{ serviceId: 's1', quantity: 1 }]
  }
})
console.log(res.result)  // 云函数返回值
```

## database — 数据库直调

```typescript
const db = wx.cloud.database()
const _ = db.command

// 查询
const { data } = await db.collection('orders')
  .where({ status: '已支付' })
  .orderBy('paidAt', 'desc')
  .limit(20)
  .get()

// 实时监听
const watcher = db.collection('orders')
  .where({ storeId: 'store-001' })
  .watch({
    onChange: (snapshot) => { /* 更新 UI */ },
    onError: (err) => { /* 降级轮询 */ }
  })
```

---

# 高级模式

## 废弃 API 迁移指引

以下 API 已被官方标记为废弃，应使用替代 API：

| 废弃 API | 替代 API | 说明 |
|---|---|---|
| `wx.getSystemInfo` | `wx.getWindowInfo` | 窗口信息（屏幕宽高、安全区等） |
| | `wx.getDeviceInfo` | 设备信息（品牌、型号、系统版本） |
| | `wx.getAppBaseInfo` | 应用基础信息（SDKVersion、语言等） |
| | `wx.getSystemSetting` | 系统设置（蓝牙、WiFi、定位开关） |
| `wx.getSystemInfoSync` | 同上分拆 API 的同步版本 | |

```typescript
// 废弃用法
const sysInfo = wx.getSystemInfoSync()
const screenWidth = sysInfo.screenWidth
const platform = sysInfo.platform

// 推荐用法
const windowInfo = wx.getWindowInfo()      // 屏幕尺寸、安全区
const deviceInfo = wx.getDeviceInfo()      // 设备品牌、型号
const appBaseInfo = wx.getAppBaseInfo()    // SDK 版本、语言
```

## 微信步数（WeRun）

**必须使用 CloudID 方式**（基础库 2.7.0+），**禁止使用 session_key 手动解密**：

```typescript
// 前端
try {
  const { cloudID } = await wx.getWeRunData()
  const res = await wx.cloud.callFunction({
    name: 'getWeRunData',
    data: { weRunData: wx.cloud.CloudID(cloudID) }
  })
  // 成功获取步数数据
} catch (err) {
  console.error('获取步数失败，使用兜底数据:', err)
  // 必须实现兜底机制：cloudID 获取失败时使用模拟数据或友好提示
  this.setData({ stepCount: '--', stepError: true })
}

// 云函数：直接访问 event.weRunData.data，无需手动解密
// 检查 event.weRunData.errCode 处理错误
```

## 跨集合操作

**必须通过云函数实现**，前端安全规则无法跨集合：

```javascript
// 云函数中的事务
await db.runTransaction(async (transaction) => {
  const order = await transaction.collection('orders').doc(orderId).get()
  await transaction.collection('orders').doc(orderId).update({
    data: { status: '已支付', paidAt: db.serverDate() }
  })
  await transaction.collection('opLogs').add({
    data: { orderId, action: 'pay', operatorId: OPENID, createdAt: db.serverDate() }
  })
})
```

---

# 错误处理与最佳实践

## 云函数响应格式

```typescript
interface ICloudFunctionResult {
  code: number     // 0=成功, -1=通用错误, 其他自定义
  message: string  // 人类可读消息
  data?: any       // 返回数据
}
```

## 错误处理链

```typescript
// 小程序端
try {
  const res = await wx.cloud.callFunction({ name: 'createOrder', data })
  const result = res.result as ICloudFunctionResult
  if (result.code !== 0) {
    wx.showToast({ title: result.message, icon: 'error' })
    return
  }
  // 成功处理
} catch (err) {
  console.error('网络或系统错误:', err)
  wx.showToast({ title: '网络异常，请重试', icon: 'error' })
}
```

```javascript
// 云函数端
exports.main = async (event, context) => {
  try {
    // 业务逻辑
    return { code: 0, message: 'success', data: result }
  } catch (error) {
    console.error(`[${context.functionName}] Error:`, error)
    return { code: -1, message: error.message || '服务器内部错误' }
  }
}
```

## 调试日志规范

```javascript
// 云函数中使用结构化日志
console.log(JSON.stringify({
  action: 'createOrder',
  openid: OPENID,
  params: { storeId, itemCount: items.length },
  timestamp: new Date().toISOString()
}))
```

## 环境变量安全

- 数据库连接串、API 密钥等**必须**使用环境变量
- **禁止硬编码**敏感信息到代码中
- 更新环境变量时先查询再合并，避免覆盖丢失
