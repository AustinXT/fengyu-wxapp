'use server'

import { db } from '@/db'
import { operationLogs } from '@db/operation-log'
import { desc, eq, and } from 'drizzle-orm'
import type { OperationLog } from '@/lib/types'

export async function getLogs(): Promise<OperationLog[]> {
  const rows = await db
    .select()
    .from(operationLogs)
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

export async function getOrderLogs(saleOrderId: string): Promise<OperationLog[]> {
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
