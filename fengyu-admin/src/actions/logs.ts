'use server'

import { db } from '@/db'
import { operationLogs } from '@db/operation-log'
import { desc, eq, and, gte, lte, like, sql } from 'drizzle-orm'
import type { OperationLog } from '@/lib/types'
import { getSession } from '@/lib/auth'
import { requirePermission } from '@/lib/permissions'

export interface LogFilter {
  operatorName?: string
  action?: string
  targetType?: string
  startDate?: string  // YYYY-MM-DD
  endDate?: string    // YYYY-MM-DD
}

function serializeLog(r: typeof operationLogs.$inferSelect): OperationLog {
  return {
    id: r.id,
    operatorEmployeeId: r.operatorEmployeeId,
    operatorName: r.operatorName,
    operatorRole: r.operatorRole,
    orgNodeId: r.orgNodeId,
    orgNodeName: r.orgNodeName,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    detail: r.detail as Record<string, unknown> | null,
    source: r.source,
    createdAt: r.createdAt.toISOString(),
  }
}

export async function getLogs(filter?: LogFilter): Promise<OperationLog[]> {
  const session = await getSession()
  requirePermission(session, 'operation_log:list')

  const conditions = []

  if (filter?.operatorName) {
    conditions.push(like(operationLogs.operatorName, `%${filter.operatorName}%`))
  }
  if (filter?.action) {
    conditions.push(like(operationLogs.action, `%${filter.action}%`))
  }
  if (filter?.targetType) {
    conditions.push(eq(operationLogs.targetType, filter.targetType))
  }
  if (filter?.startDate) {
    conditions.push(gte(operationLogs.createdAt, new Date(filter.startDate)))
  }
  if (filter?.endDate) {
    conditions.push(lte(operationLogs.createdAt, new Date(filter.endDate + 'T23:59:59')))
  }

  const rows = await db
    .select()
    .from(operationLogs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(operationLogs.createdAt))
    .limit(500)

  return rows.map(serializeLog)
}

export async function getOrderLogs(saleOrderId: string): Promise<OperationLog[]> {
  const session = await getSession()
  requirePermission(session, 'operation_log:list')

  const rows = await db
    .select()
    .from(operationLogs)
    .where(and(
      eq(operationLogs.targetType, 'sale_order'),
      eq(operationLogs.targetId, saleOrderId),
    ))
    .orderBy(desc(operationLogs.createdAt))

  return rows.map((r) => ({
    id: r.id,
    operatorEmployeeId: r.operatorEmployeeId,
    operatorName: r.operatorName,
    operatorRole: r.operatorRole,
    orgNodeId: r.orgNodeId,
    orgNodeName: r.orgNodeName,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    detail: r.detail as Record<string, unknown> | null,
    source: r.source,
    createdAt: r.createdAt.toISOString(),
  }))
}
