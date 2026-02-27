---
name: seed-data
description: |
  适用于测试数据初始化工作流。基于 Drizzle Schema 生成 PostgreSQL 种子数据，
  为集成测试和开发调试提供标准化基础数据集。
  当用户说"初始化测试数据"、"准备种子数据"、"seed"时激活。
argument-hint: '[数据范围：minimal/standard/full]'
user-invocable: true
metadata:
  author: nvoyager
  version: 1.0.0
  title: 测试数据初始化
  description_zh: 基于 Drizzle Schema 的标准化测试数据初始化工作流
---

# 测试数据初始化工作流

为开发和测试环境准备标准化的基础数据集。适用于任何微信小程序 + CloudBase + PostgreSQL（Drizzle ORM）项目。

## 何时使用

- 新开发环境搭建，数据库为空需要初始数据
- 集成测试前需要前置数据（被 `integration-test` 引用）
- 数据库迁移后需要重新填充测试数据
- 用户说"初始化数据"、"seed"、"准备测试数据"

## 使用方法

```bash
/seed-data                    # 标准数据集
/seed-data minimal            # 最小数据集（仅必需数据）
/seed-data full               # 完整数据集（含各种状态的业务数据）
```

## 不适用

- 生产数据导入（生产数据通过正式业务流程写入）
- 数据库 Schema 变更（用 `wx-database-design`）
- 只读外部数据源写入（外部数据源仅做读取验证）

---

## Step 1: 确认环境与范围

### 1.1 确认目标环境

```text
目标数据库：[ ] 开发环境  [ ] 测试环境
⚠️ 严禁在生产环境执行 seed 操作
```

### 1.2 检查数据库连接

```bash
cd db && DATABASE_URL="$DATABASE_URL" npx drizzle-kit studio
```

或通过云函数验证：

```json
{
  "tool": "invokeFunction",
  "envId": "<ENV_ID>",
  "functionName": "<functionName>",
  "params": { "action": "health.check", "payload": {} }
}
```

> **注意：** envId 从 `cloudbaserc.json` 或 `.claude/mcp.json` 中获取。

### 1.3 选择数据范围

| 范围 | 包含内容 | 适用场景 |
|------|----------|----------|
| **minimal** | 核心基础数据（用户、基本配置） | 单接口开发调试 |
| **standard** | minimal + 业务主数据（订单/记录等） | 集成测试（推荐） |
| **full** | standard + 各状态数据 + 边界场景 | 全面回归测试 |

---

## Step 2: 分析数据依赖关系

### 2.1 读取项目 Schema

阅读 `db/schema/` 下的所有表定义，识别：

1. **外键约束** — 确定表之间的依赖关系
2. **枚举值** — 了解所有有效状态
3. **必填字段** — 确定最小数据集
4. **唯一约束** — 避免种子数据冲突

### 2.2 确定写入顺序

根据外键依赖关系，将表分为层级，从无依赖的表开始写入：

```text
Layer 0（无依赖）：
  ├── 用户表
  ├── 配置表
  └── 基础实体表

Layer 1（依赖 Layer 0）：
  └── 关联映射表  → Layer 0 的主键

Layer 2（依赖 Layer 0-1）：
  └── 业务主表   → 用户表、实体表

Layer 3（依赖 Layer 2）：
  ├── 业务子表1  → 业务主表主键
  └── 业务子表2  → 业务主表主键

Layer 4（依赖 Layer 3）：
  └── 详情/明细表 → 业务子表主键
```

> **关键原则：** 按 Layer 顺序写入，确保外键引用的记录已存在。

### 2.3 外部数据源依赖（如适用）

如项目依赖只读外部数据源（如外部 SQL Server、MySQL 等），某些字段需使用外部系统中的**真实 ID**。

**处理方式：**
1. 通过项目已有的查询 action 获取外部系统真实数据
2. 记录关键 ID 用于种子数据中的引用字段
3. 如外部系统不可用，使用占位 ID 并在文档中标注

---

## Step 3: 生成种子数据

### 3.1 Seed 脚本位置

种子数据脚本放在 `db/seed/` 目录下：

```text
db/
├── seed/
│   ├── index.ts          # 种子脚本入口
│   ├── base.ts           # 基础数据（Layer 0）
│   ├── business.ts       # 业务数据（Layer 1-2）
│   ├── detail.ts         # 明细数据（Layer 3-4，standard+）
│   └── cleanup.ts        # 清理脚本
├── schema/
└── migrations/
```

### 3.2 编写种子数据

**Drizzle ORM 插入模板：**

```typescript
import { drizzle } from 'drizzle-orm/node-postgres'
import { users, products } from '../schema'

export async function seedBase(db: ReturnType<typeof drizzle>) {
  // 使用 onConflictDoNothing 实现幂等性
  await db.insert(users).values([
    {
      id: 'test-user-001',
      name: '测试用户A',
      phone: '13800000001',
      status: 'active',
    },
    {
      id: 'test-user-002',
      name: '测试用户B',
      phone: '13800000002',
      status: 'active',
    },
  ]).onConflictDoNothing()

  await db.insert(products).values([
    {
      id: 'test-product-001',
      name: '测试商品A',
      category: '测试分类',
      price: '100.00',
      sortOrder: 1,
    },
  ]).onConflictDoNothing()
}
```

**关键约定：**
- 所有测试数据 ID 使用 `test-` 前缀，便于识别和清理
- 序号类数据使用 `901`-`909` 段，不与业务序号冲突
- 使用 `onConflictDoNothing()` 保证脚本可重复执行
- 金额使用字符串格式（如 `'100.00'`）匹配 `numeric` 类型

### 3.3 种子脚本入口

```typescript
// db/seed/index.ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { seedBase } from './base'
import { seedBusiness } from './business'
import { seedDetail } from './detail'

async function main() {
  const scope = process.argv[2] || 'standard'
  console.log(`Seeding ${scope} dataset...`)

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const db = drizzle(pool)

  try {
    // Layer 0: 基础数据（所有范围都需要）
    await seedBase(db)
    console.log('[OK] Layer 0: base data')

    if (scope === 'standard' || scope === 'full') {
      // Layer 1-3: 业务数据
      await seedBusiness(db)
      console.log('[OK] Layer 1-3: business data')
    }

    if (scope === 'full') {
      // Layer 4+: 详情与边界场景数据
      await seedDetail(db)
      console.log('[OK] Layer 4+: detail data')
    }

    console.log(`\nSeed complete (${scope})`)
  } finally {
    await pool.end()
  }
}

main().catch(console.error)
```

运行方式：

```bash
cd db && DATABASE_URL="$DATABASE_URL" npx tsx seed/index.ts [minimal|standard|full]
```

### 3.4 Full 数据集（standard 基础上追加）

在 standard 基础上额外创建：

- **各状态数据**：为所有枚举状态各创建一条记录，覆盖完整状态机
- **边界场景数据**：空值字段、最大值、最小值等边界条件
- **关联复杂度**：一对多、多对多等复杂关联场景

---

## Step 4: 验证种子数据

### 4.1 数据写入验证

通过 API 调用验证数据已正确写入：

```text
验证清单：
  [ ] 认证接口 → 返回测试用户信息
  [ ] 列表查询 → 返回种子数据
  [ ] 详情查询 → 返回正确字段值
  [ ] 关联查询 → 外键引用正确解析
```

### 4.2 外部数据源可访问性（如适用）

如项目依赖外部只读数据源，确认：

```text
外部数据源验证：
  [ ] 连接正常（通过相关查询 action 验证）
  [ ] 种子数据中引用的外部 ID 存在且有效
  [ ] 外部数据源字段映射正确
```

### 4.3 数据关联完整性

```text
关联检查：
  [ ] 所有外键引用的记录存在
  [ ] 唯一约束未冲突
  [ ] 枚举值均在有效范围内
  [ ] 时间戳字段正确填充
```

---

## Step 5: 数据清理

### 5.1 清理脚本

```typescript
// db/seed/cleanup.ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { sql } from 'drizzle-orm'

async function cleanup() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const db = drizzle(pool)

  try {
    // 按外键依赖逆序删除（从最深层开始）
    // Layer 4+ → Layer 3 → Layer 2 → Layer 1 → Layer 0
    // 示例：
    // await db.execute(sql`DELETE FROM detail_table WHERE id LIKE 'test-%'`)
    // await db.execute(sql`DELETE FROM business_table WHERE id LIKE 'test-%'`)
    // await db.execute(sql`DELETE FROM base_table WHERE id LIKE 'test-%'`)

    console.log('[OK] Test data cleaned up')
  } finally {
    await pool.end()
  }
}

cleanup().catch(console.error)
```

运行方式：

```bash
cd db && DATABASE_URL="$DATABASE_URL" npx tsx seed/cleanup.ts
```

### 5.2 清理原则

- 种子数据使用 `test-` 前缀的 ID，便于批量清理
- 序号类数据使用 `901`-`909` 段，不与业务序号冲突
- 清理顺序必须与写入顺序相反（先删子表再删主表）
- **永远不要 TRUNCATE 整个表**，只删除 `test-` 前缀的记录

---

## 输出摘要

```text
=== 种子数据报告 ===

数据范围：[minimal/standard/full]
目标环境：[envId]

写入数据：
  [表名1]: X 条
  [表名2]: X 条
  ...

外部数据源验证：[可访问/不可访问/不适用]

验证结果：X/Y 通过
```
