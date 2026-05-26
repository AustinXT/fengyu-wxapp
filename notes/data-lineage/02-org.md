# 02 — `org` 模块

**Schema 文件**：`db/schema/org.ts`
**涉及 PG 表**：`org_nodes`, `stores`
**WorkFine 源表**：`UDT_M_219` 门店主数据（150 行有效数据）
**主要写入入口**：
- `db/scripts/sync-workfine.js:L114-205` — `syncOrgNodesAndStores`（同步入口；UPSERT 模式定期执行直到 2026-04-16 停用）
- `db/migrations/0012_skinny_valkyrie.sql` — 增加 `closed_at` 列 + 4 段兜底 UPDATE（T4-A/T4-B 关于 stores）

**PG 现状**（5434/fengyu，2026-04-26 探查）：
| 表 | 总行数 | 备注 |
|----|-------|------|
| org_nodes | 549 = 总部 1 + 市场 24 + 门店 148 + 部门 376 | 部门由 syncEmployees 创建（推断自员工 dept_name） |
| stores | 148 | WorkFine 端 150 valid（差 2 行，原因未确认） |

> **WorkFine 一表 UDT_M_219 → PG 多表派生**：syncOrgNodesAndStores 把单表展开成"总部 + 市场（去重）+ 门店"三层 org_nodes 树 + stores 详情表。**id 全部由 `hashId(...parts)` 派生**（sync-workfine.js:L45，sha256 前 16 字符），不来自 WorkFine。

---

## 表 1：`org_nodes`（4 类节点统一表）

org_nodes 行可分 4 类：总部 / 市场 / 门店 / 部门。每类来源逻辑不同，分别说明。

### 列级血缘

| PG 列 | 类型 | 来源类别 | WorkFine 字段 / 计算式 / 默认值 | 出处 | 备注 |
|------|------|---------|---------------------------------|------|------|
| id | text (PK) | 新系统派生 | `hashId('org', <type>, ...keys)` 取 sha256 前 16 字符 | sync-workfine.js:L140 (HQ), L152 (market), L169 (store), L267 (store-dept), L281 (global-dept) | **不来自 WorkFine**：纯派生 ID。每类节点的 hashId 输入：HQ=`('org','headquarters','总部')`；市场=`('org','market', market_name)`；门店=`('org','store', store_name)`；门店级部门=`('org','department', store_name, dept_name)`；全局部门=`('org','department', dept_name)` |
| name | text | WorkFine 直拷 | 总部=硬编码 `'总部'`；市场=`RTRIM(UDT_M_219.UDF_M_437)`；门店=`RTRIM(UDT_M_219.UDF_M_438)`；部门=`UDT_S_287.UDF_S_1513`（员工的 dept_name） | sync-workfine.js:L140-148, L165, L266, L281 | 部门名来自员工档案派生（详见 03-user 文档） |
| type | org_node_type enum | WorkFine 派生 | 硬编码：HQ=`'总部'`、市场=`'市场'`、门店=`'门店'`、部门=`'部门'` | sync-workfine.js:L143/156/175/271/283 | enum 4 值 |
| parent_id | text | WorkFine 派生 | 总部=NULL；市场=hqId；门店=marketIdMap[market_name]；门店级部门=store 节点 id；全局部门=hqId | sync-workfine.js:L140/158/170/268/279 | 树结构由代码逻辑决定，**不来自 WorkFine** |
| sort_order | integer | WorkFine 派生 | HQ=`0`；市场=数组下标（`for i in markets`）；门店/部门=`0` | sync-workfine.js:L143/158/175/271/283 | 市场顺序仅取决于扫描时遍历顺序，不稳定 |
| is_active | boolean | 默认值/NULL | 硬编码 `true` | sync-workfine.js (全部 INSERT) | 没有"非活跃节点"概念；WorkFine 闭店表现在 stores.is_closed 而不是 org_nodes.is_active |
| created_at | timestamp | 新系统独立 | `defaultNow()` | schema:L26 | INSERT 时间，与业务无关 |
| updated_at | timestamp | 新系统独立 | `defaultNow()` + onUpdate；UPSERT 时强制 `now()` | schema:L27 + sync UPSERT 子句 | 每次同步都会 bump |

### 已被脚本读但未对接到 PG 的 WorkFine 列

UDT_M_219 共 16 列，sync-workfine.js 仅用了 5 列（UDF_M_437/438/1777/8590/11956）。其中 UDF_M_437/438 用于 org_nodes，UDF_M_1777/8590/11956 用于 stores。剩余 11 列**未对接到 org_nodes 也未对接到 stores**，详见下表（与 stores 章节合并列出，避免重复）。

---

## 表 2：`stores`（门店详情，1:1 扩展 org_nodes type='门店'）

### 列级血缘

| PG 列 | 类型 | 来源类别 | WorkFine 字段 / 计算式 / 默认值 | 出处 | 备注 |
|------|------|---------|---------------------------------|------|------|
| store_id | text (PK) | 新系统派生 | `hashId('store', store_name)` | sync-workfine.js:L180 | 与 org_nodes.id（type='门店'）派生算法不同，store_id 只用 `('store', store_name)` 两段，所以 store_id ≠ org_node_id（同一门店两个 hash） |
| store_name | text (UNIQUE) | WorkFine 直拷 | `RTRIM(UDT_M_219.UDF_M_438)` | sync-workfine.js:L121, L165, L183 | |
| org_node_id | text (FK → org_nodes.id) | 新系统派生 | `hashId('org', 'store', store_name)`（即 org_nodes 中该门店节点的 id） | sync-workfine.js:L169, L183 | 反向回到 org_nodes 树 |
| opening_date | date | WorkFine 直拷 + 兜底 | ① `UDT_M_219.UDF_M_1777` → YYYY-MM-DD；② migration 0012:L33 `UPDATE stores SET opening_date = created_at::date WHERE opening_date IS NULL`（兜底） | sync-workfine.js:L122, L192 + 0012:L32-35 | 兜底命中数：本库历史上有部分 NULL 行被回填为 created_at::date |
| bed_count | integer | WorkFine 直拷 | `UDT_M_219.UDF_M_8590 \|\| null`（0 → null 应用层未做，传 0 则存 0；脚本写法 `row.bed_count \|\| null` 把 0 当 falsy） | sync-workfine.js:L123, L192 | **PG 现状：仅 5/148 行非 NULL** — WorkFine 端 UDF_M_8590 大量为 0 被脚本判断为 falsy 写入 NULL |
| is_closed | boolean | WorkFine 派生 | `toBool(UDT_M_219.UDF_M_11956)`（`'是'` → true，其他 → false） | sync-workfine.js:L124, L181, L192 | PG 现状：closed=16, open=132 |
| closed_at | date | ⚠️ 派生 + 兜底（不来自 WorkFine UDF_M_11957） | migration 0012:L26-29 兜底回填：`UPDATE stores SET closed_at = updated_at::date WHERE is_closed = TRUE AND closed_at IS NULL` | `0012_skinny_valkyrie.sql:L25-29` | **关键发现**：UDT_M_219 有 datetime 列 `UDF_M_11957`（17 行非空，疑似闭店日期），但 sync-workfine.js **未抽取**。PG 的 16 行 closed_at 全部由 0012 migration 用 stores.updated_at 回填，**不是真实的闭店日期** |
| cover_image | text | 新系统独立 | NULL / admin 手工维护 | — | PG 现状：0/148 行非空 |
| images | text[] | 新系统独立 | NULL / admin 手工维护 | — | PG 现状：1/148 行非空 |
| district | text | 新系统独立 | NULL / admin 手工维护 | — | PG 现状：5/148 行非空 |
| street_address | text | 新系统独立 | NULL / admin 手工维护 | — | PG 现状：4/148 行非空 |
| latitude / longitude | numeric | 新系统独立 | NULL / admin 手工维护（geocode 接口可能写） | — | PG 现状：4/148 行非空 |
| phone | text | 新系统独立 | NULL / admin 手工维护 | — | PG 现状：4/148 行非空 |
| business_hours | text | 新系统独立 | NULL / admin 手工维护 | — | PG 现状：**103/148 行非空**（最多的一项；可能是某次 admin 批量录入） |
| description | text | 新系统独立 | NULL / admin 手工维护 | — | PG 现状：4/148 行非空 |
| announcement | text | 新系统独立 | NULL / admin 手工维护 | — | PG 现状：2/148 行非空 |
| parking_info | text | 新系统独立 | NULL / admin 手工维护 | — | PG 现状：4/148 行非空 |
| created_at | timestamp | 新系统独立 | `defaultNow()` | schema:L64 | |
| updated_at | timestamp | 新系统独立 | `defaultNow()` + onUpdate | schema:L65 | |

### 已被脚本抽取但 PG schema 未存的 WorkFine 列

UDT_M_219 共 16 列，syncOrgNodesAndStores 仅用了 5 列。剩余 11 列：

| WorkFine 列 | 类型 | 含义推断 | 现状 |
|-------------|------|----------|------|
| RID / OBYID | int | WorkFine 内部 ID | 未对接（PG 自有 hashId 主键） |
| UDF_M_1778 | decimal | 含义不明（样本全为 0） | 未对接 |
| UDF_M_3264 | nvarchar(150) | "是/否" 标志（22 是 + 5 否 + 123 空） | 未对接，含义未明 |
| UDF_M_3683 | nvarchar(150) | 数字编码（"351"/"352"/"348"...）| 未对接，**疑似门店编号** |
| UDF_M_6437 / UDF_M_6438 | decimal | 含义不明（样本全为 0） | 未对接 |
| UDF_M_10608 | decimal | 含义不明（样本全为 0） | 未对接 |
| UDF_M_11957 | datetime2 | **疑似闭店日期**（17 行非空，对应 16 已闭店 + 1 ?） | ⚠️ **业务关键字段未抽取**：PG closed_at 是用 updated_at::date 兜底回填的，不是真实闭店日期 |
| UDF_M_12033 | nvarchar(150) | 部分行带值（"Y九江市场"等） | 未对接，疑似父级市场冗余 |
| UDF_M_21371 | nvarchar(150) | 全空 | 未对接 |

---

## 关键决策摘要

1. **id 派生不可逆**：`hashId(sha256(...).substring(0,16))` 不可反推到 WorkFine 原始字段。如果未来需要从 PG 反查 WorkFine RID，需要建一张 mapping 表。
2. **org_nodes 部门分支由 syncEmployees 写入**（不在本模块脚本内）：sync-workfine.js:L267, L281 创建门店级部门 + 全局部门节点。**部门数 376 = 门店级部门 + 全局部门**，需要在 03-user 文档里详细 trace。
3. **150 → 148 差额未解释**：WorkFine 端 valid stores=150，PG stores=148。脚本是 UPSERT（不删除），且未发现去重逻辑——可能是某次同步时部分行 INSERT 失败但脚本没报错。需要验证。
4. **closed_at 数据失真**：PG 的 16 行 closed_at 不是真实闭店日期，是用 updated_at::date 兜底的。最终迁移需要从 UDF_M_11957 抽真实闭店日期重写。
5. **顾客向字段（cover_image / images / district / address / lat / lng / phone / business_hours / description / announcement / parking_info）零依赖 WorkFine**：完全由 admin 后台手工维护或 staff/clientApi 运行时写入。最终迁移**不会**触及这些字段。
6. **store_id ≠ org_node_id**：同一门店两个不同 hash（store_id 用 2 段输入，org_node_id 用 3 段输入）。schema 通过 `stores.org_node_id` FK 关联，业务表 FK 到 stores.store_id，需要 JOIN 链回到 org_nodes 树。

---

## ⚠️ 本模块未覆盖字段汇总（同步至 _gaps.md）

- `stores.closed_at` 数据失真（PG 用 updated_at 兜底，未抽 UDF_M_11957 真实日期）
- `stores.bed_count` 仅 5/148 行非 NULL（WorkFine 大量 0 被 falsy 判断丢弃）
- `UDT_M_219.UDF_M_3683` 疑似门店编号未抽取（如果业务侧依赖该编号关联其他系统）
- `UDT_M_219.UDF_M_3264 / UDF_M_11957 / UDF_M_12033` 等含义不明字段未对接
- 150 → 148 行的 2 行差额来源未确认
- org_nodes.id 与 stores.store_id 派生算法不一致，最终迁移需谨慎保留这两个不同 hash

---

## Review 报告（2026-04-26）

独立调研：schema/org.ts + grep 全仓写入入口 + MSSQL UDT_M_219 抽样（150 行）+ PG 5434 抽样（org_nodes 549 行 / stores 148 行 / closed_at 0 mismatch）。

**一致项**：约 11 项主张准确（schema 字段清单 / sync 入口 L114-205 / hashId 派生算法 / org_nodes 三层树 + 部门两类 / 类型枚举 4 值 / closed_at 兜底来源 0012:L25-29 / opening_date 兜底 0012:L32-35 / bed_count 5/148 / business_hours 103/148 / UDT_M_219 16 列 / 5 列已用 11 列未用 / store_id ≠ org_node_id 派生差异 / 16 行已闭店）。

**不一致项**：6 类（详见下表）。

### 偏差明细

| 类别 | 条目 | 说明 |
|------|------|------|
| **缺漏（P1）** | admin 写入入口完全未列 | 第 6-8 行"主要写入入口"只写了 sync-workfine.js + 0012 migration。**遗漏 3 个 admin 写入路径**：① `fengyu-admin/src/actions/org.ts`（createOrgNode/updateOrgNode/deleteOrgNode，含 5 层 scope 校验、FK 守卫真实删除）；② `fengyu-admin/src/actions/stores.ts`（createStore 事务 org_nodes+stores 原子建、updateStore 含 isClosed↔closedAt 双写一致 + 乐观锁）；③ `fengyu-admin/src/db/seed.ts`（ORG_NODES + STORES seed）。这是 sync 停用后的**唯一可信写入路径**，但 doc 仅以"admin 手工维护"一笔带过。 |
| **缺漏（P1）** | closed_at 当前真正写入路径未提 | 第 55 行说 closed_at 全部由 0012 migration 用 updated_at 兜底回填——成立。但 doc 没提 admin updateStore lines 192-198 的 `is_closed=true → closedAt=today / is_closed=false → closedAt=null` 双写一致逻辑。这是 closed_at 字段未来的**正确数据源**，已在生产代码中。 |
| **缺漏（架构事实）** | inbound FK 概览缺失 | stores 被 8 张表 FK 引用（appointments / client_wechat_users / pickup_records / sale_items / sale_orders / service_orders / staff_wechat_users / store_unbind_requests）；org_nodes 被 6 处引用（commission_rate_matrix / operation_logs / permission_roles / staff_wechat_users / stores / 自引用）。"business 表 FK 到 stores.store_id" 是关键架构事实，doc 完全没列。 |
| **缺漏（事实）** | cloudfunctions 只读不写 | clientApi/staffApi 全部 30+ 处 stores 引用均为 `SELECT FROM stores`，0 处 INSERT/UPDATE/DELETE。doc 没明确说"运行时只读" → 易误判云函数也参与写。 |
| **数据不一致（小）** | 部门节点实测分布未提 | doc 第 90 行说"部门数 = 门店级 + 全局"，**实测分布**：374 在门店下、2 在总部下（即"全局部门"）、0 在市场下。sync-workfine.js 注释说部门可挂市场，实测无此数据，可补充事实。 |
| **错配（小）** | 第 81 行 UDF_M_11957 "16 已闭店 + 1 ?" 1 是谁未说 | 实测 1 行是`重庆东万达店`，is_closed_raw='否' 但 UDF_M_11957=2024-06-21。可能是 WorkFine 端数据脏。可加备注。 |
| **缺漏（schema 隐患）** | stores.org_node_id 未 .notNull() | schema:L46 是 `references(() => orgNodes.id)`，无 notNull。实测 148/148 非空，无即时风险，但 doc 没提该 nullable 隐患。 |
| **过时事实** | — | 未发现明显过时（"2026-04-16 sync 停用"与 memory 一致）。 |

**P0**: 无（closed_at 失真为已知问题，影响范围 16 行展示性字段，无业务功能/资损）。

**verdict**: **minor-fix** — 主体血缘叙述准确，列级映射几乎全对；主要缺主权写入路径（admin 3 入口）+ inbound FK 概览。补 1 节"运行时写入：admin（权威） + sync-workfine（已停） + cloudfunctions（只读）"+ 1 表"inbound FK 引用矩阵"即可达 accept。

---

## Edge Case 报告 R2（2026-04-26）

**调研深度**：8 类风险维度逐项探针 + MSSQL UDT_M_219 二次抽样 + 14 个 inbound FK 全量 LEFT JOIN orphan 扫描 + 递归 CTE 树深度/环路探测 + 2014 staff 路径模拟 + uuid 强制类型试错。探针脚本 `db/.tmp-probe-r2-02.js`（已删除）。

### 8 类维度命中表

| # | 维度 | 命中 / 未命中 | 关键证据 |
|---|------|--------------|---------|
| 1 | FK 孤立 / 引用完整性 | **未命中**（structurally clean） | 14 张 inbound 表全部 0 orphan；org_nodes parent_id 0 orphan；stores.org_node_id 全部指向 type='门店'；**全部 14 个 FK delete_rule = NO ACTION**（即 RESTRICT，不存在级联误删风险） |
| 2 | NULL / 空串 / 极值 | **未命中** | NotNull 守住；text 列**零** empty-string；opening_date / closed_at 全部在 2000-2100 内；bed_count 无负值/超 1000；lat/lng 无中国境外值；is_closed ↔ closed_at 双写一致 100%（0 反例两向） |
| 3 | enum 漂移 | **未命中** | DB 表实际 4 值（总部1+市场24+门店148+部门376）= schema 声明 = 代码 switch 分支 |
| 4 | unique 约束 | **未命中** | uq_org_nodes_parent_name 0 dup；store_name 0 dup；org_node_id 0 dup（1:1 守住）；type='门店' 0 缺 stores 行 |
| 5 | 跨模块一致性 | **未命中** | sale_items.store_id 与 sale_orders.store_id 100% 一致；appointments.store_id 0 NULL；commission_rate_matrix 全部指向 type='市场'（15 行）；permission_roles 2038 行 0 orphan |
| 6 | 死代码 / 永不命中 | **轻度命中** | ① stores.cover_image / images / announcement / parking_info / phone / latitude / longitude / district / street_address 大量 NULL（145+/148 行）— admin 维护型字段历史从未被填；② org_nodes.is_active 字段 100% 为 true（**死字段**：schema 声明 + 默认 + 0 false 行 + 业务从不读）；③ sort_order 出现 -1 异常值（人工编辑产物：`凤御管理中心` 市场被 admin 设负值置顶） |
| 7 | dump-restore drift / archive 残留 | **命中（中危）** | ⚠️ **org_nodes.id / stores.store_id 派生算法在 PG 共存 3 套**：① sync-workfine 16 字符 sha256 hex（533 行）+ store_id 16 字符（144 行）；② **seed.ts 硬编码** `org-store-{slug}` / `org-dept-{slug}-{role}` / `store-{slug}`（org_nodes 16 行 + stores 4 行）。两套规则共存且无 schema 约束保护——**未来如再次 syncWorkFine（理论已停），sync 用 hashId 派生不同 ID，与 seed 4 行**`store-{slug}`**永不冲突却也永不收敛**。详见高危发现 #2 |
| 8 | 运行时安全 | **重度命中** | ⚠️ **P0 SQL 类型错配**：`fengyu-staff/cloudfunctions/staffApi/utils/scope.js:112,120` 写死 `ANY($1::uuid[])`，但 `org_nodes.id` 是 text。任何 staff 一旦持有 (scope_type='市场' 或 '门店') 角色绑定，登录中间件 expandScopeStoreIds 都会抛 PostgreSQL 42883 `operator does not exist: text = uuid`。详见高危发现 #1 |

### 高危发现明细

#### 🔴 P0-1：staffApi scope.js UUID 强制转换在 text 列上必抛 42883

**位置**：
- `fengyu-staff/cloudfunctions/staffApi/utils/scope.js:108-114`（市场 scope 展开）
- `fengyu-staff/cloudfunctions/staffApi/utils/scope.js:118-122`（门店 scope 展开）

**触发链路**：
- 调用栈：`staffApi/index.js → middleware/auth.js:205 → expandScopeStoreIds(roleBindings, pg)`
- 任意活跃员工（!is_resigned）登录都会进入 auth.js:191-205，自动调用 expandScopeStoreIds

**故障代码**：
```js
// scope.js:107-114 (市场 scope 展开)
const rows = await pg.query(
  `SELECT s.store_id
   FROM stores s
   JOIN org_nodes o ON s.org_node_id = o.id
   WHERE o.parent_id = ANY($1::uuid[]) AND o.type = '门店'`,
  [marketIds]
)
// scope.js:118-122 (门店 scope 展开)
const rows = await pg.query(
  `SELECT store_id FROM stores WHERE org_node_id = ANY($1::uuid[])`,
  [storeNodeIds]
)
```

**实测验证**（5434/fengyu）：
```
ERROR: operator does not exist: text = uuid (code 42883)
```

**生产 blast radius（5434 实测）**：
- permission_roles 表共 2038 行
- 持有 (scope_type IN ('市场','门店')) 绑定的 distinct employee 数 = **2014 人**
- 这 2014 名员工任何一次走 `staffApi.action=auth.login` / 任何已绑定身份的 action，登录中间件会在 expandScopeStoreIds 内抛 42883；index.js 全局 catch 会把该异常包成 `{code:-1,message:'...'}` 返回前端；员工端"我的"/"工作台"/"开单"/"绩效"全线无法初始化

**为什么单元测试没抓到**：`__tests__/utils/scope.test.js` 的 pg 是 `vi.fn()` mock，永远不真正命中 PG 类型检查（参见 scope.test.js:121）。

**为什么生产可能没爆**：
- 单元测试里的 mock `[['org-node-store-1']]` 和 mock 数据里 ID 都是文本，pg mock 直接返回，不走真实 SQL parser
- 生产是否爆炸取决于 staffApi 实际线上版本是否含此代码（commit 时间）+ 是否有 manager/staff 在管理层模式下登录过；建议立刻在生产 staffApi 日志里 grep `operator does not exist: text = uuid` 验证

**修复方向**（一行改动）：去掉 `::uuid[]`，改 `::text[]`：
```diff
- WHERE o.parent_id = ANY($1::uuid[]) AND o.type = '门店'
+ WHERE o.parent_id = ANY($1::text[]) AND o.type = '门店'
- WHERE org_node_id = ANY($1::uuid[])
+ WHERE org_node_id = ANY($1::text[])
```

#### 🟠 P1-2：org_nodes.id / stores.store_id 派生规则三套并存（dump-restore 风险）

**实测分布**（5434）：

| 表 | 16字符 sha256 hex（sync-workfine） | seed.ts 硬编码（admin/seed） |
|----|-----------------------------------|-----------------------------|
| org_nodes | 533 行（hashId 派生） | 16 行（如 `org-store-jj01`、`org-dept-nc01-beauty` 长度 14-23） |
| stores | 144 行（16 字符 hex） | 4 行（`store-jj01`、`store-nc01`、`store-nc02`、`store-gqc01` 长度 10-11） |
| 创建时间 | 2026-03-13 14:46-（多次同步 UPSERT） | 全部 `2026-03-13T15:48:03.041Z`（同一秒 batch insert） |

**问题**：
- schema 没有 CHECK 约束限制 ID 格式，业务代码也没有任何派生函数集中到一处。`db/seed.ts` 用一种规则、`sync-workfine.js:hashId` 用另一种规则、`fengyu-admin/src/actions/stores.ts:111` createStore 又写死 `org_nodeId = 'store-' + storeId`（**第三套**！）。
- 如果未来某个 admin 重命名了已经被 sync-workfine 创建过的某门店（hashId 输入参数变化），sync 重启时会以 `('store', new_name)` 计算出新 hash，导致 **同一物理门店 in PG 两行**，旧 `stores.store_id` 行的 inbound FK（sale_orders / sale_items / service_orders 等）变成"幽灵指针"。

**当前数据规模影响**：
- 4 个 admin/seed 创建的门店（共青城店 / 九江旗舰店 / 青山湖店 / 南昌旗舰店）所有 inbound FK 已经全部依附 `store-jj01` 等 seed 派生 ID
- WorkFine 端 6 行 Y- 前缀新店（Y南昌云暖店等）2025-11/2026-03 创建，sync 已停（2026-04-16）所以从未 ETL 入 PG —— 这就是 150 → 148 的真正解释（**WF 端新增-PG 滞后**，不是 sync 报错）

**修复方向**：
- A（推荐）：写一份 `db/scripts/idgen.js` 单一权威派生函数，admin actions / seed.ts / 历史 sync-workfine.js 全部改用同一函数；同时在 schema 加 CHECK 约束 `id ~ '^[0-9a-f]{16}$|^(org-|store-|dept-)'`
- B：sync-workfine 已停用，可以接受现状但需要在数据迁移规范里写明"两套 ID 不收敛"

#### 🟡 P2-3：closed_at 真实日期丢失（已知问题，doc 主体已记）

**位置**：sync-workfine.js:118-127 — UDT_M_219.UDF_M_11957 datetime 列**未抽取**，PG closed_at 16 行全部由 0012 migration 用 updated_at::date 兜底；二次实测 `closed_at = updated_at::date` 命中 16/16 行。

**新增证据**（doc 主体未提）：MSSQL 探针发现 6 个 Y- 前缀新店（2025-11~2026-04 期间 WorkFine 新增）`UDF_M_11957` 全 NULL — 说明 WF 端可能也只在闭店时填 11957，正常营业期为 NULL。**最终历史迁移仍可用 UDF_M_11957 抽真实闭店日期**，但要预期会是稀疏列。

#### 🟡 P2-4：org_nodes.is_active 死字段

NotNull + 默认 true + 全表 0 行 false + grep 全仓代码无任何 `is_active = false` 或 `WHERE is_active` 条件。属"声明了但永不使用"——schema 注释也写"没有非活跃节点概念"。可在最终迁移阶段一并 DROP。

#### 🟢 P3-5：sort_order = -1 哑值

`org_nodes.sort_order` 字段定义了 `notNull().default(0)`，但 5434 实测出现 1 行 -1：`凤御管理中心`（type='市场'，parent='总部'）。证明 admin 把它作为"置顶"约定 hack。属业务约定，无功能影响。可在 doc 补一句"特殊值 -1 表示置顶（人工编辑约定）"。

### Verdict

**verdict: serious-edge-cases**

主因：P0-1（staffApi UUID 强制转换 → 2014 员工生产链路必抛 42883）触发"业务永久失效"门槛。建议本轮立刻：
1. 修复 scope.js 两处 `::uuid[]` → `::text[]`（一行 diff，零风险）
2. 部署 staffApi 后通过 staff 登录复测
3. 如生产已观察到该报错，扫一下 staff 端无法登录的同窗投诉历史


