# CloudBase 增删改查操作

本文档介绍 CloudBase 文档数据库的创建、更新和删除操作。

## 创建操作

### 添加单个文档

向集合中添加一个新文档：

```javascript
// 添加单个文档
const result = await db.collection('todos').add({
    title: 'Learn CloudBase',
    description: 'Study the database API',
    completed: false,
    priority: 'high',
    createdAt: new Date()
});

console.log('Added document with ID:', result.id);
```

**返回值：**
```javascript
{
    id: "generated-doc-id",  // 自动生成的文档 ID
    // ... 其他元数据
}
```

### 使用自定义 ID 添加

指定自定义文档 ID：

```javascript
// 使用自定义 ID 添加
const result = await db.collection('todos')
    .doc('custom-todo-id')
    .set({
        title: 'Custom ID Todo',
        completed: false,
        createdAt: new Date()
    });
```

**注意：** 使用 `.set()` 配合 `.doc()` 来指定自定义 ID。如果文档已存在，将被覆盖。

### 批量添加文档

一次添加多个文档：

```javascript
// 批量添加文档
const todos = [
    { title: 'Task 1', completed: false },
    { title: 'Task 2', completed: false },
    { title: 'Task 3', completed: true }
];

// 逐个添加
for (const todo of todos) {
    await db.collection('todos').add(todo);
}

// 或使用 Promise.all 并行插入
const results = await Promise.all(
    todos.map(todo => db.collection('todos').add(todo))
);

console.log('Added', results.length, 'documents');
```

### 数据验证

在插入前验证数据：

```javascript
function validateTodo(todo) {
    if (!todo.title || todo.title.trim() === '') {
        throw new Error('Title is required');
    }
    if (typeof todo.completed !== 'boolean') {
        throw new Error('Completed must be a boolean');
    }
    return true;
}

async function addTodo(todoData) {
    try {
        validateTodo(todoData);

        const result = await db.collection('todos').add({
            ...todoData,
            createdAt: new Date(),
            updatedAt: new Date()
        });

        return result;
    } catch (error) {
        console.error('Failed to add todo:', error);
        throw error;
    }
}
```

## 更新操作

### 通过文档 ID 更新

通过 ID 更新指定文档：

```javascript
// 通过 ID 更新
const result = await db.collection('todos')
    .doc('todo-id-123')
    .update({
        completed: true,
        updatedAt: new Date()
    });

console.log('Updated:', result.updated, 'document(s)');
```

**返回值：**
```javascript
{
    updated: 1,  // 更新的文档数量
    // ... 其他元数据
}
```

### 条件更新

更新符合特定条件的文档：

```javascript
// 更新所有未完成的高优先级待办事项
const result = await db.collection('todos')
    .where({
        completed: false,
        priority: 'high'
    })
    .update({
        priority: 'urgent',
        updatedAt: new Date()
    });

console.log('Updated', result.updated, 'documents');
```

### 部分更新

仅更新指定字段（其他字段保持不变）：

```javascript
// 仅更新标题，其他字段保持不变
await db.collection('todos')
    .doc('todo-id-123')
    .update({
        title: 'Updated Title'
    });
```

### 使用更新操作符

使用更新操作符进行复杂更新：

```javascript
const _ = db.command;

// 递增计数器
await db.collection('posts')
    .doc('post-123')
    .update({
        views: _.inc(1)  // 将浏览数加 1
    });

// 向数组中添加元素
await db.collection('todos')
    .doc('todo-123')
    .update({
        tags: _.push(['urgent'])  // 向 tags 数组添加 'urgent'
    });

// 从数组中移除元素
await db.collection('todos')
    .doc('todo-123')
    .update({
        tags: _.pull('completed')  // 从 tags 中移除 'completed'
    });

// 乘以一个数值
await db.collection('products')
    .doc('product-123')
    .update({
        price: _.mul(1.1)  // 价格上涨 10%
    });
```

### 常用更新操作符

| 操作符 | 描述 | 示例 |
|--------|------|------|
| `_.inc(n)` | 递增 n | `views: _.inc(1)` |
| `_.mul(n)` | 乘以 n | `price: _.mul(1.5)` |
| `_.push(items)` | 向数组添加元素 | `tags: _.push(['new'])` |
| `_.pull(item)` | 从数组移除元素 | `tags: _.pull('old')` |
| `_.set(value)` | 设置为指定值 | `status: _.set('active')` |
| `_.remove()` | 删除字段 | `tempField: _.remove()` |

### set 与 update 的区别

**`.update()`** - 仅更新指定字段：
```javascript
// 仅更新 'title'，其他字段保持不变
await db.collection('todos')
    .doc('todo-123')
    .update({ title: 'New Title' });
```

**`.set()`** - 替换整个文档：
```javascript
// 替换整个文档，未指定的字段将被删除
await db.collection('todos')
    .doc('todo-123')
    .set({ title: 'New Title', completed: false });
```

### 批量更新

高效更新多个文档：

```javascript
// 更新分配给某用户的所有未完成待办事项
async function reassignTodos(oldUserId, newUserId) {
    const result = await db.collection('todos')
        .where({
            assigneeId: oldUserId,
            completed: false
        })
        .update({
            assigneeId: newUserId,
            updatedAt: new Date()
        });

    return result.updated;
}

const updatedCount = await reassignTodos('user-1', 'user-2');
console.log('Reassigned', updatedCount, 'todos');
```

## 删除操作

### 通过文档 ID 删除

删除指定文档：

```javascript
// 通过 ID 删除
const result = await db.collection('todos')
    .doc('todo-id-123')
    .remove();

console.log('Deleted:', result.deleted, 'document(s)');
```

**返回值：**
```javascript
{
    deleted: 1,  // 删除的文档数量
    // ... 其他元数据
}
```

### 条件删除

删除符合条件的文档：

```javascript
// 删除所有超过 30 天的已完成待办事项
const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

const result = await db.collection('todos')
    .where({
        completed: true,
        completedAt: db.command.lt(thirtyDaysAgo)
    })
    .remove();

console.log('Deleted', result.deleted, 'old completed todos');
```

### 带条件的删除

仅在满足条件时删除：

```javascript
async function deleteTodoIfOwner(todoId, userId) {
    try {
        const result = await db.collection('todos')
            .where({
                _id: todoId,
                ownerId: userId  // 仅当用户是所有者时才删除
            })
            .remove();

        if (result.deleted === 0) {
            throw new Error('Todo not found or user is not owner');
        }

        return true;
    } catch (error) {
        console.error('Delete failed:', error);
        return false;
    }
}
```

### 批量删除

删除多个文档：

```javascript
// 删除所有已归档的项目
async function deleteArchived() {
    const result = await db.collection('todos')
        .where({
            status: 'archived'
        })
        .remove();

    return result.deleted;
}

const deletedCount = await deleteArchived();
console.log('Deleted', deletedCount, 'archived items');
```

### 软删除模式

不永久删除，而是标记为已删除：

```javascript
// 软删除 - 标记为已删除而非真正移除
async function softDeleteTodo(todoId) {
    const result = await db.collection('todos')
        .doc(todoId)
        .update({
            deleted: true,
            deletedAt: new Date()
        });

    return result.updated > 0;
}

// 仅查询未删除的项目
async function getActiveTodos() {
    const result = await db.collection('todos')
        .where({
            deleted: db.command.neq(true)  // 或者: deleted: false
        })
        .get();

    return result.data;
}
```

## 完整增删改查示例

### 待办事项管理器

```javascript
class TodoManager {
    constructor(db) {
        this.db = db;
        this.collection = db.collection('todos');
    }

    // 创建
    async createTodo(title, description, priority = 'medium') {
        const result = await this.collection.add({
            title,
            description,
            priority,
            completed: false,
            createdAt: new Date(),
            updatedAt: new Date()
        });
        return result.id;
    }

    // 读取（单个）
    async getTodo(id) {
        const result = await this.collection.doc(id).get();
        return result.data[0];
    }

    // 读取（多个）
    async getTodos(filter = {}) {
        const result = await this.collection
            .where(filter)
            .orderBy('createdAt', 'desc')
            .get();
        return result.data;
    }

    // 更新
    async updateTodo(id, updates) {
        const result = await this.collection
            .doc(id)
            .update({
                ...updates,
                updatedAt: new Date()
            });
        return result.updated > 0;
    }

    // 切换完成状态
    async toggleComplete(id) {
        const todo = await this.getTodo(id);
        return this.updateTodo(id, {
            completed: !todo.completed,
            completedAt: !todo.completed ? new Date() : null
        });
    }

    // 删除
    async deleteTodo(id) {
        const result = await this.collection.doc(id).remove();
        return result.deleted > 0;
    }

    // 批量操作
    async deleteCompleted() {
        const result = await this.collection
            .where({ completed: true })
            .remove();
        return result.deleted;
    }
}

// 使用方法
const todoManager = new TodoManager(db);

// 创建
const todoId = await todoManager.createTodo(
    'Learn CloudBase',
    'Study the database API',
    'high'
);

// 读取
const todo = await todoManager.getTodo(todoId);
const allTodos = await todoManager.getTodos({ completed: false });

// 更新
await todoManager.updateTodo(todoId, { priority: 'urgent' });
await todoManager.toggleComplete(todoId);

// 删除
await todoManager.deleteTodo(todoId);
await todoManager.deleteCompleted();
```

## 错误处理最佳实践

```javascript
async function safeCRUD() {
    try {
        // 创建
        const result = await db.collection('todos').add({
            title: 'New Todo'
        });

        console.log('Created:', result.id);

    } catch (error) {
        if (error.code === 'PERMISSION_DENIED') {
            console.error('No permission to create document');
        } else if (error.code === 'INVALID_PARAM') {
            console.error('Invalid data provided');
        } else {
            console.error('Unexpected error:', error);
        }

        throw error;  // 重新抛出错误让调用者处理
    }
}
```

## 事务支持

对于需要原子性的操作（全部成功或全部失败）：

```javascript
// 查阅 CloudBase 文档了解事务 API
// 事务确保数据一致性
await db.runTransaction(async transaction => {
    // 读取
    const todo = await transaction.collection('todos').doc('id').get();

    // 基于读取结果进行更新
    await transaction.collection('todos').doc('id').update({
        views: todo.data.views + 1
    });
});
```

## 最佳实践

1. **始终处理错误**：将操作包裹在 try-catch 中
2. **验证输入**：在执行数据库操作前检查数据
3. **更新时间戳**：跟踪 createdAt 和 updatedAt
4. **使用事务**：对于必须同时成功的关联操作
5. **批量操作**：尽可能使用批量更新/删除
6. **软删除**：对重要数据考虑使用软删除
7. **建立索引**：为频繁查询/更新的字段建立索引
8. **限制更新范围**：仅更新已变更的字段
9. **测试权限**：确保数据库安全规则允许相关操作
10. **记录操作日志**：跟踪重要的数据变更
