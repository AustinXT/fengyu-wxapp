'use server'

import { db } from '@/db'
import { operationLogs } from '@db/operation-log'
import { desc, eq, and, gte, lte, like, sql } from 'drizzle-orm'
import type { OperationLog } from '@/lib/types'
import { getSession } from '@/lib/auth'
import { requirePermission, requireAnyPermission } from '@/lib/permissions'

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
    // 转义 SQL LIKE 特殊字符
    const escapedName = filter.operatorName.replace(/[%_]/g, '\\$&')
    conditions.push(like(operationLogs.operatorName, `%${escapedName}%`))
  }
  if (filter?.action) {
    // action 格式为 module.method，支持精确匹配和前缀匹配
    if (filter.action.includes('.')) {
      conditions.push(eq(operationLogs.action, filter.action))
    } else {
      const escapedAction = filter.action.replace(/[%_]/g, '\\$&')
      conditions.push(like(operationLogs.action, `${escapedAction}.%`))
    }
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
    // 例外：日志型表无 updatedAt 列
    .orderBy(desc(operationLogs.createdAt))
    .limit(500)

  return rows.map(serializeLog)
}

export async function getOrderLogs(saleOrderId: string): Promise<OperationLog[]> {
  const session = await getSession()
  // 查看订单操作日志：订单查看者（sale_order:list）、退款提单人/审批人
  // （sale_order:refund_create / sale_order:refund_approve）或操作日志查看者
  // （operation_log:list）任一即可。
  requireAnyPermission(session, [
    'sale_order:list',
    'sale_order:refund_create',
    'sale_order:refund_approve',
    'operation_log:list',
  ])

  const rows = await db
    .select()
    .from(operationLogs)
    .where(and(
      eq(operationLogs.targetType, 'sale_order'),
      eq(operationLogs.targetId, saleOrderId),
    ))
    // 例外：日志型表无 updatedAt 列
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
