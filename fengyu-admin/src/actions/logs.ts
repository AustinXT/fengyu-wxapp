'use server'

import { db } from '@/db'
import { operationLogs } from '@db/operation-log'
import { stores, orgNodes } from '@db/org'
import { desc, eq, and, gte, lte, like, sql, inArray } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { beijingBoundaryTs } from '@/lib/db-time'
import type { OperationLog, AuthSession } from '@/lib/types'
import { withPermission, withAnyPermission } from '@/lib/with-permission'
import { requireAdmin, isAdminScope } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'
import { revalidatePath } from 'next/cache'

export interface LogFilter {
  operatorName?: string
  action?: string
  targetType?: string
  marketId?: string    // 市场 org_node_id
  storeId?: string     // 门店 store_id
  startDate?: string   // YYYY-MM-DD
  endDate?: string     // YYYY-MM-DD
  page?: number
  pageSize?: number
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

async function buildLogConditions(session: AuthSession, filter?: LogFilter): Promise<(SQL | undefined)[]> {
  const conditions: (SQL | undefined)[] = []

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
    // 日期串拼北京字面 timestamp（created_at 库存北京字面）；不经 new Date（date-only 串 UTC 午夜解析→+8h）。
    conditions.push(gte(operationLogs.createdAt, beijingBoundaryTs(filter.startDate, '00:00:00')))
  }
  if (filter?.endDate) {
    conditions.push(lte(operationLogs.createdAt, beijingBoundaryTs(filter.endDate, '23:59:59')))
  }

  // scope 过滤：通过 org_node_id 关联门店，非 admin 仅看权限范围内门店的日志
  if (!isAdminScope(session)) {
    const scopeStoreIds = session.permissions.scopeStoreIds

    if (scopeStoreIds.length === 0) {
      // 无门店权限，过滤掉所有日志
      conditions.push(sql`FALSE`)
    } else {
      // operation_logs.org_node_id 是门店的 org_node_id，通过 stores 表找到对应的 store_id
      const scopeOrgNodeIds = await db
        .select({ orgNodeId: stores.orgNodeId })
        .from(stores)
        .where(inArray(stores.storeId, scopeStoreIds))
      const orgNodeIdList = scopeOrgNodeIds.map((r: { orgNodeId: string | null }) => r.orgNodeId).filter((id: string | null): id is string => id !== null)

      if (orgNodeIdList.length === 0) {
        conditions.push(sql`FALSE`)
      } else if (orgNodeIdList.length === 1) {
        conditions.push(eq(operationLogs.orgNodeId, orgNodeIdList[0]))
      } else {
        conditions.push(inArray(operationLogs.orgNodeId, orgNodeIdList))
      }
    }
  }

  // 市场筛选（前端传入的筛选条件，所有角色包括 admin）
  if (filter?.marketId) {
    const storeOrgNodes = await db
      .select({ id: orgNodes.id })
      .from(orgNodes)
      .where(and(eq(orgNodes.type, '门店'), eq(orgNodes.parentId, filter.marketId)))
    const marketStoreOrgNodeIds = storeOrgNodes.map((r) => r.id)

    if (marketStoreOrgNodeIds.length === 0) {
      conditions.push(sql`FALSE`)
    } else {
      conditions.push(inArray(operationLogs.orgNodeId, marketStoreOrgNodeIds))
    }
  }

  // 门店筛选（前端传入的筛选条件，所有角色包括 admin）
  if (filter?.storeId) {
    const [storeOrgNode] = await db
      .select({ orgNodeId: stores.orgNodeId })
      .from(stores)
      .where(eq(stores.storeId, filter.storeId))
      .limit(1)

    if (!storeOrgNode || !storeOrgNode.orgNodeId) {
      conditions.push(sql`FALSE`)
    } else {
      conditions.push(eq(operationLogs.orgNodeId, storeOrgNode.orgNodeId))
    }
  }

  return conditions
}

export const getLogs = withPermission(
  'operation_log:list',
  async (session, filter?: LogFilter): Promise<OperationLog[]> => {
  const conditions = await buildLogConditions(session, filter)

  const rows = await db
    .select()
    .from(operationLogs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    // 例外：日志型表无 updatedAt 列
    .orderBy(desc(operationLogs.createdAt))

  return rows.map(serializeLog)
  },
)

export interface PaginatedLogs {
  data: OperationLog[]
  total: number
}

export const getLogsPaginated = withPermission(
  'operation_log:list',
  async (session, filter: LogFilter = {}): Promise<PaginatedLogs> => {
    const page = Math.max(1, filter.page || 1)
    const pageSize = [20, 50, 100].includes(filter.pageSize ?? 0) ? filter.pageSize! : 20
    const offset = (page - 1) * pageSize
    const conditions = await buildLogConditions(session, filter)
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined

    const [countRow] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(operationLogs)
      .where(whereClause)

    const rows = await db
      .select()
      .from(operationLogs)
      .where(whereClause)
      // 例外：日志型表无 updatedAt 列
      .orderBy(desc(operationLogs.createdAt))
      .limit(pageSize)
      .offset(offset)

    return {
      data: rows.map(serializeLog),
      total: countRow?.count ?? 0,
    }
  },
)

// 查看订单操作日志：订单查看者（sale_order:list）、退款提单人/审批人
// （sale_order:refund_create / sale_order:refund_approve）或操作日志查看者
// （operation_log:list）任一即可。
export const getOrderLogs = withAnyPermission(
  ['sale_order:list', 'sale_order:refund_create', 'sale_order:refund_approve', 'operation_log:list'],
  async (_session, saleOrderId: string): Promise<OperationLog[]> => {
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
  },
)

/**
 * 物理删除单条操作日志（仅系统管理员；数据治理用，清理无意义的噪音日志）。
 *
 * operation_logs 无任何 inbound FK，物理删除无级联风险。
 * 删除动作本身仍写一条新审计日志（who deleted which log）。
 */
export const deleteOperationLog = withPermission(
  'operation_log:delete',
  async (session, id: number): Promise<{ success: boolean; message: string }> => {
    requireAdmin(session)
    const [snapshot] = await db
      .select({ action: operationLogs.action, targetType: operationLogs.targetType, targetId: operationLogs.targetId, operatorName: operationLogs.operatorName, createdAt: operationLogs.createdAt })
      .from(operationLogs)
      .where(eq(operationLogs.id, id))
      .limit(1)

    if (!snapshot) {
      return { success: false, message: '日志不存在或已被删除' }
    }

    const result = await db.delete(operationLogs).where(eq(operationLogs.id, id))
    if ((result as any).count === 0) {
      return { success: false, message: '日志不存在或已被删除' }
    }

    await logOperation(session, 'operation_log.delete', 'operation_log', String(id), {
      snapshot: {
        action: snapshot.action,
        targetType: snapshot.targetType,
        targetId: snapshot.targetId,
        operatorName: snapshot.operatorName,
        createdAt: snapshot.createdAt?.toISOString(),
      },
    })

    revalidatePath('/logs')
    return { success: true, message: '日志已删除' }
  },
)
