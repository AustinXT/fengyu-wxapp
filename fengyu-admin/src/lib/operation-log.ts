import { db } from '@/db'
import { operationLogs } from '@db/operation-log'
import type { AuthSession } from './types'
import { sanitizeDetail } from './pii'


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


export async function logOperation(
  session: AuthSession,
  action: string,
  targetType: string,
  targetId: string,
  detail?: Record<string, unknown>,
) {
  const primaryRole = session.roles[0]

  
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
    detail: detail ? sanitizeDetail(detail) : null,
    source: 'adminApi',
  })
}


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
    _v: 3,
    _t: 'update',
    changes,
  })
}


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
    _v: 3,
    _t: 'transition',
    from,
    to,
    ...(context ? { context } : {}),
  })
}
