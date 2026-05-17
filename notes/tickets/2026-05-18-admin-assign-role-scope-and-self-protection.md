> 生成日期：2026-05-18
> 严重级别：P0（D-Q12-2026-04-26 已决 + audit-22 P0-22-01/P0-22-03 未关闭；SUMMARY v4 §6.3 E10 子项）
> 端：**admin 单端**（fengyu-admin）
> 影响面：
> - admin actions：`src/actions/permissions.ts` `assignRole` (L170)、`revokeRole` (L244)；`src/actions/employees.ts` `updateEmployee` (L456) `isResigned=true` 分支
> - admin lib：可选 `src/lib/admin-guard.ts` 抽出"最后一个 admin"检查（也可内联）
> - admin tests：`src/actions/__tests__/permissions.test.ts` + `employees.test.ts` 新增 6 个 case
> 修复成本：S-M（2–3 天，含 4 路守卫 + Vitest 覆盖）
> 前置：无（`permission_roles` 表已存在 + `withPermission` HOF 已落 + `hasRole` helper 已就绪）
> 来源：D-Q12-2026-04-26 决策 + audit-22 P0-22-01（scope.type 校验缺失）+ P0-22-03（最后 admin 死锁）+ SUMMARY v4 §6.3 E10

**一句话目标**：补齐 `assignRole` 的 scope.type × role 配对校验、`revokeRole` 的"最后一个 admin"保护，以及 `updateEmployee(isResigned=true)` 的同款保护，把 audit-22 P0-22-01 / P0-22-03 两条"系统死锁 + 越权写入部门 scope"P0 关闭。

---

## 0 一句话背景

D-Q12-2026-04-26 已决"admin 自删保护：阻断撤销最后一个 admin（≥1 admin 守卫，revokeRole + employees.updateEmployee(isResigned=true) 同时 guard）"，但 audit-22 P0-22-03 的 2026-05-17 复核栏已确认**仍未做**。本 ticket 同时收口 audit-22 P0-22-01 的 scope.type 校验（assignRole 不校验非 admin 角色的 scope.type，可越权写入"部门"型 scope）。

> 既有现状：`fengyu-admin/src/actions/permissions.ts:194-203` 仅当 `data.role === 'admin'` 时校验 `node.type === '总部'`；其他 6 种角色（manager/finance/hr/product/customer_mgr/staff）只要 `scopeId` 存在于 `org_nodes` 即接受 → 可越权写入 `部门` 型 scope。

> `revokeRole` (L244-290)：无任何"最后 admin"检查；`updateEmployee(isResigned=true)` (employees.ts:456-460) 直接 DELETE permission_roles。

---

## 1 现状盘点

### 1.1 assignRole 当前 scope 校验逻辑（grep 实证 2026-05-18）

`fengyu-admin/src/actions/permissions.ts:170-242`：

```ts
export const assignRole = withAnyPermission(
  ['permission:assign', 'permission:assign_admin'],
  async (session, data: { employeeId, role, scopeId }) => {
    // admin 角色额外权限校验
    if (data.role === 'admin' && !hasPermission(session, 'permission:assign_admin')) {
      throw new Error('PERMISSION_DENIED: 无权执行 permission:assign_admin')
    }
    // 非 admin 用户的 scope 限制（仅集合相等，不含子树语义）
    if (!hasRole(session, 'admin')) {
      const userScopeIds = session.roles.map(r => r.scopeId)
      if (!userScopeIds.includes(data.scopeId)) {
        return { success:false, message:'不能分配超出自身权限范围的角色' }
      }
    }
    // admin 角色必须绑定总部节点
    if (data.role === 'admin') {
      const [node] = await db.select({type: orgNodes.type})
        .from(orgNodes).where(eq(orgNodes.id, data.scopeId)).limit(1)
      if (!node || node.type !== '总部') {
        return { success:false, message:'系统管理员角色必须绑定总部节点' }
      }
    }
    // ⚠ 缺失：role !== 'admin' 时不校验 scope.type 是否在 {总部/市场/门店} 内
    // ⚠ 缺失：role × scope.type 配对（如 manager 仅能配 门店，hr 仅能配 总部/市场）

    // 直接 INSERT（含 23505 接住）
  },
)
```

### 1.2 revokeRole 当前实现（grep 实证 2026-05-18）

`fengyu-admin/src/actions/permissions.ts:244-290`：

```ts
export const revokeRole = withPermission(
  'permission:revoke',
  async (session, id: number) => {
    const [target] = await db.select({role, scopeId}).from(permissionRoles).where(eq(permissionRoles.id, id)).limit(1)
    if (!target) return { success:false, message:'角色记录不存在' }

    if (target.role === 'admin' && !hasRole(session, 'admin')) {
      return { success:false, message:'只有系统管理员才能撤销系统管理员角色' }
    }
    if (!hasRole(session, 'admin')) { /* scope 校验 */ }

    // ⚠ 缺失：target.role === 'admin' 时未检查"剩余 admin >= 2"
    // ⚠ 缺失：未检查 target.employeeId !== session.employeeId（admin 不能自删自己 admin 角色）

    await db.delete(permissionRoles).where(eq(permissionRoles.id, id))
    // logOperation detail 仅含 role（audit-22 P2-22-11 也未关闭，本 ticket 顺手补 employeeId/scopeId）
  },
)
```

### 1.3 updateEmployee `isResigned=true` 分支（grep 实证 2026-05-18）

`fengyu-admin/src/actions/employees.ts:456-460`：

```ts
// 标记离职时删除所有权限角色
if (data.isResigned === true) {
  await db.delete(permissionRoles).where(eq(permissionRoles.employeeId, employeeId))
}
```

整段无 SELECT 也无 admin-count guard，可直接清空唯一 admin → 系统死锁。

### 1.4 hasRole helper 现状

`fengyu-admin/src/lib/auth.ts`（已存在）`hasRole(session, 'admin')` 已实现，本 ticket 直接复用。

### 1.5 既有 logOperation 模式

`logOperation(session, action, targetType, targetId, detail)` —— `targetId` 当前是 `permission_roles.id`（删除后已无法回查 employeeId/scopeId），audit-22 P2-22-11 已列。本 ticket 顺手把 detail 补全（成本边际）。

---

## 2 关键架构决策

### 2.1 scope.type × role 配对规则

按 audit-22 P0-22-01 §修复建议 + 业务语义：

| role | 允许的 scope.type |
|---|---|
| admin | **总部**（唯一） |
| hr | 总部 / 市场 |
| finance | 总部 / 市场 / 门店 |
| product | 总部 / 市场 |
| customer_mgr | 总部 / 市场 / 门店 |
| manager | **门店**（唯一；总部/市场级 manager 概念在 audit-22 P1-22-09 也被反对）|
| staff | 门店（哑角色，audit-22 P1-22-07 未关闭）|

**统一硬规则**：禁止任何 role 配 `部门` 型 scope。

**实现位置**：抽 `src/lib/role-scope-rules.ts`（与 PERMISSION_MATRIX 相邻），exports `const ROLE_SCOPE_TYPES: Record<RoleType, OrgNodeType[]>`。

### 2.2 "最后一个 admin"判定口径

```sql
-- 候选 A：仅统计活跃 admin
SELECT count(*) FROM permission_roles pr
JOIN staff_wechat_users s ON s.employee_id = pr.employee_id
WHERE pr.role='admin' AND s.is_resigned = false

-- 候选 B：仅统计 permission_roles.role='admin' 行数（不 join 员工）
SELECT count(*) FROM permission_roles WHERE role='admin'
```

**推荐 A**：与"离职即清角色"语义一致——离职员工虽然 permission_roles 行还在（清的瞬间才删），但其角色不应被计数为"可用 admin"。

**门槛**：`count >= 2` 才允许 revoke/resign；如果当前刚好 = 1 → 阻断 + 提示"系统至少需保留 1 个活跃 admin"。

### 2.3 事务边界

`updateEmployee(isResigned=true)` 是多步操作：

1. UPDATE staff_wechat_users SET is_resigned=true
2. DELETE permission_roles WHERE employee_id=$1

应包成一个 PG 事务。当前实现两步分离（L437 update + L457 delete），若步骤 2 失败步骤 1 已 commit → 员工标 resigned 但角色未清，状态不一致。

**本 ticket 范围**：把 admin-count guard 加到步骤 2 之前（仍未包事务），并**额外**包成事务。事务的拆分 audit-22 P1-22-06 "调店 + 角色迁移事务边界"涉及更大范围，独立 ticket。

### 2.4 自删保护 vs 跨员工撤销

| 场景 | 当前行为 | 本 ticket 后行为 |
|---|---|---|
| admin 撤销自己唯一的 admin role | 成功（死锁）| 阻断 — `INVALID_STATE: 不能撤销自己唯一的 admin 角色` |
| admin 撤销其他人的 admin role（系统还有别的 admin）| 成功 | 成功 |
| admin 撤销其他人的唯一 admin role（撤销后 0 admin）| 成功（死锁）| 阻断 — `INVALID_STATE: 系统至少需保留 1 个活跃 admin` |
| hr 给离职员工标 isResigned=true（该员工持唯一 admin）| 成功 → 0 admin 死锁 | 阻断（hr 也不能 bypass admin guard）|
| admin 给自己标 isResigned=true（自己持唯一 admin）| 成功 → 0 admin 死锁 | 阻断 |

### 2.5 错误码与消息

- scope.type 不匹配 → `INVALID_PARAMS: 角色 X 不能绑定到 Y 型 scope`
- 最后 admin 守卫 → `INVALID_STATE: 系统至少需保留 1 个活跃 admin`
- 自删 admin → `INVALID_STATE: 不能撤销自己唯一的 admin 角色`

均在 9 项白名单内（参考 `fengyu-admin/src/lib/api-error.ts`）。

---

## 3 设计目标

### 3.1 assignRole 增量校验流程

```
assignRole(data)
  ├── withAnyPermission(['permission:assign','permission:assign_admin'])
  ├── role === 'admin' 时 hasPermission('permission:assign_admin') 校验  ← 已存在
  ├── 非 admin session.roles[i].scopeId 集合内  ← 已存在（仍按 P0-22-02 的"集合相等"，子树语义独立 ticket）
  ├── SELECT scope node type from org_nodes WHERE id=scopeId
  ├── if !node → INVALID_PARAMS: 组织节点不存在
  ├── if node.type === '部门' → INVALID_PARAMS: 角色不能绑定到部门型 scope    ← 新增
  ├── if !ROLE_SCOPE_TYPES[data.role].includes(node.type) → INVALID_PARAMS  ← 新增
  ├── 已存在 (employee, role, scope) 重复检查
  └── INSERT permission_roles
```

### 3.2 revokeRole 增量守卫流程

```
revokeRole(id)
  ├── withPermission('permission:revoke')
  ├── SELECT target FROM permission_roles WHERE id  ← 改：补 employeeId 列
  ├── if !target → return
  ├── if target.role === 'admin':
  │     ├── if target.employeeId === session.employeeId:
  │     │     return INVALID_STATE: 不能撤销自己的 admin 角色  ← 新增
  │     └── SELECT count(*) FROM permission_roles pr JOIN staff_wechat_users s
  │           WHERE pr.role='admin' AND s.is_resigned=false
  │         if count <= 1 → return INVALID_STATE: 系统至少需保留 1 个活跃 admin  ← 新增
  ├── scope 校验 ← 已存在
  ├── DELETE
  └── logOperation(detail={role, scopeId, employeeId})  ← 补全 detail (P2-22-11 顺手关闭)
```

### 3.3 updateEmployee(isResigned=true) 增量守卫流程

```
updateEmployee(employeeId, data)
  ├── ... 已存在 scope + 乐观锁 ...
  ├── if data.isResigned === true:
  │     ├── SELECT admin_count for this employeeId  ← 新增
  │     │     if exists admin role for this employee:
  │     │       SELECT system admin count;
  │     │       if count <= 1 → return INVALID_STATE: 该员工是系统最后一个 admin
  │     └── BEGIN TRANSACTION  ← 新增（事务包裹）
  │           UPDATE staff_wechat_users SET is_resigned=true, resigned_at=...
  │           SELECT roles before delete  ← 为 logOperation 准备
  │           DELETE permission_roles WHERE employee_id
  │           foreach role: logOperation('permission.revoke', detail={role, scopeId, batch:'resignation'})  ← P1-22-06 顺手关
  │         COMMIT
  └── 已存在 logUpdate('employee.update', ...) 不变
```

### 3.4 API 增量清单

#### 新建 `src/lib/role-scope-rules.ts`

```ts
import type { RoleType } from './types'

export type OrgNodeType = '总部' | '市场' | '门店' | '部门'

export const ROLE_SCOPE_TYPES: Record<RoleType, OrgNodeType[]> = {
  admin: ['总部'],
  hr: ['总部', '市场'],
  finance: ['总部', '市场', '门店'],
  product: ['总部', '市场'],
  customer_mgr: ['总部', '市场', '门店'],
  manager: ['门店'],
  staff: ['门店'],
}

export function isScopeTypeValidForRole(role: RoleType, scopeType: OrgNodeType): boolean {
  const allowed = ROLE_SCOPE_TYPES[role]
  return allowed ? allowed.includes(scopeType) : false
}
```

#### 新建 `src/lib/admin-guard.ts`

```ts
import { db } from '@/db'
import { permissionRoles } from '@db/permission'
import { staffWechatUsers } from '@db/user'
import { and, eq, sql } from 'drizzle-orm'

/** 统计当前活跃 admin 数量（is_resigned=false 的员工持有 admin role 的行数）*/
export async function countActiveAdmins(): Promise<number> {
  const r = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(permissionRoles)
    .innerJoin(staffWechatUsers, eq(permissionRoles.employeeId, staffWechatUsers.employeeId))
    .where(and(eq(permissionRoles.role, 'admin'), eq(staffWechatUsers.isResigned, false)))
  return r[0]?.c ?? 0
}

/** 判定指定员工是否持有 admin role（独立查询，避免与 countActiveAdmins 数据竞态）*/
export async function isAdminEmployee(employeeId: string): Promise<boolean> {
  const r = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(permissionRoles)
    .where(and(eq(permissionRoles.employeeId, employeeId), eq(permissionRoles.role, 'admin')))
    .limit(1)
  return (r[0]?.c ?? 0) > 0
}
```

#### 改 `src/actions/permissions.ts:170-242` assignRole

详见 §3.1。约 +20 行。

#### 改 `src/actions/permissions.ts:244-290` revokeRole

详见 §3.2。约 +25 行（含 logOperation detail 补全）。

#### 改 `src/actions/employees.ts:456-460` updateEmployee

详见 §3.3。约 +30 行（含事务包裹 + 逐条 log）。

---

## 4 详细变更清单（按层）

### 4.1 L7 — admin lib

| 文件 | 增量 | 行数 |
|---|---|---|
| `src/lib/role-scope-rules.ts`（新建）| ROLE_SCOPE_TYPES + isScopeTypeValidForRole | ~20 行 |
| `src/lib/admin-guard.ts`（新建）| countActiveAdmins + isAdminEmployee | ~30 行 |

### 4.2 L7 — admin actions

#### `src/actions/permissions.ts` assignRole 修改

```diff
   if (data.role === 'admin') {
     const [node] = await db
       .select({ type: orgNodes.type })
       .from(orgNodes)
       .where(eq(orgNodes.id, data.scopeId))
       .limit(1)
     if (!node || node.type !== '总部') {
       return { success: false, message: '系统管理员角色必须绑定总部节点' }
     }
+  } else {
+    const [node] = await db
+      .select({ type: orgNodes.type })
+      .from(orgNodes)
+      .where(eq(orgNodes.id, data.scopeId))
+      .limit(1)
+    if (!node) {
+      throw new Error('INVALID_PARAMS: 组织节点不存在')
+    }
+    if (node.type === '部门') {
+      throw new Error('INVALID_PARAMS: 角色不能绑定到部门型 scope')
+    }
+    if (!isScopeTypeValidForRole(data.role as RoleType, node.type as OrgNodeType)) {
+      throw new Error(`INVALID_PARAMS: 角色 ${data.role} 不能绑定到 ${node.type} 型 scope`)
+    }
   }
```

#### `src/actions/permissions.ts` revokeRole 修改

```diff
   const [target] = await db
-    .select({ role: permissionRoles.role, scopeId: permissionRoles.scopeId })
+    .select({
+      role: permissionRoles.role,
+      scopeId: permissionRoles.scopeId,
+      employeeId: permissionRoles.employeeId,
+    })
     .from(permissionRoles)
     .where(eq(permissionRoles.id, id))
     .limit(1)

   if (!target) {
     return { success: false, message: '角色记录不存在' }
   }
+
+  // 自删 admin 守卫（D-Q12 + audit-22 P0-22-03）
+  if (target.role === 'admin') {
+    if (target.employeeId === session.employeeId) {
+      throw new Error('INVALID_STATE: 不能撤销自己的 admin 角色')
+    }
+    const adminCount = await countActiveAdmins()
+    if (adminCount <= 1) {
+      throw new Error('INVALID_STATE: 系统至少需保留 1 个活跃 admin')
+    }
+  }
   ...
   await logOperation(session, 'permission.revoke', 'permission_role', String(id), {
-    role: target.role,
+    role: target.role,
+    scopeId: target.scopeId,
+    employeeId: target.employeeId,
   })
```

#### `src/actions/employees.ts:456-460` updateEmployee 修改

```diff
-  // 标记离职时删除所有权限角色
-  if (data.isResigned === true) {
-    await db
-      .delete(permissionRoles)
-      .where(eq(permissionRoles.employeeId, employeeId))
-  }
+  // 标记离职时：admin 守卫 + 事务删除角色 + 逐条 log
+  if (data.isResigned === true) {
+    if (await isAdminEmployee(employeeId)) {
+      const adminCount = await countActiveAdmins()
+      // adminCount 含当前员工自己；离职后会 -1。如果当前 <= 1 即"该员工就是最后一个"
+      if (adminCount <= 1) {
+        throw new Error('INVALID_STATE: 该员工是系统最后一个活跃 admin，请先转移角色')
+      }
+    }
+    await db.transaction(async (tx) => {
+      const roles = await tx
+        .select({ id: permissionRoles.id, role: permissionRoles.role, scopeId: permissionRoles.scopeId })
+        .from(permissionRoles)
+        .where(eq(permissionRoles.employeeId, employeeId))
+      await tx.delete(permissionRoles).where(eq(permissionRoles.employeeId, employeeId))
+      for (const r of roles) {
+        await logOperation(session, 'permission.revoke', 'permission_role', String(r.id), {
+          role: r.role, scopeId: r.scopeId, employeeId, batch: 'resignation',
+        })
+      }
+    })
+  }
```

> 注：当前 `updateEmployee` 整体未包事务（L437 update + L457 delete 是两步），本 ticket 仅把"isResigned=true 时的角色清理"包成事务。**update + delete 跨步骤事务**需要更大范围 refactor，独立 ticket（audit-22 P1-22-06 后续）。

### 4.3 tests

| 文件 | 新增 case |
|---|---|
| `src/actions/__tests__/permissions.test.ts` | (a) assignRole 部门 scope 拒绝 (b) assignRole hr+门店拒绝 (c) revokeRole 自删 admin 拒绝 (d) revokeRole 最后 admin 拒绝 (e) revokeRole 倒数第二 admin 成功 (f) logOperation detail 含 employeeId/scopeId |
| `src/actions/__tests__/employees.test.ts` | (g) updateEmployee resign 最后 admin 拒绝 (h) updateEmployee resign 倒数第二 admin 成功 (i) updateEmployee resign 事务回滚（mock delete throw → roles 仍在）|
| `src/lib/__tests__/admin-guard.test.ts`（新建）| (j) countActiveAdmins 含/不含 is_resigned 边界 (k) isAdminEmployee true/false |

合计 ~11 新用例。

---

## 5 迁移策略（按 Stage）

| Stage | 内容 | 工期 |
|---|---|---|
| **S0（preflight）** | 跑 SQL：`SELECT count(*) FROM permission_roles pr JOIN org_nodes o ON o.id=pr.scope_id WHERE o.type='部门'` — 如果 > 0 表示历史已有越权写入，先报告再批量清理 | 0.25 天 |
| **S1（L7 lib）** | role-scope-rules.ts + admin-guard.ts 新建 + 单测 | 0.5 天 |
| **S2（L7 actions）** | assignRole / revokeRole / updateEmployee 三处 patch + tests | 1 天 |
| **S3（E2E + docs）** | Playwright 1 spec（admin 自删被拒）+ admin.sys.spec.md §AFF-07 / §AFF-03 增 admin-guard 段 | 0.5 天 |

**总工期：2.25 天**

S0 不通过（历史脏数据）→ 先开独立批量清理 ticket，再做 S1+。

---

## 6 验证 Checklist

### 6.1 后端

- [ ] `cd fengyu-admin && npx tsc --noEmit` 0 错
- [ ] `bun run test` Vitest 全绿（含新增 11 用例）
- [ ] `bun run build` 通过

### 6.2 SQL preflight

- [ ] 5434 跑：`SELECT pr.id, pr.employee_id, pr.role, pr.scope_id, o.type, o.name FROM permission_roles pr JOIN org_nodes o ON o.id=pr.scope_id WHERE o.type='部门'` → 期望 0 行
- [ ] 5434 跑：`SELECT count(*) FROM permission_roles pr JOIN staff_wechat_users s ON s.employee_id=pr.employee_id WHERE pr.role='admin' AND s.is_resigned=false` → 期望 ≥ 2（线上至少 2 个 admin 才能正常做测试 + 守卫）

### 6.3 手工

- [ ] 创建测试 admin B → admin A 撤销 admin A 自己 → 拒绝 "不能撤销自己的 admin 角色"
- [ ] admin A 撤销 admin B → 成功（剩 1）→ admin A 撤销 admin A 自己 → 拒绝 "系统至少需保留 1 个活跃 admin"
- [ ] hr 给 admin C 标 isResigned=true → 拒绝（假设 C 是最后 admin）
- [ ] assignRole role=manager scopeId=<部门 org_node id> → 拒绝 INVALID_PARAMS
- [ ] assignRole role=hr scopeId=<门店 org_node id> → 拒绝 INVALID_PARAMS（hr 仅允许 总部/市场）
- [ ] revokeRole 后 operation_logs.detail 含 employeeId / scopeId

---

## 7 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| **生产已有部门 scope 历史脏数据** | assignRole 校验前已 INSERT 的行不受影响，但 admin UI 选择器（excludeTypes=['部门']）不显示 → 用户改不动 → 卡死 | S0 preflight SQL 先排查；如有则独立 ticket UPDATE 修正 |
| **唯一 admin 紧急离职但没人能接** | resign 被拒，业务卡 | 提供"转移 admin 角色"流程：先给员工 D 加 admin role（admin A 操作）→ 再给 admin A 标 resign 即通过 |
| **测试环境只有 1 个 admin → 单测自冲** | 单测自身被守卫拒绝 | 单测 mock countActiveAdmins 返回大值；不依赖真实 admin 数 |
| **事务在 PG 连接超时下崩** | resign 写入一半 | 事务自动回滚（PG 默认）；可加 try/catch 重抛 INVALID_STATE |
| **logOperation 在事务内调用引入死锁** | resign 流程卡 | logOperation 走独立连接（admin db 是连接池，事务内 await 普通 query 即可）|

**回滚策略**：
- 单 commit revert（无 schema 变更，无数据迁移）
- 紧急可临时回退仅 assignRole 一处校验（保留 revoke / resign 守卫），独立提交

---

## 8 关联

- **决策**：D-Q12-2026-04-26（`docs/audit/SUMMARY.md` §5.1）
- **审计来源**：`docs/audit/audit-22-permission-matrix.md`
  - P0-22-01 scope.type 校验
  - P0-22-03 自删/最后 admin 保护
  - P2-22-11 revokeRole logOperation detail 补 employeeId/scopeId（顺手关闭）
  - P1-22-06 离职批量清角色未单条 log（顺手关闭）
- **不在范围**：
  - audit-22 P0-22-02（"集合相等" → 子树包含语义改造，独立 ticket）
  - audit-22 P0-22-04（getEmployeeRoles 跨员工读，独立 ticket）
  - audit-22 P0-22-05（role 列加 PG enum，独立 ticket）
  - audit-22 P1-22-09（staff 端 21 处 manager 散落，独立 ticket）
  - audit-22 P2-22-13（staff AUTH_CACHE 失效，独立 ticket）
- **相关 memory**：feedback `no-legacy-compat`（不为历史脏 部门 scope 数据做兼容兜底，发现即清理）

---

## 9 复核反馈区（R1 待填）

> 实施前/中由 code reviewer 在此追加反馈块。重点复核：
>
> 1. S0 preflight SQL 在 5434 跑后的行数：是否 0（部门 scope）+ ≥2（活跃 admin）
> 2. updateEmployee 事务边界：仅角色清理包事务 vs 整个 update + delete 包事务（后者超出本 ticket）
> 3. ROLE_SCOPE_TYPES 映射表是否与 audit-22 §3.1 + admin.pr.spec.md §AFF-07 一致
> 4. "最后 admin"判定是否要把 admin role 在多个 scope 的同一员工算 1 次而非 N 次（当前 countActiveAdmins 是 row count，可能漏判）
> 5. resignation 批量 log 是否要按"父子日志"组合写（一条 batch summary + N 条 detail）改善审计可读性
