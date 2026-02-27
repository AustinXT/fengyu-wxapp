---
name: implement-api
description: |
  适用于后端 API 全流程开发工作流。从需求文档出发，完成 Drizzle Schema 设计、
  数据库迁移、云函数路由开发、PG 查询编写、部署与 invokeFunction 验证。
  当用户说"加个接口"、"实现后端 API"、"写云函数"时激活。
argument-hint: '[API 名称或功能描述]'
user-invocable: true
metadata:
  author: nvoyager
  version: 2.0.0
  title: 后端 API 全流程
  description_zh: 从 Schema 设计到部署验证的后端 API 完整开发工作流
---

# 后端 API 全流程开发

从需求理解到 API 部署验证的完整后端开发流程。适用于任何微信小程序 + 腾讯云开发（CloudBase）项目。

## 何时使用

- 需要新增或修改云函数 API 接口
- 涉及数据库 Schema 变更 + API 路由开发
- 用户说"加个接口"、"写后端"、"实现 API"

## 使用方法

```bash
/implement-api 添加用户搜索接口
/implement-api 实现订单退款 API
```

## 不适用

- 仅前端页面修改（用 `wx-ui-design` / `wx-coding`）
- 全栈功能含前端（用 `implement-feature`）
- 线上问题排查（用 `debug-production`）

---

## Step 1: 需求理解

### 1.1 阅读项目需求文档

定位并阅读项目中的需求文档，通常位于：

```text
.42cog/spec/   # 需求文档目录（常见命名：backend_pr.md, client_pr.md 等）
CLAUDE.md      # 项目说明与规范
README.md      # 项目概览
```

> 根据实际项目结构，找到对应的需求文档与约束说明。

### 1.2 确认 API 设计

输出并确认：

```text
目标云函数：<functionName>（如 myApi / adminApi / 其他）
Action 名称：module.method
请求参数：{ param1: type, param2: type }
返回数据：{ field1: type, field2: type }
权限要求：[ ] 无  [ ] 需要手机号  [ ] 需要特定角色
数据源：[ ] PostgreSQL  [ ] 其他外部数据源
是否需要 Schema 变更：[ ] 是  [ ] 否
```

---

## Step 2: 数据库 Schema（如需要）

### 2.1 检查现有 Schema

查看 `db/schema/` 目录下已有的 Schema 文件，了解现有数据模型：

```bash
ls db/schema/
```

重点关注：
- `index.ts` — 导出索引，新表需在此导出
- `enums.ts` — pgEnum 枚举定义
- 其他业务表文件 — 了解已有字段和关联关系

### 2.2 编写 Schema

Drizzle ORM 约定：

```typescript
import { pgTable, serial, text, integer, timestamp, boolean, numeric } from 'drizzle-orm/pg-core'
import { someEnum } from './enums'

export const newTable = pgTable('table_name', {
  id: serial('id').primaryKey(),
  // 业务字段...
  someField: text('some_field').notNull(),
  amount: numeric('amount', { precision: 10, scale: 2 }),
  status: someEnum('status').default('pending'),
  // 时间戳
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})
```

**记得在 `db/schema/index.ts` 中导出新表。**

### 2.3 生成迁移

```bash
cd db && npm run db:generate
```

检查生成的迁移文件：
- `db/migrations/xxxx_xxx.sql` — 确认 SQL 正确
- `db/migrations/meta/_journal.json` — 确认已记录

### 2.4 执行迁移

```bash
cd db && npm run db:migrate    # 生产
# 或
cd db && npm run db:push       # 开发（直接推送，不生成迁移文件）
```

---

## Step 3: 路由 Handler 开发

### 3.1 定位目标文件

云函数路由目录的通用结构：

```text
<project>/cloudfunctions/<functionName>/
├── index.js          # 入口文件（路由分发）
├── routes/           # 路由 Handler 目录
│   ├── module1.js
│   └── module2.js
├── db/
│   └── pg.js         # PostgreSQL 连接
└── middleware/
    ├── auth.js       # 认证中间件
    └── validate.js   # 参数校验中间件
```

> 根据实际项目结构定位对应的云函数目录和路由文件。

### 3.2 编写 Handler

在 `routes/{module}.js` 中添加导出函数：

```javascript
const pg = require('../db/pg')
const { requirePhone } = require('../middleware/auth')
const { requireFields, validateTypes } = require('../middleware/validate')

/**
 * action: module.method
 * payload: { param1, param2 }
 */
exports.method = async (ctx) => {
  // === 1. 参数校验 ===
  const { param1, param2 } = ctx.event.payload
  requireFields(ctx.event.payload, ['param1'])
  validateTypes(ctx.event.payload, { param1: 'string', param2: 'number' })

  // === 2. 权限校验 ===
  await requirePhone(ctx)  // 如需要手机号
  const userId = ctx.auth.userId

  // === 3. 数据查询 ===
  const { rows } = await pg.query(`
    SELECT id, field1, field2
    FROM table_name
    WHERE user_id = $1 AND status = $2
    ORDER BY created_at DESC
  `, [userId, 'active'])

  // === 4. 返回结果 ===
  ctx.result = rows
}
```

### 3.3 事务模式（如需要）

```javascript
await pg.transaction(async (client) => {
  // Advisory lock 防并发（hashtext 将字符串转为 bigint）
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey])

  // 生成序号
  const { rows: [{ next_seq }] } = await client.query(`
    SELECT COALESCE(MAX(daily_seq), 0) + 1 AS next_seq
    FROM orders WHERE DATE(created_at) = CURRENT_DATE
  `)

  // INSERT
  await client.query('INSERT INTO ...', [...])

  // 返回结果
  return { orderNo }
})
```

### 3.4 外部数据源查询（如需要）

如项目需要查询外部数据库（如 SQL Server、MySQL 等只读数据源），遵循以下原则：

- **只读访问**：外部数据源仅用于读取，严禁写入
- **连接池复用**：模块级别维护连接池，避免每次请求新建连接
- **缓存策略**：对不频繁变动的外部数据，使用 TTL Map 缓存减少查询压力

```javascript
const cache = new Map()  // key -> { data, expireAt }
const CACHE_TTL = 5 * 60 * 1000  // 5 分钟

async function getCachedData(key, queryFn) {
  const cached = cache.get(key)
  if (cached && cached.expireAt > Date.now()) return cached.data

  const data = await queryFn()
  cache.set(key, { data, expireAt: Date.now() + CACHE_TTL })
  return data
}
```

---

## Step 4: 注册路由

在云函数 `index.js` 的路由映射表中添加：

```javascript
const routes = {
  // ... 现有路由 ...
  'module.method': () => require('./routes/module').method,
}
```

**确认事项：**
- action 命名格式：`module.method`（小写点分隔）
- 懒加载格式：`() => require('./routes/module').method`
- 如果是新模块文件，确认 `routes/` 目录下文件已创建

---

## Step 5: 部署

### 5.1 部署云函数

使用 `cloudbase-deploy` 技能触发部署：

```text
"部署 <functionName>"
```

对应 MCP 工具：
```json
{
  "tool": "updateFunctionCode",
  "envId": "<ENV_ID>",
  "functionName": "<functionName>",
  "functionRootPath": "/absolute/path/to/<project>/cloudfunctions"
}
```

> **注意：** envId 从 `cloudbaserc.json` 或 `.claude/mcp.json` 中获取。

### 5.2 环境变量检查

如果新接口依赖新的环境变量：
1. `getFunctionConfig` 读取当前配置
2. 合并新变量到现有列表
3. `updateFunctionConfig` 写入完整列表

**绝不直接覆盖环境变量，必须先读后合并。**

---

## Step 6: 验证

### 6.1 invokeFunction 冒烟测试

```json
{
  "tool": "invokeFunction",
  "envId": "<ENV_ID>",
  "functionName": "<functionName>",
  "params": {
    "action": "module.method",
    "payload": { "param1": "testValue" }
  }
}
```

### 6.2 验证清单

- [ ] 返回 `{ code: 0, message: "success", data: ... }`
- [ ] 参数校验：缺少必填参数时返回 `{ code: -400 }`
- [ ] 权限校验：无权限时返回对应错误码
- [ ] 数据正确性：返回数据与预期结构一致
- [ ] 外部数据源仅读取、无写入操作
- [ ] 幂等安全：重复调用不产生副作用

### 6.2.1 错误码映射表

云函数返回的错误码与业务语义对照：

| 业务错误 | 返回 code | 前端处理 |
|---|---|---|
| `UNAUTHORIZED` | `-401` | 提示重新登录 |
| `PHONE_REQUIRED` | `-403` | 弹出手机号授权弹窗 |
| `PERMISSION_DENIED` | `-403` | 提示无权限 |
| `INVALID_PARAMS` | `-400` | 提示参数错误 |
| `NOT_FOUND` | `-404` | 提示资源不存在 |
| 未知错误 | `-1` | 通用错误提示 |

### 6.3 错误排查

如返回错误，使用 MCP 工具查看日志：

```json
{
  "tool": "getFunctionLogs",
  "envId": "<ENV_ID>",
  "functionName": "<functionName>",
  "startTime": "最近时间",
  "endTime": "当前时间"
}
```

找到 RequestId 后获取详细日志：
```json
{
  "tool": "getFunctionLogDetail",
  "envId": "<ENV_ID>",
  "requestId": "从上一步获取"
}
```

---

## 输出摘要

完成后输出：

```text
新增/修改 API：
  - module.method — 功能描述

修改文件：
  - db/schema/xxx.ts
  - db/migrations/xxxx.sql
  - cloudfunctions/<functionName>/routes/xxx.js
  - cloudfunctions/<functionName>/index.js

部署状态：已部署 / 待部署
验证结果：通过 / 需处理
```
