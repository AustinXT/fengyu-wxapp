import { db } from '@/db'
import { permissionRoleDefinitions, permissionRoles } from '@db/permission'
import { staffWechatUsers } from '@db/user'
import { and, eq, sql } from 'drizzle-orm'

export async function countActiveAdmins(): Promise<number> {
  const rows = await db
    .select({ c: sql<number>`count(DISTINCT ${permissionRoles.employeeId})::int` })
    .from(permissionRoles)
    .innerJoin(permissionRoleDefinitions, eq(permissionRoles.role, permissionRoleDefinitions.roleKey))
    .innerJoin(staffWechatUsers, eq(permissionRoles.employeeId, staffWechatUsers.employeeId))
    .where(and(eq(permissionRoleDefinitions.isSuperAdmin, true), eq(staffWechatUsers.isResigned, false)))
  return rows[0]?.c ?? 0
}

export async function isAdminEmployee(employeeId: string): Promise<boolean> {
  const rows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(permissionRoles)
    .innerJoin(permissionRoleDefinitions, eq(permissionRoles.role, permissionRoleDefinitions.roleKey))
    .where(and(eq(permissionRoles.employeeId, employeeId), eq(permissionRoleDefinitions.isSuperAdmin, true)))
    .limit(1)
  return (rows[0]?.c ?? 0) > 0
}
