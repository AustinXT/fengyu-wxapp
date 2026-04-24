'use server'

import { db } from '@/db'
import { cardTransactions, prepaidCards } from '@db/prepaid-card'
import { clientWechatUsers } from '@db/user'
import { stores, orgNodes } from '@db/org'
import { and, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { AdminCardTransaction, CardTransactionSummary } from '@/lib/types'
import { getSession } from '@/lib/auth'
import { requirePermission, scopeCondition } from '@/lib/permissions'

/** 充值卡流水筛选参数 */
export interface CardTransactionFilters {
  marketId?: string
  storeId?: string
  type?: '充值' | '扣款' | string
  search?: string
  startDate?: string  // YYYY-MM-DD
  endDate?: string    // YYYY-MM-DD
  page?: number
  pageSize?: number
}

/** 分页结果 */
export interface PaginatedCardTransactions {
  data: AdminCardTransaction[]
  total: number
  summary: CardTransactionSummary
}

/**
 * 构建充值卡流水查询的 WHERE 条件
 *
 * scope 基于顾客当前绑定门店（`client_wechat_users.bound_store_id`）。
 * 储值卡自 2026-04-24 起**跨店共享**（prepaid_cards.store_id 列已 DROP），
 * 卡账户本身不再挂门店；展示/筛选维度退回到"顾客当前绑定门店"这一近似口径，
 * 与 points 模块保持一致。
 */
function buildConditions(
  session: Awaited<ReturnType<typeof getSession>>,
  filters: CardTransactionFilters,
): SQL[] {
  const conditions: SQL[] = []

  // scope 数据隔离（基于顾客当前绑定门店，近似"卡账户归属门店"）
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
  // 类型筛选（静态枚举 `充值` / `扣款`，精确匹配）
  if (filters.type === '充值' || filters.type === '扣款') {
    conditions.push(eq(cardTransactions.type, filters.type))
  }
  // 搜索：顾客姓名或手机号（转义 `%` 和 `_`）
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
    conditions.push(gte(cardTransactions.createdAt, new Date(filters.startDate)))
  }
  if (filters.endDate) {
    conditions.push(lte(cardTransactions.createdAt, new Date(filters.endDate + 'T23:59:59')))
  }

  return conditions
}

/**
 * 服务端分页充值卡流水列表 — DB 级过滤 + LIMIT/OFFSET + 汇总统计
 *
 * 一次 action 调用返回：data（当前页）、total（总记录数）、summary（全局汇总）。
 * 汇总按金额符号判断（amount > 0 = 充值 / amount < 0 = 扣款），避免脏数据下 type 与符号不一致。
 * 类型枚举为静态 2 值（`充值`/`扣款`），下拉在前端硬编码，不做 selectDistinct。
 */
export async function getCardTransactionsPaginated(
  filters: CardTransactionFilters = {},
): Promise<PaginatedCardTransactions> {
  const session = await getSession()
  requirePermission(session, 'card_transaction:list')

  const page = Math.max(1, filters.page || 1)
  const pageSize = [10, 20, 50, 100].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
  const offset = (page - 1) * pageSize

  const conditions = buildConditions(session, filters)
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined

  // 标量子查询：顾客当前绑定门店对应的市场名
  const marketName = sql<string | null>`(
    SELECT n.name FROM org_nodes n
    JOIN org_nodes sn ON sn.parent_id = n.id
    JOIN stores s ON s.org_node_id = sn.id
    WHERE s.store_id = ${clientWechatUsers.boundStoreId}
  )`

  // 顾客当前绑定门店名（近似"卡账户当前所属门店"）
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
      // 例外：流水型表无 updatedAt 列
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
}
