---
name: implement-api
description: |
  适用于后端 API 全流程开发工作流。从需求文档出发，完成 Drizzle Schema 设计、
  数据库迁移、云函数路由开发、PG/WorkFine 查询编写、部署与 invokeFunction 验证。
  当用户说"加个接口"、"实现后端 API"、"写云函数"时激活。
argument-hint: '[API 名称或功能描述]'
user-invocable: true
metadata:
  author: fengyu
  version: 1.0.0
  title: 后端 API 全流程
  description_zh: 从 Schema 设计到部署验证的后端 API 完整开发工作流
---

# 后端 API 全流程开发

从需求理解到 API 部署验证的完整后端开发流程。

## 何时使用

- 需要新增或修改云函数 API 接口
- 涉及数据库 Schema 变更 + API 路由开发
- 用户说"加个接口"、"写后端"、"实现 API"

## 使用方法

```bash
/implement-api 添加客户搜索接口
/implement-api 实现订单退款 API
```

## 不适用

- 仅前端页面修改（用 `wx-ui-design` / `wx-coding`）
- 全栈功能含前端（用 `implement-feature`）
- 线上问题排查（用 `debug-production`）

---

## Step 1: 需求理解

### 1.1 定位需求文档

```text
.42cog/spec/backend_pr.md    # 后端需求
.42cog/spec/client_pr.md     # 客户端需求（了解前端如何调用）
.42cog/spec/staff_pr.md      # 员工端需求
.42cog/cog.md                # 认知模型（实体关系）
.42cog/real.md               # 现实约束（必读）
```

### 1.2 确认 API 设计

输出并确认：

```text
目标端：[ ] clientApi  [ ] staffApi
Action 名称：module.method
请求参数：{ param1: type, param2: type }
返回数据：{ field1: type, field2: type }
权限要求：[ ] 无  [ ] 需要手机号  [ ] 需要店长角色
数据源：[ ] PG  [ ] WorkFine(只读)  [ ] 两者
是否需要 Schema 变更：[ ] 是  [ ] 否
```

---

## Step 2: 数据库 Schema（如需要）

### 2.1 检查现有 Schema

```text
db/schema/
├── index.ts          # 导出索引
├── enums.ts          # pgEnum 枚举定义
├── order.ts          # orders, order_items
├── product.ts        # product_spu, product_spu_sku_map
├── user.ts           # client_wechat_users, staff_wechat_users
├── service.ts        # service_orders, service_items
└── appointment.ts    # appointments
```

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

| 端 | 路由目录 | 入口文件 |
|---|---|---|
| clientApi | `fengyu-client/cloudfunctions/clientApi/routes/` | `index.js` |
| staffApi | `fengyu-staff/cloudfunctions/staffApi/routes/` | `index.js` |

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
  // PG 查询
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

### 3.3 WorkFine 查询模式（如需要）

**必须遵守：WorkFine 只读，严禁写入（real.md 第 1 条）。**

```javascript
const mssql = require('../db/mssql')

async function queryWorkFine(storeWfId) {
  const pool = await mssql.getPool()
  const result = await pool.request()
    .input('storeId', mssql.NVarChar, storeWfId)
    .query(`
      SELECT UDF_S_xxx AS fieldName
      FROM UDT_M_xxx
      WHERE UDF_S_yyy = @storeId
        AND UDF_S_zzz <> '是'
    `)
  return result.recordset
}
```

常用 WorkFine 表（详见 `.42cog/spec/workfine_database.md`）：
- `UDT_M_219` — 门店列表
- `UDT_S_287` — 员工档案
- `UDT_S_311` — 客户档案
- `UDT_M_1281` — 可售项目（全国）
- `UDT_M_1383` — 门店自定义项目
- `UDT_M_341` — 院装产品

### 3.4 事务模式（如需要）

```javascript
await pg.transaction(async (client) => {
  // Advisory lock 防并发
  await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey])

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
"部署 clientApi" 或 "部署 staffApi"
```

对应 MCP 工具：
```json
{
  "tool": "updateFunctionCode",
  "envId": "<ENV_ID>",
  "functionName": "clientApi",
  "functionRootPath": "/absolute/path/to/fengyu-client/cloudfunctions"
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
  "functionName": "clientApi",
  "params": {
    "action": "module.method",
    "payload": { "param1": "testValue" }
  }
}
```

### 6.2 验证清单

- [ ] 返回 `{ code: 0, message: "success", data: ... }`
- [ ] 参数校验：缺少必填参数时返回 `{ code: -400 }`
- [ ] 权限校验：无手机号时返回 `{ code: -403, message: "PHONE_REQUIRED:..." }`
- [ ] 数据正确性：返回数据与预期结构一致
- [ ] real.md 约束：WorkFine 无写入，权限校验到位，幂等安全

### 6.3 错误排查

如返回错误，使用 MCP 工具查看日志：

```json
{
  "tool": "getFunctionLogs",
  "envId": "<ENV_ID>",
  "functionName": "clientApi",
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
  - cloudfunctions/.../routes/xxx.js
  - cloudfunctions/.../index.js

部署状态：已部署 / 待部署
验证结果：通过 / 需处理
```
