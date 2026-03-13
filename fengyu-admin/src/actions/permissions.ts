'use server'

import { db } from '@/db'
import { permissionRoles } from '@db/permission'
import { staffWechatUsers } from '@db/user'
import { orgNodes } from '@db/org'
import { eq, and } from 'drizzle-orm'
import type { PermissionRole } from '@/lib/types'

export async function getRoles(): Promise<PermissionRole[]> {
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
  createdBy: string
}) {
  await db.insert(permissionRoles).values({
    employeeId: data.employeeId,
    role: data.role,
    scopeId: data.scopeId,
    createdBy: data.createdBy,
  })
}

export async function revokeRole(id: number) {
  await db
    .update(permissionRoles)
    .set({ isVoid: true, voidedAt: new Date() })
    .where(eq(permissionRoles.id, id))
}
