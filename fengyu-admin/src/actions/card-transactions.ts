'use server'

import { db } from '@/db'
import { cardTransactions, prepaidCards } from '@db/prepaid-card'
import { clientWechatUsers } from '@db/user'
import { stores, orgNodes } from '@db/org'
import { and, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm'
import { beijingBoundaryTs } from '@/lib/db-time'
import type { SQL } from 'drizzle-orm'
import type { AdminCardTransaction, CardTransactionSummary } from '@/lib/types'
import type { AuthSession } from '@/lib/types'
import { scopeCondition } from '@/lib/permissions'
import { withPermission } from '@/lib/with-permission'


export interface CardTransactionFilters {
  marketId?: string
  storeId?: string
  type?: '充值' | '扣款' | string
  search?: string
  startDate?: string  
  endDate?: string    
  page?: number
  pageSize?: number
}


export interface PaginatedCardTransactions {
  data: AdminCardTransaction[]
  total: number
  summary: CardTransactionSummary
}


function buildConditions(
  session: AuthSession,
  filters: CardTransactionFilters,
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
  
  if (filters.type === '充值' || filters.type === '扣款') {
    conditions.push(eq(cardTransactions.type, filters.type))
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
    
    conditions.push(gte(cardTransactions.createdAt, beijingBoundaryTs(filters.startDate, '00:00:00')))
  }
  if (filters.endDate) {
    conditions.push(lte(cardTransactions.createdAt, beijingBoundaryTs(filters.endDate, '23:59:59')))
  }

  return conditions
}


export const getCardTransactionsPaginated = withPermission(
  'card_transaction:list',
  async (
    session,
    filters: CardTransactionFilters = {},
  ): Promise<PaginatedCardTransactions> => {
  const page = Math.max(1, filters.page || 1)
  const pageSize = [10, 20, 50, 100].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
  const offset = (page - 1) * pageSize

  const conditions = buildConditions(session, filters)
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined

  
  const marketName = sql<string | null>`(
    SELECT n.name FROM org_nodes n
    JOIN org_nodes sn ON sn.parent_id = n.id
    JOIN stores s ON s.org_node_id = sn.id
    WHERE s.store_id = ${clientWechatUsers.boundStoreId}
  )`

  
  const storeName = sql<string | null>`(
    SELECT s.store_name FROM stores s WHERE s.store_id = ${clientWechatUsers.boundStoreId}
  )`

  const [[countRow], rows, [summaryRow]] = await Promise.all([
    db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(cardTransactions)
      .innerJoin(prepaidCards, eq(cardTransactions.cardId, prepaidCards.cardId))
      .innerJoin(clientWechatUsers, eq(prepaidCards.userId, clientWechatUsers.userId))
      .where(whereClause),
    db
      .select({
        id: cardTransactions.id,
        cardId: cardTransactions.cardId,
        userId: prepaidCards.userId,
        type: cardTransactions.type,
        amount: cardTransactions.amount,
        balance: prepaidCards.balance,
        refOrderId: cardTransactions.refOrderId,
        createdAt: cardTransactions.createdAt,
        customerName: clientWechatUsers.name,
        customerPhone: clientWechatUsers.phone,
        memberLevel: clientWechatUsers.memberLevel,
        storeId: clientWechatUsers.boundStoreId,
        storeName,
        marketName,
      })
      .from(cardTransactions)
      .innerJoin(prepaidCards, eq(cardTransactions.cardId, prepaidCards.cardId))
      .innerJoin(clientWechatUsers, eq(prepaidCards.userId, clientWechatUsers.userId))
      .where(whereClause)
      
      .orderBy(desc(cardTransactions.createdAt))
      .limit(pageSize)
      .offset(offset),
    db
      .select({
        totalRecharge: sql<string>`coalesce(sum(case when ${cardTransactions.amount} > 0 then ${cardTransactions.amount} else 0 end), 0)`,
        totalDeduct: sql<string>`coalesce(sum(case when ${cardTransactions.amount} < 0 then -${cardTransactions.amount} else 0 end), 0)`,
        netChange: sql<string>`coalesce(sum(${cardTransactions.amount}), 0)`,
        txnCount: sql<number>`cast(count(*) as int)`,
        userCount: sql<number>`cast(count(distinct ${prepaidCards.userId}) as int)`,
      })
      .from(cardTransactions)
      .innerJoin(prepaidCards, eq(cardTransactions.cardId, prepaidCards.cardId))
      .innerJoin(clientWechatUsers, eq(prepaidCards.userId, clientWechatUsers.userId))
      .where(whereClause),
  ])

  return {
    data: rows.map((r) => ({
      id: r.id,
      cardId: r.cardId,
      userId: r.userId,
      type: r.type as '充值' | '扣款',
      amount: Number(r.amount),
      balance: Number(r.balance),
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
      totalRecharge: Number(summaryRow?.totalRecharge ?? 0),
      totalDeduct: Number(summaryRow?.totalDeduct ?? 0),
      netChange: Number(summaryRow?.netChange ?? 0),
      txnCount: summaryRow?.txnCount ?? 0,
      userCount: summaryRow?.userCount ?? 0,
    },
  }
  },
)
