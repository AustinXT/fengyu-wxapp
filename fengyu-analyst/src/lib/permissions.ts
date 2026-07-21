import { db } from "@/db"
import { orgNodes, stores } from "@db/org"
import { and, eq, inArray, sql } from "drizzle-orm"
import type { AuthSession, RoleType } from "@/lib/types"

const DEFAULT_PERMISSION_MATRIX: Record<RoleType, string[]> = {
  admin: ["data_center:dashboard", "analyst:view", "analyst:chat", "analyst:export"],
  manager: ["data_center:dashboard", "analyst:view", "analyst:chat"],
  finance: ["data_center:dashboard", "analyst:view", "analyst:export"],
  hr: [],
  product: [],
  customer_mgr: [],
  staff: [],
}

let matrixCache: { matrix: Record<RoleType, string[]>; expiresAt: number } | null = null

async function getPermissionMatrix(): Promise<Record<RoleType, string[]>> {
  const now = Date.now()
  if (matrixCache && matrixCache.expiresAt > now) {
    return matrixCache.matrix
  }

  try {
    const rows = await db.execute<{ value: string }>(
      sql`SELECT value FROM system_configs WHERE key = 'permission_matrix' LIMIT 1`,
    )
    const raw = (rows as unknown as Array<{ value: string }>)[0]?.value
    if (!raw) {
      matrixCache = { matrix: DEFAULT_PERMISSION_MATRIX, expiresAt: now + 30_000 }
      return DEFAULT_PERMISSION_MATRIX
    }
    const parsed = JSON.parse(raw) as Record<RoleType, string[]>
    matrixCache = { matrix: parsed, expiresAt: now + 30_000 }
    return parsed
  } catch {
    return DEFAULT_PERMISSION_MATRIX
  }
}

export async function computeActions(roles: Array<{ role: RoleType }>): Promise<string[]> {
  const matrix = await getPermissionMatrix()
  const actions = new Set<string>()

  for (const { role } of roles) {
    for (const action of matrix[role] ?? []) {
      actions.add(action)
    }
  }

  return Array.from(actions)
}

export async function expandScopeStoreIds(roles: AuthSession["roles"]): Promise<string[]> {
  const storeIds = new Set<string>()

  for (const role of roles) {
    if (role.scopeType === "总部") {
      const rows = await db.select({ storeId: stores.storeId }).from(stores)
      for (const row of rows) storeIds.add(row.storeId)
      return Array.from(storeIds)
    }

    if (role.scopeType === "市场") {
      const storeNodes = await db
        .select({ id: orgNodes.id })
        .from(orgNodes)
        .where(and(eq(orgNodes.parentId, role.scopeId), eq(orgNodes.type, "门店")))

      if (storeNodes.length > 0) {
        const rows = await db
          .select({ storeId: stores.storeId })
          .from(stores)
          .where(inArray(stores.orgNodeId, storeNodes.map((node) => node.id)))

        for (const row of rows) storeIds.add(row.storeId)
      }
    }

    if (role.scopeType === "门店") {
      const rows = await db
        .select({ storeId: stores.storeId })
        .from(stores)
        .where(eq(stores.orgNodeId, role.scopeId))

      for (const row of rows) storeIds.add(row.storeId)
    }
  }

  return Array.from(storeIds)
}

export function canAccessAdmin(roles: Array<{ role: string }>): boolean {
  return roles.some((role) => role.role !== "staff")
}

export function hasPermission(session: AuthSession, action: string): boolean {
  return session.permissions.actions.includes(action)
}

export function isAdminScope(session: AuthSession): boolean {
  return session.roles.some((role) => role.role === "admin")
}

