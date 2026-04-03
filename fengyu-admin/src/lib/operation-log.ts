import { db } from '@/db'
import { operationLogs } from '@db/operation-log'
import type { AuthSession } from './types'

/**
 * 对比 before/after，返回实际变更的字段 diff。
 * 只遍历 after 中的 key（Partial 更新只有变更字段）。
 * 返回 null 表示无实际变更。
 */
export function computeChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> | null {
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  for (const key of Object.keys(after)) {
    if (after[key] === undefined) continue
    const fromVal = before[key]
    const toVal = after[key]
    if (JSON.stringify(fromVal) !== JSON.stringify(toVal)) {
      changes[key] = { from: fromVal ?? null, to: toVal }
    }
  }
  return Object.keys(changes).length > 0 ? changes : null
}

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

/**
 * 写入更新操作日志（结构化 diff）
 *
 * detail 格式：{ _v: 2, _t: 'update', changes: { field: { from, to } } }
 */
export async function logUpdate(
  session: AuthSession,
  action: string,
  targetType: string,
  targetId: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  const changes = computeChanges(before, after)
  if (!changes) return
  await logOperation(session, action, targetType, targetId, {
    _v: 2,
    _t: 'update',
    changes,
  })
}

/**
 * 写入状态变更日志（状态流转 + 上下文）
 *
 * detail 格式：{ _v: 2, _t: 'transition', from, to, context? }
 */
export async function logTransition(
  session: AuthSession,
  action: string,
  targetType: string,
  targetId: string,
  from: string,
  to: string,
  context?: Record<string, unknown>,
) {
  await logOperation(session, action, targetType, targetId, {
    _v: 2,
    _t: 'transition',
    from,
    to,
    ...(context ? { context } : {}),
  })
}
