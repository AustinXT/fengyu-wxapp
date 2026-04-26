# 审计报告：权限矩阵 + 角色（permission_roles）(22)

**审计时间**：2026-04-25
**域 ID**：22
**审计员**：claude-opus-4-7
**审计时长**：约 15 分钟
**关联 PR/Ticket**：— （延续 audit-01 P1-PERM-07、CC4 段累积命中）

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/permission.ts:12-35`（`permission_roles`：employee_id+role+scope_id 三联唯一） + `db/schema/enums.ts:85`（`orgNodeTypeEnum` 4 值） + `db/schema/enums.ts:91`（`positionScopeEnum` 3 值） | ↑ | — |
| 角色矩阵 | `fengyu-admin/src/lib/permissions.ts:15-85`（PERMISSION_MATRIX 代码常量，硬编码 7 角色 × N action） | 无矩阵：`utils/scope.js:24-50` 把 roleBindings 折叠成 `staffLevel`（headquarters / market / store_manager / store_staff），而后用 `requireManager()` / `requireManagementLevel()` 守卫 | — 不参与 |
| 角色解析 | `src/actions/auth.ts:188-213`（permission_roles JOIN org_nodes，`scopeType ?? '门店'`兜底） | `cloudfunctions/staffApi/middleware/auth.js:192-205`（同样 SQL，但保留 `scopeType=null` 原值） | — |
| Scope 展开 | `src/lib/permissions.ts:108-150` `expandScopeStoreIds` | `utils/scope.js:79-127` `expandScopeStoreIds` | — |
| 矩阵管理 UI | `src/app/(main)/permissions/page.tsx` + `_components/permissions-page.tsx` | — | — |
| Server Actions | `src/actions/permissions.ts:14-287`（getRoles / getRolesByScope / getRoleCountsByScope / getEmployeeRoles / assignRole / revokeRole） + `src/actions/employees.ts:439-476`（员工调店 scope 同步、离职清角色） + `src/actions/org.ts:214-222`（删 org 节点前检查角色引用） | 无（员工端不维护角色） | — |
| 自动同步 | `db/scripts/sync-workfine.js:405-478`（按 position_name + dept_name 推导 role / scope，`created_by='sync'`，仅写不删） | — | — |
| 测试 | `src/actions/permissions.test.ts`（约 60+ 用例） + `src/lib/permissions.test.ts` | — | — |

## 2. 数据流图

```
admin/permissions/page.tsx
  └─→ assignRole({employeeId, role, scopeId})
        ├─ requirePermission('permission:assign' or 'permission:assign_admin')
        ├─ if !admin: scopeId 必须 ∈ session.roles[].scopeId  (集合相等而非"包含子树"，见 P0-22-02)
        ├─ if role==='admin': scopeId 对应 orgNode.type 必须 = '总部'  (其他 role 不校验 type，见 P0-22-01)
        ├─ INSERT permission_roles (employee_id, role, scope_id, created_by=session.employeeId)
        ├─ logOperation('permission.assign', detail={role, scopeId})
        └─ revalidatePath('/permissions','/employees')

employees.updateEmployee(storeId 变更)
  └─→ UPDATE permission_roles
        SET scope_id = newStore.orgNodeId, updated_by=session.employeeId
        WHERE employee_id=$ AND scope_id=oldStore.orgNodeId
        ├─ 仅迁移 store 级 scope，市场 / 总部级 scope 不动
        └─ logOperation('permission.scopeSync')
        ⚠ 无校验角色是否仍合身份（如 store_staff 调店后仍是 store_staff，但 manager 调店后仍是 manager — 业务上需手动复核）

employees.updateEmployee({isResigned:true})
  └─→ DELETE FROM permission_roles WHERE employee_id=$
        ⚠ 单 SQL 物理删除，未单独写 logOperation（见 P1-22-04）

cron / 任意时刻任意员工请求
  └─→ admin: getSessionFromCookie() 每次查 DB（无缓存）
      staff: middleware/auth.js 5 分钟 LRU 缓存（200 条上限）
        ⚠ 角色变更后：admin 即时生效；staff 端需等 ≤5 分钟（CC4 已知）
```

## 3. 自身漏洞

### 3.1 P0（阻断 / 资损 / 越权）

#### **[P0-22-01]** assignRole 不校验非 admin 角色的 scope.type，可把 manager/finance/hr/product/customer_mgr 角色绑到 `部门` 类型 org_node

- **文件**：`fengyu-admin/src/actions/permissions.ts:192-201`
- **现象**：仅当 `data.role === 'admin'` 时校验 `node.type === '总部'`。其他角色无任何 type 校验 —— `scopeId` 只要存在于 `org_nodes` 即接受。UI（`permissions-page.tsx:422 excludeTypes=["部门"]` / `OrgTreeSelect`）只过滤选择器，但 server action 直接调用绕过 UI（如自动化脚本 / 调试 / 篡改 form payload）即可写入 `部门` 类型 scope。
- **下游放大**：
  - `expandScopeStoreIds`（admin & staff 两端）对 `部门`（既非总部 / 市场 / 门店）整段直接忽略（`fengyu-staff/.../utils/scope.js:42-44 // 部门级忽略`，admin 端 `permissions.ts:113-146` 也只匹配三类）→ 该角色实际 `scopeStoreIds=[]`。
  - admin `scopeCondition()` 在 `scopeStoreIds=[]` 时返回 `sql\`FALSE\``——业务列表全部空，看似"安全"，但**该用户登录后不会被任何 SQL 拒绝**：`requirePermission('xxx:list')` 通过（actions 集合按 role 算）+ 数据 WHERE FALSE → 看到空表，但**写操作 `requirePermission` 仍允许执行**（如 `customer:update` 不查 scope）。
  - 更严重的是 `staff` 角色（actions=[]）若被绑到 `部门` 域，登录员工端时 `deriveStaffLevel()` 因 `scopeType==='部门'` 整体被忽略 → `staffLevel=null` → 该员工自动被锁出员工端，但**admin 端 menu 仍按 role 字段渲染入口**。
- **风险**：scope.type 假设贯穿整个 admin/staff scope 体系，绕过 type 校验 → 权限语义崩坏；且这是越权类隐患（CC4 命中）。
- **复现**：
  1. 直接 POST/调 `assignRole({employeeId:'X', role:'manager', scopeId:'<部门 org_node_id>'})`
  2. UI 看不见，但 DB 落库 + employee X 登录后 `roles.includes('manager')`
  3. 触发任何 `requirePermission('store_unbind:approve')` 等 manager-only action
- **修复**：(L7) `assignRole` 在 admin 校验旁补：`node.type !== '部门'` AND（按角色校验 `positionScope` 兼容）：
  - admin → 总部
  - manager / finance / customer_mgr → 总部 / 市场 / 门店
  - hr / product → 总部 / 市场（按业务定义）
  - 同时把"非 admin 用户分配的 scope 必须 ∈ 自身 scopeIds"扩展为"必须 ∈ 自身 scopeIds 子树"（见 P0-22-02 同源 Bug）。
- **关联**：P0-22-02、CC4 集中命中。

#### **[P0-22-02]** 非 admin 分配/撤销 scope 比对仅做"集合相等"而非"子树包含"，scope 升降级路径混乱

- **文件**：`fengyu-admin/src/actions/permissions.ts:184-188`、`263-269`
- **现象**：
  ```ts
  const userScopeIds = session.roles.map(r => r.scopeId)
  if (!userScopeIds.includes(data.scopeId)) return { success:false, ... }
  ```
  即 hr 用户仅当其本人 `scope_id` **完全等于** 目标 `scope_id` 才能分配。但 `expandScopeStoreIds` 的语义是"市场 scope 包含其下所有门店 / 总部包含全网" —— 也就是 **session.roles 与可管理的 scope 不是同一个集合**。
- **结果**：
  - 总部级 hr（`scope_type='总部'`，`scope_id=hq-node`）想给某门店员工分配 manager → `data.scopeId=门店 org_node`，不在 `userScopeIds` 里 → 拒绝。**hr 实际上无法在自己的 scope 子树内分配除总部外的任何角色**。
  - 同样，市场级 hr 无法分配下属任意门店的角色，必须用 admin。spec `admin.pr.spec.md:190` 写"hr 分配的 scope_id 须在其 scope 内"——代码实现是"等于"，与 spec **直接冲突**。
- **风险**：要么 hr 角色完全失能（业务挫败），要么所有人不得不全部走 admin（与 RBAC 设计意图相反，等于把权限模型瓦解）。
- **复现**：用 hr 账号试图给市场内任一门店员工分配角色 → 被拒。
- **修复**：(L7) 改为子树包含判定：用 `expandScopeStoreIds(session.roles)` 等价语义对 `data.scopeId` 反向判断（先看 `data.scopeId` 是否就是某个 session.scopeId，否则递归 org_nodes 检查父链是否含 session.scopeId）。或者干脆把"可分配 scope"也作为派生集合，`session.permissions.assignableScopeIds`，与 `scopeStoreIds` 同步计算。
- **关联**：P0-22-01、admin.pr.spec.md AFF-07。

#### **[P0-22-03]** 撤销/修改/查询 admin 角色未要求"目标本人 ≠ session.employeeId"，可发生 admin 自删导致系统无超管

- **文件**：`fengyu-admin/src/actions/permissions.ts:241-286`、`employees.ts:439-444`
- **现象**：
  - `revokeRole(id)`：仅校验"`role==='admin'` → 必须 hasRole(admin)"。但若 admin 把"自己"的唯一 admin 记录撤销 → 立即丧失整套全局权限，且无第二步保护。
  - `employees.updateEmployee({isResigned:true})`：DELETE permission_roles WHERE employee_id=$ —— 任何 hr/admin 把唯一 admin 标离职即把 admin 角色也连根拔。
- **风险**：系统出现"无任何 admin 角色"的死锁状态 —— `assignRole` 自身需要 `permission:assign_admin`，但已无人持有。需直接进 DB 修复。
- **修复**：(L7) `revokeRole` / `updateEmployee(isResigned)` 在删除 `role='admin'` 前 `SELECT count(*) FROM permission_roles WHERE role='admin'`，至少留 1 条；或加专门"超管转移"流程。
- **关联**：admin.pr.spec.md 应明文要求"系统始终保留至少 1 个 admin 角色"。

### 3.2 P1（数据一致 / 状态错乱）

#### **[P1-22-04]** 离职批量清角色（`employees.ts:439-444`）未写 operation_logs，与 `revokeRole` 不一致

- **文件**：`fengyu-admin/src/actions/employees.ts:439-444`
- **现象**：`if (data.isResigned===true) DELETE FROM permission_roles WHERE employee_id=$`。直接删除，未对每条记录调 `logOperation('permission.revoke', ...)`，与单条 `revokeRole` 路径行为不一致。审计追溯丢失。
- **现有 logUpdate**：在最后一次写 `'employee.update'` 一条带 diff，但 detail 不包含被删的角色清单。
- **修复**：(L7) DELETE 前 SELECT 出列表，对每条 logOperation 一笔；或单独打一条 `permission.batchRevoke` 含 `targetIds: [...]`。

#### **[P1-22-05]** PERMISSION_MATRIX 中 `staff` 角色 `actions=[]`（空数组），却同时是 `RoleType` 联合类型必备值，制造"哑角色"

- **文件**：`fengyu-admin/src/lib/permissions.ts:84`、`src/lib/types.ts:202`
- **现象**：`staff: []` 让所有 `requirePermission(s, 'xxx')` 拒绝。但 admin UI / employee detail / sync-workfine 将 `staff` 当成默认 fallback role 大量产生（seed.ts 5 处、sync 默认 `role='staff'`）。结果是 staff 角色登录 admin 后**菜单完全空白、无任何权限**——这是预期吗？
- **跨端不一致**：
  - admin: `staff` actions=[] → admin 后台对 staff 完全锁住。
  - staff 端: `staff` 通过 `deriveStaffLevel` 派生 `LEVEL_STORE_STAFF` → 仍可正常使用员工小程序（开单除外）。
  - 命名"staff"在两端语义割裂：admin 认为"无权限"，staff 端认为"一线员工"。
- **风险**：spec `admin.pr.spec.md:64-65` 没有 "staff" 列；类型定义却包含 `staff`，形成"未声明但合法"的 ghost 值。任何依赖 `RoleType` 枚举完备性的逻辑（如菜单 fallback / 测试 mock）都暴露这个空洞。
- **修复**：(L7) 二选一：
  - 把 `staff` 从 `RoleType` 联合移除，permission_roles.role 入库前用应用层校验把 `staff` 拒绝，sync-workfine 把"无 manager 头衔的员工"产生 `role='staff'` 的逻辑改成"不写 permission_roles"（员工小程序根据 staff_wechat_users.is_resigned 判定即可）。
  - 或保留 `staff`，但显式给一个最低 actions 集（如 `['dashboard:view']`），消除空数组陷阱。
- **关联**：staff/admin 跨端语义。

#### **[P1-22-06]** `permission_roles.role` 列是裸 `text`，无 enum 约束，可写入任意字符串

- **文件**：`db/schema/permission.ts:20`
- **现象**：`role: text('role').notNull()` —— DB 层不限制取值。`sync-workfine.js:444-457` 写入 `'staff'/'manager'/'finance'`，admin `assignRole` 写入 PERMISSION_MATRIX 的 7 个键之一。但若有人手工 INSERT `'super_admin'` 或拼写错 `'admins'`，DB 会接受，前端 `getRoles` 会带回该字符串，type cast 为 `RoleType` 后 `PERMISSION_MATRIX[role]` 查得 `undefined`，`computeActions` 静默跳过 → 该用户拥有"DB 中存在但前端无法识别"的角色。
- **风险**：CC5（错误码） / CC9（数据一致性）；若进 `roles[].role` 数组进入 type 收紧的代码（`switch(role)`），可能漏分支。
- **修复**：(L0) 加 `roleEnum` PG enum 7 值（与 `RoleType` 联合一致），permission_roles.role 类型升级；或 (L7) `assignRole` 校验 `role ∈ Object.keys(PERMISSION_MATRIX)`。

#### **[P1-22-07]** Admin 与 Staff 两端 scope 体系并行，但 PERMISSION_MATRIX 仅 admin 有，staff 端守卫各自硬编码

- **文件**：`fengyu-admin/src/lib/permissions.ts:15-85` vs `fengyu-staff/cloudfunctions/staffApi/middleware/auth.js:254-292`（`requireManager` / `requireManagementLevel`）
- **现象**：staff 端没有 `PERMISSION_MATRIX` 或 `requirePermission(action)`。所有路由作者各自判断：
  - "店长才能开单"→ `requireManager()`
  - "管理层才能看 mgmt-dashboard"→ `requireManagementLevel()`
  - 其他路由直接信任 `auth()` middleware 通过即可
  这与 admin 的"action 集合 + 集中校验"模型完全不同。同一 role（`manager`）在 admin 有 22 个 action，在 staff 仅靠 1 个守卫函数判定 ——**两套真相源**。
- **风险**：增改权限要同时改两端，spec `admin.pr.spec.md:54-75` 的权限矩阵表实际上**与 staff 端代码无强校验关系**。已知 audit-01 P1-PERM-07 提到 admin 矩阵硬编码需发版，本条进一步指出 staff 端连矩阵都没有。
- **修复**：(L0/L3) 长期：将 PERMISSION_MATRIX 移至 DB（如 `system_configs.permission_matrix`），admin/staff/cron 共读；短期：把 staff 端的硬编码守卫显式列成 `STAFF_REQUIRED_ROLES` 常量，至少做到"两端一份事实"。
- **关联**：audit-01 P1-PERM-07（既有），CC4 累积命中。

#### **[P1-22-08]** Staff 端 `requireManager()` 兜底逻辑（无 scopeType 旧数据）退化到 `roles.includes('manager')`，可放过总部级 manager

- **文件**：`fengyu-staff/cloudfunctions/staffApi/middleware/auth.js:259-272`
- **现象**：注释写"兼容旧数据"。fallback 仅检查 `roles.includes('manager')` —— 即使该 manager 是市场或总部级（不是门店）也通过。`requireManager()` 守门的开单 / 营业额分配 / 服务单等接口本应仅"门店店长"调用。
- **风险**：旧缓存 / 单测中残留无 scopeType 的 binding → 总部 / 市场级 manager 误获开单权。生产是否真有"无 scopeType"行需要 SQL 验证。
- **修复**：(L3) 直接移除兜底；或先 SQL 排查 `SELECT pr.* FROM permission_roles pr LEFT JOIN org_nodes o ON o.id=pr.scope_id WHERE o.type IS NULL` 并清理。
- **关联**：CC4。

### 3.3 P2

#### **[P2-22-09]** `permission_roles.scopeId` 列类型为 `text`，但 `org_nodes.id` 是 ULID/text，无 schema 层 enum / format 校验，依赖 FK 兜底

- **文件**：`db/schema/permission.ts:22-24`
- **现象**：`scope_id: text(...).references(orgNodes.id)` —— FK 保证存在，但格式自由。如果 ULID 生成器变更或导入历史数据带空格，FK 会通过但语义异常。
- **修复**：(L0) 可以加 `CHECK (scope_id ~ '^[0-9a-f]{16,32}$')` 或迁移到 uuid 类型；优先级低。

#### **[P2-22-10]** `revokeRole` 写 logOperation 时 detail 仅含 `{role}`，丢失 `scopeId` 与 `employeeId`

- **文件**：`fengyu-admin/src/actions/permissions.ts:279-281`
- **现象**：
  ```ts
  await logOperation(session, 'permission.revoke', 'permission_role', String(id), { role: target.role })
  ```
  `targetId=id` 是 permission_roles.id，删除后无法回查 employeeId / scopeId（已被删行）。审计困难。
- **修复**：(L7) detail 补 `{role, scopeId, employeeId}`，targetId 改成 employeeId（或保留 id 但追加 detail）。

#### **[P2-22-11]** UI 角色排序为字符串字面量列表，未与 `RoleType` 类型联合做编译期一致性校验

- **文件**：`fengyu-admin/src/app/(main)/permissions/_components/permissions-page.tsx:34`、`employees/[id]/_components/employee-detail-page.tsx:32`
- **现象**：`const allRoles: RoleType[] = ["admin","manager","finance","hr","product","customer_mgr","staff"]` —— 若 `RoleType` 增减，TypeScript 不会强制更新这两处常量长度。
- **修复**：(L9) 用 `Object.keys(PERMISSION_MATRIX) as RoleType[]` 即可保证一致。

## 4. 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| 矩阵存储 | PERMISSION_MATRIX 代码常量 | 无矩阵：staffLevel + 硬编码守卫 | — 不参与 | 两套真相源，admin 改完 staff 失同步 | P1（本轮 P1-22-07） |
| 角色集合 | 7 值（含 staff 空数组） | 4 个 staffLevel（headquarters / market / store_manager / store_staff） + raw role | — | 同一 manager 在两端语义不等价（admin: 22 actions；staff: requireManager 通过） | P1 |
| Scope 校验粒度 | UI 排除"部门"；server `assignRole` 仅 admin 校验 type | scope.js 把"部门"silently 忽略 | — | 部门绑普通角色 → admin 视为有效但 storeIds=[] | P0（本轮 P0-22-01） |
| Scope 子树语义 | session.scopeId === target.scopeId（**集合相等**） | 业务用 `scopeStoreIds` 列表（**子树展开**） | — | hr 在 admin 端"集合相等"使其几乎无法分配下属 scope | P0（本轮 P0-22-02） |
| 角色失效延迟 | 每请求查 DB，立即生效 | 5 分钟 LRU cache | — | staff 端撤销角色后仍可工作 ≤5 分钟 | P1（CC4 累积） |
| FK 完整性 | `permission_roles.scope_id → org_nodes.id` | ↑ 同库 | — | OK | — |
| 角色类型 enum | TS `RoleType` 7 值 | 无 enum，字符串透传 | — | DB 层 `text` 无约束 → ghost 值（本轮 P1-22-06） | P1 |
| `staff` 角色 | actions=[] | 派生 LEVEL_STORE_STAFF 走员工端正常 | — | 同名异义 | P1 |
| `部门` 类型 scope | `expandScopeStoreIds` 不命中（返回空） | 同 | — | 写入合法但语义空 | 与 P0-22-01 重叠 |
| 离职审计 | `employees.updateEmployee` 批量 DELETE 无单条日志 | 不参与 | — | 审计断链 | P1（本轮 P1-22-04） |

## 5. 横切检查（CC1–CC9）

| CC | 命中 | 简述 |
|----|------|------|
| CC1 数值精度 | — | 本域无金额字段 |
| CC2 并发幂等 | 部分 | `permission_roles` UNIQUE `(employee_id, role, scope_id)` + `assignRole` 先 SELECT 后 INSERT 并接 `23505` —— 防重入 OK；但 `revokeRole` 后立即 `assignRole` 同 key 无问题。`updateEmployee` 调店 + 删除 + 重建场景未做事务包裹（`employees.ts:439-476`），中间崩溃可能 scope 半同步、半删除 → P1 边缘问题 |
| CC3 隔离 | ✅命中 | P0-22-01、P0-22-02 两条；以及 `部门`/`市场`scope 的逆向语义混乱 |
| CC4 后端鉴权 | ✅命中 | P0-22-01、P1-22-07、P1-22-08；与 audit-01 P1-PERM-07 累积 |
| CC5 错误前缀 | 部分 | `requirePermission` 抛 `PERMISSION_DENIED:` ✅；但 `assignRole`/`revokeRole` 的业务失败用 `{success:false,message}` 而非 throw（与 admin 习惯一致），不算违规 |
| CC6 PII | — | 本域无 PII |
| CC7 时间字段 | ✅ | `created_at`/`updated_at` 由 Drizzle `defaultNow / $onUpdate` 写，OK |
| CC8 WXML/Vant | — | 本域无前端组件 |
| CC9 测试残留 | 部分 | `permissions.test.ts` 仅覆盖 happy path（assign / revoke / hasPermission）；P0-22-01（部门 scope）/ P0-22-02（子树语义）/ P0-22-03（最后一个 admin）三类 case 缺测 |

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema/enums | `db/schema/enums.ts` 新增 `roleEnum` | 收紧 `permission_roles.role` 列类型；或加 `CHECK (role IN (...))` | P1-22-06 |
| L0 schema | `db/schema/permission.ts` | scope_id 增 CHECK 排除 `部门` 类型（需 trigger 或迁移期校验） | P0-22-01 |
| L0 配置 | `system_configs.permission_matrix` | 把 PERMISSION_MATRIX 移至 DB，admin/staff/cron 共读（spec 增补） | P1-22-07、audit-01 P1-PERM-07 |
| L7 admin actions | `src/actions/permissions.ts:assignRole` | (a) 校验 `node.type !== '部门'` 且 role 与 type 配对；(b) "scope ⊆ session"换为子树判定；(c) admin 角色撤销前保留 ≥1 | P0-22-01/02/03、P1-22-06 |
| L7 admin actions | `src/actions/permissions.ts:revokeRole` | logOperation detail 补 `{employeeId, scopeId}` | P2-22-10 |
| L7 admin actions | `src/actions/employees.ts:439-476` | 离职清角色前先 SELECT + 逐条 logOperation；包成事务；检查最后一个 admin | P0-22-03、P1-22-04 |
| L3 staff middleware | `cloudfunctions/staffApi/middleware/auth.js:259-272` | 移除 `legacyFallback`；先排查无 scopeType 数据 | P1-22-08 |
| L3 staff util | `cloudfunctions/staffApi/utils/scope.js:42-44` | "部门级忽略"改为"部门级拒绝（throw 或返回错误）"，提早暴露异常配置 | P0-22-01 |
| L9 admin UI | `_components/permissions-page.tsx:34` 等 | 用 `Object.keys(PERMISSION_MATRIX)` 替代字面量数组 | P2-22-11 |

## 7. 验证 SQL（5434 EXPLAIN / SELECT 仅）

```sql
-- 7.1 P0-22-01：检查 permission_roles 是否已有"部门"型 scope 写入
SELECT pr.id, pr.employee_id, pr.role, pr.scope_id, o.type, o.name
FROM permission_roles pr
JOIN org_nodes o ON o.id = pr.scope_id
WHERE o.type = '部门';

-- 7.2 P0-22-03：当前活跃 admin 角色数量（应 ≥ 1，建议 ≥ 2）
SELECT count(*) AS admin_count
FROM permission_roles pr
JOIN staff_wechat_users s ON s.employee_id = pr.employee_id
WHERE pr.role = 'admin' AND s.is_resigned = false;

-- 7.3 P1-22-06：permission_roles.role 是否含意外值
SELECT role, count(*) AS cnt
FROM permission_roles
GROUP BY role
ORDER BY role;
-- 期望仅 admin/manager/finance/hr/product/customer_mgr/staff 7 值

-- 7.4 P1-22-08：staff 端兼容兜底是否还有"无 scopeType"行
SELECT pr.id, pr.role, pr.scope_id, o.type
FROM permission_roles pr
LEFT JOIN org_nodes o ON o.id = pr.scope_id
WHERE o.type IS NULL OR o.id IS NULL;

-- 7.5 P0-22-02：hr 用户当前 scope 与"可分配 scope"集合差距（举例）
SELECT pr.scope_id AS hr_scope, o.type, o.name
FROM permission_roles pr JOIN org_nodes o ON o.id = pr.scope_id
WHERE pr.role = 'hr';
-- 与 expandScopeStoreIds 子树展开比对，量化 hr 实际能/不能分配的 scope 比例
```

## 8. 回归测试用例（建议）

1. `assignRole({role:'manager', scopeId:'<部门 org_node_id>'})` → 应被 server 拒绝（当前不会）。
2. hr 用户（scope=市场）`assignRole` 给该市场下任一门店员工 manager → 应通过（当前会被拒）。
3. 唯一 admin 调用 `revokeRole(自己 admin id)` → 应被拒绝。
4. 唯一 admin 被 hr 标"isResigned=true" → 应阻断或提示先转移 admin。
5. 离职清角色后查 `operation_logs WHERE target_type='permission_role' AND operator_employee_id=$current` → 应见每条角色对应一笔日志。
6. 直接 INSERT `permission_roles(role='unknown_role')` → admin 端登录 `computeActions` 应拒绝该值（最少 throw / 跳过且记 warn）。
7. staff 端旧缓存（无 scopeType）总部级 manager 调用 `order.create` → 应被拒（移除 legacyFallback 后）。

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☑（admin + staff 共享 permission_roles，但矩阵两套）
- 全栈（3 端 + DB）：☐（client 不参与）
- 涉及历史数据：☑（需 SQL 7.1 / 7.4 排查现网是否已有"部门 scope"或"无 scopeType"残留）
- 修复成本：M（L0 enum 化 + L7 校验扩充 + L3 staff middleware 收紧；矩阵 DB 化属于 L 大重构，可拆分滚动）

## 10. 后续待办

- [ ] 与 PM 对齐：staff 角色究竟是"哑角色（不入 permission_roles）"还是"持空 actions 占位"，落定 spec
- [ ] 与 PM 对齐：hr 是否需要"在自身 scope 子树内"分配（spec 已写，代码错位）
- [ ] 与 admin 团队对齐：是否启动 PERMISSION_MATRIX → DB 迁移（audit-01 P1-PERM-07 + 本域 P1-22-07）
- [ ] 跑 SQL 7.1 / 7.4 确认现网历史脏数据，必要时写补丁迁移
- [ ] 评估 `employees.updateEmployee` 调店 + 角色迁移的事务边界（CC2 边缘）

---

### 关联引用

- audit-01 P1-PERM-07（admin 矩阵代码常量）
- CROSS-CUTTING.md CC4（admin scope 隐式合约依赖矩阵兜底；payNotify 无鉴权）
- audit-02 / audit-03 CC4 命中
- spec：`.42cog/pm/admin.pr.spec.md` AFF-07（角色分配 scope 传递约束）、第 64-65 行权限矩阵表
- spec：`.42cog/real.md` #5 后端统一鉴权、#6 组织域隔离
