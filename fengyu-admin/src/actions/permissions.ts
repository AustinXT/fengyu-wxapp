'use server'

import { db } from '@/db'
import { pgErrorCode } from '@/lib/pg-error'
import { permissionRoles } from '@db/permission'
import { staffWechatUsers } from '@db/user'
import { orgNodes } from '@db/org'
import { eq, and, inArray, sql, desc, asc } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { PermissionRole, RoleType } from '@/lib/types'
import { hasRole } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { withPermission, withAnyPermission } from '@/lib/with-permission'
import { logOperation } from '@/lib/operation-log'
import { isScopeTypeValidForRole, type OrgNodeType } from '@/lib/role-scope-rules'
import { countActiveAdmins } from '@/lib/admin-guard'

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
  const isAdmin = hasRole(session, 'admin')
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
      scopeId: permissionRoles.scopeId,
      createdBy: permissionRoles.createdBy,
      createdAt: permissionRoles.createdAt,
      updatedAt: permissionRoles.updatedAt,
      employeeName: staffWechatUsers.name,
      scopeName: orgNodes.name,
    })
    .from(permissionRoles)
    .leftJoin(staffWechatUsers, eq(permissionRoles.employeeId, staffWechatUsers.employeeId))
    .leftJoin(orgNodes, eq(permissionRoles.scopeId, orgNodes.id))
    .where(whereCondition)
    // 默认排序：最近分配/修改的角色浮顶（admin.sys.spec.md §5）
    .orderBy(desc(permissionRoles.updatedAt), desc(permissionRoles.createdAt), desc(permissionRoles.id))

  return rows.map((r) => ({
    id: r.id,
    employeeId: r.employeeId,
    role: r.role as PermissionRole['role'],
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
  const isAdmin = hasRole(session, 'admin')
  if (!isAdmin) {
    const userScopeIds = permissionScopeIds(session)
    if (!userScopeIds.includes(scopeId)) return []
  }

  const rows = await db
    .select({
      id: permissionRoles.id,
      employeeId: permissionRoles.employeeId,
      role: permissionRoles.role,
      scopeId: permissionRoles.scopeId,
      createdBy: permissionRoles.createdBy,
      createdAt: permissionRoles.createdAt,
      updatedAt: permissionRoles.updatedAt,
      employeeName: staffWechatUsers.name,
      scopeName: orgNodes.name,
    })
    .from(permissionRoles)
    .leftJoin(staffWechatUsers, eq(permissionRoles.employeeId, staffWechatUsers.employeeId))
    .leftJoin(orgNodes, eq(permissionRoles.scopeId, orgNodes.id))
    .where(eq(permissionRoles.scopeId, scopeId))
    // 默认排序：最近分配/修改的角色浮顶（admin.sys.spec.md §5）
    .orderBy(desc(permissionRoles.updatedAt), desc(permissionRoles.createdAt), desc(permissionRoles.id))

  return rows.map((r) => ({
    id: r.id,
    employeeId: r.employeeId,
    role: r.role as PermissionRole['role'],
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
  const isAdmin = hasRole(session, 'admin')
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
      scopeId: permissionRoles.scopeId,
      createdBy: permissionRoles.createdBy,
      createdAt: permissionRoles.createdAt,
      updatedAt: permissionRoles.updatedAt,
      scopeName: orgNodes.name,
    })
    .from(permissionRoles)
    .leftJoin(orgNodes, eq(permissionRoles.scopeId, orgNodes.id))
    .where(eq(permissionRoles.employeeId, employeeId))
    // 例外：详情页短子列表（1~3 条），按插入顺序稳定展示
    .orderBy(asc(permissionRoles.id))

  return rows.map((r) => ({
    id: r.id,
    employeeId: r.employeeId,
    role: r.role as PermissionRole['role'],
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
  if (data.role === 'admin' && !hasPermission(session, 'permission:assign_admin')) {
    throw new Error('PERMISSION_DENIED: 无权执行 permission:assign_admin')
  }

  // 非 admin 用户不能分配超出自身 scope 的权限
  if (!hasRole(session, 'admin')) {
    const userScopeIds = permissionScopeIds(session)
    if (!userScopeIds.includes(data.scopeId)) {
      return { success: false, message: '不能分配超出自身权限范围的角色' }
    }
  }

  // role × scope.type 配对校验（admin: 仅总部；其余按 ROLE_SCOPE_TYPES）
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
  if (data.role === 'admin') {
    if (node.type !== '总部') {
      return { success: false, message: '系统管理员角色必须绑定总部节点' }
    }
  } else if (!isScopeTypeValidForRole(data.role as RoleType, node.type as OrgNodeType)) {
    throw new Error(`INVALID_PARAMS: 角色 ${data.role} 不能绑定到 ${node.type} 型 scope`)
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

  // 只有 admin 才能撤销 admin 角色
  if (target.role === 'admin' && !hasRole(session, 'admin')) {
    return { success: false, message: '只有系统管理员才能撤销系统管理员角色' }
  }

  // admin 自删保护 + 最后 admin 保护（D-Q12-2026-04-26 / audit-22 P0-22-03）
  if (target.role === 'admin') {
    if (target.employeeId === session.employeeId) {
      throw new Error('INVALID_STATE: 不能撤销自己的 admin 角色')
    }
    const adminCount = await countActiveAdmins()
    if (adminCount <= 1) {
      throw new Error('INVALID_STATE: 系统至少需保留 1 个活跃 admin')
    }
  }

  // 非 admin 用户不能撤销超出自身 scope 的角色
  if (!hasRole(session, 'admin')) {
    const userScopeIds = permissionScopeIds(session)
    if (!userScopeIds.includes(target.scopeId)) {
      return { success: false, message: '不能撤销超出自身权限范围的角色' }
    }
  }

  const result = await db
    .delete(permissionRoles)
    .where(eq(permissionRoles.id, id))

  if ((result as any).count === 0) {
    return { success: false, message: '角色记录不存在' }
  }

  await logOperation(session, 'permission.revoke', 'permission_role', String(id), {
    role: target.role,
    scopeId: target.scopeId,
    employeeId: target.employeeId,
  })

  revalidatePath('/permissions')
  revalidatePath('/employees')
  return { success: true, message: '角色已撤销' }
  },
)
