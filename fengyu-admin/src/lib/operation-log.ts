import { db } from '@/db'
import { operationLogs } from '@db/operation-log'
import type { AuthSession } from './types'

/**
 * 写入操作日志
 */
export async function logOperation(
  session: AuthSession,
  action: string,
  targetType: string,
  targetId: string,
  detail?: Record<string, unknown>,
) {
  const primaryRole = session.roles[0]

  await db.insert(operationLogs).values({
    operatorEmployeeId: session.employeeId,
    operatorName: session.name,
    operatorRole: primaryRole?.role ?? null,
    orgNodeId: null,
    orgNodeName: null,
    action,
    targetType,
    targetId,
    detail: detail ?? null,
    source: 'adminApi',
  })
}
