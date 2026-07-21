import { cookies } from "next/headers"
import { jwtVerify } from "jose"
import { eq } from "drizzle-orm"
import { db } from "@/db"
import { JWT_SECRET } from "@/lib/jwt-secret"
import { canAccessAdmin, computeActions, expandScopeStoreIds } from "@/lib/permissions"
import type { AuthSession, RoleType } from "@/lib/types"
import { permissionRoles } from "@db/permission"
import { orgNodes } from "@db/org"
import { staffWechatUsers } from "@db/user"

const COOKIE_NAME = "fy-admin-token"

export async function getSession(): Promise<AuthSession | null> {
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get(COOKIE_NAME)?.value
    if (!token) return null

    const { payload } = await jwtVerify(token, JWT_SECRET)
    const employeeId = payload.employeeId as string | undefined
    if (!employeeId) return null

    const [staff] = await db
      .select({
        employeeId: staffWechatUsers.employeeId,
        name: staffWechatUsers.name,
        phone: staffWechatUsers.phone,
      })
      .from(staffWechatUsers)
      .where(eq(staffWechatUsers.employeeId, employeeId))
      .limit(1)

    if (!staff) return null

    const roleRows = await db
      .select({
        role: permissionRoles.role,
        scopeId: permissionRoles.scopeId,
        scopeType: orgNodes.type,
      })
      .from(permissionRoles)
      .leftJoin(orgNodes, eq(permissionRoles.scopeId, orgNodes.id))
      .where(eq(permissionRoles.employeeId, employeeId))

    const roles = roleRows.map((r) => ({
      role: r.role as RoleType,
      scopeId: r.scopeId,
      scopeType: (r.scopeType ?? "门店") as "总部" | "市场" | "门店",
    }))

    if (!canAccessAdmin(roles)) return null

    const [actions, scopeStoreIds] = await Promise.all([
      computeActions(roles),
      expandScopeStoreIds(roles),
    ])

    return {
      employeeId: staff.employeeId,
      name: staff.name ?? "未命名",
      phone: staff.phone ?? "",
      roles,
      permissions: { actions, scopeStoreIds },
    }
  } catch {
    return null
  }
}

