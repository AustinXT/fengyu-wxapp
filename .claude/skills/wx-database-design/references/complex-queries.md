# CloudBase 复杂查询

本文档详细介绍如何使用 CloudBase 文档数据库构建复杂查询。

## 查询操作符

通过 `db.command` 访问操作符：

```javascript
const _ = db.command;
```

### 比较操作符

| 操作符 | 用法 | 描述 |
|--------|------|------|
| `gt` | `_.gt(value)` | 大于 |
| `gte` | `_.gte(value)` | 大于或等于 |
| `lt` | `_.lt(value)` | 小于 |
| `lte` | `_.lte(value)` | 小于或等于 |
| `eq` | `_.eq(value)` | 等于 |
| `neq` | `_.neq(value)` | 不等于 |

### 数组操作符

| 操作符 | 用法 | 描述 |
|--------|------|------|
| `in` | `_.in([values])` | 值存在于数组中 |
| `nin` | `_.nin([values])` | 值不在数组中 |

## 构建复杂查询

### 多条件查询

在 `where()` 对象中组合多个条件：

```javascript
const result = await db.collection('todos')
    .where({
        // 年龄大于 18
        age: _.gt(18),
        // 标签包含 'tech' 或 'study'
        tags: _.in(['tech', 'study']),
        // 最近一周内创建的
        createdAt: _.gte(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
    })
    .get();
```

### 结果排序

使用 `orderBy()` 对结果进行排序：

```javascript
// 单字段排序
db.collection('posts')
    .orderBy('createdAt', 'desc')
    .get()

// 多字段排序（链式调用多个 orderBy）
db.collection('products')
    .orderBy('category', 'asc')
    .orderBy('price', 'desc')
    .get()
```

**排序方向：**
- `'asc'` - 升序
- `'desc'` - 降序

### 限制结果数量

控制返回结果的数量：

```javascript
// 限制返回 10 条结果
db.collection('posts')
    .limit(10)
    .get()
```

**限制说明：**
- 默认：100 条记录
- 每次查询最多：1000 条记录

### 字段选择

通过只选择需要的字段来优化查询：

```javascript
const result = await db.collection('users')
    .field({
        title: true,        // 包含 title
        completed: true,    // 包含 completed
        createdAt: true,    // 包含 createdAt
        _id: false          // 排除 _id
    })
    .get();
```

**字段选择规则：**
- `true` - 在结果中包含该字段
- `false` - 从结果中排除该字段
- 未指定时，默认包含所有字段

## 完整复杂查询示例

以下是一个组合了所有查询特性的综合示例：

```javascript
const _ = db.command;

const result = await db.collection('todos')
    .where({
        // 状态必须为 'active' 或 'pending'
        status: _.in(['active', 'pending']),
        // 优先级为高
        priority: 'high',
        // 年龄大于 18
        age: _.gt(18),
        // 最近 30 天内创建的
        createdAt: _.gte(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
    })
    .field({
        title: true,
        status: true,
        priority: true,
        assignee: true,
        createdAt: true
    })
    .orderBy('createdAt', 'desc')
    .orderBy('priority', 'asc')
    .limit(50)
    .skip(0)
    .get();

console.log('找到', result.data.length, '条待办事项');
console.log('结果:', result.data);
```

## 查询性能优化建议

1. **使用索引**：为频繁查询的字段创建索引
2. **限制返回字段**：使用 `.field()` 只选择需要的字段
3. **尽早应用过滤**：使用具体的 `where()` 条件减少扫描的数据量
4. **合理设置限制**：不要查询超出需要的数据量
5. **优化排序字段**：尽可能对已建索引的字段进行排序

## 常见查询模式

### 日期范围查询

```javascript
const startDate = new Date('2025-01-01');
const endDate = new Date('2025-12-31');

db.collection('events')
    .where({
        eventDate: _.gte(startDate).and(_.lte(endDate))
    })
    .get()
```

### 文本搜索（精确匹配）

```javascript
// 精确匹配标题
db.collection('articles')
    .where({
        title: 'Specific Title'
    })
    .get()
```

### 多值匹配

```javascript
// 查找具有特定角色的用户
db.collection('users')
    .where({
        role: _.in(['admin', 'moderator', 'editor'])
    })
    .get()
```

### 排除特定值

```javascript
// 查找状态不为草稿或已归档的文章
db.collection('posts')
    .where({
        status: _.nin(['draft', 'archived'])
    })
    .get()
```

### 结合逻辑操作符

```javascript
// 年龄大于 18 或已验证的用户
db.collection('users')
    .where({
        _or: [
            { age: _.gt(18) },
            { verified: true }
        ]
    })
    .get()
```

## 错误处理

始终处理可能的错误：

```javascript
try {
    const result = await db.collection('todos')
        .where({ status: _.in(['active']) })
        .orderBy('priority', 'desc')
        .limit(10)
        .get();

    if (result.data.length === 0) {
        console.log('未找到匹配的文档');
    } else {
        console.log('找到的文档:', result.data);
    }
} catch (error) {
    console.error('查询失败:', error);
    // 适当处理错误
}
```
