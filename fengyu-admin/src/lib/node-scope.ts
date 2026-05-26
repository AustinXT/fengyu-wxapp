import { db } from '@/db'
import { orgNodes } from '@db/org'
import { eq } from 'drizzle-orm'
import type { AuthSession } from '@/lib/types'
import { isAdminScope } from '@/lib/permissions'

/**
 * 校验某 org_node 是否在用户 scope 内（admin 始终通过）。
 *
 * 从目标节点沿 parentId 向上遍历（最多 5 层），任一祖先命中 session.roles[].scopeId
 * 即视为在 scope 内：门店级用户命中门店节点本身，市场级用户命中其父市场节点，总部全通。
 *
 * 放在独立模块（而非 permissions.ts）以保持「调用方 mock isAdminScope 即可驱动本函数」的
 * 测试关系——若内联进 permissions.ts，模块内对 isAdminScope 的调用将无法被 mock 替换。
 */
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
