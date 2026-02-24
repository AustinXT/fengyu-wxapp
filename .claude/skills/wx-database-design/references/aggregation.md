# CloudBase 聚合查询

本文档介绍如何在 CloudBase 文档数据库中执行聚合操作，用于数据分析和统计。

## 概述

聚合查询允许你：
- 按特定字段对数据进行分组
- 计算统计值（计数、求和、平均值等）
- 转换和重塑数据
- 执行复杂的数据分析

## 基本聚合语法

```javascript
const result = await db.collection('collectionName')
    .aggregate()
    .group({ /* 分组配置 */ })
    .end();

console.log('结果:', result.list);
```

**注意：** 聚合查询使用 `.end()` 而非 `.get()`

## 数据分组

### 简单分组与计数

按特定字段对文档进行计数：

```javascript
// 按优先级统计待办事项数量
const result = await db.collection('todos')
    .aggregate()
    .group({
        _id: '$priority',  // 按 priority 字段分组
        count: {
            $sum: 1        // 统计每组中的文档数量
        }
    })
    .end();

console.log('按优先级统计:', result.list);
// 输出: [
//   { _id: 'high', count: 15 },
//   { _id: 'medium', count: 23 },
//   { _id: 'low', count: 8 }
// ]
```

### 字段引用语法

使用 `$` 前缀引用文档字段：
- `$priority` - 引用 `priority` 字段
- `$status` - 引用 `status` 字段
- `$user.name` - 引用嵌套字段

## 聚合操作符

### 累加器操作符

| 操作符 | 描述 | 用法 |
|--------|------|------|
| `$sum` | 求和 | `{ total: { $sum: '$amount' } }` |
| `$avg` | 求平均值 | `{ avgScore: { $avg: '$score' } }` |
| `$min` | 最小值 | `{ minPrice: { $min: '$price' } }` |
| `$max` | 最大值 | `{ maxPrice: { $max: '$price' } }` |
| `$first` | 第一个值 | `{ first: { $first: '$date' } }` |
| `$last` | 最后一个值 | `{ last: { $last: '$date' } }` |
| `$push` | 所有值的数组 | `{ items: { $push: '$name' } }` |

## 常见聚合模式

### 按类别计数

```javascript
// 按角色统计用户数量
const result = await db.collection('users')
    .aggregate()
    .group({
        _id: '$role',
        count: { $sum: 1 }
    })
    .end();
```

### 求和与平均值

```javascript
// 按客户计算订单总金额和平均金额
const result = await db.collection('orders')
    .aggregate()
    .group({
        _id: '$customerId',
        totalAmount: { $sum: '$amount' },
        averageAmount: { $avg: '$amount' },
        orderCount: { $sum: 1 }
    })
    .end();
```

### 查找最小值和最大值

```javascript
// 按产品类别查找价格范围
const result = await db.collection('products')
    .aggregate()
    .group({
        _id: '$category',
        minPrice: { $min: '$price' },
        maxPrice: { $max: '$price' },
        avgPrice: { $avg: '$price' }
    })
    .end();
```

### 多字段分组

```javascript
// 按状态和优先级分组
const result = await db.collection('todos')
    .aggregate()
    .group({
        _id: {
            status: '$status',
            priority: '$priority'
        },
        count: { $sum: 1 }
    })
    .end();

// 输出: [
//   { _id: { status: 'active', priority: 'high' }, count: 5 },
//   { _id: { status: 'active', priority: 'low' }, count: 3 },
//   { _id: { status: 'completed', priority: 'high' }, count: 10 }
// ]
```

## 管道阶段

聚合支持在管道中使用多个阶段：

### Match 阶段（过滤）

在分组之前过滤文档：

```javascript
const result = await db.collection('orders')
    .aggregate()
    .match({
        status: 'completed',
        createdAt: db.command.gte(new Date('2025-01-01'))
    })
    .group({
        _id: '$customerId',
        totalRevenue: { $sum: '$amount' }
    })
    .end();
```

### Sort 阶段

对聚合结果进行排序：

```javascript
const result = await db.collection('todos')
    .aggregate()
    .group({
        _id: '$assignee',
        taskCount: { $sum: 1 }
    })
    .sort({
        taskCount: -1  // -1 为降序，1 为升序
    })
    .end();
```

### Limit 阶段

限制返回结果数量：

```javascript
// 按订单数量排名前 10 的客户
const result = await db.collection('orders')
    .aggregate()
    .group({
        _id: '$customerId',
        orderCount: { $sum: 1 }
    })
    .sort({ orderCount: -1 })
    .limit(10)
    .end();
```

### Project 阶段

重塑输出文档：

```javascript
const result = await db.collection('users')
    .aggregate()
    .group({
        _id: '$department',
        employeeCount: { $sum: 1 },
        avgSalary: { $avg: '$salary' }
    })
    .project({
        department: '$_id',
        employees: '$employeeCount',
        averageSalary: '$avgSalary',
        _id: 0  // 从输出中排除 _id
    })
    .end();
```

## 完整管道示例

```javascript
// 综合销售分析
const salesAnalysis = await db.collection('orders')
    .aggregate()
    // 阶段 1：过滤 2025 年已完成的订单
    .match({
        status: 'completed',
        orderDate: db.command.gte(new Date('2025-01-01'))
    })
    // 阶段 2：按产品类别分组
    .group({
        _id: '$category',
        totalRevenue: { $sum: '$amount' },
        orderCount: { $sum: 1 },
        avgOrderValue: { $avg: '$amount' },
        maxOrder: { $max: '$amount' },
        minOrder: { $min: '$amount' }
    })
    // 阶段 3：按收入降序排列
    .sort({
        totalRevenue: -1
    })
    // 阶段 4：限制为前 5 个类别
    .limit(5)
    // 阶段 5：重塑输出
    .project({
        category: '$_id',
        revenue: '$totalRevenue',
        orders: '$orderCount',
        averageValue: '$avgOrderValue',
        range: {
            min: '$minOrder',
            max: '$maxOrder'
        },
        _id: 0
    })
    .end();

console.log('前 5 个类别:', salesAnalysis.list);
```

## 基于时间的聚合

### 按日期分组

```javascript
// 按日期统计订单数量
const result = await db.collection('orders')
    .aggregate()
    .group({
        _id: {
            year: db.command.aggregate.dateToString({
                format: '%Y',
                date: '$createdAt'
            }),
            month: db.command.aggregate.dateToString({
                format: '%m',
                date: '$createdAt'
            })
        },
        orderCount: { $sum: 1 },
        revenue: { $sum: '$amount' }
    })
    .sort({
        '_id.year': 1,
        '_id.month': 1
    })
    .end();
```

## 数组聚合

### 处理数组字段

```javascript
// 展开数组字段进行分析
const result = await db.collection('orders')
    .aggregate()
    .unwind('$items')  // 展开 items 数组
    .group({
        _id: '$items.productId',
        totalQuantity: { $sum: '$items.quantity' },
        totalRevenue: { $sum: '$items.total' }
    })
    .sort({ totalRevenue: -1 })
    .limit(10)
    .end();
```

## 性能优化建议

1. **尽早使用 match**：在分组之前过滤数据以减少处理量
2. **为 match 字段建立索引**：确保 match 阶段使用的字段已建立索引
3. **限制返回结果数量**：使用 limit 减少数据传输
4. **避免过大的分组**：非常大的分组可能影响性能
5. **仅投影需要的字段**：尽早移除不必要的字段

## 常见使用场景

### 仪表盘统计

```javascript
// 获取概览统计数据
const stats = await db.collection('todos')
    .aggregate()
    .group({
        _id: null,  // 单个分组用于整体统计
        total: { $sum: 1 },
        completed: {
            $sum: {
                $cond: [{ $eq: ['$status', 'completed'] }, 1, 0]
            }
        },
        active: {
            $sum: {
                $cond: [{ $eq: ['$status', 'active'] }, 1, 0]
            }
        }
    })
    .end();
```

### 用户活动分析

```javascript
// 分析用户活动
const userActivity = await db.collection('activities')
    .aggregate()
    .match({
        timestamp: db.command.gte(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
    })
    .group({
        _id: '$userId',
        actionCount: { $sum: 1 },
        lastAction: { $max: '$timestamp' },
        actions: { $push: '$actionType' }
    })
    .sort({ actionCount: -1 })
    .limit(20)
    .end();
```

## 错误处理

始终处理聚合错误：

```javascript
try {
    const result = await db.collection('orders')
        .aggregate()
        .group({
            _id: '$category',
            total: { $sum: '$amount' }
        })
        .end();

    if (result.list.length === 0) {
        console.log('未找到数据');
    } else {
        console.log('聚合结果:', result.list);
    }
} catch (error) {
    console.error('聚合失败:', error);
}
```
