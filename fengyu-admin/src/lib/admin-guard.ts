import { db } from '@/db'
import { permissionRoles } from '@db/permission'
import { staffWechatUsers } from '@db/user'
import { and, eq, sql } from 'drizzle-orm'

export async function countActiveAdmins(): Promise<number> {
  const rows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(permissionRoles)
    .innerJoin(staffWechatUsers, eq(permissionRoles.employeeId, staffWechatUsers.employeeId))
    .where(and(eq(permissionRoles.role, 'admin'), eq(staffWechatUsers.isResigned, false)))
  return rows[0]?.c ?? 0
}

export async function isAdminEmployee(employeeId: string): Promise<boolean> {
  const rows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(permissionRoles)
    .where(and(eq(permissionRoles.employeeId, employeeId), eq(permissionRoles.role, 'admin')))
    .limit(1)
  return (rows[0]?.c ?? 0) > 0
}
