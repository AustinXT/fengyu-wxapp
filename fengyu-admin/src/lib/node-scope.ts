import { db } from '@/db'
import { orgNodes } from '@db/org'
import { eq } from 'drizzle-orm'
import type { AuthSession } from '@/lib/types'
import { isAdminScope } from '@/lib/permissions'


export async function isNodeInScope(session: AuthSession, nodeId: string): Promise<boolean> {
  if (isAdminScope(session)) return true
  const scopeIds = new Set(session.roles.map((r) => r.scopeId))
  if (scopeIds.size === 0) return false

  let currentId: string | null = nodeId
  for (let depth = 0; depth < 5 && currentId; depth++) {
    if (scopeIds.has(currentId)) return true
    const [node] = await db
      .select({ parentId: orgNodes.parentId })
      .from(orgNodes)
      .where(eq(orgNodes.id, currentId))
      .limit(1)
    currentId = node?.parentId ?? null
  }
  return false
}
