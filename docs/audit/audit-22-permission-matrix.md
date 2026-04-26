# 审计报告：权限矩阵 + 角色（permission_roles）(22)

**审计时间**：2026-04-25 初审 + 2026-04-26 v2 复核，**v1+v2 合并版 2026-04-26**
**域 ID**：22
**审计员**：claude-opus-4-7
**审计时长**：v1 约 15 分钟 + v2 约 25 分钟
**关联 PR/Ticket**：—（v1 原版：[audit-22-permission-matrix.md (v1)](audit-22-permission-matrix.md)；v2 原版：[audit-22-permission-matrix-v2.md](audit-22-permission-matrix-v2.md)，已合并入本文件后删除）

> **合并说明**：本报告合并 v1（2026-04-25）与 v2（2026-04-26 独立复核）两轮审计结果。
> v2 确认所有 v1 问题**均未修复**（PENDING 状态）。v2 同时新增 4 项独立发现（已标注 v2-only），
> 并对 admin/staff"两套真相源"问题作了定量补充。
> 合并后重新计数：**5 P0 + 6 P1 + 4 P2 = 15 findings**（v1 11 + v2 新增 4，无重复）。

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/permission.ts:12-35`（`permission_roles`：`id` PK、`employee_id`+`role`+`scope_id` 三列联合 UNIQUE、role=`text` 无 enum、scope_id=`text` FK→`org_nodes.id` ON DELETE NO ACTION） | ↑ | — |
| 枚举 | `db/schema/enums.ts:93` `orgNodeTypeEnum` 4 值（总部/市场/门店/部门）+ `enums.ts:99` `positionScopeEnum` 3 值（总部/市场/门店） | ↑ | — |
| 角色矩阵 | `fengyu-admin/src/lib/permissions.ts:15-86` `PERMISSION_MATRIX` 代码常量（7 角色 × N action，共 51 actions）；类型 `RoleType` 联合在 `lib/types.ts:209` | **无矩阵**：`utils/scope.js:25-51` `deriveStaffLevel` 把 `roleBindings` 折叠成 `staffLevel` ∈ {headquarters / market / store_manager / store_staff / null}；权限校验由路由内 `requireManager()` / `requireManagementLevel()` / `roles.includes('manager')` **散落 21 处**判断 | — 不参与 |
| Session 解析 | `src/actions/auth.ts:164-218` `getSessionFromCookie`：JWT → `staff_wechat_users` + `permission_roles` LEFT JOIN `org_nodes`；空兜底 `?? '门店'`（line 201） | `staffApi/middleware/auth.js:99-138` `auth()`：OPENID → 5 分钟 LRU `AUTH_CACHE`（≤200 entry）→ 同样 SQL，保留 `scopeType=null` 原值 | — |
| Scope 展开 | `src/lib/permissions.ts:109-151` `expandScopeStoreIds`：总部→全店 / 市场→子树门店 / 门店→单行 / `部门`/无 type→**静默忽略** | `staffApi/utils/scope.js:82-127` `expandScopeStoreIds`：与 admin 同语义；`部门` 同样**静默忽略**（line 105 注释） | — |
| 矩阵管理 UI | `src/app/(main)/permissions/page.tsx` + `_components/permissions-page.tsx:34`（字面量数组）+ `:422` `OrgTreeSelect excludeTypes=["部门"]` | — | — |
| Server Actions | `src/actions/permissions.ts` 7 函数：getRoles / getRolesByScope / getRoleCountsByScope / **getEmployeeRoles**（⚠ 缺 scope 过滤）/ assignRole / revokeRole | — | — |
| 调店 scope 同步 | `src/actions/employees.ts:439-444` 离职批量 DELETE；`:446-476` 调店时 UPDATE `permission_roles.scope_id` | — | — |
| 缓存失效 | assignRole/revokeRole 后 `revalidatePath` admin 页面，**不清 staff AUTH_CACHE**（v2-only P2-22-12） | AUTH_CACHE 5 分钟 LRU，OPENID 键 | — |
| 测试 | `src/actions/permissions.test.ts` 22 用例（仅 happy path）；`src/lib/permissions.test.ts` 单元测试 | — | — |

> 客户端（client）路由完全不引用 `permission_roles`（已 grep 验证），符合"客户端 = 顾客"语义。

## 2. 数据流图

```
admin/permissions/page.tsx
  ├─→ getRolesByScope(scopeId)  ── requirePermission('permission:list')
  │     非 admin：scopeId ∈ session.scopeIds ? 否则空数组
  ├─→ getEmployees() ── requirePermission('employee:list')
  └─→ assignRole({employeeId, role, scopeId})
        ├─ requirePermission('permission:assign' | 'permission:assign_admin')
        ├─ 非 admin：scopeId === session.scopeId （集合相等！见 P0-22-02）
        ├─ if role==='admin' → orgNode.type='总部' 校验
        ├─ ⚠ 不校验 role ∈ PERMISSION_MATRIX 键集合（见 P0-22-04）
        ├─ ⚠ 不校验非 admin 角色 scope.type ∈ {总部/市场/门店} （见 P0-22-01）
        ├─ INSERT permission_roles
        ├─ revalidatePath（admin 页面）
        └─ ⚠ 不 invalidate staff AUTH_CACHE（见 P2-22-12）

admin/employees/[id]/page.tsx
  └─→ Promise.all([getEmployeeById, getEmployeeRoles, ...])
        ├─ getEmployeeById：scopeCondition(staff.storeId) ← 含组织域过滤
        └─ getEmployeeRoles(employeeId)：
              ⚠ 仅 requirePermission('employee:list')，无 scope 过滤（见 P0-22-03）
              ⚠ 注释声称"页面级 scopeCondition 已保证…"，但 Server Action 是公开 RPC

employees.updateEmployee
  ├─ if isResigned===true → DELETE permission_roles WHERE employee_id=$1
  │     ⚠ 单条 SQL 直接物理删除，未对每条 logOperation
  │     ⚠ 可能直接清掉系统唯一 admin（见 P0-22-02）
  └─ if storeId 变更：UPDATE permission_roles.scope_id（仅同步 store-level 行）
        + logOperation('permission.scopeSync')

cron / 任意时刻员工请求
  ├─ admin: getSessionFromCookie() 每请求 → 即时生效
  └─ staff: middleware/auth.js AUTH_CACHE 5 分钟 LRU
        ⚠ 撤销角色后员工端权限延迟 ≤5 分钟（P2-22-12）
        ⚠ invalidateAuthCache 仅 auth.bindPhone 后调用；assignRole/revokeRole 不感知
```

## 3. 自身漏洞

### 3.1 P0（阻断 / 资损 / 越权）— 5 项

#### **[P0-22-01]**（来源：v1 P0-22-01，状态：PENDING — v2 确认未修复）assignRole 不校验非 admin 角色的 scope.type，可越权写入 `部门` 类型 scope

- **文件**：`fengyu-admin/src/actions/permissions.ts:191-201`
- **现象**：仅当 `data.role === 'admin'` 时校验 `node.type === '总部'`。其他 6 种角色（manager/finance/hr/product/customer_mgr/staff）只要 `scopeId` 存在于 `org_nodes` 即接受。UI（`permissions-page.tsx:422 excludeTypes=["部门"]`）只过滤前端选择器；Server Action 是公开 RPC，调用方可直接传部门 org_node id 绕过 UI。
- **下游放大**：
  - `expandScopeStoreIds`（admin `permissions.ts:114-148` + staff `utils/scope.js:82-127`）对 `部门`/无 type 整段静默忽略 → 该角色 `scopeStoreIds=[]` → admin 端 `scopeCondition()` 返回 `sql\`FALSE\``（列表全空）。
  - 但 actions 集合（`computeActions`）按 role 名映射，**写动作（如 `customer:update`）的 `requirePermission` 通过**（不查 scope）→ 该用户仍可越权改写非 scope 数据。
  - staff 端 `deriveStaffLevel(roleBindings)` 因 `scopeType==='部门'` 整体 `continue`（`utils/scope.js:43-44`） → `staffLevel=null` → 员工小程序登录被锁，但 admin 后台依然渲染 role-driven 菜单。
- **风险**：scope.type 是整套 RBAC 的隐式合约；规避它即权限语义崩坏 + 越权。命中 CC4 / CC3。
- **复现**：
  1. 直接 `assignRole({ employeeId:'X', role:'manager', scopeId:'<部门 org_node_id>' })`
  2. 入库 + employee X 登录后 `roles.includes('manager')` 仍 true
  3. 触发任何 `requirePermission('store_unbind:approve')` 等 manager-only action
- **修复**：(L7) 在 `permissions.ts:201` 后追加 scope.type 校验，`node.type !== '部门'`，并按角色 × type 配对（admin→总部 / manager→任意 / hr→总部/市场 等）。

#### **[P0-22-02]**（来源：v1 P0-22-02，状态：PENDING — v2 确认未修复）非 admin "scope ⊆ session.scopeIds" 仍写为"集合相等"，hr 实际无法分配子树内 scope

- **文件**：`fengyu-admin/src/actions/permissions.ts:184-188`、`263-269`
- **现象**：
  ```ts
  const userScopeIds = session.roles.map(r => r.scopeId)
  if (!userScopeIds.includes(data.scopeId)) return { success:false, ... }
  ```
  即 hr 用户必须 `data.scopeId === session.scopeId` 完全相等才能分配。但 `expandScopeStoreIds` 的语义是"市场 scope 包含其下所有门店 / 总部包含全网"——session.roles 与可管理 scope 不是同一集合。
- **结果**：
  - 总部级 hr（`scope_type='总部'`，`scope_id=hq-node`）想给某门店员工分配 manager → `data.scopeId=门店 org_node`，不在 `userScopeIds` 里 → 拒绝。**hr 实际上无法在 scope 子树内分配除自身节点外的任何角色**。
  - 市场级 hr 同样无法分配下属任意门店的角色，必须升级到 admin。spec `admin.pr.spec.md:190` 写"hr 分配的 scope_id **须在其 scope 内**"——代码实现是"等于"，与 spec 直接冲突。
- **风险**：hr 角色业务挫败 / RBAC 模型瓦解 / spec 对齐失败。
- **修复**：(L7) 改为子树包含判定：用 `expandScopeStoreIds(session.roles)` 语义反向判断（先看 `data.scopeId` 是否就是某个 session.scopeId，否则递归 `org_nodes` 检查父链是否含 session.scopeId）。

#### **[P0-22-03]**（来源：v1 P0-22-03，状态：PENDING — v2 确认未修复）自删 / 离职清角色 / 最后一个 admin 仍无任何保护

- **文件**：`fengyu-admin/src/actions/permissions.ts:241-286`、`employees.ts:439-444`
- **现象**：
  - `revokeRole(id)` 不检查 `target.employeeId === session.employeeId` → admin 撤销自己的唯一 admin 记录后即丧失整套全局权限。
  - `revokeRole` 不检查"剩余 admin 角色数量 ≥ 1"。
  - `employees.updateEmployee({isResigned:true})` 单条 SQL `DELETE FROM permission_roles WHERE employee_id=$1`，把唯一 admin 离职即把 admin 角色连根拔。
- **风险**：系统进入"无任何 admin"死锁状态——`assignRole(role='admin')` 自身需要 `permission:assign_admin`（仅 admin 持有），无人可恢复，需直进 DB 修。
- **修复**：(L7)
  - `revokeRole`：删除前 `if (target.role === 'admin') { count = SELECT count(*) FROM permission_roles WHERE role='admin'; if (count <= 1) return error; }`；并且 `if (target.employeeId === session.employeeId && target.role === 'admin') return error`（不能自删 admin）。
  - `employees.updateEmployee(isResigned)`：删除前 SELECT 该员工的 admin 角色数量，若是系统最后一个 admin → 阻断 + 提示先转移。

#### **[P0-22-04]**（来源：v2 新发现 P0-22-V2-04，v2-only）`getEmployeeRoles` 是公开 Server Action，仅查 `employee:list` 不做 scope 过滤，越权读取任意员工角色

- **文件**：`fengyu-admin/src/actions/permissions.ts:136-167`
- **现象**：函数注释 `页面级 scopeCondition 已保证只有可访问的员工才会到达此处，无需再做 scope 过滤`（line 134）。但 Next.js Server Action 是公开 RPC 入口（`'use server'`），任何登录会话都能直接调用 `getEmployeeRoles('any-employee-id')`，**绕过页面 fetch 顺序**。
- **风险**：
  - hr 用户（`scope=市场 A`）调用 `getEmployeeRoles('<市场 B 某 admin 的 employee_id>')` 即可读到该 admin 的所有角色绑定，包含 `scopeId / scopeName / role`。这构成**跨域信息泄露**，违反 CC3 组织域隔离。
  - 同 page.tsx 中 `Promise.all([getEmployeeById, getEmployeeRoles])` 并行 fetch，二者成功/失败不联动；`getEmployeeById` 受 scopeCondition 限制，`getEmployeeRoles` 不限制——形成 silent leak。
- **复现**：
  1. hr 账号登录 admin。
  2. DevTools / curl 直接 POST 或在 console 中调用 `getEmployeeRoles('OTHER-EMP-ID')`。
  3. 返回该员工完整 `role[]`、`scopeId/scopeName`，包括其总部/市场绑定。
- **修复**：(L7) 在 `getEmployeeRoles` 内增加 scope 过滤：
  ```ts
  const isAdmin = hasRole(session, 'admin')
  if (!isAdmin) {
    const [target] = await db.select({ storeId: staffWechatUsers.storeId })
      .from(staffWechatUsers).where(eq(staffWechatUsers.employeeId, employeeId)).limit(1)
    if (!target || (target.storeId && !session.permissions.scopeStoreIds.includes(target.storeId))) {
      return [] // 或抛 PERMISSION_DENIED
    }
  }
  ```
- **关联**：CC3 / CC4 双命中。

#### **[P0-22-05]**（来源：v2 新发现 P0-22-V2-05，v2-only）`assignRole.role` 是裸 `string` 入参，无 allow-list 校验，可写入任意角色名

- **文件**：`fengyu-admin/src/actions/permissions.ts:169-238`、`db/schema/permission.ts:20`
- **现象**：
  - 入参类型 `data.role: string`（line 171），未做 `data.role in PERMISSION_MATRIX` 之类的 allow-list 校验。
  - DB 列 `role: text('role').notNull()` 也无 PG enum 或 CHECK。
  - `permission:assign` 通过即接受 `role='superadmin'` / `role='Admin'`（大小写）/ `role='   '` 等。
- **下游放大**：
  - admin `getRoles` 把 DB 字段 cast 成 `RoleType`（`permissions.ts:50`）→ `PERMISSION_MATRIX[r.role]` 查得 `undefined`，`computeActions` 静默跳过 → 该用户拥有"DB 中存在但前端无法识别"的 role 名。
  - staff 端 `deriveStaffLevel` 仅认识 `'manager'` 字面量；其他名字静默归 `store_staff` → 拿到部分门店权限但缺乏审计。
  - `roles.includes('manager')` 散落判断允许大小写拼写错误的 role 永远拿不到权限，但**调用方仍能成功**入库 → 数据脏。
- **风险**：配合 P0-22-01 可造"任意 role × 任意 scope"行；CC9 数据完整性 / CC5 错误码。
- **修复**：(L0 + L7)
  - L0：`permission_roles.role` 升级为 PG enum 7 值，或加 CHECK `CHECK (role IN ('admin','manager','finance','hr','product','customer_mgr','staff'))`
  - L7：`assignRole` 入口先 `if (!(data.role in PERMISSION_MATRIX)) return { success:false, message:'未知角色' }`

### 3.2 P1（数据一致 / 状态错乱）— 6 项

#### **[P1-22-06]**（来源：v1 P1-22-04，状态：PENDING — v2 确认未修复）离职批量清角色未单独写 operation_logs，与单条 `revokeRole` 路径不一致

- **文件**：`fengyu-admin/src/actions/employees.ts:439-444`
- **现象**：整段无 SELECT-then-log，仅在外层 `logUpdate('employee.update', diff)` 一笔，detail 不含被删的角色清单。审计断链：之后无法回查"该员工离职时被撤销了哪些角色 × 哪些 scope"。
- **修复**：(L7) DELETE 前先 SELECT 出列表，对每条 `logOperation('permission.revoke', ..., {role, scopeId, batch:'resignation'})`。

#### **[P1-22-07]**（来源：v1 P1-22-05，状态：PENDING — v2 确认未修复）`staff` 角色仍是 actions=[] 哑角色，admin/staff 双端语义割裂

- **文件**：`fengyu-admin/src/lib/permissions.ts:85`、`src/lib/types.ts:209`、`db/scripts/sync-workfine.js:444-457`
- **现象**：
  - `PERMISSION_MATRIX.staff = []` → admin 后台对 staff 角色完全锁死，登录看不到任何菜单。
  - sync-workfine.js 默认所有非"门店经理/市场总监/片区经理/财智部"员工 `role='staff'`，意味着**绝大多数员工**入库时角色都是 staff。
  - staff 端 `deriveStaffLevel` 把 `role='staff' AND scopeType='门店'` 派生为 `LEVEL_STORE_STAFF`，员工小程序正常使用。
  - 同一 role 在两端语义割裂：admin = 无权限 / staff = 一线员工。spec `admin.pr.spec.md:64-65` 权限矩阵表无 "staff" 列；类型定义却含 staff，是"未声明但合法"的 ghost 值。
- **修复**：(L7) 二选一：
  - 把 `staff` 从 `RoleType` 联合移除，sync-workfine 把"无 manager 头衔"的逻辑改成不写 permission_roles；
  - 或保留 `staff`，但显式给最低 actions 集（如 `['dashboard:view']`），消除空数组陷阱。

#### **[P1-22-08]**（来源：v1 P1-22-07，状态：PENDING — v2 确认未修复）PERMISSION_MATRIX 仅 admin 一份，staff 端硬编码守卫，"两套真相源"问题已量化

- **文件**：`fengyu-admin/src/lib/permissions.ts:15-86` vs `staffApi/middleware/auth.js:254-292`
- **量化**：
  - admin 端 `PERMISSION_MATRIX` 共 51 个 action × 7 角色 = 真值表共 357 元素；变更需发版。
  - staff 端守卫总数：`requireManager`、`requireManagementLevel`、`requireStaffBound` 三个；散落 `roles.includes('manager')` 判断 **21 处**（grep 结果，分布于 7 个 routes 文件：`order.js` 7 处 / `service.js` 7 处 / `staff.js` 4 处 / `appointment.js` 3 处 / `customer.js` 3 处 / `mgmt-product.js` 1 处 / `mgmt-traffic.js` 1 处）。
  - 同一角色（`manager`）在 admin 有 22 个 action 定义，在 staff 仅靠 `requireManager()` 单一开关 + 21 处分散 `includes` 判定。
- **风险**：增改权限要同时改两端；admin 给 manager 加新 action，staff 端不感知；staff 端新接口未加守卫，admin 端无法识别。
- **修复**：(L0/L3) 长期：PERMISSION_MATRIX 移至 DB；短期：staff 端守卫显式列成 `STAFF_REQUIRED_ROLES_BY_ROUTE` 常量，做到"两端一份事实表"。
- **关联**：audit-01 P1-PERM-07。

#### **[P1-22-09]**（来源：v2 新发现 P1-22-V2-11，v2-only）staff 端 `roles.includes('manager')` 散落 21 处绕过 scopeType=门店 约束，与 `requireManager()` 行为不一致

- **文件**：21 处散落点，集中在：
  - `staffApi/routes/order.js:702, 1087, 1199, 1256, 2535, 2611`
  - `staffApi/routes/service.js:50, 258, 306, 494, 644, 742, 805`
  - `staffApi/routes/staff.js:154, 319, 439, 621`
  - `staffApi/routes/appointment.js:66, 153, 195, 242`
  - `staffApi/routes/customer.js:23, 250, 581`
- **现象**：散落 `ctx.auth.roles.includes('manager')` 用去重后的 role 字符串数组判断"是否店长"，**未检查 `scopeType=门店`**。总部级 manager `roles.includes('manager') === true`，但 `requireManager()` 中间件**仅店长**会通过。
- **影响**：
  - 部分是"管理员宽容"路径（如 `customer.js:23` 决定是否脱敏手机号），允许总部级 manager 拿到完整 PII，可能符合预期；
  - 但 `service.complete`（`service.js:805`）` if (!roles.includes('manager'))` 这种"只有店长才能完成服务"的语义，会被总部 manager 满足；
  - `order.confirmOffline`（`order.js:1199`）"非店长不能确认收款"也同样被总部 manager 满足。
- **风险**：与 `requireManager()` 守卫"仅 scopeType=门店 manager"语义不一致 → 跨端权限模型混乱；配合 P0-22-01：写入 `部门` scope 的 manager → admin 视为有效 → staff 端 21 处 `includes` 全过 → 越权。
- **修复**：(L3) 把所有散落 `ctx.auth.roles.includes('manager')` 替换为统一 helper `isStoreManager(ctx)`（内含 `roleBindings.some(r => r.role==='manager' && r.scopeType==='门店')`）；或所有需要"门店店长"的接口前置 `requireManager()` middleware。

### 3.3 P2（代码质量 / 可维护）— 4 项

#### **[P2-22-10]**（来源：v1 P2-22-09，状态：PENDING — v2 确认未修复）`permission_roles.scope_id` 列类型 `text`，无 format 校验，依赖 FK 兜底

- **文件**：`db/schema/permission.ts:22-24`
- **现象**：`scope_id: text(...).references(orgNodes.id)` —— FK 保证存在，但 ULID/格式不限。如果 ULID 生成器变更或导入历史数据带空格，FK 会通过但语义异常。
- **修复**：(L0) 加 `CHECK (scope_id ~ '^[0-9a-zA-Z_]{16,40}$')` 或迁移到固定长度 ULID/UUID 列；优先级低。

#### **[P2-22-11]**（来源：v1 P2-22-10，状态：PENDING — v2 确认未修复）`revokeRole` logOperation detail 仅含 `{role}`，丢失 scopeId / employeeId

- **文件**：`fengyu-admin/src/actions/permissions.ts:279-281`
- **现象**：
  ```ts
  await logOperation(session, 'permission.revoke', 'permission_role', String(id), { role: target.role })
  ```
  `targetId=id` 是 `permission_roles.id`，删除后已无法回查 employeeId / scopeId（行已删）。审计困难。
- **修复**：(L7) `target` SELECT 时一并捞 employeeId / scopeId，detail 补 `{ role, scopeId, employeeId }`。

#### **[P2-22-12]**（来源：v1 P2-22-11，状态：PENDING — v2 确认未修复）UI 角色列表常量 `allRoles` 与 `RoleType` 类型联合无编译期一致性

- **文件**：`fengyu-admin/src/app/(main)/permissions/_components/permissions-page.tsx:34`、`employees/[id]/_components/employee-detail-page.tsx:32`
- **现象**：`const allRoles: RoleType[] = ["admin","manager","finance","hr","product","customer_mgr","staff"]` —— 若 `RoleType` 增减，TS 不会强制更新这两处常量长度。
- **修复**：(L9) 用 `Object.keys(PERMISSION_MATRIX) as RoleType[]` 即可保证一致。

#### **[P2-22-13]**（来源：v2 新发现 P2-22-V2-15，v2-only）`assignRole`/`revokeRole` 后未 `invalidateAuthCache`，员工端权限变更生效延迟最长 5 分钟

- **文件**：`fengyu-admin/src/actions/permissions.ts:218-238`、`267-285`；`staffApi/middleware/auth.js:21-22, 297-299`
- **现象**：admin 端 `assignRole`/`revokeRole` 成功后只 `revalidatePath('/permissions','/employees')` 刷 admin 页面缓存，**不清 staff 端 AUTH_CACHE**。staff 端 5 分钟 LRU 缓存持有旧 roleBindings，员工小程序仍按旧权限工作。
- **风险**：员工被撤 manager 后仍可在 ≤5 分钟内开单/收款，违反"权限即时生效"语义。生产场景常见即时弹劾 → 5 分钟窗口足够造成资损。
- **修复**：(L3 + L7) admin 端 assign/revoke 成功后通过 CloudBase 事件 / 直接调用 staffApi 内部 invalidate 接口清掉对应 OPENID 的 AUTH_CACHE；或缩短 TTL（如 30s）。

## 4. 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| 矩阵存储 | PERMISSION_MATRIX 代码常量（51 actions × 7 roles） | 无矩阵：staffLevel + 21 处 `includes('manager')` + 3 个守卫函数 | — 不参与 | 两套真相源，admin 改完 staff 不感知 | P1（P1-22-08） |
| 角色集合 | 7 值（含 staff actions=[]） | 4 个 staffLevel + raw role 字符串数组 | — | 同名异义（manager 在两端语义不等价） | P1 |
| Scope.type 校验 | 仅 admin role 校验=`总部`；其他 6 角色不校验 | scope.js 把 `部门` 静默忽略 | — | 部门 scope 写入合法，admin 视为有效但 storeIds=[] | P0（P0-22-01） |
| Scope 子树语义 | session.scopeId === target.scopeId（**集合相等**） | 业务用 scopeStoreIds 列表（**子树展开**） | — | hr 在 admin 端"集合相等"几乎无法分配 scope | P0（P0-22-02） |
| 角色变更生效 | 每请求查 DB，立即生效 | 5 分钟 LRU；assign/revoke 不 invalidate | — | 撤销后 ≤5 分钟员工仍工作 | P2（P2-22-13） |
| Role 列约束 | `RoleType` 联合 7 值；入参无 allow-list | 无 enum，字符串透传 | — | DB 层 `text` 无 CHECK → 任意字符串可入库，配合 P0-22-01 越权 | P0（P0-22-04/05） |
| `staff` 角色 | actions=[] 哑角色 | LEVEL_STORE_STAFF 正常使用 | — | 同名异义 | P1（P1-22-07） |
| 离职批量清角色 | 单 SQL DELETE 无单条 logOperation | 不参与 | — | 审计断链 | P1（P1-22-06） |
| 自删 / 最后 admin | 无任何保护 | 不参与 | — | 系统死锁风险 | P0（P0-22-03） |
| 跨员工读角色 | `getEmployeeRoles` 无 scope 过滤 | 不参与 | — | hr 可读其他市场 admin 角色（v2-only） | P0（P0-22-04） |
| `roles.includes('manager')` 散落 | hasRole 内置 | 21 处；总部 manager 误中"店长"判定（v2-only） | — | 越权完成服务单/确认收款 | P1（P1-22-09） |
| FK ON DELETE | NO ACTION | ↑ 同库 | — | OK（org/staff 删除前置检查） | — |

## 5. 横切检查（CC1–CC9）

| CC | 命中 | 说明 |
|----|------|------|
| CC1 数值 | — | 本域无金额字段 |
| CC2 并发幂等 | 部分 | `permission_roles` UNIQUE `(employee_id, role, scope_id)` + `assignRole` 先 SELECT 后 INSERT 接 23505 ✅；`updateEmployee(isResigned)` + 角色清理 + 调店 scope 同步未事务包裹；assign/revoke 不 invalidate staff cache（P2-22-13） |
| CC3 隔离 | ✅ 命中 | P0-22-01（部门 scope）/ P0-22-02（子树语义）/ P0-22-04（getEmployeeRoles 跨员工读）三条；P1-22-09 散落 manager 判定不分 scopeType |
| CC4 后端鉴权 | ✅ 命中 | P0-22-01/03/04/05 / P1-22-07/08/09；与 audit-01 P1-PERM-07、CROSS-CUTTING CC4 累积 |
| CC5 错误前缀 | 部分 | `requirePermission` 抛 `PERMISSION_DENIED:` ✅；assignRole/revokeRole 业务失败用 `{success:false,message}`（admin 习惯，可接受）；staff 端 `PERMISSION_DENIED:` 前缀符合约定 |
| CC6 PII | 部分 | `getEmployeeRoles` 跨员工读取 → 信息泄露；customer.js 中 `roles.includes('manager')` 决定 phone 脱敏（P1-22-09 关联） |
| CC7 时间字段 | ✅ | `created_at`/`updated_at` 由 Drizzle `defaultNow / $onUpdate` 写，OK |
| CC8 WXML/Vant | — | 本域无前端组件 |
| CC9 测试残留 | 部分 | `permissions.test.ts` 22 用例仅覆盖 happy path；P0-22-01/02/03/04/05 五类 case 全部缺测；staff 端 `requireManager` legacyFallback 路径缺 SQL 验证 |

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema/enums | `db/schema/enums.ts` 新增 `roleEnum` + `db/schema/permission.ts:20` | 收紧 `permission_roles.role` 列；CHECK `IN ('admin','manager','finance','hr','product','customer_mgr','staff')` | P0-22-05 |
| L0 schema | `db/schema/permission.ts:22` | scope_id 加 CHECK 排除 `部门` 类型触发器（DB 层兜底） | P0-22-01 |
| L0 配置 | `system_configs.permission_matrix` | 把 PERMISSION_MATRIX 移至 DB，admin/staff/cron 共读 | P1-22-08、audit-01 P1-PERM-07 |
| L7 admin actions | `src/actions/permissions.ts:assignRole` | (a) 校验 `role ∈ Object.keys(PERMISSION_MATRIX)`；(b) 校验 `scopeNode.type ∈ {总部/市场/门店}` 且按 role × type 配对；(c) "scope ⊆ session"换为子树判定 | P0-22-01、02、05 |
| L7 admin actions | `src/actions/permissions.ts:revokeRole` | (a) 检查 `target.employeeId !== session.employeeId OR target.role !== 'admin'`；(b) admin 角色撤销前 `count(*) WHERE role='admin' >= 2`；(c) detail 补 `{employeeId, scopeId}` | P0-22-03、P2-22-11 |
| L7 admin actions | `src/actions/permissions.ts:getEmployeeRoles` | 加 scope 过滤：非 admin 用户仅可查 scope 内员工 | P0-22-04 |
| L7 admin actions | `src/actions/employees.ts:439-444` | 离职清角色前先 SELECT + 检查最后一个 admin + 逐条 logOperation；包成事务 | P0-22-03、P1-22-06 |
| L3 staff middleware | `staffApi/middleware/auth.js:259-272` | 移除 `legacyFallback`；先 SQL 排查无 scopeType 数据 | P1-22-09 |
| L3 staff util | `staffApi/utils/scope.js:42-44` | "部门级忽略"改为"部门级拒绝（throw / 返回错误）"，提早暴露异常配置 | P0-22-01 |
| L3 staff routes | 21 处 `roles.includes('manager')` | 替换为统一 helper `isStoreManager(ctx)`（含 `scopeType=门店` 校验）；或前置 `requireManager()` middleware | P1-22-09 |
| L3 cache 同步 | admin assign/revoke 后清 staff AUTH_CACHE | 通过 CloudBase 事件 / 内部 invalidate 接口；或缩短 TTL | P2-22-13 |
| L9 admin UI | `_components/permissions-page.tsx:34` 等 | 用 `Object.keys(PERMISSION_MATRIX)` 替代字面量数组 | P2-22-12 |

## 7. 验证 SQL（5434/fengyu，仅 SELECT / EXPLAIN）

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

-- 7.3 P0-22-05：permission_roles.role 是否含意外值
SELECT role, count(*) AS cnt
FROM permission_roles
GROUP BY role
ORDER BY role;
-- 期望仅 admin/manager/finance/hr/product/customer_mgr/staff 7 值

-- 7.4 P1-22-09：staff 端 legacyFallback 是否还有"无 scopeType"行
SELECT pr.id, pr.role, pr.scope_id, o.type
FROM permission_roles pr
LEFT JOIN org_nodes o ON o.id = pr.scope_id
WHERE o.type IS NULL OR o.id IS NULL;

-- 7.5 P0-22-02：hr 用户当前 scope 与"可分配 scope"集合差距（举例量化）
SELECT pr.scope_id AS hr_scope, o.type, o.name
FROM permission_roles pr JOIN org_nodes o ON o.id = pr.scope_id
WHERE pr.role = 'hr';
-- 与 expandScopeStoreIds 子树展开比对，量化 hr 实际能/不能分配的 scope 比例

-- 7.6 P1-22-09：staff 端 manager 角色是否含非 scopeType=门店 的行
SELECT pr.id, pr.employee_id, pr.role, pr.scope_id, o.type
FROM permission_roles pr
JOIN org_nodes o ON o.id = pr.scope_id
WHERE pr.role = 'manager' AND o.type != '门店';
-- 这些行会被 21 处 includes('manager') 误判为店长

-- 7.7 P0-22-04：模拟非 admin 跨员工读角色（仅诊断，无副作用）
EXPLAIN SELECT pr.role, pr.scope_id
FROM permission_roles pr
WHERE pr.employee_id = '<other-employee-id>';
-- 验证 SQL 路径与生产 getEmployeeRoles 一致；现实应在应用层加 scope 过滤
```

## 8. 回归测试用例（建议）

1. `assignRole({role:'manager', scopeId:'<部门 org_node_id>'})` → 应被拒绝（当前 success:true）。
2. `assignRole({role:'audit_test', scopeId:'<hq>'})` → 应被拒绝（当前 success:true，DB 落库脏值）。
3. hr 用户（scope=市场 A）调用 `assignRole` 给市场 A 下任一门店员工 manager → 应通过（当前会被拒）。
4. hr 用户（scope=市场 A）调用 `getEmployeeRoles('<市场 B 某 admin 的 employee_id>')` → 应返回空数组或抛 PERMISSION_DENIED（当前可读完整角色，v2-only）。
5. 唯一 admin 调用 `revokeRole(自己 admin 记录 id)` → 应被拒（当前 success:true，系统进入死锁）。
6. 唯一 admin 被 hr 标 `isResigned=true` → 应阻断或先要求转移（当前直接 DELETE，admin 角色丢失）。
7. 离职清角色后查 `operation_logs WHERE target_type='permission_role' AND operator_employee_id=$current` → 应见每条角色对应一笔日志（当前仅一笔 employee.update）。
8. staff 端旧缓存（无 scopeType）总部级 manager 调用 `order.create` → 应被拒（移除 legacyFallback 后）；当前 SQL 7.4 排查后再回归。
9. 总部级 manager 调用 `service.complete`、`order.confirmOffline` → 应被拒（仅店长场景）；P1-22-09 修复后回归。
10. admin assign/revoke 完成后 30 秒内 staff 端是否仍持旧权限 → 5 分钟窗口下全失败，需 cache 失效机制。

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☑（admin + staff 共享 permission_roles，但矩阵两套）
- 全栈（3 端 + DB）：☐（client 不参与）
- 涉及历史数据：☑（需 SQL 7.1 / 7.3 / 7.4 / 7.6 排查现网是否已有"部门 scope"、"未知 role"、"无 scopeType"、"非门店 manager"残留）
- 修复成本：M（L0 enum 化 + CHECK + 触发器 / L7 校验扩充 + 自删保护 / L3 staff middleware 收紧 + 21 处替换；矩阵 DB 化属于大重构，可拆分滚动）

## 10. 后续待办

- [ ] 与 PM 对齐：staff 角色究竟是"哑角色（不入 permission_roles）"还是"持空 actions 占位"，落定 spec
- [ ] 与 PM 对齐：hr 是否需要"在自身 scope 子树内"分配（spec `admin.pr.spec.md:190` 已写"在其 scope 内"，代码错位）
- [ ] 与 PM 对齐：是否启动 PERMISSION_MATRIX → DB 迁移（audit-01 P1-PERM-07 + 本域 P1-22-08）
- [ ] 跑 SQL 7.1 / 7.3 / 7.4 / 7.6 确认现网历史脏数据，必要时写补丁迁移（**注意只读账号 / 5434 主库**）
- [ ] 评估 `employees.updateEmployee` 调店 + 角色迁移的事务边界（CC2 边缘）
- [ ] 评估 staff AUTH_CACHE 失效机制（事件总线 / 缩短 TTL / 主动 invalidate API）
- [ ] 把"两端真相源"问题升级为 epic：是否引入共享 SDK / 配置中心 / 共用 SQL 视图

---

## 11. v1 → v2 合并摘要

### 合并决策

| 决策 | 说明 |
|------|------|
| v1 全部 PENDING | v2 确认 v1 所有 11 项（3 P0 + 5 P1 + 3 P2）均**未修复**，保留原编号，标注 PENDING |
| v2 量化补充并入 | v1 P1-22-07（双矩阵问题）v2 补充了 21 处 `includes('manager')` 散落 + 357 元素真值表量化数据；并入 P1-22-08 |
| v2 新增独立发现 | 4 项 v2-only 独立发现（见下），分配新编号，不复用 V2 后缀 |
| 编号去重重排 | 所有 findings 统一编号（P0-22-01 ~ P2-22-13），去除原 V2 后缀（避免 report ID 与 finding ID 混淆） |
| v2 引用替换 | 原 v2 内所有 `P0-22-V2-0X` 引用替换为合并后编号；v2 整份报告已删除 |

### 合并后计数

| 级别 | v1 原计数 | v2 新增 | 合并后 | 变化 |
|------|-----------|---------|--------|------|
| P0 | 3 | +2 | **5** | +2 v2-only |
| P1 | 5 | +1 | **6** | +1 v2-only |
| P2 | 3 | +1 | **4** | +1 v2-only |
| **合计** | **11** | **+4** | **15** | 无重复，v2 全部为独立新发现 |

### v2 新增发现详情（v2-only，2026-04-26）

| 新编号 | 原 v2 ID | 标题 | 级别 | 关键影响 |
|--------|----------|------|------|----------|
| P0-22-04 | P0-22-V2-04 | `getEmployeeRoles` 公开 Server Action 无 scope 过滤，越权读任意员工角色 | P0 | hr 可读其他市场 admin 角色绑定，跨域信息泄露 |
| P0-22-05 | P0-22-V2-05 | `assignRole.role` 裸 string 无 allow-list 校验，可写入任意角色名 | P0 | 配合 P0-22-01 可造"任意 role × 任意 scope"行 |
| P1-22-09 | P1-22-V2-11 | staff 端 `roles.includes('manager')` 散落 21 处，绕过 scopeType=门店 约束 | P1 | 总部/市场级 manager 可越权完成服务单/确认收款 |
| P2-22-13 | P2-22-V2-15 | assignRole/revokeRole 后不清 staff AUTH_CACHE，权限变更延迟 ≤5 分钟 | P2 | 被撤权限员工在 5 分钟窗口内仍可操作，潜在资损 |

### v1 原 findings 状态（全部 PENDING）

| ID | 标题 | v2 确认 |
|----|------|---------|
| P0-22-01 | assignRole 不校验非 admin 角色 scope.type | PENDING（未修复） |
| P0-22-02 | scope ⊆ session 写为"集合相等"，hr 无法分配子树内 scope | PENDING（未修复） |
| P0-22-03 | 自删/离职清角色无最后 admin 保护 | PENDING（未修复） |
| P1-22-06 | 离职批量清角色未写 operation_logs | PENDING（未修复） |
| P1-22-07 | staff 角色 actions=[] 哑角色，admin/staff 语义割裂 | PENDING（未修复） |
| P1-22-08 | PERMISSION_MATRIX 仅 admin 一份，staff 端"两套真相源" | PENDING（未修复，v2 补充量化） |
| P2-22-10 | scope_id 列 text 无 format 校验 | PENDING（未修复） |
| P2-22-11 | revokeRole logOperation detail 仅含 role | PENDING（未修复） |
| P2-22-12 | UI allRoles 字面量与 RoleType 无编译期一致性 | PENDING（未修复） |

### 关联引用

- v1 原版：[audit-22-permission-matrix.md (v1)](audit-22-permission-matrix.md)（已合并入本文件）
- audit-01-auth.md P1-PERM-07（admin 矩阵代码常量）
- CROSS-CUTTING.md CC4（admin scope 隐式合约依赖矩阵兜底；payNotify 无鉴权）
- audit-CC3-org-isolation.md（多端组织隔离）
- audit-CC4-auth.md（后端鉴权）
- spec：`.42cog/pm/admin.pr.spec.md` AFF-07（角色分配 scope 传递约束）、§2.2 权限矩阵表
- spec：`.42cog/real.md` #5 后端统一鉴权、#6 组织域隔离
- memory：`feedback_no_legacy_compat.md`（开发阶段无需历史兼容，可清理 legacyFallback）
