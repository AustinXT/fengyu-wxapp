# 16 — `store-unbind` 模块

**Schema 文件**：`db/schema/store-unbind.ts`
**涉及 PG 表**：`store_unbind_requests`（顾客向当前绑定门店发起的解绑申请 + 店长审批流）
**WorkFine 源表**：**无**（WorkFine 不存在"门店绑定 / 解绑 / 申请"概念实体）
**主要写入入口**：

| 入口 | 文件 | 操作 |
|------|------|------|
| 顾客提交解绑申请 | `fengyu-client/cloudfunctions/clientApi/routes/store.js:138-162`（`requestUnbind`） | INSERT |
| 顾客取消申请 | `fengyu-client/cloudfunctions/clientApi/routes/store.js:198-219`（`cancelUnbindRequest`） | UPDATE status='已取消' |
| 店长审批通过（staff 端） | `fengyu-staff/cloudfunctions/staffApi/routes/store.js:75-106`（`approveUnbind`） | UPDATE status='已通过' + reviewed_by/at + 联动清空 client_wechat_users.bound_store_id |
| 店长拒绝（staff 端） | `fengyu-staff/cloudfunctions/staffApi/routes/store.js:112-136`（`rejectUnbind`） | UPDATE status='已拒绝' + reject_reason |
| admin 审批通过 | `fengyu-admin/src/actions/store-unbind.ts:59-107`（`approveUnbind`） | tx UPDATE status='已通过' + reviewed_by/at + 联动清空 client_wechat_users.bound_store_id / bound_employee_id |
| admin 拒绝 | `fengyu-admin/src/actions/store-unbind.ts:109-152`（`rejectUnbind`） | UPDATE status='已拒绝' + reject_reason |
| baseline 建表 | `db/migrations/0000_baseline.sql:347-358`（5434）+ `592-595` （FK） | DDL |

**只读入口**（不写入但依赖此表）：
- `fengyu-staff/cloudfunctions/staffApi/routes/store.js:39-69`（`unbindRequests`）— 店长拉取门店待审批列表
- `fengyu-staff/cloudfunctions/staffApi/routes/staff.js:367-371`（`todoList` 中的 `pendingUnbindCount`）— 待办徽标
- `fengyu-client/cloudfunctions/clientApi/routes/store.js:167-192`（`getUnbindRequest`）— 顾客端查"我的待审批申请"

**PG 现状**（5434/fengyu，2026-04-26 探查）：

| 表 | 总行数 | 来源 |
|----|-------|------|
| store_unbind_requests | **0** | — |

**佐证**：
- MSSQL `sys.tables` 名称 LIKE '%unbind%' / '%jiebang%' → **0 命中**
- MSSQL `sys.extended_properties` 列描述 LIKE '%解绑%' → **0 命中**
- MSSQL 描述含"门店"+("申请"\|"审批")的列 → **0 命中**
- `notes/research/workfine_database.md` 全文 0 处提及"解绑 / unbind"
- `db/scripts/{migrate,sync,seed,backfill}-*.js` 全部无 store_unbind_requests 写入
- `db/seed.ts` 不写本表

> **结论：100% 新系统独立、运行时也尚未产出**。本模块整张表是"已设计、已实现、未触发"的空表，最终 WorkFine→PG 迁移 **完全不需要触及**。

---

## 表 1：`store_unbind_requests`

### 列级血缘（按 schema 顺序）

| PG 列 | 类型 | 来源类别 | WorkFine 字段 / 计算式 / 默认值 | 出处 | 备注 |
|------|------|---------|---------------------------------|------|------|
| request_id | text (PK) | 新系统独立 | `crypto.randomUUID()` | clientApi/routes/store.js:L154 | 仅顾客端入口生成；admin/staff 路径只 UPDATE 不 INSERT |
| user_id | text NOT NULL | 新系统独立 | `ctx.auth.userId`（FK→`client_wechat_users.user_id`） | clientApi/routes/store.js:L139, L158 | 由 OPENID → auth 中间件解析 |
| from_store_id | text NOT NULL | ⚠️ 未覆盖（运行时 BUG） | 设计：`ctx.auth.boundStoreId`（FK→`stores.store_id`）；**实际**：clientApi INSERT 把 `boundStoreName` 写入了 `from_store_name` 列（不存在） | clientApi/routes/store.js:L156-158 | **关键 Bug**：见下文「关键决策」第 2 条。导致 INSERT SQL 必定 `column "from_store_name" does not exist` 失败，顾客端"申请解绑"按钮永久无法成功 |
| status | store_unbind_request_status enum | 默认值/NULL | INSERT 时硬编码 `'待处理'`；UPDATE 时切到 `'已通过' / '已拒绝' / '已取消'` | clientApi/routes/store.js:L157, L214；staffApi/routes/store.js:L99/L130；admin/store-unbind.ts:L86/L136 | enum 4 值（schema/enums.ts:L72-77） |
| note | text NULLABLE | 新系统独立 | 顾客端表单可选输入；空字符串归一化为 NULL（`note \|\| null`） | clientApi/routes/store.js:L143, L158 + miniprogram pagesStore/store-detail/store-detail.ts:L175 | |
| reviewed_by | varchar(30) NULLABLE | 新系统独立 | 审批员工：`ctx.auth.staffWfId`（FK→`staff_wechat_users.employee_id`）/ admin 路径用 `session.employeeId` | staffApi/routes/store.js:L101/L132；admin/store-unbind.ts:L87/L137 | 仅 status ∈ {已通过, 已拒绝} 的行有值 |
| reviewed_at | timestamp NULLABLE | 默认值/NULL | 审批时 `NOW()` / Drizzle `new Date()` | staffApi/routes/store.js:L99/L130；admin/store-unbind.ts:L88/L138 | 仅审批后写入 |
| reject_reason | text NULLABLE | 新系统独立 | 仅 rejectUnbind 路径写入：表单可选输入，空时为 NULL | staffApi/routes/store.js:L116, L132；admin/store-unbind.ts:L139 | 仅 status='已拒绝' 行有值 |
| created_at | timestamp NOT NULL | 默认值/NULL | `defaultNow()` | schema:L19 | |
| updated_at | timestamp NOT NULL | 默认值/NULL | `defaultNow()` + `$onUpdate(()=>new Date())`；clientApi cancel 路径手写 `updated_at = NOW()`；staffApi 也手写；admin 路径靠 Drizzle `$onUpdate` | schema:L20；clientApi/routes/store.js:L214；staffApi/routes/store.js:L100/L131 | 4 个写路径有 3 套不同 updated_at 写法（手写 SQL × 2 + Drizzle hook × 1），运行时一致但代码不统一 |

### 关键约束 / 索引（DDL 派生）

| 约束 | 内容 | 出处 |
|------|------|------|
| PK | `request_id` | baseline:L348 |
| FK `user_id` → `client_wechat_users.user_id` | NO ACTION | baseline:L552 |
| FK `from_store_id` → `stores.store_id` | NO ACTION | baseline:L553 |
| FK `reviewed_by` → `staff_wechat_users.employee_id` | NO ACTION | baseline:L554 |
| status enum 默认值 `'待处理'` | enum 4 值（待处理/已通过/已拒绝/已取消） | baseline:L351；schema/enums.ts:L72-77 |

**注意**：本表无任何**业务索引**（仅有主键 + FK 隐含索引）。当前 0 行无所谓，但运行时常用查询是：
- `WHERE user_id = $1 AND status = '待处理'`（clientApi:L147, L177）
- `WHERE from_store_id = $1 AND status = '待处理'`（staffApi:L56, L368）

未来量级上来后建议补 `(user_id, status)` 和 `(from_store_id, status)` 复合索引。

### 已被脚本读但未对接到 PG 的 WorkFine 列

**无**。WorkFine MSSQL 全库无任何"门店绑定/解绑/申请"语义实体或字段：

- `sys.tables` 名称 LIKE '%unbind%' / '%jiebang%' → 0 命中
- `sys.extended_properties` 列描述 LIKE '%解绑%' → 0 命中
- 描述含"门店"且"申请/审批"的列 → 0 命中
- `notes/research/workfine_database.md` 全文 0 处提及

WorkFine 的"顾客-门店"绑定关系仅通过销售单上的归属门店字段（`UDT_S_209.UDF_S_372` 等）隐含表达，**无显式的"绑定 / 解绑 / 申请"流程模型**。最终迁移没有任何 WorkFine 字段需要承接到 `store_unbind_requests`。

---

## 关键决策摘要

1. **100% 新系统独立**：本模块与 `06/appointments`、`08/commission`、`09/coupon`、`10/points`、`12/messages`、`15/pickup_records`、`17/system-config` 同属一组——WorkFine 完全无对应实体、迁移阶段无需建立任何 WF→PG 字段映射。
2. **⚠️ 严重运行时 Bug：clientApi `requestUnbind` 写错列名**：
   - `fengyu-client/cloudfunctions/clientApi/routes/store.js:156-158` 的 INSERT SQL 是 `INSERT INTO store_unbind_requests (request_id, user_id, from_store_name, status, note) VALUES ($1, $2, $3, '待处理', $4)`
   - 但 PG 表上**没有 `from_store_name` 列**（baseline 0000:L347-358 + information_schema 探查双向确认），列名是 `from_store_id`
   - 入参传的也是 `boundStoreName`（门店名字符串），不是 store_id（hash）
   - 后果：每次顾客点击"申请解绑此门店"，clientApi 必抛 `column "from_store_name" of relation "store_unbind_requests" does not exist`，**前端会显示"申请失败"**
   - 与 PG 现状 0 行完全自洽——本路径自上线以来**从未成功写入过任何一行**
   - 修复方案：把列名改回 `from_store_id`，把入参改成 `boundStoreId`（auth 中间件已暴露）
3. **PG 现状 0 行 = 设计实现 + 运行时阻塞**：写入路径完整（顾客端提交 → 顾客端取消 / staff 端审批 / admin 端审批），但顾客端唯一的 INSERT 入口被 Bug 阻塞，整条业务链 baseline reset 至今 0 产出。
4. **3 端 4 写入路径并存**：clientApi（顾客提交/取消） + staffApi（店长审批通过/拒绝） + adminAction（admin 审批通过/拒绝），共 6 个写函数。审批联动清空顾客 `client_wechat_users.bound_store_id` 的逻辑在 staffApi 和 admin 都有，**但两端清空字段不一致**：
   - staffApi/store.js:L94 只清 `bound_store_id`
   - admin/store-unbind.ts:L93-94 同时清 `bound_store_id` 和 `bound_employee_id`
   - 这是潜在不一致：staff 端审批后顾客 `bound_employee_id` 残留，理论上应该和 admin 一致清空
5. **流水型审批表，但有 updated_at**：与 `pickup_records / point_transactions / card_transactions / messages / operation_logs` 不同——这些纯流水表故意不放 updated_at；但本表是**带状态机**的（待处理 → 已通过/已拒绝/已取消），所以保留 updated_at 合理（admin orderBy 默认用 `desc(updatedAt), desc(createdAt)`，admin/store-unbind.ts:L42）。
6. **`from_store_id` 是 hash 而非门店编号**：FK→`stores.store_id`，store_id 是 `hashId('store', store_name)` 派生（详见 02-org.md），同一个门店在 org_nodes 和 stores 两张表上是两个不同 hash。本表的 from_store_id 走的是 stores.store_id 这一支。

---

## ⚠️ 本模块未覆盖字段汇总（同步至 _gaps.md）

无字段级 gap（WorkFine 无对应实体）。但有 **3 个运行时风险**需要 _gaps.md 留底：

- ⚠️ **clientApi `requestUnbind` 写错列名**：`from_store_name` → 应为 `from_store_id`，且入参 `boundStoreName` → 应为 `boundStoreId`。所有顾客端"申请解绑"调用必失败，PG 0 行的根本原因。属于**待修复 Bug**，与最终迁移无关，但优先级高于一切迁移工作（业务功能完全失效）。
- ⚠️ **审批联动清空字段不一致**：staffApi `approveUnbind` 只清 `bound_store_id`，admin `approveUnbind` 同时清 `bound_store_id + bound_employee_id`。staff 端审批后顾客残留 `bound_employee_id` 异常。
- ⚠️ **缺业务索引**：`(user_id, status)` 和 `(from_store_id, status)` 是高频 WHERE 条件但无索引。当前 0 行无影响，但放量后会全表扫。

---

## Review 报告（2026-04-26）

独立调研路径：schema 列清单 → grep 全仓写入入口（cloudfunctions + admin actions + db/scripts + migrations + archive）→ PG 5434 抽样（columns / rowcount / FK / index / operation_logs.action）→ MSSQL 跳过（doc 已确认 WorkFine 无对应实体；上轮 03/05 等模块已多次复现"unbind 0 命中"）→ 形成"应该长什么样"独立结论 → 比对原文。

### 一致项 / 不一致项总览

- 一致项：**12+**（schema 9 列血缘、4 写入函数 + 3 只读函数定位、enum 4 值、FK 3 个、PG 0 行、updated_at 三套写法、status 状态机、staff↔admin 联动清空字段不对称、archive 0026 enum 中文化、archive 0004 reviewed_by FK 重指）
- 不一致项：**3 处轻微偏差** + **0 处事实性错误**

### 偏差明细

**1. 错配（minor，行号偏移）**

- baseline FK 行号写 `592-595`，实际为 `0000_baseline.sql:552-554`（3 行 FK + 表定义 347-358）。位于行 16 表内"baseline 建表"列。

**2. 缺漏（minor，归档 migration 历史链未列出）**

- `archive_pre_baseline_2026_04/sql/0000_init_v3_1.sql:13/289-353` — 表的初始 DDL（status 默认值原为英文 `pending`/`approved`/`rejected`/`cancelled`）
- `archive_pre_baseline_2026_04/sql/0004_windy_thor_girl.sql:80/103` — `reviewed_by` FK 由 `employees.employee_id` 改指 `staff_wechat_users.employee_id`（v3.2 employees 合并的传播）
- `archive_pre_baseline_2026_04/sql/0026_enum_chinese_values.sql:19-23` — enum 4 值整体由英文 RENAME 为中文（pending→待处理 等）
- `archive_pre_baseline_2026_04/sql/0016_sync_to_current.sql:54/149-152` — 中间用过一次 status 列降级 text → 重建 enum 类型 → 再升回的循环
- 这些都是"历史演化路径"，对当前迁移产物无影响，但作为完整血缘链应一笔带过。

**3. 过时事实**：无（文档 PG 0 行、enum 4 值中文、FK 3 个、staff↔admin 联动清空字段不一致 全部与 5434 现状 100% 吻合）

**4. 数据不一致**：无

### P0 风险确认（非新发现，原文档已自报）

✅ clientApi `requestUnbind` SQL 写错列名 `from_store_name`（schema 实际为 `from_store_id`，且该列 NOT NULL）— 已在 `_gaps.md` 顶部独立登记 P0 章节。本 review 在 5434 双向核验：
- `information_schema.columns` 列出的 9 列中 **无 `from_store_name`**
- `from_store_id` is_nullable=NO，default=NULL
- `store_unbind_requests` 总行数 = 0，与"该 INSERT 路径自上线起从未成功"完全自洽
- `operation_logs.action` LIKE `'store_unbind.%'` 命中 0（审批路径同样未触发，与上游 INSERT 阻塞链路一致）

### Verdict

**accept**

文档质量极高（与 13/operation-log、09/coupon 同档）：列血缘 9/9 准确、4 写入函数行号 ±1 内、3 只读入口定位精确、enum 4 值齐全、FK 3 个齐全、PG 0 行原因（运行时 BUG 阻塞）已自报、admin↔staff 联动差异已自报、缺索引建议已自报。仅有的 3 处偏差全部是"baseline FK 行号错位 5 行 + 归档 migration 历史链未追溯"的 cosmetic 级问题，**不影响最终 WorkFine→PG 迁移决策（本表全程不需要承接任何 WorkFine 字段）**。

---

## R2 边缘风险审计（2026-04-26）

> 探针：`db/.tmp-probe-r2-16.js`（5434/fengyu，已删除）+ codebase grep 全量入口（4 写 + 3 读 + 1 admin 列表 + 2 个前端调用页）。MSSQL 跳过（R1 已三向核验 WorkFine 0 实体），R2 不重复。
>
> verdict：**serious-edge-cases**

### 8 维度命中矩阵

| # | 维度 | 命中 | 等级 | 摘要 |
|---|------|------|------|------|
| 1 | FK 孤立 | ✗ | clean | 4 FK 完整（user_id/from_store_id/reviewed_by 三个；processor 等不存在）；orphan 3 项 0 行（rowCount=0 自洽） |
| 2 | NULL/空串/极值 | ✓ | LOW | clientApi `requestUnbind` 入参 `boundStoreName \|\| ''` 用空串兜底（即使该路径修复后改用 `boundStoreId`，沿用此模式会让 from_store_id 进空串，撞 FK 反查 stores 0 行而抛错；建议显式 NOT NULL guard） |
| 3 | enum 漂移 | ✗ | clean | enum 4 值（待处理/已通过/已拒绝/已取消）与 schema/baseline 100% 一致；归档 0026 中文化 + 0016 重建循环已收敛；`statusUsed` 实际取值 = ∅（rowCount=0） |
| 4 | unique 守住 | ✓ | **HIGH** | **缺 `(user_id) WHERE status='待处理'` partial unique index** — clientApi:L146-152 通过 SELECT-then-INSERT 单点检查"是否已有 pending"，但中间无 advisory lock，**双击/并发提交可绕过**生成 2 行同一 user_id 的待处理申请。当前 0 行无影响，bug 修复后需立即补 partial unique 兜底，否则 staff 端 unbindRequests 列表会展示 2 行需要分别审批，且任意一行通过后另一行 status 仍 '待处理' 永远悬挂 |
| 5 | 跨模块一致性 | ✓ | **HIGH** | （a）staffApi/store.js:L94 仅 `bound_store_id=NULL`，admin/store-unbind.ts:L94 同时清 `bound_store_id + bound_employee_id` — **行为分叉已确认**（已在 R1 自报，R2 复核仍存在）；（b）当前 `client_wechat_users` 中 `bound_employee_id IS NOT NULL` 共 4218 行（全部叠在 bound_store_id 之上，0 行 emp_only_orphan），一旦解绑业务恢复后用 staff 路径审批，这 4218 行会逐渐积累 emp_only_orphan，破坏 bound_employee_id 必依附 bound_store_id 的隐式不变量 |
| 6 | 死代码/永不命中 | ✓ | **HIGH** | （a）clientApi `requestUnbind` 列名错（已记 P0）— 整个写入入口永不命中；（b）`getUnbindRequest`（clientApi:L167-192）+ `cancelUnbindRequest`（L198-219）+ `unbindRequests`（staffApi:L39-69）+ admin `getUnbindRequests`（L26-57）4 个查询入口全部"读 0 行"运行 17+ 天；（c）`reject_reason` 列 admin/staff 均接受 NULL，前端是否有强制必填约束未追溯 — 实际数据 0 行无法验证 |
| 7 | dump-restore 残留/drift | ✗ | clean | 5434 列结构 9/9 与 schema/baseline 严格匹配；探针验证 `from_store_name / approver_id / processor_id` 等历史列名残留 = 全部 false；归档 0003/0004 v3.2 employees 合并的 reviewed_by FK 重指（employees → staff_wechat_users）已对齐 |
| 8 | 运行时安全 | ✓ | MED | （a）缺业务索引 `(user_id, status)` 和 `(from_store_id, status)`（已自报）；（b）admin `getUnbindRequests` 用 `scopeCondition` 但无 `LIMIT` 在 `where` 之前 — 当前 `LIMIT 500` 写在末尾，业务放量后总部账号一次拉 500 条混合状态混合门店，前端要客户端分页；（c）clientApi:L147-152 SELECT-then-INSERT 模式裸跑（无 advisory lock）；（d）staff 端审批未做"二次确认 status='待处理'"的 UPDATE WHERE 守卫，依赖前面 SELECT 行内 status；admin 路径同样在 SELECT 后再 UPDATE 但中间无 row lock，**2 个店长同时点"通过"会双扣 client_wechat_users.bound_store_id（幂等无害）+ 双写 operation_logs 审计（视觉不一致）**；优先级 LOW（操作面极窄）|

**命中数：6/8**（FK + drift 干净，其余 6 维全部命中；HIGH 3 个、MED 1 个、LOW 2 个）

### 关键新发现（R1 未独立列出）

1. **partial unique 兜底缺失（HIGH）** — 在 P0 列名 bug 修复**之后**，必须立即补 `CREATE UNIQUE INDEX ON store_unbind_requests (user_id) WHERE status='待处理'`，否则双击/并发将产生悬挂状态。R1 仅自报"index 缺失影响放量性能"，未识别这是**正确性**而非性能问题。
2. **bound_employee_id 隐式不变量风险（HIGH）** — 5434 实测 4218 行 `bound_employee_id IS NOT NULL`、`emp_only_orphan=0`，说明业务上"绑员工必绑门店"是隐式不变量。staff 路径审批后只清 store_id，会逐渐打破这个不变量；admin 路径行为正确。修复方向：staffApi/store.js:L93-96 同步加 `bound_employee_id = NULL`，与 admin 对齐。
3. **审批并发重复 UPDATE 双写审计（LOW）** — admin SELECT-then-UPDATE 中间无 row lock，两个店长同时点"通过"，bound_store_id=NULL 是幂等的（无害），但 operation_logs 会同时产生 2 行 `store_unbind.approve` 审计，看起来"被通过了两次"。修复：admin update WHERE 加 `AND status='待处理'`，rowCount=0 时跳过 logTransition。
4. **scopeCondition + LIMIT 顺序（LOW）** — admin/store-unbind.ts:L43 `LIMIT 500` 在 `scopeCondition` 之后，对 admin 角色合理；当业务体量起来，需要补真正的服务端分页（参考 admin.sys.spec.md §5）。

### 与 P0 bug 的关系

R1 P0（clientApi 列名错）解决后，本模块业务才会真正"开火"。一旦开火：

- 必须同时上线 partial unique（防双重申请）
- 必须同时改 staff 路径（同步清 bound_employee_id）
- 否则 bug 修复 = 释放 3 个新隐患到生产

---

## R2 字段扩展建议

### 概述

WorkFine 完全无解绑实体（`sys.tables` / `sys.extended_properties` / workfine_database.md / R1 三轮 0 命中），R2 重判结论一致：**无 WorkFine 反推字段**。但本表是带状态机的**审批流水**，从纯 PG 视角看待业务可观测性、合规、并发安全有可加字段。

### 候选清单（3 个 P1 + 3 个 P2 + 0 个 P0；全部为新系统独立列，非 WF 反推）

#### P1.1 `requested_at`（明确化命名）/ 改名 `created_at`

| 项 | 内容 |
|----|------|
| WF 源 | 无（新系统独立） |
| PG 应新增列 | 不新增。建议把现 `created_at` 当作 "申请提交时间" 使用即可，无需变更 |
| 优先级 | P3（命名改进，非新增） |
| 业务理由 | 现 `created_at` 与"提交时间"语义重合，无需改名 |
| 依赖 | 无 |

> **撤回**：本字段命名已由 `created_at` 担任，改名收益过低，不构成扩展候选。

#### P1.1 `cancelled_at` / `cancelled_reason`（取消时间和原因）

| 项 | 内容 |
|----|------|
| WF 源 | 无 |
| PG 应新增列 | `cancelled_at timestamp NULLABLE` + `cancel_reason text NULLABLE` |
| 优先级 | **P1** |
| 业务理由 | 当前 `cancelUnbindRequest`（clientApi:L198-219）只把 status='已取消' + 改 updated_at，丢失"何时取消、为什么取消"的核心审计信息。顾客可能因"门店主动联系挽留"或"误点"撤销申请，业务需要区分这两类以优化转化漏斗。同时与 reviewed_by/reviewed_at/reject_reason 三件套对称（审批/拒绝/取消三条状态机出口都该有时间戳和原因） |
| 抽取式 | INSERT/UPDATE 时显式写入；前端弹窗收集 reason；时间戳 = NOW() |
| 数据量 | rowCount=0 当前 0 行；业务恢复后预期年级 100~1000 行（参考 58797 个 bound_store 顾客 ×解绑率 0.1~1%） |
| 依赖 | clientApi `cancelUnbindRequest` payload 加 `cancelReason`；前端 store-detail 取消按钮加 reason 输入 |

#### P1.2 `requested_employee_id`（顾客在哪个员工/店长引导下提交）

| 项 | 内容 |
|----|------|
| WF 源 | 无 |
| PG 应新增列 | `requested_employee_id varchar(30) NULLABLE` + FK `staff_wechat_users.employee_id` |
| 优先级 | **P1** |
| 业务理由 | 业务方反馈「顾客通过店长引导申请解绑」与「顾客主动通过 App 申请」需要区分（前者多为门店间转店，后者多为流失风险）。当前 schema 无任何字段承载"引导员工"，仅靠 `note` 文本字段隐含。同时这个字段也帮助统计"店长 X 帮助过几个顾客解绑"（HR 维度的辅助绩效数据） |
| 抽取式 | clientApi `requestUnbind` payload 增加 `referredByEmployeeId`（前端可选输入，店长扫码引导顾客填）；后端写入即可 |
| 数据量 | NULLABLE，估计 30%~50% 行有值 |
| 依赖 | 顾客端 store-detail 加"由谁帮你解绑"输入框（可选） |

#### P1.3 `reviewed_role` / `reviewed_via`（审批来源端）

| 项 | 内容 |
|----|------|
| WF 源 | 无 |
| PG 应新增列 | `reviewed_via varchar(20) NULLABLE`（取值 `'staff_app' / 'admin_web'`） |
| 优先级 | **P1** |
| 业务理由 | 当前同一个 `reviewed_by` 字段，无法区分该审批是来自 staff 小程序的店长还是 admin 后台的总部/HR。这两种渠道**联动逻辑不同**（已在 R2 边缘风险确认 staff 仅清 store_id、admin 同时清 employee_id），出问题时无法快速定位审批渠道；同时合规上需要审计来源端 |
| 抽取式 | staffApi/store.js:L98-101 写入 `reviewed_via='staff_app'`；admin/store-unbind.ts:L84-89 写入 `reviewed_via='admin_web'` |
| 数据量 | NULLABLE 兼容历史；新写入 100% 有值 |
| 依赖 | 6 个写函数中的 4 个审批/拒绝路径 |

#### P2.1 `from_store_snapshot_name`（门店名快照，用于已停业归档）

| 项 | 内容 |
|----|------|
| WF 源 | 无 |
| PG 应新增列 | `from_store_name varchar(100) NULLABLE`（**注意**：这正是 P0 bug 误用的列名，但语义不同 — 这里是"快照"而非"FK 替代") |
| 优先级 | **P2** |
| 业务理由 | 当 `stores.is_closed=true` 后，前端通过 JOIN stores 取 store_name 仍能显示，但若未来彻底删除门店行（远期），则历史申请会丢失 from_store_name 上下文。审计/客诉场景需要展示"3 年前你向 XX 门店申请解绑"。这种字段也是 sale_orders.store_name 已采用的模式（archive 0028-0031 销售单已加快照） |
| 抽取式 | INSERT 时同步写入 `boundStoreName` 快照 |
| 数据量 | NOT NULL 新写入 100%；历史 0 行无需回填 |
| 依赖 | clientApi `requestUnbind` 修复 P0 时一并加该列 |

#### P2.2 `expected_response_at` / SLA 超时时间

| 项 | 内容 |
|----|------|
| WF 源 | 无 |
| PG 应新增列 | `expected_response_at timestamp NULLABLE`（如 `created_at + 7 days`） |
| 优先级 | **P2** |
| 业务理由 | 业务诉求：「店长 7 天未审批 → 自动通过 / 升级到 admin」。当前 schema 无任何 SLA 字段，cron-worker 也无超时巡检 STEP。这个列让 cron 直接 `WHERE expected_response_at < NOW() AND status='待处理'` 拉超时清单。是否真的要做"超时自动通过"是产品决策，但**字段先有不阻塞** |
| 抽取式 | INSERT 时计算 `created_at + INTERVAL '7 days'` |
| 数据量 | NOT NULL 新写入 100% |
| 依赖 | 后续若启用，需补 cron-worker STEP 6 |

#### P2.3 `unbind_reason_category`（解绑原因分类，结构化）

| 项 | 内容 |
|----|------|
| WF 源 | 无 |
| PG 应新增列 | enum 列 `unbind_reason_category` 取值 `'搬家'/'转店'/'服务不满意'/'误绑'/'其他'`，NULLABLE |
| 优先级 | **P2** |
| 业务理由 | 当前 `note` 是自由文本，无法做"流失原因分布统计"。结构化分类能让 admin/dashboard 出"近 3 月 Top3 解绑原因 → 服务不满意 35%"这类决策图表。`note` 字段可保留（细节备注） |
| 抽取式 | clientApi `requestUnbind` payload 加 `reasonCategory`（前端弹窗强制单选） |
| 数据量 | NULLABLE 兼容老路径，新写入 100% |
| 依赖 | 前端 store-detail 解绑弹窗加 RadioGroup |

### 撤回项（不再列入候选）

- **客户身份字段（`requestor_phone` / `requestor_name`）**：完全可通过 JOIN `client_wechat_users` 取，无需冗余快照（顾客身份不会变更，且本表 user_id NOT NULL）
- **多门店申请（`to_store_id`）**：业务需求是"解绑当前门店"，不存在"换绑到目标门店"语义；admin/staff 都未暴露此入口

### 总结

- **P0：0 个**（与 R1 一致，确认无 WF 反推 + 当前 schema 已守住核心）
- **P1：3 个**（cancelled_at/cancel_reason / requested_employee_id / reviewed_via）
- **P2：3 个**（from_store_name 快照 / expected_response_at / unbind_reason_category）
- 所有候选均为**新系统独立**，与 WorkFine 完全无关，可在 P0 bug 修复后任意节奏推进


