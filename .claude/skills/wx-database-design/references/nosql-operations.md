# CloudBase NoSQL 操作参考

本文档介绍 CloudBase 文档数据库的 CRUD 操作与复杂查询。

## 创建操作

### 添加单个文档

```typescript
const result = await db.collection('orders').add({
  orderNo: 'FY-001',
  status: '待支付',
  totalAmount: 1280,
  createdAt: new Date(),
  updatedAt: new Date()
})
console.log('文档 ID:', result.id)
```

### 使用自定义 ID

```typescript
// .set() + .doc() 指定 ID，已存在则覆盖
await db.collection('orders')
  .doc('custom-id')
  .set({
    orderNo: 'FY-001',
    status: '待支付',
    createdAt: new Date()
  })
```

### 批量添加

```typescript
const items = [
  { name: '项目A', price: 100 },
  { name: '项目B', price: 200 },
]

// 并行插入
const results = await Promise.all(
  items.map(item => db.collection('products').add(item))
)
```

### 服务端时间戳（serverDate）

> 始终使用 `db.serverDate()` 而非 `new Date()`，避免客户端时钟偏差。

```typescript
// 服务端时间戳（推荐替代 new Date()）
const serverDate = db.serverDate()
await db.collection('orders').add({
  createdAt: serverDate,
  updatedAt: serverDate
})

// 带偏移的服务端时间（如 30 分钟后过期）
const expireAt = db.serverDate({ offset: 30 * 60 * 1000 })
```

## 查询操作

### 单文档查询

```typescript
const { data } = await db.collection('orders').doc('order-id').get()
```

### 条件查询

```typescript
const _ = db.command

const { data } = await db.collection('orders')
  .where({
    status: _.in(['已支付', '已完成']),
    totalAmount: _.gte(100),
    createdAt: _.gte(new Date('2025-01-01'))
  })
  .orderBy('createdAt', 'desc')
  .field({ orderNo: true, status: true, totalAmount: true })
  .limit(20)
  .get()
```

### 查询操作符

| 操作符 | 描述 | 示例 |
|--------|------|------|
| `_.gt(n)` | 大于 | `price: _.gt(100)` |
| `_.gte(n)` | 大于等于 | `price: _.gte(100)` |
| `_.lt(n)` | 小于 | `stock: _.lt(10)` |
| `_.lte(n)` | 小于等于 | `score: _.lte(60)` |
| `_.eq(v)` | 等于 | `status: _.eq('已支付')` |
| `_.neq(v)` | 不等于 | `deleted: _.neq(true)` |
| `_.in([])` | 在数组中 | `role: _.in(['admin', 'editor'])` |
| `_.nin([])` | 不在数组中 | `status: _.nin(['已取消'])` |

### 逻辑组合

```typescript
// OR 查询
const { data } = await db.collection('users')
  .where(_.or([
    { role: 'admin' },
    { level: _.gte(5) }
  ]))
  .get()

// 同字段 AND
const { data } = await db.collection('events')
  .where({
    eventDate: _.gte(startDate).and(_.lte(endDate))
  })
  .get()
```

### 字段选择

```typescript
const { data } = await db.collection('users')
  .field({
    name: true,
    phone: true,
    _id: false  // 排除 _id
  })
  .get()
```

### 排序

```typescript
// 多字段排序
db.collection('products')
  .orderBy('category', 'asc')
  .orderBy('price', 'desc')
  .get()
```

### 嵌套字段查询（点表示法）

```typescript
// 使用点表示法查询嵌套对象字段
const { data } = await db.collection('products')
  .where({ 'style.color': 'red', 'specs.size': _.gte(10) })
  .get()
```

## 更新操作

### 按 ID 更新

```typescript
await db.collection('orders')
  .doc('order-id')
  .update({
    status: '已支付',
    paidAt: new Date(),
    updatedAt: new Date()
  })
```

### 条件更新

```typescript
const result = await db.collection('orders')
  .where({ status: '待支付', storeId: 'store-001' })
  .update({ status: '已关闭', updatedAt: new Date() })
console.log('更新了', result.updated, '条')
```

### 更新操作符

| 操作符 | 描述 | 示例 |
|--------|------|------|
| `_.inc(n)` | 递增 | `views: _.inc(1)` |
| `_.mul(n)` | 乘以 | `price: _.mul(0.8)` |
| `_.push(items)` | 数组追加 | `tags: _.push(['new'])` |
| `_.pull(item)` | 数组移除 | `tags: _.pull('old')` |
| `_.set(value)` | 设置值 | `status: _.set('active')` |
| `_.remove()` | 删除字段 | `tempField: _.remove()` |

### set 与 update 的区别

- **`.update()`** — 仅更新指定字段，其他字段保持不变
- **`.set()`** — 替换整个文档，未指定的字段将被删除

## 删除操作

### 按 ID 删除

```typescript
await db.collection('orders').doc('order-id').remove()
```

### 条件删除

```typescript
// 注意：条件批量删除仅在云函数中可用
// 小程序端只能逐条删除 doc(id).remove()
const result = await db.collection('orders')
  .where({
    status: 'archived',
    createdAt: _.lt(thirtyDaysAgo)
  })
  .remove()  // 仅云函数可用
```

### 软删除模式

```typescript
// 标记删除而非物理删除
await db.collection('orders').doc(id).update({
  deleted: true,
  deletedAt: new Date()
})

// 查询时排除已删除
const { data } = await db.collection('orders')
  .where({ deleted: _.neq(true) })
  .get()
```

## 事务

### 方式一：runTransaction（回调式）

```typescript
await db.runTransaction(async (transaction) => {
  const order = await transaction.collection('orders').doc(orderId).get()
  await transaction.collection('orders').doc(orderId).update({
    views: order.data.views + 1
  })
})
```

### 方式二：startTransaction（手动控制，更灵活）

```typescript
const transaction = await db.startTransaction()
try {
  const order = await transaction.collection('orders').doc(orderId).get()
  await transaction.collection('orders').doc(orderId).update({
    views: order.data.views + 1
  })
  await transaction.commit()
} catch (e) {
  await transaction.rollback()
  throw e
}
```

## 获取总数

```typescript
const { total } = await db.collection('orders')
  .where({ status: '已支付' })
  .count()
```

## 错误处理

```typescript
try {
  const result = await db.collection('orders').add({ title: 'New' })
} catch (error) {
  if (error.code === 'PERMISSION_DENIED') {
    console.error('无权限')
  } else if (error.code === 'INVALID_PARAM') {
    console.error('参数无效')
  } else {
    console.error('未知错误:', error)
  }
}
```
