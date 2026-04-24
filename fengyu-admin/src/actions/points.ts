'use server'

import { db } from '@/db'
import { pointTransactions } from '@db/points'
import { clientWechatUsers } from '@db/user'
import { stores, orgNodes } from '@db/org'
import { and, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { PointTransaction, PointTransactionSummary } from '@/lib/types'
import { getSession } from '@/lib/auth'
import { requirePermission, scopeCondition } from '@/lib/permissions'

/** 积分流水筛选参数 */
export interface PointTransactionFilters {
  marketId?: string
  storeId?: string
  type?: string
  search?: string
  startDate?: string  // YYYY-MM-DD
  endDate?: string    // YYYY-MM-DD
  page?: number
  pageSize?: number
}

/** 分页结果 */
export interface PaginatedPointTransactions {
  data: PointTransaction[]
  total: number
  summary: PointTransactionSummary
  distinctTypes: string[]
}

/**
 * 构建积分流水查询的 WHERE 条件
 *
 * scope 基于顾客的 bound_store_id（非 admin 角色只能看本 scope 内的顾客流水）。
 */
function buildConditions(
  session: Awaited<ReturnType<typeof getSession>>,
  filters: PointTransactionFilters,
): SQL[] {
  const conditions: SQL[] = []

  // scope 数据隔离（基于顾客归属门店）
  const scope = scopeCondition(session!, clientWechatUsers.boundStoreId)
  if (scope) conditions.push(scope)

  // 市场二级筛选：市场 → 该市场下所有门店
  if (filters.marketId) {
    const sub = db
      .select({ storeId: stores.storeId })
      .from(stores)
      .innerJoin(orgNodes, eq(stores.orgNodeId, orgNodes.id))
      .where(eq(orgNodes.parentId, filters.marketId))
    conditions.push(inArray(clientWechatUsers.boundStoreId, sub))
  }
  // 门店筛选
  if (filters.storeId) {
    conditions.push(eq(clientWechatUsers.boundStoreId, filters.storeId))
  }
  // 类型筛选（自由文本精确匹配）
  if (filters.type) {
    conditions.push(eq(pointTransactions.type, filters.type))
  }
  // 搜索：顾客姓名或手机号
  if (filters.search) {
    const pattern = `%${filters.search.replace(/[%_]/g, '\\$&')}%`
    const searchCond = or(
      ilike(clientWechatUsers.name, pattern),
      ilike(clientWechatUsers.phone, pattern),
    )
    if (searchCond) conditions.push(searchCond)
  }
  // 时间范围
  if (filters.startDate) {
    conditions.push(gte(pointTransactions.createdAt, new Date(filters.startDate)))
  }
  if (filters.endDate) {
    conditions.push(lte(pointTransactions.createdAt, new Date(filters.endDate + 'T23:59:59')))
  }

  return conditions
}

/**
 * 服务端分页积分流水列表 — DB 级过滤 + LIMIT/OFFSET + 汇总统计
 *
 * 一次 action 调用返回：data（当前页）、total（总记录数）、summary（全局汇总）、distinctTypes（筛选下拉动态值）。
 * 汇总与下拉动态值受相同筛选影响，用户每次筛选看到的是"当前筛选下的"统计值。
 */
export async function getPointTransactionsPaginated(
  filters: PointTransactionFilters = {},
): Promise<PaginatedPointTransactions> {
  const session = await getSession()
  requirePermission(session, 'point_transaction:list')

  const page = Math.max(1, filters.page || 1)
  const pageSize = [10, 20, 50, 100].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
  const offset = (page - 1) * pageSize

  const conditions = buildConditions(session, filters)
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined

  // 标量子查询：顾客所在市场名
  const marketName = sql<string | null>`(
    SELECT n.name FROM stores s
    JOIN org_nodes sn ON sn.id = s.org_node_id
    JOIN org_nodes n ON n.id = sn.parent_id
    WHERE s.store_id = ${clientWechatUsers.boundStoreId}
  )`

  // 门店名标量子查询
  const storeName = sql<string | null>`(
    SELECT s.store_name FROM stores s WHERE s.store_id = ${clientWechatUsers.boundStoreId}
  )`

  const [[countRow], rows, [summaryRow], typeRows] = await Promise.all([
    db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(pointTransactions)
      .innerJoin(clientWechatUsers, eq(pointTransactions.userId, clientWechatUsers.userId))
      .where(whereClause),
    db
      .select({
        id: pointTransactions.id,
        userId: pointTransactions.userId,
        type: pointTransactions.type,
        amount: pointTransactions.amount,
        refOrderId: pointTransactions.refOrderId,
        createdAt: pointTransactions.createdAt,
        customerName: clientWechatUsers.name,
        customerPhone: clientWechatUsers.phone,
        memberLevel: clientWechatUsers.memberLevel,
        storeId: clientWechatUsers.boundStoreId,
        storeName,
        marketName,
      })
      .from(pointTransactions)
      .innerJoin(clientWechatUsers, eq(pointTransactions.userId, clientWechatUsers.userId))
      .where(whereClause)
      // 例外：积分流水型表无 updatedAt 列
      .orderBy(desc(pointTransactions.createdAt))
      .limit(pageSize)
      .offset(offset),
    db
      .select({
        totalEarn: sql<number>`cast(coalesce(sum(case when ${pointTransactions.amount} > 0 then ${pointTransactions.amount} else 0 end), 0) as int)`,
        totalSpend: sql<number>`cast(coalesce(sum(case when ${pointTransactions.amount} < 0 then -${pointTransactions.amount} else 0 end), 0) as int)`,
        netChange: sql<number>`cast(coalesce(sum(${pointTransactions.amount}), 0) as int)`,
        txnCount: sql<number>`cast(count(*) as int)`,
        userCount: sql<number>`cast(count(distinct ${pointTransactions.userId}) as int)`,
      })
      .from(pointTransactions)
      .innerJoin(clientWechatUsers, eq(pointTransactions.userId, clientWechatUsers.userId))
      .where(whereClause),
    db
      .selectDistinct({ type: pointTransactions.type })
      .from(pointTransactions)
      .innerJoin(clientWechatUsers, eq(pointTransactions.userId, clientWechatUsers.userId))
      .where(whereClause),
  ])

  return {
    data: rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      type: r.type,
      amount: r.amount,
      refOrderId: r.refOrderId,
      createdAt: r.createdAt.toISOString(),
      customerName: r.customerName,
      customerPhone: r.customerPhone,
      memberLevel: r.memberLevel,
      storeId: r.storeId,
      storeName: r.storeName,
      marketName: r.marketName,
    })),
    total: countRow?.count ?? 0,
    summary: {
      totalEarn: summaryRow?.totalEarn ?? 0,
      totalSpend: summaryRow?.totalSpend ?? 0,
      netChange: summaryRow?.netChange ?? 0,
      txnCount: summaryRow?.txnCount ?? 0,
      userCount: summaryRow?.userCount ?? 0,
    },
    distinctTypes: typeRows.map((t) => t.type).filter((t): t is string => !!t).sort(),
  }
}
