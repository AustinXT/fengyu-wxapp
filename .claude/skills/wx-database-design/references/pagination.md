# CloudBase 分页查询

本文档介绍如何在 CloudBase 文档数据库中对大数据集实现分页。

## 基本分页概念

分页允许你将大数据集分成更小、更易管理的块（页）来检索。

**关键参数：**
- `pageSize` - 每页记录数
- `pageNum` - 当前页码（从 1 开始）
- `skip()` - 跳过的记录数
- `limit()` - 返回的最大记录数

> **⚠️ limit 限制差异**：小程序端 `.get()` 默认返回 **20** 条，最大只能设为 **20**；云函数端默认 100，最大 1000。小程序端分页 `pageSize` 不可超过 20，需要更大批量请查询通过云函数中转。

## 简单分页实现

### 基本的页码查询

```javascript
const pageSize = 10;  // 每页记录数
const pageNum = 1;    // 当前页码（从 1 开始）

const result = await db.collection('todos')
    .orderBy('createdAt', 'desc')
    .skip((pageNum - 1) * pageSize)
    .limit(pageSize)
    .get();

console.log('Page', pageNum, 'data:', result.data);
```

### 计算公式

```javascript
// 对于第 N 页：
const skip = (pageNum - 1) * pageSize;
const limit = pageSize;
```

## 完整的分页函数

以下是一个可复用的分页函数：

```javascript
/**
 * 对集合进行分页查询
 * @param {string} collectionName - 集合名称
 * @param {number} page - 页码（从 1 开始）
 * @param {number} pageSize - 每页记录数
 * @param {object} whereConditions - 查询条件（可选）
 * @param {string} sortField - 排序字段（可选）
 * @param {string} sortDirection - 'asc' 或 'desc'（可选）
 */
async function paginateCollection(
    collectionName,
    page = 1,
    pageSize = 10,
    whereConditions = {},
    sortField = 'createdAt',
    sortDirection = 'desc'
) {
    const skip = (page - 1) * pageSize;

    let query = db.collection(collectionName);

    // 如果提供了条件则应用
    if (Object.keys(whereConditions).length > 0) {
        query = query.where(whereConditions);
    }

    // 应用排序
    if (sortField) {
        query = query.orderBy(sortField, sortDirection);
    }

    // 应用分页
    const result = await query
        .skip(skip)
        .limit(pageSize)
        .get();

    return {
        data: result.data,
        page: page,
        pageSize: pageSize,
        hasMore: result.data.length === pageSize
    };
}

// 使用方法
const pageData = await paginateCollection('todos', 2, 20, { status: 'active' });
console.log('Page 2 data:', pageData);
```

## 获取总数

要显示"第 X 页，共 Y 页"，你需要获取总数：

```javascript
async function paginateWithCount(collectionName, page, pageSize, whereConditions = {}) {
    const skip = (page - 1) * pageSize;

    // 获取分页数据
    const dataQuery = db.collection(collectionName);
    const countQuery = db.collection(collectionName);

    if (Object.keys(whereConditions).length > 0) {
        dataQuery.where(whereConditions);
        countQuery.where(whereConditions);
    }

    // 同时执行两个查询
    const [dataResult, countResult] = await Promise.all([
        dataQuery
            .orderBy('createdAt', 'desc')
            .skip(skip)
            .limit(pageSize)
            .get(),
        countQuery.count()
    ]);

    const totalCount = countResult.total;
    const totalPages = Math.ceil(totalCount / pageSize);

    return {
        data: dataResult.data,
        pagination: {
            currentPage: page,
            pageSize: pageSize,
            totalCount: totalCount,
            totalPages: totalPages,
            hasNextPage: page < totalPages,
            hasPrevPage: page > 1
        }
    };
}

// 使用方法
const result = await paginateWithCount('todos', 1, 10, { status: 'active' });
console.log(`Page ${result.pagination.currentPage} of ${result.pagination.totalPages}`);
console.log(`Total items: ${result.pagination.totalCount}`);
```

## 游标分页

对于实时数据或需要更好性能的场景，使用游标分页：

```javascript
/**
 * 基于游标的分页，使用字段值作为游标
 */
async function paginateWithCursor(collectionName, cursor = null, pageSize = 10) {
    const _ = db.command;
    let query = db.collection(collectionName);

    // 如果存在游标，查询游标之后的记录
    if (cursor) {
        query = query.where({
            createdAt: _.lt(cursor) // 假设为降序排列
        });
    }

    const result = await query
        .orderBy('createdAt', 'desc')
        .limit(pageSize + 1) // 多取一条以检查是否还有更多数据
        .get();

    const hasMore = result.data.length > pageSize;
    const data = hasMore ? result.data.slice(0, pageSize) : result.data;
    const nextCursor = hasMore ? data[data.length - 1].createdAt : null;

    return {
        data: data,
        nextCursor: nextCursor,
        hasMore: hasMore
    };
}

// 使用方法 - 第一页
const firstPage = await paginateWithCursor('todos', null, 10);
console.log('First page:', firstPage.data);

// 使用游标获取下一页
const secondPage = await paginateWithCursor('todos', firstPage.nextCursor, 10);
console.log('Second page:', secondPage.data);
```

## React 组件示例

以下是如何在 React 组件中实现分页：

```javascript
import { useState, useEffect } from 'react';

function TodoList() {
    const [todos, setTodos] = useState([]);
    const [currentPage, setCurrentPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);
    const [loading, setLoading] = useState(false);
    const pageSize = 10;

    useEffect(() => {
        loadPage(currentPage);
    }, [currentPage]);

    async function loadPage(page) {
        setLoading(true);
        try {
            const result = await paginateWithCount('todos', page, pageSize);
            setTodos(result.data);
            setTotalPages(result.pagination.totalPages);
        } catch (error) {
            console.error('Failed to load todos:', error);
        } finally {
            setLoading(false);
        }
    }

    function goToNextPage() {
        if (currentPage < totalPages) {
            setCurrentPage(currentPage + 1);
        }
    }

    function goToPrevPage() {
        if (currentPage > 1) {
            setCurrentPage(currentPage - 1);
        }
    }

    return (
        <div>
            <h2>待办事项</h2>
            {loading ? (
                <p>加载中...</p>
            ) : (
                <>
                    <ul>
                        {todos.map(todo => (
                            <li key={todo._id}>{todo.title}</li>
                        ))}
                    </ul>

                    <div className="pagination">
                        <button
                            onClick={goToPrevPage}
                            disabled={currentPage === 1}
                        >
                            上一页
                        </button>
                        <span>第 {currentPage} 页，共 {totalPages} 页</span>
                        <button
                            onClick={goToNextPage}
                            disabled={currentPage === totalPages}
                        >
                            下一页
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}
```

## 无限滚动模式

用于无限滚动 UI：

```javascript
function useInfiniteScroll(collectionName, pageSize = 20) {
    const [items, setItems] = useState([]);
    const [cursor, setCursor] = useState(null);
    const [hasMore, setHasMore] = useState(true);
    const [loading, setLoading] = useState(false);

    async function loadMore() {
        if (loading || !hasMore) return;

        setLoading(true);
        try {
            const result = await paginateWithCursor(collectionName, cursor, pageSize);
            setItems(prev => [...prev, ...result.data]);
            setCursor(result.nextCursor);
            setHasMore(result.hasMore);
        } catch (error) {
            console.error('Failed to load more:', error);
        } finally {
            setLoading(false);
        }
    }

    return { items, loadMore, hasMore, loading };
}
```

## 性能注意事项

1. **为排序字段建立索引**：确保 `orderBy()` 中使用的字段已建立索引
2. **合理的每页大小**：通常每页 10-50 条记录为宜
3. **缓存总数**：如果总数不经常变化，可以缓存
4. **skip 的限制**：很大的 `skip()` 值可能会导致查询变慢；考虑使用游标分页
5. **并行查询**：使用 `Promise.all()` 同时执行计数和数据查询

## 最佳实践

1. 始终指定 `orderBy()` 以确保分页结果一致
2. 对实时信息流使用游标分页
3. 适当时缓存页面结果
4. 在页面切换时显示加载状态
5. 优雅处理空结果
6. 验证页码（必须 >= 1）
7. 考虑使用 URL 查询参数来保存分页状态
8. 实现错误处理和重试逻辑
