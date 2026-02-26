# 云函数高级模式

> 本文档是 `wx-coding` 技能的参考资料，涵盖云函数开发中的生产级模式。

## Action 路由完整模板

### 目录结构

```text
cloudfunctions/
└── myApi/
    ├── index.js              # 入口：路由分发
    ├── package.json
    ├── middleware/
    │   ├── auth.js            # 认证中间件
    │   └── validate.js        # 参数校验中间件
    ├── routes/
    │   ├── auth.js            # auth.login / auth.bindPhone
    │   ├── order.js           # order.create / order.list
    │   └── product.js         # product.categories / product.detail
    └── db/
        └── pg.js              # 外部数据库连接池
```

### 入口文件（index.js）

```javascript
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 路由表：lazy load 优化冷启动
const routes = {
  'auth.login':        () => require('./routes/auth').login,
  'auth.bindPhone':    () => require('./routes/auth').bindPhone,
  'order.create':      () => require('./routes/order').create,
  'order.list':        () => require('./routes/order').list,
  'product.categories':() => require('./routes/product').categories,
}

exports.main = async (event, context) => {
  const { action, payload = {} } = event
  const startTime = Date.now()

  // 1. 路由匹配
  const routeLoader = routes[action]
  if (!routeLoader) {
    return { code: -1, message: `未知操作: ${action}` }
  }

  // 2. 构建上下文
  const ctx = {
    event: { ...event, payload },
    context,
    wxContext: cloud.getWXContext(),
    auth: null,    // 中间件注入
    result: null,  // handler 写入
  }

  try {
    // 3. 加载并执行 handler
    const handler = routeLoader()
    await handler(ctx)

    // 4. 返回结果
    const duration = Date.now() - startTime
    console.log(JSON.stringify({ action, duration, code: 0 }))
    return { code: 0, message: 'success', data: ctx.result }
  } catch (err) {
    const duration = Date.now() - startTime
    console.error(JSON.stringify({
      action, duration, code: -1,
      error: err.message, stack: err.stack
    }))
    return { code: -1, message: err.message || '服务器内部错误' }
  }
}
```

### 前端调用

```typescript
const res = await wx.cloud.callFunction({
  name: 'myApi',
  data: {
    action: 'order.create',
    payload: { storeId: 'xxx', items: [...] }
  }
})
const result = res.result as { code: number; message: string; data: any }
```

## 中间件链

### 认证中间件

```javascript
// middleware/auth.js
const { query } = require('../db/pg')

// 内存缓存：{ openid → { data, expireAt } }
const authCache = new Map()
const CACHE_TTL = 5 * 60 * 1000     // 5 分钟
const CACHE_MAX = 200

async function auth(ctx, next) {
  const { OPENID } = ctx.wxContext
  if (!OPENID) throw new Error('UNAUTHORIZED: 缺少身份信息')

  // 查缓存
  const cached = authCache.get(OPENID)
  if (cached && cached.expireAt > Date.now()) {
    ctx.auth = cached.data
  } else {
    // 查数据库
    const rows = await query(
      'SELECT id, phone, name FROM users WHERE openid = $1', [OPENID]
    )
    if (!rows.length) throw new Error('UNAUTHORIZED: 用户未注册')

    ctx.auth = rows[0]
    // 写缓存（LRU 淘汰）
    if (authCache.size >= CACHE_MAX) {
      const oldest = authCache.keys().next().value
      authCache.delete(oldest)
    }
    authCache.set(OPENID, { data: rows[0], expireAt: Date.now() + CACHE_TTL })
  }

  await next()
}

module.exports = { auth }
```

### 使用中间件

```javascript
// routes/order.js
const { auth } = require('../middleware/auth')
const { requireFields } = require('../middleware/validate')

async function create(ctx) {
  await auth(ctx, async () => {
    requireFields(ctx, 'storeId', 'items')
    // 业务逻辑...
    ctx.result = { orderId: 'xxx' }
  })
}

module.exports = { create }
```

## 参数校验中间件

```javascript
// middleware/validate.js

// 必填字段校验
function requireFields(ctx, ...fields) {
  const { payload } = ctx.event
  const missing = fields.filter(f => payload[f] == null)
  if (missing.length) {
    throw new Error(`INVALID_PARAMS: 缺少参数 ${missing.join(', ')}`)
  }
}

// 类型校验工厂
function validateTypes(ctx, schema) {
  const { payload } = ctx.event
  for (const [field, type] of Object.entries(schema)) {
    if (payload[field] != null && typeof payload[field] !== type) {
      throw new Error(`INVALID_PARAMS: ${field} 应为 ${type}`)
    }
  }
}

module.exports = { requireFields, validateTypes }
```

## 外部数据库连接池

适用于从云函数连接自托管 PostgreSQL / MySQL 等外部数据库。

```javascript
// db/pg.js
const { Pool } = require('pg')

let pool = null   // 延迟初始化

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.PG_CONNECTION_STRING,
      max: 5,                    // serverless 限制并发
      idleTimeoutMillis: 30000,  // 空闲连接超时
      connectionTimeoutMillis: 2000,
    })
    pool.on('error', (err) => console.error('PG pool error:', err))
  }
  return pool
}

async function query(sql, params = []) {
  const client = await getPool().connect()
  try {
    const result = await client.query(sql, params)
    return result.rows
  } finally {
    client.release()   // ✅ 务必释放连接
  }
}

async function transaction(callback) {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

module.exports = { query, transaction }
```

**关键点：**
- `max: 5` — 云函数实例间不共享连接池，过大无意义且浪费资源
- 延迟初始化 — 仅在首次查询时创建，避免冷启动时无用连接
- `finally { client.release() }` — 任何情况下必须归还连接

## 环境变量管理

```javascript
// ❌ 错误：直接覆盖，丢失已有变量
await updateFunctionConfig({
  envVariables: { NEW_VAR: 'value' }
})

// ✅ 正确：先读取再合并
const detail = await getFunctionDetail({ functionName: 'myApi' })
const current = detail.EnvVariables || {}
await updateFunctionConfig({
  envVariables: { ...current, NEW_VAR: 'value' }
})
```

## 定时触发器

CloudBase Cron 表达式为 **7 个字段**（比标准 Cron 多「秒」和「年」）：

```text
秒 分 时 日 月 周 年
```

| 表达式 | 含义 |
|---|---|
| `0 0 2 1 * * *` | 每月1日 02:00 |
| `0 30 9 * * * *` | 每天 09:30 |
| `0 */30 * * * * *` | 每 30 分钟 |
| `0 0 0 * * MON-FRI *` | 工作日零点 |

```javascript
// config.json 或通过 MCP 工具
{
  "triggers": [{
    "name": "dailySync",
    "type": "timer",
    "config": "0 30 9 * * * *"
  }]
}
```

使用 `manageFunctionTriggers` MCP 工具创建或删除触发器。

## 运行时与部署

| 项目 | 说明 |
|---|---|
| 推荐运行时 | `Nodejs18.15` |
| 运行时变更 | **不可变** — 创建后无法修改，需删除重建 |
| node_modules | **不上传** — 云端自动安装依赖 |
| functionRootPath | 函数目录的**父目录**（如 `cloudfunctions/`） |

**部署工具链：**

| 操作 | MCP 工具 |
|---|---|
| 首次创建 | `createFunction`（指定 `func.runtime`，`force=true`） |
| 更新代码 | `updateFunctionCode` |
| 更新配置 | `updateFunctionConfig` |
| 触发器 | `manageFunctionTriggers` |

> 云函数部署后可能缺少云调用等特殊权限。对于需要敏感数据解密（手机号、步数等）的函数，建议在微信开发者工具中手动部署一次。

## 结构化日志

```javascript
// ✅ JSON 格式，便于日志平台检索
console.log(JSON.stringify({
  action: 'order.create',
  openid: OPENID,
  params: { storeId, itemCount: items.length },
  duration: Date.now() - startTime,
  timestamp: new Date().toISOString()
}))

// ❌ 字符串拼接，不利于结构化查询
console.log('order.create by ' + OPENID + ' took ' + duration + 'ms')
```

**日志查询限制：**
- 时间范围不超过 24 小时
- `Offset + Limit <= 10,000`

## 跨集合事务

NoSQL 数据库的跨集合操作**必须通过云函数**，前端安全规则无法跨集合：

```javascript
const db = cloud.database()

await db.runTransaction(async (transaction) => {
  // 1. 读取订单
  const order = await transaction.collection('orders').doc(orderId).get()
  if (order.data.status !== '待支付') {
    await transaction.rollback('订单状态不允许操作')
  }

  // 2. 更新订单
  await transaction.collection('orders').doc(orderId).update({
    data: { status: '已支付', paidAt: db.serverDate() }
  })

  // 3. 写操作日志
  await transaction.collection('opLogs').add({
    data: {
      orderId, action: 'pay',
      operatorId: OPENID,
      createdAt: db.serverDate()
    }
  })
})
```

## HTTP 访问配置

将云函数暴露为 HTTP 端点（适用于 webhook、第三方回调）：

```javascript
// 通过 MCP 工具创建 HTTP 访问
createFunctionHTTPAccess({
  functionName: 'webhook',
  path: '/api/webhook',
  authSwitch: 2  // 2=无需鉴权（公开）, 1=需要鉴权
})
```

URL 格式：`https://{envId}.{region}.app.tcloudbase.com/{path}`
