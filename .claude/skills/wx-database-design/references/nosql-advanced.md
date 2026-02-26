# CloudBase NoSQL 高级查询

本文档介绍聚合管道、分页与实时推送。

## 聚合查询

### 基本语法

```typescript
const result = await db.collection('orders')
  .aggregate()
  .group({ /* 分组配置 */ })
  .end()  // 注意：聚合用 .end()，不是 .get()

console.log('结果:', result.list)
```

### 分组与计数

```typescript
// 按状态统计订单数
const result = await db.collection('orders')
  .aggregate()
  .group({
    _id: '$status',
    count: { $sum: 1 }
  })
  .end()
// [{ _id: '已支付', count: 15 }, { _id: '待支付', count: 8 }]
```

### 累加器操作符

| 操作符 | 描述 | 用法 |
|--------|------|------|
| `$sum` | 求和 | `{ total: { $sum: '$amount' } }` |
| `$avg` | 平均值 | `{ avg: { $avg: '$score' } }` |
| `$min` | 最小值 | `{ min: { $min: '$price' } }` |
| `$max` | 最大值 | `{ max: { $max: '$price' } }` |
| `$first` | 第一个 | `{ first: { $first: '$date' } }` |
| `$last` | 最后一个 | `{ last: { $last: '$date' } }` |
| `$push` | 收集为数组 | `{ items: { $push: '$name' } }` |

### 多字段分组

```typescript
const result = await db.collection('orders')
  .aggregate()
  .group({
    _id: { status: '$status', store: '$storeId' },
    count: { $sum: 1 },
    totalAmount: { $sum: '$amount' }
  })
  .end()
```

### 完整管道示例

```typescript
const analysis = await db.collection('orders')
  .aggregate()
  // 1. 过滤
  .match({
    status: 'completed',
    orderDate: db.command.gte(new Date('2025-01-01'))
  })
  // 2. 分组统计
  .group({
    _id: '$storeId',
    totalRevenue: { $sum: '$amount' },
    orderCount: { $sum: 1 },
    avgOrder: { $avg: '$amount' }
  })
  // 3. 排序
  .sort({ totalRevenue: -1 })
  // 4. 限制
  .limit(10)
  // 5. 投影
  .project({
    store: '$_id',
    revenue: '$totalRevenue',
    orders: '$orderCount',
    average: '$avgOrder',
    _id: 0
  })
  .end()
```

### 展开数组

```typescript
// 展开 items 数组，按商品统计
const result = await db.collection('orders')
  .aggregate()
  .unwind('$items')
  .group({
    _id: '$items.productId',
    totalQuantity: { $sum: '$items.quantity' },
    totalRevenue: { $sum: '$items.total' }
  })
  .sort({ totalRevenue: -1 })
  .limit(10)
  .end()
```

### 整体统计

```typescript
const [stats] = (await db.collection('orders')
  .aggregate()
  .group({
    _id: null,  // 不分组，整体统计
    total: { $sum: 1 },
    paid: {
      $sum: { $cond: [{ $eq: ['$status', '已支付'] }, 1, 0] }
    }
  })
  .end()).list
```

---

## 分页查询

> **limit 差异**：小程序端最大 20，云函数端最大 1000。

### skip/limit 分页

```typescript
const pageSize = 10
const pageNum = 1

const { data } = await db.collection('orders')
  .where({ status: '已支付' })
  .orderBy('createdAt', 'desc')
  .skip((pageNum - 1) * pageSize)
  .limit(pageSize)
  .get()
```

### 带总数的分页

```typescript
async function paginateWithCount(collection, page, pageSize, where = {}) {
  const query = db.collection(collection).where(where)

  const [dataResult, countResult] = await Promise.all([
    query.orderBy('createdAt', 'desc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get(),
    query.count()
  ])

  return {
    data: dataResult.data,
    pagination: {
      currentPage: page,
      pageSize,
      totalCount: countResult.total,
      totalPages: Math.ceil(countResult.total / pageSize),
      hasMore: page < Math.ceil(countResult.total / pageSize)
    }
  }
}
```

### 游标分页（推荐）

```typescript
async function cursorPaginate(collection, cursor, pageSize = 10) {
  const _ = db.command
  let query = db.collection(collection)

  if (cursor) {
    query = query.where({ createdAt: _.lt(cursor) })
  }

  const { data } = await query
    .orderBy('createdAt', 'desc')
    .limit(pageSize + 1)
    .get()

  const hasMore = data.length > pageSize
  const items = hasMore ? data.slice(0, pageSize) : data
  const nextCursor = hasMore ? items[items.length - 1].createdAt : null

  return { data: items, nextCursor, hasMore }
}
```

### 小程序无限滚动

```typescript
// pages/orders/orders.ts
Page({
  data: {
    orders: [] as IOrder[],
    cursor: null as Date | null,
    hasMore: true,
    loading: false,
  },

  onLoad() {
    this.loadMore()
  },

  onReachBottom() {
    this.loadMore()
  },

  async loadMore() {
    if (this.data.loading || !this.data.hasMore) return
    this.setData({ loading: true })

    try {
      const res = await wx.cloud.callFunction({
        name: 'myApi',
        data: {
          action: 'order.list',
          payload: { cursor: this.data.cursor, pageSize: 20 }
        }
      })
      const { data, nextCursor, hasMore } = res.result as any
      this.setData({
        orders: [...this.data.orders, ...data],
        cursor: nextCursor,
        hasMore,
      })
    } finally {
      this.setData({ loading: false })
    }
  }
})
```

### 突破 limit 上限（批量拉取）

```typescript
// 云函数端：批量拉取所有数据（突破 limit 上限）
async function fetchAll(collectionName: string, where = {}) {
  const { total } = await db.collection(collectionName).where(where).count()
  const batchSize = 100  // 云函数最大 100
  const batches = Math.ceil(total / batchSize)
  const tasks = Array.from({ length: batches }, (_, i) =>
    db.collection(collectionName)
      .where(where)
      .skip(i * batchSize)
      .limit(batchSize)
      .get()
  )
  return (await Promise.all(tasks)).flatMap(r => r.data)
}
```

> **注意：** 小程序端 limit 最大 20，云函数端最大 1000（推荐每批 100）。数据量极大时应使用分页而非全量拉取。

---

## 实时推送（watch）

### 基本用法

```typescript
// pages/orders/orders.ts
Page({
  data: { orders: [] as IOrder[] },
  watcher: null as any,

  onLoad() {
    this.watcher = db.collection('orders')
      .where({ storeId: 'store-001', status: '已支付' })
      .watch({
        onChange: (snapshot) => {
          // snapshot.docChanges 包含变更详情
          this.setData({ orders: snapshot.docs })
        },
        onError: (err) => {
          console.error('监听失败:', err)
          // 降级为轮询
        }
      })
  },

  onUnload() {
    // 必须关闭，否则资源泄漏
    this.watcher?.close()
  }
})
```

### 变更类型

```typescript
onChange(snapshot) {
  for (const change of snapshot.docChanges) {
    switch (change.dataType) {
      case 'init':    // 初始数据
      case 'update':  // 文档更新
      case 'add':     // 新增文档
      case 'remove':  // 删除文档
        break
    }
  }
}
```

### 注意事项

1. **必须关闭**：页面卸载时调用 `watcher.close()`
2. **连接数限制**：同一客户端最多 50 个 watch 连接
3. **安全规则**：watch 受安全规则限制，只能监听有权限的数据
4. **降级策略**：网络不稳定时降级为定时轮询
