'use server'

import { db } from '@/db'
import { permissionRoles } from '@db/permission'
import { staffWechatUsers } from '@db/user'
import { orgNodes } from '@db/org'
import { eq, and, inArray } from 'drizzle-orm'
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

  const baseWhere = eq(permissionRoles.isVoid, false)
  const whereCondition = isAdmin
    ? baseWhere
    : and(baseWhere, inArray(permissionRoles.scopeId, userScopeIds))

  const rows = await db
    .select({
      id: permissionRoles.id,
      employeeId: permissionRoles.employeeId,
      role: permissionRoles.role,
      scopeId: permissionRoles.scopeId,
      isVoid: permissionRoles.isVoid,
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

  return rows.map((r) => ({
    id: r.id,
    employeeId: r.employeeId,
    role: r.role as PermissionRole['role'],
    scopeId: r.scopeId,
    isVoid: r.isVoid,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    employeeName: r.employeeName ?? undefined,
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

  // 检查是否已存在相同的活跃角色记录，避免重复分配
  const [existing] = await db
    .select({ id: permissionRoles.id })
    .from(permissionRoles)
    .where(and(
      eq(permissionRoles.employeeId, data.employeeId),
      eq(permissionRoles.role, data.role),
      eq(permissionRoles.scopeId, data.scopeId),
      eq(permissionRoles.isVoid, false),
    ))
    .limit(1)

  if (existing) {
    return { success: false, message: '该员工已拥有相同的角色和权限范围' }
  }

  await db.insert(permissionRoles).values({
    employeeId: data.employeeId,
    role: data.role,
    scopeId: data.scopeId,
    createdBy: session.employeeId,
  })

  await logOperation(session, 'permission.assign', 'permission_role', data.employeeId, {
    role: data.role, scopeId: data.scopeId,
  })

  revalidatePath('/permissions')
  return { success: true, message: '角色分配成功' }
}

export async function revokeRole(
  id: number,
  /** 乐观锁：提交时携带的 updated_at */
  expectedUpdatedAt?: string,
): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'permission:revoke')

  // 查询要撤销的角色记录
  const [target] = await db
    .select({ role: permissionRoles.role, isVoid: permissionRoles.isVoid, scopeId: permissionRoles.scopeId })
    .from(permissionRoles)
    .where(eq(permissionRoles.id, id))
    .limit(1)

  if (!target) {
    return { success: false, message: '角色记录不存在' }
  }
  if (target.isVoid) {
    return { success: false, message: '该角色已被撤销' }
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

  const whereConditions = expectedUpdatedAt
    ? and(eq(permissionRoles.id, id), eq(permissionRoles.updatedAt, new Date(expectedUpdatedAt)))
    : eq(permissionRoles.id, id)

  const result = await db
    .update(permissionRoles)
    .set({ isVoid: true, voidedAt: new Date(), updatedBy: session.employeeId })
    .where(whereConditions)

  if (expectedUpdatedAt && (result as any).rowCount === 0) {
    return { success: false, message: '数据已被其他人修改，请刷新后重试' }
  }

  await logOperation(session, 'permission.revoke', 'permission_role', String(id), {
    role: target.role,
  })

  revalidatePath('/permissions')
  return { success: true, message: '角色已撤销' }
}
