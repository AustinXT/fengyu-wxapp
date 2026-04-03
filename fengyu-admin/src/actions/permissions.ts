'use server'

import { db } from '@/db'
import { permissionRoles } from '@db/permission'
import { staffWechatUsers } from '@db/user'
import { orgNodes } from '@db/org'
import { eq, and, inArray, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { PermissionRole } from '@/lib/types'
import { getSession, hasRole } from '@/lib/auth'
import { requirePermission } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'

export async function getRoles(): Promise<PermissionRole[]> {
  const session = await getSession()
  requirePermission(session, 'permission:list')

  // 非 admin 用户只能看自身 scope 内的角色分配（AC-05 数据隔离）
  const isAdmin = hasRole(session, 'admin')
  const userScopeIds = session.roles.map(r => r.scopeId)
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
    .orderBy(permissionRoles.id)
    .limit(500)

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
}

/** 按 scope 查询角色分配 */
export async function getRolesByScope(scopeId: string): Promise<PermissionRole[]> {
  const session = await getSession()
  requirePermission(session, 'permission:list')

  const isAdmin = hasRole(session, 'admin')
  if (!isAdmin) {
    const userScopeIds = session.roles.map(r => r.scopeId)
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
    .orderBy(permissionRoles.id)

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
}

/** 查询每个 scope 的角色分配数量 */
export async function getRoleCountsByScope(): Promise<Record<string, number>> {
  const session = await getSession()
  requirePermission(session, 'permission:list')

  const isAdmin = hasRole(session, 'admin')
  const userScopeIds = session.roles.map(r => r.scopeId)
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
}

/**
 * 按员工查询权限角色，用于员工详情页。
 * 页面级 scopeCondition 已保证只有可访问的员工才会到达此处，无需再做 scope 过滤。
 */
export async function getEmployeeRoles(employeeId: string): Promise<PermissionRole[]> {
  const session = await getSession()
  requirePermission(session, 'employee:list')

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
    .orderBy(permissionRoles.id)

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
}

export async function assignRole(data: {
  employeeId: string
  role: string
  scopeId: string
}): Promise<{ success: boolean; message: string }> {
  const session = await getSession()

  // admin 角色只有 admin 可分配
  if (data.role === 'admin') {
    requirePermission(session, 'permission:assign_admin')
  } else {
    requirePermission(session, 'permission:assign')
  }

  // 非 admin 用户不能分配超出自身 scope 的权限
  if (!hasRole(session, 'admin')) {
    const userScopeIds = session.roles.map(r => r.scopeId)
    if (!userScopeIds.includes(data.scopeId)) {
      return { success: false, message: '不能分配超出自身权限范围的角色' }
    }
  }

  // admin 角色的 scopeId 必须是总部节点（spec AFF-07: scope_id 固定 headquarters）
  if (data.role === 'admin') {
    const [node] = await db
      .select({ type: orgNodes.type })
      .from(orgNodes)
      .where(eq(orgNodes.id, data.scopeId))
      .limit(1)
    if (!node || node.type !== '总部') {
      return { success: false, message: 'admin 角色必须绑定总部节点' }
    }
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
    if (err?.code === '23505') {
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
}

export async function revokeRole(
  id: number,
): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'permission:revoke')

  // 查询要撤销的角色记录
  const [target] = await db
    .select({ role: permissionRoles.role, scopeId: permissionRoles.scopeId })
    .from(permissionRoles)
    .where(eq(permissionRoles.id, id))
    .limit(1)

  if (!target) {
    return { success: false, message: '角色记录不存在' }
  }

  // 只有 admin 才能撤销 admin 角色
  if (target.role === 'admin' && !hasRole(session, 'admin')) {
    return { success: false, message: '只有系统管理员才能撤销 admin 角色' }
  }

  // 非 admin 用户不能撤销超出自身 scope 的角色
  if (!hasRole(session, 'admin')) {
    const userScopeIds = session.roles.map(r => r.scopeId)
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
  })

  revalidatePath('/permissions')
  revalidatePath('/employees')
  return { success: true, message: '角色已撤销' }
}
