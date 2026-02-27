# Drizzle ORM 完整参考

本文档介绍在微信小程序云函数中使用 Drizzle ORM 操作 PostgreSQL 的完整模式。

## 两种使用模式

| 模式 | 适用场景 | 说明 |
|------|---------|------|
| **Schema + Migration + Query** | 云函数用 TypeScript 编写 | Drizzle 全功能使用，类型安全查询 |
| **Schema + Migration only** | 云函数用 CommonJS/JS 编写 | Drizzle 仅用于定义 schema 和生成迁移，运行时用 `pg.query()` 裸 SQL |

第二种模式下，`db/schema/*.ts` 是唯一的 schema 定义源，Drizzle Kit 负责生成迁移 SQL，但云函数中直接用 `pg` 模块执行参数化查询。这种模式在 CloudBase 云函数（默认 CommonJS 运行时）中很常见。

## Drizzle Kit 配置

```typescript
// db/drizzle.config.ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
})
```

## 常用列类型映射

| 业务场景 | Drizzle 类型 | PostgreSQL 类型 |
|----------|-------------|----------------|
| 主键（自增） | `bigserial('id', { mode: 'number' })` | `BIGSERIAL` |
| 主键（文本） | `text('order_no').primaryKey()` | `TEXT PRIMARY KEY` |
| 文本 | `text('name')` | `TEXT` |
| 整数 | `integer('count')` | `INTEGER` |
| 金额 | `numeric('amount', { precision: 12, scale: 2 })` | `NUMERIC(12,2)` |
| 大整数 | `bigint('wf_id', { mode: 'number' })` | `BIGINT` |
| 布尔 | `boolean('is_active')` | `BOOLEAN` |
| 时间戳 | `timestamp('created_at')` | `TIMESTAMP` |
| 日期 | `date('expire_date')` | `DATE` |
| 枚举 | `myEnum('status')` | 自定义 ENUM |

## 枚举定义

```typescript
import { pgEnum } from 'drizzle-orm/pg-core'

// 定义枚举
export const orderStatusEnum = pgEnum('order_status', [
  '待支付', '待确认收款', '已支付', '已完成', '支付失败', '已关闭',
])

export const orderTypeEnum = pgEnum('order_type', ['正式', '体验', '促销方案'])
export const paymentMethodEnum = pgEnum('payment_method', ['wechat', 'offline'])

// 在表中使用
export const orders = pgTable('orders', {
  status: orderStatusEnum('status').notNull().default('待支付'),
  paymentMethod: paymentMethodEnum('payment_method').notNull(),
})
```

## 完整表定义示例

```typescript
import {
  pgTable, text, timestamp, integer, numeric, boolean,
  bigserial, bigint, date,
  index, unique, uniqueIndex,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// 带所有常见特性的表
export const orders = pgTable(
  'orders',
  {
    // 文本主键
    orderNo: text('order_no').primaryKey(),

    // 枚举 + 默认值
    status: orderStatusEnum('status').notNull().default('待支付'),
    orderType: orderTypeEnum('order_type').notNull().default('正式'),

    // 普通文本字段
    marketName: text('market_name').notNull(),
    storeName: text('store_name').notNull(),

    // 可选外键
    clientUserId: text('client_user_id'),

    // 金额字段
    totalAmount: numeric('total_amount', { precision: 12, scale: 2 }).notNull(),

    // 可选时间戳
    paidAt: timestamp('paid_at'),

    // 唯一约束（内联）
    wechatTransactionId: text('wechat_transaction_id').unique(),

    // 自动时间戳
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // 部分唯一索引
    uniqueIndex('uq_orders_client_pending')
      .on(table.clientUserId)
      .where(sql`status = '待支付' AND client_user_id IS NOT NULL`),

    // 复合索引
    index('idx_orders_store_status').on(table.storeName, table.status),

    // 普通索引
    index('idx_orders_client_user_id').on(table.clientUserId),
  ],
)
```

## 外键与引用

```typescript
export const orderItems = pgTable(
  'order_items',
  {
    itemFlowNo: text('item_flow_no').primaryKey(),

    // 必填外键
    orderNo: text('order_no')
      .notNull()
      .references(() => orders.orderNo),

    // 可选外键
    skuId: text('sku_id')
      .references(() => productSpuSkuMap.skuId),

    // 整数外键
    allocationId: bigint('allocation_id', { mode: 'number' })
      .notNull()
      .references(() => revenueAllocations.id),
  },
  (table) => [
    index('idx_order_items_order_no').on(table.orderNo),
  ],
)
```

## 复合唯一约束

```typescript
import { unique } from 'drizzle-orm/pg-core'

export const taskAssignments = pgTable(
  'task_assignments',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orderNo: text('order_no').notNull().references(() => orders.orderNo),
    employeeId: text('employee_id').notNull(),
  },
  (table) => [
    // 复合唯一
    unique('uq_task_assign_order_emp').on(table.orderNo, table.employeeId),
  ],
)
```

## 类型推断

```typescript
// 从 schema 自动推断类型
export type Order = typeof orders.$inferSelect          // SELECT 结果
export type NewOrder = typeof orders.$inferInsert        // INSERT 参数
export type OrderItem = typeof orderItems.$inferSelect
export type NewOrderItem = typeof orderItems.$inferInsert

// 使用示例
async function createOrder(data: NewOrder): Promise<Order> {
  const [order] = await db.insert(orders).values(data).returning()
  return order
}
```

## 查询模式

### 基本 CRUD

```typescript
import { eq, and, or, gt, gte, lt, lte, ne, inArray, isNull, desc, asc, sql } from 'drizzle-orm'

// INSERT
const [newOrder] = await db.insert(orders)
  .values({
    orderNo: 'ORD-WX-250226001',
    status: '待支付',
    storeName: '示例门店',
    totalAmount: '1280.00',
  })
  .returning()

// SELECT 单条
const order = await db.query.orders.findFirst({
  where: eq(orders.orderNo, 'ORD-WX-250226001'),
})

// SELECT 多条 + 条件
const pendingOrders = await db.query.orders.findMany({
  where: and(
    eq(orders.storeName, '示例门店'),
    eq(orders.status, '待支付'),
  ),
  orderBy: [desc(orders.createdAt)],
  limit: 20,
})

// UPDATE
await db.update(orders)
  .set({ status: '已支付', paidAt: new Date() })
  .where(eq(orders.orderNo, 'ORD-WX-250226001'))

// DELETE
await db.delete(orders)
  .where(eq(orders.orderNo, 'ORD-WX-250226001'))
```

### 原子更新（并发安全）

```typescript
// 库存扣减 — 原子操作，禁止先 SELECT 再 UPDATE
const result = await db.update(orderItems)
  .set({
    remainingSessions: sql`remaining_sessions - 1`,
  })
  .where(and(
    eq(orderItems.itemFlowNo, flowNo),
    gt(orderItems.remainingSessions, 0),  // 乐观锁
  ))

if (result.rowCount === 0) {
  throw new Error('扣减失败：余次不足或记录不存在')
}
```

### 条件查询操作符

| Drizzle 操作符 | SQL | 示例 |
|---------------|-----|------|
| `eq(col, val)` | `=` | `eq(orders.status, '已支付')` |
| `ne(col, val)` | `!=` | `ne(orders.status, '已关闭')` |
| `gt(col, val)` | `>` | `gt(orders.createdAt, date)` |
| `gte(col, val)` | `>=` | `gte(items.remainingSessions, 1)` |
| `lt(col, val)` | `<` | `lt(orders.createdAt, date)` |
| `lte(col, val)` | `<=` | `lte(items.unitPrice, '100')` |
| `inArray(col, arr)` | `IN` | `inArray(orders.status, ['已支付', '已完成'])` |
| `isNull(col)` | `IS NULL` | `isNull(orders.clientUserId)` |
| `isNotNull(col)` | `IS NOT NULL` | `isNotNull(orders.paidAt)` |
| `like(col, pat)` | `LIKE` | `like(orders.customerName, '%张%')` |

### 关联查询

```typescript
// 使用 relationalQuery API
const orderWithItems = await db.query.orders.findFirst({
  where: eq(orders.orderNo, orderNo),
  with: {
    items: true,           // 加载关联的 orderItems
    allocations: {         // 嵌套关联
      with: {
        allocationItems: true,
      },
    },
  },
})
```

需先在 schema 中定义 relations：

```typescript
import { relations } from 'drizzle-orm'

export const ordersRelations = relations(orders, ({ many }) => ({
  items: many(orderItems),
  allocations: many(revenueAllocations),
}))

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, {
    fields: [orderItems.orderNo],
    references: [orders.orderNo],
  }),
}))
```

### 分页查询

```typescript
// 偏移分页
async function getOrders(page: number, pageSize: number = 20) {
  const data = await db.query.orders.findMany({
    where: eq(orders.storeName, storeName),
    orderBy: [desc(orders.createdAt)],
    limit: pageSize,
    offset: (page - 1) * pageSize,
  })
  return data
}

// 游标分页（推荐，性能更好）
async function getOrdersCursor(cursor?: string, pageSize: number = 20) {
  const conditions = [eq(orders.storeName, storeName)]
  if (cursor) {
    conditions.push(lt(orders.createdAt, new Date(cursor)))
  }
  return db.query.orders.findMany({
    where: and(...conditions),
    orderBy: [desc(orders.createdAt)],
    limit: pageSize + 1,  // 多取一条判断 hasMore
  })
}
```

### 聚合查询

```typescript
import { count, sum, avg } from 'drizzle-orm'

// 按门店统计订单数和总金额
const stats = await db
  .select({
    storeName: orders.storeName,
    orderCount: count(),
    totalAmount: sum(orders.totalAmount),
  })
  .from(orders)
  .where(eq(orders.status, '已支付'))
  .groupBy(orders.storeName)

// 统计总数
const [{ total }] = await db
  .select({ total: count() })
  .from(orders)
  .where(eq(orders.status, '待支付'))
```

### 原始 SQL

```typescript
// 需要复杂 SQL 时使用 sql 模板
const result = await db.execute(sql`
  SELECT store_name, COUNT(*) as cnt
  FROM orders
  WHERE status = '已支付'
    AND created_at >= ${startDate}
  GROUP BY store_name
  ORDER BY cnt DESC
`)
```

## 事务

```typescript
await db.transaction(async (tx) => {
  // 创建订单
  const [order] = await tx.insert(orders).values(orderData).returning()

  // 创建销售明细
  await tx.insert(orderItems).values(
    items.map(item => ({ ...item, orderNo: order.orderNo }))
  )

  // 如果任何操作失败，整个事务回滚
})
```

## 迁移命令参考

```bash
# package.json scripts
{
  "db:generate": "drizzle-kit generate",   # schema → SQL 迁移文件
  "db:migrate": "drizzle-kit migrate",     # 执行迁移
  "db:push": "drizzle-kit push",           # 开发环境直推
  "db:studio": "drizzle-kit studio"        # Web UI
}
```

### 迁移最佳实践

1. **每次改动只改一个 schema 文件**，生成的迁移更清晰
2. **生成后检查 SQL**：`migrations/` 下的 `.sql` 文件可手动编辑
3. **破坏性变更前备份**：删列、改类型前确认数据可丢弃
4. **枚举新增值**：Drizzle 会自动生成 `ALTER TYPE ... ADD VALUE`
5. **生产环境**：始终用 `db:migrate`（有记录），不用 `db:push`（无记录）
