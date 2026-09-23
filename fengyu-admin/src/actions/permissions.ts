'use server'

import { db } from '@/db'
import { pgErrorCode, pgErrorConstraint } from '@/lib/pg-error'
import { permissionRoleDefinitions, permissionRoles } from '@db/permission'
import { staffWechatUsers } from '@db/user'
import { orgNodes } from '@db/org'
import { eq, and, inArray, sql, desc, asc } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { PermissionRole } from '@/lib/types'
import { hasRole } from '@/lib/auth'
import { hasPermission, isAdminScope, isEmployeeRowVisible } from '@/lib/permissions'
import { withPermission, withAnyPermission } from '@/lib/with-permission'
import { logOperation } from '@/lib/operation-log'
import { ApiError } from '@/lib/api-error'
import { countActiveAdmins } from '@/lib/admin-guard'
// 与 employees 侧共用同一把「活跃 admin 计数」锁；取锁顺序见该模块顶部（#318）
import { lockActiveAdminCount } from '@/lib/invariant-locks'

async function loadRoleDefinition(roleKey: string): Promise<{
  roleKey: string
  name: string
  isSuperAdmin: boolean
  allowedScopeTypes: Array<'总部' | '市场' | '门店'>
} | null> {
  const rows = await db.execute(sql`
    SELECT role_key, name, is_super_admin, allowed_scope_types
      FROM permission_role_definitions
     WHERE role_key = ${roleKey}
     LIMIT 1
  `)
  const row = (rows as unknown as Array<{
    role_key: string
    name: string
    is_super_admin: boolean
    allowed_scope_types: Array<'总部' | '市场' | '门店'>
  }>)[0]
  if (!row) return null
  const isSuperAdmin = row.is_super_admin ?? roleKey === 'admin'
  return {
    roleKey: row.role_key || roleKey,
    name: row.name || roleKey,
    isSuperAdmin,
    allowedScopeTypes: row.allowed_scope_types ?? (isSuperAdmin ? ['总部'] : ['总部', '市场', '门店']),
  }
}

/** 非 admin 可操作的组织节点：角色绑定节点自身及其全部后代。 */
function permissionScopeIds(session: Parameters<typeof hasRole>[0]): string[] {
  return Array.from(new Set(
    session.permissions?.scopeOrgNodeIds
      ?? session.permissions?.scopeDeptNodeIds
      ?? session.roles.map((role) => role.scopeId),
  ))
}

export const getRoles = withPermission(
  'permission:list',
  async (session): Promise<PermissionRole[]> => {
  // 非 admin 用户只能看自身 scope 内的角色分配（AC-05 数据隔离）
  const isAdmin = isAdminScope(session)
  const userScopeIds = permissionScopeIds(session)
  if (!isAdmin && userScopeIds.length === 0) return []

  const whereCondition = isAdmin
    ? undefined
    : inArray(permissionRoles.scopeId, userScopeIds)

  const rows = await db
    .select({
      id: permissionRoles.id,
      employeeId: permissionRoles.employeeId,
      role: permissionRoles.role,
      roleName: permissionRoleDefinitions.name,
      canAccessAdmin: permissionRoleDefinitions.canAccessAdmin,
      isSuperAdmin: permissionRoleDefinitions.isSuperAdmin,
      isStoreManager: permissionRoleDefinitions.isStoreManager,
      allowedScopeTypes: permissionRoleDefinitions.allowedScopeTypes,
      scopeId: permissionRoles.scopeId,
      createdBy: permissionRoles.createdBy,
      createdAt: permissionRoles.createdAt,
      updatedAt: permissionRoles.updatedAt,
      employeeName: staffWechatUsers.name,
      scopeName: orgNodes.name,
    })
    .from(permissionRoles)
    .innerJoin(permissionRoleDefinitions, eq(permissionRoles.role, permissionRoleDefinitions.roleKey))
    .leftJoin(staffWechatUsers, eq(permissionRoles.employeeId, staffWechatUsers.employeeId))
    .leftJoin(orgNodes, eq(permissionRoles.scopeId, orgNodes.id))
    .where(whereCondition)
    // 默认排序：最近分配/修改的角色浮顶（admin.sys.spec.md §5）
    .orderBy(desc(permissionRoles.updatedAt), desc(permissionRoles.createdAt), desc(permissionRoles.id))

  return rows.map((r) => ({
    id: r.id,
    employeeId: r.employeeId,
    role: r.role as PermissionRole['role'],
    roleName: r.roleName,
    canAccessAdmin: r.canAccessAdmin,
    isSuperAdmin: r.isSuperAdmin,
    isStoreManager: r.isStoreManager,
    allowedScopeTypes: r.allowedScopeTypes as Array<'总部' | '市场' | '门店'>,
    scopeId: r.scopeId,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    employeeName: r.employeeName ?? undefined,
    scopeName: r.scopeName ?? undefined,
  }))
  },
)

/** 按 scope 查询角色分配 */
export const getRolesByScope = withPermission(
  'permission:list',
  async (session, scopeId: string): Promise<PermissionRole[]> => {
  const isAdmin = isAdminScope(session)
  if (!isAdmin) {
    const userScopeIds = permissionScopeIds(session)
    if (!userScopeIds.includes(scopeId)) return []
  }

  const rows = await db
    .select({
      id: permissionRoles.id,
      employeeId: permissionRoles.employeeId,
      role: permissionRoles.role,
      roleName: permissionRoleDefinitions.name,
      canAccessAdmin: permissionRoleDefinitions.canAccessAdmin,
      isSuperAdmin: permissionRoleDefinitions.isSuperAdmin,
      isStoreManager: permissionRoleDefinitions.isStoreManager,
      allowedScopeTypes: permissionRoleDefinitions.allowedScopeTypes,
      scopeId: permissionRoles.scopeId,
      createdBy: permissionRoles.createdBy,
      createdAt: permissionRoles.createdAt,
      updatedAt: permissionRoles.updatedAt,
      employeeName: staffWechatUsers.name,
      scopeName: orgNodes.name,
    })
    .from(permissionRoles)
    .innerJoin(permissionRoleDefinitions, eq(permissionRoles.role, permissionRoleDefinitions.roleKey))
    .leftJoin(staffWechatUsers, eq(permissionRoles.employeeId, staffWechatUsers.employeeId))
    .leftJoin(orgNodes, eq(permissionRoles.scopeId, orgNodes.id))
    .where(eq(permissionRoles.scopeId, scopeId))
    // 默认排序：最近分配/修改的角色浮顶（admin.sys.spec.md §5）
    .orderBy(desc(permissionRoles.updatedAt), desc(permissionRoles.createdAt), desc(permissionRoles.id))

  return rows.map((r) => ({
    id: r.id,
    employeeId: r.employeeId,
    role: r.role as PermissionRole['role'],
    roleName: r.roleName,
    canAccessAdmin: r.canAccessAdmin,
    isSuperAdmin: r.isSuperAdmin,
    isStoreManager: r.isStoreManager,
    allowedScopeTypes: r.allowedScopeTypes as Array<'总部' | '市场' | '门店'>,
    scopeId: r.scopeId,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    employeeName: r.employeeName ?? undefined,
    scopeName: r.scopeName ?? undefined,
  }))
  },
)

/** 查询每个 scope 的角色分配数量 */
export const getRoleCountsByScope = withPermission(
  'permission:list',
  async (session): Promise<Record<string, number>> => {
  const isAdmin = isAdminScope(session)
  const userScopeIds = permissionScopeIds(session)
  if (!isAdmin && userScopeIds.length === 0) return {}

  const whereCondition = isAdmin
    ? undefined
    : inArray(permissionRoles.scopeId, userScopeIds)

  const rows = await db
    .select({
      scopeId: permissionRoles.scopeId,
      count: sql<number>`count(*)::int`,
    })
    .from(permissionRoles)
    .where(whereCondition)
    .groupBy(permissionRoles.scopeId)

  const result: Record<string, number> = {}
  for (const r of rows) {
    result[r.scopeId] = r.count
  }
  return result
  },
)

/**
 * 按员工查询权限角色，用于员工详情页。
 * 页面级 scopeCondition 已保证只有可访问的员工才会到达此处，无需再做 scope 过滤。
 */
export const getEmployeeRoles = withPermission(
  'employee:list',
  async (_session, employeeId: string): Promise<PermissionRole[]> => {
  const rows = await db
    .select({
      id: permissionRoles.id,
      employeeId: permissionRoles.employeeId,
      role: permissionRoles.role,
      roleName: permissionRoleDefinitions.name,
      canAccessAdmin: permissionRoleDefinitions.canAccessAdmin,
      isSuperAdmin: permissionRoleDefinitions.isSuperAdmin,
      isStoreManager: permissionRoleDefinitions.isStoreManager,
      allowedScopeTypes: permissionRoleDefinitions.allowedScopeTypes,
      scopeId: permissionRoles.scopeId,
      createdBy: permissionRoles.createdBy,
      createdAt: permissionRoles.createdAt,
      updatedAt: permissionRoles.updatedAt,
      scopeName: orgNodes.name,
    })
    .from(permissionRoles)
    .innerJoin(permissionRoleDefinitions, eq(permissionRoles.role, permissionRoleDefinitions.roleKey))
    .leftJoin(orgNodes, eq(permissionRoles.scopeId, orgNodes.id))
    .where(eq(permissionRoles.employeeId, employeeId))
    // 例外：详情页短子列表（1~3 条），按插入顺序稳定展示
    .orderBy(asc(permissionRoles.id))

  return rows.map((r) => ({
    id: r.id,
    employeeId: r.employeeId,
    role: r.role as PermissionRole['role'],
    roleName: r.roleName,
    canAccessAdmin: r.canAccessAdmin,
    isSuperAdmin: r.isSuperAdmin,
    isStoreManager: r.isStoreManager,
    allowedScopeTypes: r.allowedScopeTypes as Array<'总部' | '市场' | '门店'>,
    scopeId: r.scopeId,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    scopeName: r.scopeName ?? undefined,
  }))
  },
)

export const assignRole = withAnyPermission(
  ['permission:assign', 'permission:assign_admin'],
  async (
    session,
    data: {
      employeeId: string
      role: string
      scopeId: string
    },
  ): Promise<{ success: boolean; message: string }> => {
  // admin 角色只有持 'permission:assign_admin' 才能分配
  const definition = await loadRoleDefinition(data.role)
  if (!definition) throw new Error('INVALID_PARAMS: 角色不存在')

  if (definition.isSuperAdmin && !hasPermission(session, 'permission:assign_admin')) {
    throw new Error('PERMISSION_DENIED: 无权执行 permission:assign_admin')
  }

  // 非 admin 用户不能分配超出自身 scope 的权限
  if (!isAdminScope(session)) {
    const userScopeIds = permissionScopeIds(session)
    if (!userScopeIds.includes(data.scopeId)) {
      return { success: false, message: '不能分配超出自身权限范围的角色' }
    }
  }

  // 每个角色只允许绑定定义中声明的组织层级；数据库触发器还有最终兜底。
  const [node] = await db
    .select({ type: orgNodes.type })
    .from(orgNodes)
    .where(eq(orgNodes.id, data.scopeId))
    .limit(1)
  if (!node) {
    throw new Error('INVALID_PARAMS: 组织节点不存在')
  }
  if (node.type === '部门') {
    throw new Error('INVALID_PARAMS: 角色不能绑定到部门型 scope')
  }
  if (!definition.allowedScopeTypes.includes(node.type as '总部' | '市场' | '门店')) {
    return { success: false, message: `角色“${definition.name}”只能绑定到${definition.allowedScopeTypes.join('、')}节点，不能绑定到${node.type}节点` }
  }
  if (!['总部', '市场', '门店'].includes(node.type)) {
    throw new Error(`INVALID_PARAMS: 角色 ${data.role} 不能绑定到 ${node.type} 型 scope`)
  }

  /*
   * 被授权人（第二主体）校验 —— #250。
   *
   * 上面那段只管住了 `data.scopeId`（授权范围），对 `data.employeeId` 此前零约束：
   * 绑市场 M 的 hr 可以把市场 N 的真实员工授予 M 内节点的角色（授权范围本身没越界，
   * 但「被授权人」完全未校验）；传垃圾 ID 则触发 `permission_roles.employee_id` 的
   * FK 23503，而 catch 只认 23505 → 裸抛 500 而非友好文案。
   *
   * 判据用 `isEmployeeRowVisible`（store ∪ orgNode 双维度）而**不是** `isInScope`：
   * `permission_roles` 授的恰恰包含职能部门员工（`store_id IS NULL`、靠 `org_node_id` 命中 scope），
   * 只按 store 判会把他们整体挡掉。这与 `customers.ts` 的 `resolveBoundEmployee` 刻意用
   * 单维度 `isInScope` 是两套口径，各有出处，别互相「对齐」。
   *
   * 「不存在」与「存在但不可见」合并成同一条文案、且都零写入（对齐 #228 commit 2c27c34a）：
   * 分成两句话只是把 oracle 从「员工归属」换成「employeeId 是否存在」。
   * 必须前置到下面的 existing 查询之前 —— 那句「该员工已拥有相同的角色和权限范围」
   * 对 scope 外员工同样是可探测的信道。
   *
   * 在职判定排在可见性**之后**：对不可见的员工连「他已离职」都不该泄露。
   *
   * 失败通道的分层判据（本函数里 throw 与 return 混用，不是随意的）：
   * **全局公共数据可以 throw**（角色定义 `:253`、组织节点 `:274` —— 任何持 permission:assign
   * 的人本来就能列举它们，且 scopeId 在 :260-265 已被挡在自身 scope 内）；
   * **敏感归属必须走合并 return**（本段的员工校验）。
   * 后续维护者不要在员工侧加 throw —— 那会重新暴露「employeeId 是否存在」。
   */
  const [targetEmployee] = await db
    .select({
      storeId: staffWechatUsers.storeId,
      orgNodeId: staffWechatUsers.orgNodeId,
      isResigned: staffWechatUsers.isResigned,
    })
    .from(staffWechatUsers)
    .where(eq(staffWechatUsers.employeeId, data.employeeId))
    .limit(1)
  if (!targetEmployee || !isEmployeeRowVisible(session, targetEmployee.storeId, targetEmployee.orgNodeId)) {
    return { success: false, message: '员工不存在或不在您的权限范围内' }
  }
  if (targetEmployee.isResigned) {
    return { success: false, message: '该员工已离职，无法分配角色' }
  }

  // 检查是否已存在相同的角色记录，避免重复分配
  const [existing] = await db
    .select({ id: permissionRoles.id })
    .from(permissionRoles)
    .where(and(
      eq(permissionRoles.employeeId, data.employeeId),
      eq(permissionRoles.role, data.role),
      eq(permissionRoles.scopeId, data.scopeId),
    ))
    .limit(1)

  if (existing) {
    return { success: false, message: '该员工已拥有相同的角色和权限范围' }
  }

  try {
    await db.insert(permissionRoles).values({
      employeeId: data.employeeId,
      role: data.role,
      scopeId: data.scopeId,
      createdBy: session.employeeId,
    })
  } catch (err: any) {
    if (pgErrorCode(err) === '23505') {
      return { success: false, message: '该员工已拥有相同的角色和权限范围' }
    }
    // employee_id 的 FK 兜底：前置校验与 insert 之间员工被并发删除的竞态。
    // 这条确实可达 —— deleteEmployee 在事务里先 `tx.delete(permissionRoles)` 再删主表
    // （employees.ts:1047-1058），所以「有角色行就删不掉员工」的直觉不成立。
    // 文案与前置校验逐字相同，不让竞态窗口变成另一个探测信道。
    //
    // ⚠️ 必须按约束名收窄：permission_roles 另有 scope_id → org_nodes、
    // role → permission_role_definitions 两条 FK，只判 23503 会把「组织节点/角色定义被并发删除」
    // 误报成「员工不存在」—— 把原本响亮的 500 变成静默且主体错误的业务拒绝，排障指错方向。
    // 判据取**前缀**而非全名或裸子串：全名
    // `permission_roles_employee_id_staff_wechat_users_employee_id_fk` 由 drizzle 生成规则决定、
    // 会随 schema 改名漂移；而裸 `includes('employee_id')` 在将来新增
    // `created_by → staff_wechat_users.employee_id` 之类的 FK 时会把它也吞进来
    // （那条约束名同样含 employee_id）。前缀锁死「引用列就是 employee_id」这一点。
    if (pgErrorCode(err) === '23503'
      && pgErrorConstraint(err)?.startsWith('permission_roles_employee_id_')) {
      return { success: false, message: '员工不存在或不在您的权限范围内' }
    }
    throw err
  }

  await logOperation(session, 'permission.assign', 'permission_role', data.employeeId, {
    role: data.role, scopeId: data.scopeId,
  })

  revalidatePath('/permissions')
  revalidatePath('/employees')
  return { success: true, message: '角色分配成功' }
  },
)

/**
 * 事务内回滚哨兵：删完发现系统零活跃超管。
 * 外层 `.catch` 按 message 匹配后转成友好文案（已登记进
 * `cross-end-error-codes-snapshot.test.js` 的 `TX_SENTINELS` 白名单）。
 */
const LAST_ACTIVE_ADMIN = 'LAST_ACTIVE_ADMIN'

export const revokeRole = withPermission(
  'permission:revoke',
  async (
    session,
    id: number,
  ): Promise<{ success: boolean; message: string }> => {
  // 查询要撤销的角色记录
  const [target] = await db
    .select({
      role: permissionRoles.role,
      scopeId: permissionRoles.scopeId,
      employeeId: permissionRoles.employeeId,
    })
    .from(permissionRoles)
    .where(eq(permissionRoles.id, id))
    .limit(1)

  if (!target) {
    return { success: false, message: '角色记录不存在' }
  }

  const definition = await loadRoleDefinition(target.role)
  if (!definition) return { success: false, message: '角色定义不存在' }

  // 只有超级管理员才能撤销超级管理员角色
  if (definition.isSuperAdmin && !isAdminScope(session)) {
    return { success: false, message: '只有系统管理员才能撤销系统管理员角色' }
  }

  // admin 自删保护（纯 session 比对，不打库，放在事务外早拒）
  if (definition.isSuperAdmin && target.employeeId === session.employeeId) {
    throw new ApiError('INVALID_STATE', '不能撤销自己的 admin 角色')
  }

  // 非 admin 用户不能撤销超出自身 scope 的角色（同样纯内存判定）
  if (!isAdminScope(session)) {
    const userScopeIds = permissionScopeIds(session)
    if (!userScopeIds.includes(target.scopeId)) {
      return { success: false, message: '不能撤销超出自身权限范围的角色' }
    }
  }

  /**
   * ## 撤销超管必须与 employees 侧**共用同一把锁**（issue #318）
   *
   * 「系统至少留一名在职超级管理员」这个不变量的守卫散落在四个 action 里：
   * `updateEmployee`（标离职）、`deleteEmployee`（物理删除）、
   * `role-definitions.updateRoleDefinition`（把角色降级成非超管）、以及这里（撤超管绑定）。
   * #249/#259 那轮把前两个收进了 `admin:active_count`，这里**没跟上** —— 于是
   * 「撤销 A 的 admin 角色」与「标记 B 离职」并发时，两边各自读到 `count = 2`
   * （READ COMMITTED 下看不见对方未提交的改动）、改的又是不同行，双双提交 → **零管理员**。
   * 光把前两个收进锁反而给人「已经闭合」的错觉，这条是真正的缺口。
   *
   * 取锁 + DELETE + 复核 + 审计整体进事务。锁序见 `lib/invariant-locks.ts`：
   * 本路径只需 ②，不涉及组织树与员工行锁。
   *
   * ## 「先删再数」而不是「先数再删」
   *
   * 前一版是「`count <= 1` 就拒」，那个判据**过紧**（codex 第 1 轮 P2）：
   *   - 目标员工**已离职** → 他本来就不在 `countActiveAdmins` 里（那个查询 join 了
   *     `is_resigned = false`），`count = 1` 指的是**别人**，删他这条绑定一个活跃超管都不减，
   *     却被拒 → 离职残留绑定永远清理不掉
   *   - 目标员工**还持有另一个**超管角色 → 删这条他仍然是超管，同样不减，同样被拒
   * 删完再数就不用枚举这些情形：`count === 0` 才是真的「系统零超管」，其余一律放行。
   * 代价是拒绝时要回滚，所以走**抛哨兵**（已登记进跨端 `TX_SENTINELS` 白名单）而不是返回值 ——
   * 返回值会把删除一起提交掉。
   */
  const txResult = await db.transaction(async (tx): Promise<true | { failure: string }> => {
    if (definition.isSuperAdmin) await lockActiveAdminCount(tx)

    const result = await tx.delete(permissionRoles).where(eq(permissionRoles.id, id))
    if ((result as any).count === 0) return { failure: '角色记录不存在' }

    if (definition.isSuperAdmin && await countActiveAdmins(tx) === 0) {
      throw new Error(LAST_ACTIVE_ADMIN)
    }

    // 审计与删除同生共死 —— 留在事务外时它失败会留下「角色已撤销但前端显示失败」
    await logOperation(session, 'permission.revoke', 'permission_role', String(id), {
      role: target.role,
      scopeId: target.scopeId,
      employeeId: target.employeeId,
    }, tx)
    return true
  }).catch((err: unknown) => {
    if (err instanceof Error && err.message === LAST_ACTIVE_ADMIN) {
      return { failure: '系统至少需保留 1 个活跃 admin' }
    }
    throw err
  })
  if (txResult !== true) {
    return { success: false, message: txResult.failure }
  }

  revalidatePath('/permissions')
  revalidatePath('/employees')
  return { success: true, message: '角色已撤销' }
  },
)
