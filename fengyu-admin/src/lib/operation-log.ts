import { db } from '@/db'
import { operationLogs } from '@db/operation-log'
import type { AuthSession } from './types'

/**
 * 写入操作日志
 *
 * orgNodeId/orgNodeName 从 session 的主要角色 scopeId 中获取
 */
export async function logOperation(
  session: AuthSession,
  action: string,
  targetType: string,
  targetId: string,
  detail?: Record<string, unknown>,
) {
  const primaryRole = session.roles[0]

  // 从角色 scope 中获取组织节点上下文
  let orgNodeId: string | null = null
  let orgNodeName: string | null = null
  if (primaryRole?.scopeId) {
    try {
      const { orgNodes } = await import('@db/org')
      const { eq } = await import('drizzle-orm')
      const [node] = await db
        .select({ id: orgNodes.id, name: orgNodes.name })
        .from(orgNodes)
        .where(eq(orgNodes.id, primaryRole.scopeId))
        .limit(1)
      if (node) {
        orgNodeId = node.id
        orgNodeName = node.name
      }
    } catch {
      // 查询失败不影响日志写入
    }
  }

  await db.insert(operationLogs).values({
    operatorEmployeeId: session.employeeId,
    operatorName: session.name,
    operatorRole: primaryRole?.role ?? null,
    orgNodeId,
    orgNodeName,
    action,
    targetType,
    targetId,
    detail: detail ?? null,
    source: 'adminApi',
  })
}
