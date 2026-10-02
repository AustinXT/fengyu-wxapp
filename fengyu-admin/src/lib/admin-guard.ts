import { db } from '@/db'
import { permissionRoleDefinitions, permissionRoles } from '@db/permission'
import { staffWechatUsers } from '@db/user'
import { and, eq, sql } from 'drizzle-orm'

/**
 * 可传事务句柄 —— 「最后一个超级管理员」守卫必须与那次 UPDATE 在**同一个事务**里读，
 * 否则两个 admin 被并发离职时双方都读到 count=2、各自成功，最终留下零管理员
 * （codex 谱系第 9 轮）。与 `operation-log.ts` 的 `OperationLogExecutor` 同一套路。
 */
type AdminGuardExecutor = Pick<typeof db, 'select'>

export async function countActiveAdmins(executor: AdminGuardExecutor = db): Promise<number> {
  const rows = await executor
    .select({ c: sql<number>`count(DISTINCT ${permissionRoles.employeeId})::int` })
    .from(permissionRoles)
    .innerJoin(permissionRoleDefinitions, eq(permissionRoles.role, permissionRoleDefinitions.roleKey))
    .innerJoin(staffWechatUsers, eq(permissionRoles.employeeId, staffWechatUsers.employeeId))
    .where(and(eq(permissionRoleDefinitions.isSuperAdmin, true), eq(staffWechatUsers.isResigned, false)))
  return rows[0]?.c ?? 0
}

export async function isAdminEmployee(
  employeeId: string,
  executor: AdminGuardExecutor = db,
): Promise<boolean> {
  const rows = await executor
    .select({ c: sql<number>`count(*)::int` })
    .from(permissionRoles)
    .innerJoin(permissionRoleDefinitions, eq(permissionRoles.role, permissionRoleDefinitions.roleKey))
    .where(and(eq(permissionRoles.employeeId, employeeId), eq(permissionRoleDefinitions.isSuperAdmin, true)))
    .limit(1)
  return (rows[0]?.c ?? 0) > 0
}
