---
name: syncing-workfine
description: |
  执行 WorkFine（SQL Server）→ PostgreSQL 单向数据同步。支持全量同步和增量同步两种模式。
  当用户说"同步WorkFine数据"、"sync workfine"、"运行数据同步"、"全量同步"、"增量同步"时激活。
  不适用于：实时数据流、写入 WorkFine、商品手动维护后的重新导入。
metadata:
  author: 42ailab
  version: '1.0'
  title: WorkFine 数据同步
  description_zh: WorkFine SQL Server → PostgreSQL 全量/增量数据同步工作流
user-invocable: true
argument-hint: '[full|sync-only|import-only|incremental|dry-run|verify]'
---

# WorkFine → PostgreSQL 数据同步

## 概述

将 WorkFine（万应低代码平台，SQL Server）数据单向同步到 PostgreSQL。同步脚本位于 `db/scripts/sync-workfine.js`。

连接凭据配置在同步脚本中（支持环境变量覆盖：`MSSQL_SERVER`/`MSSQL_USER`/`MSSQL_PASSWORD`/`MSSQL_DATABASE`/`DATABASE_URL`）。实际值见 `.42cog/pm/workfine-sync.spec.md` §2。

## 使用示例

```bash
cd db
node scripts/sync-workfine.js --dry-run     # 预览模式，不写入
node scripts/sync-workfine.js               # 全量同步 + 商品导入
node scripts/sync-workfine.js --sync-only   # 仅定期同步域（日常使用）
```

## 模式路由

| 用户意图 | 模式 | 命令 |
|----------|------|------|
| 首次同步 / 全量刷新 | full | `node scripts/sync-workfine.js` |
| 仅同步组织/员工/顾客 | sync-only | `node scripts/sync-workfine.js --sync-only` |
| 仅导入商品（一次性） | import-only | `node scripts/sync-workfine.js --import-only` |
| 增量同步（仅变更数据） | incremental | 见 Step 3 增量同步方案 |
| 预览不写入 | dry-run | `node scripts/sync-workfine.js --dry-run` |
| 仅验证数据 | verify | 直接查询 PG 表计数 |

## Step 1: 预检

### 1.1 确认连接

同步脚本内置默认凭据（见 `db/scripts/sync-workfine.js` 头部常量），也支持环境变量覆盖。直接运行脚本即可测试连接——连接成功会打印 `✓ MSSQL 连接成功` 和 `✓ PostgreSQL 连接成功`。

```bash
cd db
node scripts/sync-workfine.js --dry-run   # dry-run 同时验证连接
```

### 1.2 首次同步必须先 dry-run

```bash
node scripts/sync-workfine.js --dry-run
```

## Step 2: 全量同步

直接运行脚本。所有操作幂等（UPSERT），可安全重复执行。

```bash
node scripts/sync-workfine.js
```

**同步顺序（硬约束，脚本已内置）：**

```
1. org_nodes + stores  ← 无依赖
2. employees           ← 依赖 stores
3. permission_roles    ← 依赖 employees + org_nodes（PG 内推导，不查 MSSQL）
4. client_wechat_users ← 依赖 stores
5. product_categories  ← 无依赖（一次性导入）
6. products + skus     ← 依赖 product_categories（一次性导入）
```

**注意：** 商品域（步骤 5-6）是一次性导入。首次导入后由员工手动维护，不应反复 `--import-only`。

## Step 3: 增量同步

WorkFine 表无可靠的 `updated_at` 时间戳，增量同步通过以下策略实现：

### 3.1 基于 PG updated_at 的冷启动预检

云函数冷启动时检查 PG 数据新鲜度，超过阈值则触发同步：

```js
// 在云函数中嵌入的增量检查
async function shouldSync(pg, domain, thresholdHours = 24) {
  const tableMap = { employees: 'employees', customers: 'client_wechat_users', stores: 'stores' }
  const table = tableMap[domain]
  const { rows } = await pg.query(`SELECT MAX(updated_at) AS last FROM ${table}`)
  if (!rows[0].last) return true
  const hoursSince = (Date.now() - new Date(rows[0].last).getTime()) / 3600000
  return hoursSince > thresholdHours
}
```

### 3.2 分域增量

对于大表（如 client_wechat_users 5.7 万条），可按门店分片：

```bash
# 仅同步特定门店的顾客（需在脚本中添加 --store 参数支持）
node scripts/sync-workfine.js --sync-only --store "某某门店"
```

### 3.3 添加增量支持到现有脚本

在 MSSQL 查询中添加时间条件（需确认 WorkFine 表是否有修改时间字段）：

```sql
-- 如果 WorkFine 表有 LastModified 字段（视实际表结构）
SELECT ... FROM UDT_S_287
WHERE LastModified > @lastSyncTime
```

若 WorkFine 无修改时间字段，仍使用全量 UPSERT（幂等安全），但可通过以下优化减少耗时：
- 批量 staging 表模式（已实现，500 行/批）
- `DISTINCT ON` 去重（已实现）
- 跳过无变化记录：`WHERE ... DO UPDATE SET ... WHERE <column> IS DISTINCT FROM EXCLUDED.<column>`

## Step 4: 验证

同步脚本自带 `verify()` 函数，成功执行后自动打印各表行数。也可单独运行验证：

```bash
# 使用同步脚本自带的 PG 连接配置查询计数
node -e "
const { Pool } = require('pg')
const pg = new Pool({ connectionString: process.env.DATABASE_URL || require('./scripts/sync-workfine.js').PG_URL, max: 1 })
// 或直接查询（凭据见 sync-workfine.js 头部 PG_CONFIG）
const tables = ['org_nodes','stores','employees','permission_roles','client_wechat_users','product_categories','products','product_skus']
Promise.all(tables.map(t => pg.query('SELECT count(*) AS cnt FROM ' + t).then(r => t + ': ' + r.rows[0].cnt))).then(r => { r.forEach(l => console.log(l)); pg.end() })
"
```

**期望数量级：** org_nodes ~180, stores ~144, employees ~3200, permission_roles ~2000, client_wechat_users ~56000, product_categories ~30, products ~950, product_skus ~1700

## Step 5: 故障排查

| 错误 | 原因 | 修复 |
|------|------|------|
| `value too long for varchar(N)` | WorkFine 数据超出 PG 列长度 | 查 MSSQL `MAX(LEN(...))` → ALTER TABLE 扩宽 → 更新 schema.ts |
| `ON CONFLICT cannot affect row a second time` | 源数据有重复键（如重复手机号） | 用 `DISTINCT ON (key)` 子查询包装 UPSERT 源 |
| `violates foreign key constraint` | 依赖表未先同步 | 按 Step 2 依赖顺序执行 |
| MSSQL 连接超时 | 网络或 SQL Server 不可用 | 检查 `47.96.87.33:1433` 可达性 |
| PG 事务超时 | 大批量写入锁超时 | 拆分为 `--sync-only` + `--import-only` 分步执行 |

### 检查 WorkFine 字段最大长度

```js
// 替换 UDF_xxx 和 UDT_xxx 为目标字段/表
const { recordset } = await mssqlPool.request().query(`
  SELECT MAX(LEN(RTRIM(UDF_xxx))) AS max_len FROM UDT_xxx
`)
```

## 关键设计决策

| 决策 | 说明 |
|------|------|
| 确定性 ID | `hashId('prefix', ...parts)` = SHA256 前 16 位，保证幂等 |
| 批量写入 | 顾客域用 `CREATE TEMP TABLE` + 批量 INSERT + 批量 UPSERT |
| 不物理删除 | 员工 `is_resigned=true`，门店 `is_closed=true` |
| 权限推导 | 员工同步后自动推导 permission_roles，`created_by='sync'` 标记 |
| 手动数据不覆盖 | permission_roles `created_by != 'sync'` 的行不被覆盖 |
| 微信身份不覆盖 | 顾客 UPSERT 不触碰 openid/session_key/last_login_at/bound_store_id |

## 不适用

- 实时数据同步（本方案为批量 ETL）
- 写入 WorkFine（单向只读同步）
- 商品首次导入后的重新覆盖（手动维护优先）
- commission_rate_matrix 同步（WorkFine 字段待补充）
- WorkFine 历史销售单/护理单迁移（见 spec §9，独立任务）

## 资源

| 文件 | 说明 |
|------|------|
| `db/scripts/sync-workfine.js` | 同步脚本主体 |
| `.42cog/pm/workfine-sync.spec.md` | 完整同步规格文档 |
| `db/schema/*.ts` | Drizzle ORM 表结构定义 |
| [references/field-mapping.md](references/field-mapping.md) | WorkFine → PG 字段映射速查表 |
