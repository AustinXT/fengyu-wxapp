# 云函数模式参考

> `wx-coding` 技能参考资料。仅包含项目特有模式，标准 pg/Node.js 用法省略。

## Auth LRU 缓存

中间件使用内存 Map 缓存用户数据（5 分钟 TTL，上限 200 条，FIFO 淘汰）。

```javascript
// middleware/auth.js
const authCache = new Map()
const CACHE_TTL = 5 * 60 * 1000
const CACHE_MAX = 200

async function auth(ctx, next) {
  const { OPENID } = ctx.wxContext
  if (!OPENID) throw new Error('UNAUTHORIZED: 缺少身份信息')

  const cached = authCache.get(OPENID)
  if (cached && cached.expireAt > Date.now()) {
    ctx.auth = cached.data
  } else {
    const rows = await query('SELECT ... FROM users WHERE openid = $1', [OPENID])
    if (!rows.length) throw new Error('UNAUTHORIZED: 用户未注册')
    ctx.auth = rows[0]
    if (authCache.size >= CACHE_MAX) {
      authCache.delete(authCache.keys().next().value)
    }
    authCache.set(OPENID, { data: rows[0], expireAt: Date.now() + CACHE_TTL })
  }
  await next()
}

function invalidateAuthCache(openid) {
  authCache.delete(openid)
}

module.exports = { auth, invalidateAuthCache }
```

### 必须调用 invalidateAuthCache 的时机

- `auth.bindPhone` — 绑定手机号后
- `auth.bindStore` — 绑定门店后
- 任何修改用户表的写操作

## N+1 查询预防

循环逐条查询 → 批量 IN 查询 + Map 分组。

```javascript
// ❌ N+1
for (const order of orders) {
  const items = await pg.query('SELECT * FROM order_items WHERE order_id = $1', [order.id])
  order.items = items
}

// ✅ 批量查询 + Map 分组
const orderIds = orders.map(o => o.id)
const allItems = await pg.query(
  'SELECT * FROM order_items WHERE order_id = ANY($1)', [orderIds]
)
const itemMap = new Map()
for (const item of allItems) {
  if (!itemMap.has(item.order_id)) itemMap.set(item.order_id, [])
  itemMap.get(item.order_id).push(item)
}
for (const order of orders) {
  order.items = itemMap.get(order.id) || []
}
```

## 测试模式 (_testOpenid)

`invokeFunction` 不注入 OPENID。Auth 中间件支持 `payload._testOpenid` 作为 fallback：

```javascript
async function auth(ctx, next) {
  let OPENID = ctx.wxContext.OPENID
  // 仅在 OPENID 为空时生效（invokeFunction 调用）
  if (!OPENID && ctx.event.payload?._testOpenid) {
    OPENID = ctx.event.payload._testOpenid
  }
  if (!OPENID) throw new Error('UNAUTHORIZED: 缺少身份信息')
  // ...
}
```

**使用：** invokeFunction 时传 `"_testOpenid": "oXXXX_real_openid_from_db"`。小程序端微信注入 OPENID 后 `_testOpenid` 不会覆盖。

## 环境变量管理

```javascript
// ❌ 直接覆盖 → 丢失已有变量
await updateFunctionConfig({ envVariables: { NEW_VAR: 'value' } })

// ✅ 先读后合并
const detail = await getFunctionDetail({ functionName: 'myApi' })
const current = detail.EnvVariables || {}
await updateFunctionConfig({ envVariables: { ...current, NEW_VAR: 'value' } })
```

## 定时触发器

CloudBase Cron 表达式为 **7 个字段**（比标准多「秒」和「年」）：

```text
秒 分 时 日 月 周 年
```

| 表达式 | 含义 |
|---|---|
| `0 0 2 1 * * *` | 每月1日 02:00 |
| `0 30 9 * * * *` | 每天 09:30 |
| `0 */30 * * * * *` | 每 30 分钟 |
| `0 0 0 * * MON-FRI *` | 工作日零点 |

## 运行时与部署

| 项目 | 说明 |
|---|---|
| 推荐运行时 | `Nodejs18.15` |
| 运行时变更 | **不可变** — 创建后无法修改，需删除重建 |
| node_modules | **不上传** — 云端自动安装依赖 |

**部署工具链（MCP）：**

| 操作 | MCP 工具 |
|---|---|
| 首次创建 | `createFunction`（指定 `func.runtime`，`force=true`） |
| 更新代码 | `updateFunctionCode` |
| 更新配置 | `updateFunctionConfig` |
| 触发器 | `manageFunctionTriggers` |

> 需要敏感数据解密（手机号、步数等）的函数，建议在微信开发者工具中手动部署一次以获取云调用权限。
