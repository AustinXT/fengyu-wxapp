---
name: wx-database-design
description: |
  用于帮助设计和操作微信小程序 + CloudBase 数据库。覆盖三种选型
  （NoSQL 文档数据库、CloudBase MySQL、外部 PostgreSQL + Drizzle ORM），
  帮助生成 schema 定义、编写 CRUD 查询、配置安全规则与执行数据库迁移。
  Use when designing database schemas, writing queries, or managing migrations.
  当用户需要设计表结构、编写数据库查询、配置安全规则、执行数据迁移时激活。
metadata:
  title: 微信小程序数据库设计
  author: fengyu
  version: 1.0.0
  description_zh: 微信小程序三种数据库选型与操作指南
---

## 何时使用此技能

在进行 **微信小程序数据库设计与操作** 时使用，包括：

- 选择数据库方案（NoSQL / CloudBase MySQL / 外部 PostgreSQL）
- 设计 Drizzle ORM schema 或 NoSQL 集合结构
- 执行数据库迁移（generate → migrate → push）
- 编写云函数中的数据库查询
- 配置数据库安全规则
- 连接外部数据库（PostgreSQL、SQL Server 等）

**不适用于：**
- 前端页面开发（请使用 `wx-ui-design` / `wx-coding`）
- 云函数路由与部署（请使用 `wx-coding` / `cloudbase-deploy`）
- Web 端数据库操作

---

# 数据库选型决策框架

## 三种方案对比

| 维度 | CloudBase NoSQL | CloudBase MySQL | 外部 SQL（PostgreSQL 等） |
|------|----------------|-----------------|--------------------------|
| **数据结构** | 灵活 schema，嵌套文档 | 严格 schema，关系表 | 严格 schema，关系表 |
| **实时推送** | `.watch()` 实时监听 | 不支持 | 不支持 |
| **ORM 支持** | 无（SDK 直操作） | 数据模型 SDK | Drizzle / Prisma / Knex |
| **TypeScript** | 手动 interface | 手动 interface | Drizzle 自动类型推断 |
| **迁移管理** | 无（无 schema） | 手动 DDL | Drizzle Kit 自动迁移 |
| **事务** | `db.runTransaction` | 原生 ACID | 原生 ACID |
| **安全规则** | 支持前端直调 | 支持前端直调 | 仅云函数访问 |
| **适用场景** | 实时数据、watch 推送 | 简单关系、前端直调 | 复杂业务、类型安全 |

## 选型建议

```text
需要前端直调数据库？
├── 是 → 需要实时推送（watch）？
│   ├── 是 → CloudBase NoSQL
│   └── 否 → CloudBase MySQL
└── 否（云函数中转）→ 外部 SQL（推荐 PostgreSQL + Drizzle ORM）
```

**常见组合模式：**
- **纯 NoSQL**：适合简单 CRUD、实时聊天、状态监听
- **纯外部 SQL**：适合复杂业务逻辑、强类型需求、多表关联
- **混合模式**：主数据源存外部 SQL，实时状态用 NoSQL watch 推送

---

# 外部 SQL 数据库（PostgreSQL + Drizzle ORM）

适用于通过云函数访问外部 PostgreSQL（或 MySQL）的场景。

## 项目结构

```text
db/
├── schema/           # Schema 定义（唯一真相源）
│   ├── index.ts      # 统一导出
│   ├── enums.ts      # pgEnum 枚举定义
│   ├── user.ts       # 用户表
│   ├── order.ts      # 订单及关联表
│   └── ...
├── migrations/       # 自动生成的迁移文件
├── drizzle.config.ts # Drizzle Kit 配置
└── package.json      # db:generate / db:migrate / db:push
```

## Schema 定义规范

### 枚举

```typescript
import { pgEnum } from 'drizzle-orm/pg-core'

// 中文枚举值 — 与业务语义一致，前端可直接展示
export const orderStatusEnum = pgEnum('order_status', [
  '待支付', '已支付', '已完成', '已关闭',
])
```

### 表定义

```typescript
import {
  pgTable, text, timestamp, integer, numeric,
  index, unique, uniqueIndex,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export const orders = pgTable(
  'orders',
  {
    orderNo: text('order_no').primaryKey(),
    status: orderStatusEnum('status').notNull().default('待支付'),
    storeName: text('store_name').notNull(),
    clientUserId: text('client_user_id'),
    totalAmount: numeric('total_amount', { precision: 12, scale: 2 }).notNull(),
    paidAt: timestamp('paid_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // 普通索引
    index('idx_orders_store_status').on(table.storeName, table.status),
    // 部分唯一索引（条件唯一）
    uniqueIndex('uq_orders_client_pending')
      .on(table.clientUserId)
      .where(sql`status = '待支付' AND client_user_id IS NOT NULL`),
  ],
)
```

### 类型推断

```typescript
// 自动生成 TypeScript 类型，无需手写 interface
export type Order = typeof orders.$inferSelect    // 查询结果类型
export type NewOrder = typeof orders.$inferInsert  // 插入参数类型
```

### 外键引用

```typescript
export const orderItems = pgTable('order_items', {
  itemFlowNo: text('item_flow_no').primaryKey(),
  orderNo: text('order_no')
    .notNull()
    .references(() => orders.orderNo),  // 外键引用
  skuId: text('sku_id')
    .references(() => productSpuSkuMap.skuId),  // 可选外键
})
```

## 迁移工作流

```bash
cd db

# 1. 修改 schema/*.ts 后生成迁移文件
npm run db:generate    # → migrations/XXXX_xxx.sql

# 2. 执行迁移（生产环境）
npm run db:migrate     # 按顺序执行未应用的迁移

# 3. 直接推送 schema（开发环境，跳过迁移文件）
npm run db:push

# 4. 可视化查看数据
npm run db:studio
```

**迁移注意事项：**
- 生成的 SQL 文件可手动审查和编辑
- 生产环境始终使用 `db:migrate`，不要用 `db:push`
- 破坏性变更（删列、改类型）需人工确认迁移 SQL

## 云函数中连接外部数据库

```typescript
// cloudfunctions/myApi/src/db.ts
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from '../../../db/schema'

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,          // 云函数并发受限，连接池不宜过大
  idleTimeoutMillis: 30000,
})

export const db = drizzle(pool, { schema })
```

**连接池建议：**
- 云函数冷启动会创建新连接，`max` 设 3-5
- 设置 `idleTimeoutMillis` 避免僵尸连接
- 连接字符串通过环境变量传入，不硬编码

## 只读外部数据库（如 SQL Server / WorkFine）

```typescript
import sql from 'mssql'

const pool = new sql.ConnectionPool({
  server: process.env.WF_HOST!,
  database: process.env.WF_DB!,
  user: process.env.WF_USER!,
  password: process.env.WF_PASS!,
  options: { encrypt: false, trustServerCertificate: true },
})

// 只读查询，不写入
export async function queryWorkFine<T>(query: string): Promise<T[]> {
  const conn = await pool.connect()
  try {
    const result = await conn.request().query(query)
    return result.recordset as T[]
  } finally {
    conn.release()
  }
}
```

详见 [Drizzle ORM 完整参考](references/drizzle-orm.md)

---

# CloudBase NoSQL 文档数据库

## 初始化

```typescript
// 小程序端
const db = wx.cloud.database()
const _ = db.command

// 云函数端
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
```

## 集合命名规范

- 使用 **camelCase**（如 `orders`、`serviceRecords`）
- 建议添加项目前缀（如 `fy_orders`），避免与其他项目冲突

## 类型定义

```typescript
interface IOrder {
  _id: string
  _openid: string
  orderNo: string
  status: '待支付' | '已支付' | '已取消'
  items: IOrderItem[]
  totalAmount: number
  createdAt: Date
  updatedAt: Date
}
```

## limit 差异（关键陷阱）

| 调用环境 | 默认 limit | 最大 limit |
|----------|-----------|-----------|
| **小程序端** | 20 | **20** |
| **云函数端** | 100 | 1000 |

超过 20 条数据必须通过云函数中转。

## 常用操作速查

| 查询 | 更新 |
|------|------|
| `_.gt(n)` 大于 | `_.inc(n)` 递增 |
| `_.gte(n)` 大于等于 | `_.mul(n)` 乘以 |
| `_.in([])` 在数组中 | `_.push([])` 数组追加 |
| `_.nin([])` 不在数组中 | `_.pull(v)` 数组移除 |
| `_.eq(v)` 等于 | `_.set(v)` 设置值 |
| `_.neq(v)` 不等于 | `_.remove()` 删除字段 |

## 实时推送（watch）

```typescript
const watcher = db.collection('orders')
  .where({ storeId: 'store-001', status: '已支付' })
  .watch({
    onChange(snapshot) {
      console.log('数据变更：', snapshot.docChanges)
    },
    onError(err) {
      console.error('监听失败：', err)
    }
  })

// 页面卸载时关闭
watcher.close()
```

## 服务端时间戳

> **时间戳：** 始终使用 `db.serverDate()` 而非 `new Date()`，避免客户端时钟偏差。

```typescript
const serverDate = db.serverDate()
await db.collection('orders').add({
  createdAt: serverDate,
  updatedAt: serverDate
})
```

## 突破 limit 上限（批量拉取）

超过 20 条数据必须通过云函数中转，云函数中可批量拉取：

```typescript
// 云函数端：批量拉取所有数据
const { total } = await db.collection('orders').count()
const batches = Math.ceil(total / 100)
const tasks = Array.from({ length: batches }, (_, i) =>
  db.collection('orders').skip(i * 100).limit(100).get()
)
const results = (await Promise.all(tasks)).flatMap(r => r.data)
```

## 批量删除限制

> **批量删除：** 小程序端只能 `doc(id).remove()` 单条删除；条件批量删除 `.where({}).remove()` 仅云函数可用。

详见 [NoSQL 操作参考](references/nosql-operations.md) | [NoSQL 高级查询](references/nosql-advanced.md)

---

# CloudBase MySQL

## 操作方式

CloudBase MySQL 分两种操作场景：DDL 管理用 MCP 工具，应用查询用数据模型 SDK。

**DDL / 管理操作**（通过 MCP 工具）：

| 工具 | 用途 |
|------|------|
| `executeReadOnlySQL` | SELECT 查询 |
| `executeWriteSQL` | INSERT/UPDATE/DELETE/DDL |
| `readSecurityRule` | 读取安全规则 |
| `writeSecurityRule` | 设置安全规则 |

## 建表规范

```sql
CREATE TABLE orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  _openid VARCHAR(64) DEFAULT '' NOT NULL,  -- 必须包含
  order_no VARCHAR(50) NOT NULL UNIQUE,
  total_amount DECIMAL(10,2) NOT NULL,
  status ENUM('待支付','已支付','已取消') DEFAULT '待支付',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

> `_openid` 由服务器自动填充，INSERT 时无需手动设置。

## 数据模型 SDK

```typescript
// 小程序端
const { initHTTPOverCallFunction } = require('@cloudbase/wx-cloud-client-sdk')
const client = initHTTPOverCallFunction(wx.cloud)

const result = await client.models.orders.list({
  filter: { where: { status: { $eq: '已支付' } } },
  pageSize: 20,
  pageNumber: 1
})
```

```typescript
// 云函数端（@cloudbase/node-sdk）
const cloudbase = require('@cloudbase/node-sdk')
const app = cloudbase.init({ env: cloudbase.DYNAMIC_CURRENT_ENV })
const result = await app.models.orders.list({
  filter: { where: { status: { $eq: '已支付' } } },
  pageSize: 20,
  pageNumber: 1
})
```

**关键：** MySQL 数据模型**不能**使用 `db.collection()`，**必须**使用 `app.models.modelName`。

---

# 安全规则

## 配置流程

```text
创建集合/表 → 配置安全规则 → 等待缓存清除(约 2-5 分钟) → 编写代码 → 测试
```

## 规则类型速查

| 规则 | 读 | 写 | 适用场景 |
|------|----|----|----------|
| `READONLY` | 所有人 | 创建者/管理员 | 商品列表、服务项目 |
| `PRIVATE` | 创建者/管理员 | 创建者/管理员 | 操作日志 |
| `ADMINWRITE` | 所有人 | 管理员 | 公告、系统数据 |
| `ADMINONLY` | 管理员 | 管理员 | 敏感配置 |
| `CUSTOM` | 自定义 | 自定义 | 用户订单（只读自己的） |

## CUSTOM 规则示例

```json
{
  "read": "auth.openid == doc._openid",
  "write": "auth.openid == doc._openid"
}
```

**关键：** 云函数拥有管理员权限，不受安全规则限制。

---

# 数据建模最佳实践

1. **类型定义先行**：Drizzle 用 schema + `$inferSelect`；NoSQL 用 TypeScript interface
2. **安全规则前置**：NoSQL/MySQL 编码前配置好安全规则
3. **读多冗余**：常读字段（如顾客姓名）冗余存储，减少关联查询
4. **写多引用**：营业额分配等关系通过 ID 引用，不冗余
5. **索引覆盖**：所有 `WHERE` 条件和 `ORDER BY` 字段必须建索引
6. **事务保护**：涉及金额、库存、次卡核销等操作使用事务
7. **原子更新**：并发扣减用 `UPDATE ... SET remaining = remaining - n WHERE remaining >= n`，禁止先 SELECT 再 UPDATE
8. **枚举一致**：数据库枚举值与前端展示文案保持一致，减少映射逻辑
9. **快照字段**：订单中的价格、门店名等使用快照，防止源数据变更影响历史记录
10. **软删除**：重要业务数据用 `is_void` / `deleted_at` 标记，不物理删除

---

## 参考资源

- [Drizzle ORM 完整参考](references/drizzle-orm.md) — Schema 定义、迁移、类型、查询模式
- [NoSQL 操作参考](references/nosql-operations.md) — CRUD、复杂查询、事务
- [NoSQL 高级查询](references/nosql-advanced.md) — 聚合管道、分页、实时推送
- [地理位置查询](references/geolocation.md) — Point/Polygon、geoNear/geoWithin
