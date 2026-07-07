'use server'

import { db } from '@/db'
import { pointTransactions } from '@db/points'
import { clientWechatUsers } from '@db/user'
import { stores, orgNodes } from '@db/org'
import { and, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { PointTransaction, PointTransactionSummary, AuthSession } from '@/lib/types'
import { scopeCondition } from '@/lib/permissions'
import { withPermission } from '@/lib/with-permission'
import { parsePointFilters } from '@/lib/list-filters'




function safeNumber(v: bigint | number | string | null | undefined, label: string): number {
  if (v === null || v === undefined) return 0
  const n = typeof v === 'number' ? v : Number(v)
  if (n > Number.MAX_SAFE_INTEGER) {
    console.warn(`[points.stats] ${label} 超 2^53，精度可能丢失`, { raw: v })
  }
  return n
}


export interface PointTransactionFilters {
  marketId?: string
  storeId?: string
  type?: string
  search?: string
  startDate?: string  
  endDate?: string    
  page?: number
  pageSize?: number
}


export interface PaginatedPointTransactions {
  data: PointTransaction[]
  total: number
  summary: PointTransactionSummary
  distinctTypes: string[]
}


function buildConditions(
  session: AuthSession,
  filters: PointTransactionFilters,
): SQL[] {
  const conditions: SQL[] = []

  
  const scope = scopeCondition(session, clientWechatUsers.boundStoreId)
  if (scope) conditions.push(scope)

  
  if (filters.marketId) {
    const sub = db
      .select({ storeId: stores.storeId })
      .from(stores)
      .innerJoin(orgNodes, eq(stores.orgNodeId, orgNodes.id))
      .where(eq(orgNodes.parentId, filters.marketId))
    conditions.push(inArray(clientWechatUsers.boundStoreId, sub))
  }
  
  if (filters.storeId) {
    conditions.push(eq(clientWechatUsers.boundStoreId, filters.storeId))
  }
  
  if (filters.type) {
    conditions.push(eq(pointTransactions.type, filters.type))
  }
  
  if (filters.search) {
    const pattern = `%${filters.search.replace(/[%_]/g, '\\$&')}%`
    const searchCond = or(
      ilike(clientWechatUsers.name, pattern),
      ilike(clientWechatUsers.phone, pattern),
    )
    if (searchCond) conditions.push(searchCond)
  }
  
  if (filters.startDate) {
    
    conditions.push(gte(pointTransactions.createdAt, sql`${`${filters.startDate} 00:00:00`}::timestamp`))
  }
  if (filters.endDate) {
    conditions.push(lte(pointTransactions.createdAt, sql`${`${filters.endDate} 23:59:59`}::timestamp`))
  }

  return conditions
}


export const getPointTransactionsPaginated = withPermission(
  'point_transaction:list',
  async (
    session,
    filters: PointTransactionFilters = {},
  ): Promise<PaginatedPointTransactions> => {
  const page = Math.max(1, filters.page || 1)
  const pageSize = [10, 20, 50, 100].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
  const offset = (page - 1) * pageSize

  const conditions = buildConditions(session, filters)
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined

  
  const marketName = sql<string | null>`(
    SELECT n.name FROM stores s
    JOIN org_nodes sn ON sn.id = s.org_node_id
    JOIN org_nodes n ON n.id = sn.parent_id
    WHERE s.store_id = ${clientWechatUsers.boundStoreId}
  )`

  
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
      
      .orderBy(desc(pointTransactions.createdAt))
      .limit(pageSize)
      .offset(offset),
    db
      .select({
        totalEarn: sql<bigint>`cast(coalesce(sum(case when ${pointTransactions.amount} > 0 then ${pointTransactions.amount} else 0 end), 0) as bigint)`,
        totalSpend: sql<bigint>`cast(coalesce(sum(case when ${pointTransactions.amount} < 0 then -${pointTransactions.amount} else 0 end), 0) as bigint)`,
        netChange: sql<bigint>`cast(coalesce(sum(${pointTransactions.amount}), 0) as bigint)`,
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
      totalEarn: safeNumber(summaryRow?.totalEarn, 'totalEarn'),
      totalSpend: safeNumber(summaryRow?.totalSpend, 'totalSpend'),
      netChange: safeNumber(summaryRow?.netChange, 'netChange'),
      txnCount: summaryRow?.txnCount ?? 0,
      userCount: summaryRow?.userCount ?? 0,
    },
    distinctTypes: typeRows.map((t) => t.type).filter((t): t is string => !!t).sort(),
  }
  },
)


export interface ExportPointRow {
  createdAt: string
  customerName: string | null
  customerPhone: string | null
  memberLevel: string | null
  storeName: string | null
  type: string | null
  amount: number
  refOrderId: string | null
}


export const exportPointTransactions = withPermission(
  'point_transaction:list',
  async (
    session,
    params: Record<string, string | undefined>,
  ): Promise<{ rows: ExportPointRow[]; truncated: boolean }> => {
    const LIMIT = 10000
    const filters = parsePointFilters(params)
    const conditions = buildConditions(session, filters)
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined

    const storeName = sql<string | null>`(
      SELECT s.store_name FROM stores s WHERE s.store_id = ${clientWechatUsers.boundStoreId}
    )`

    const dataRows = await db
      .select({
        type: pointTransactions.type,
        amount: pointTransactions.amount,
        refOrderId: pointTransactions.refOrderId,
        createdAt: pointTransactions.createdAt,
        customerName: clientWechatUsers.name,
        customerPhone: clientWechatUsers.phone,
        memberLevel: clientWechatUsers.memberLevel,
        storeName,
      })
      .from(pointTransactions)
      .innerJoin(clientWechatUsers, eq(pointTransactions.userId, clientWechatUsers.userId))
      .where(whereClause)
      .orderBy(desc(pointTransactions.createdAt))
      .limit(LIMIT + 1)

    const truncated = dataRows.length > LIMIT
    const page = truncated ? dataRows.slice(0, LIMIT) : dataRows

    const rows: ExportPointRow[] = page.map((r) => ({
      createdAt: r.createdAt.toISOString(),
      customerName: r.customerName,
      customerPhone: r.customerPhone,
      memberLevel: r.memberLevel,
      storeName: r.storeName,
      type: r.type,
      amount: r.amount,
      refOrderId: r.refOrderId,
    }))

    return { rows, truncated }
  },
)
