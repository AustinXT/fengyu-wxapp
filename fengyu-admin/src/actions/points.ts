'use server'

import { db } from '@/db'
import { pointTransactions } from '@db/points'
import { clientWechatUsers } from '@db/user'
import { stores, orgNodes } from '@db/org'
import { and, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm'
import { beijingBoundaryTs } from '@/lib/db-time'
import type { SQL } from 'drizzle-orm'
import type { PointTransaction, PointTransactionSummary, AuthSession } from '@/lib/types'
import { scopeCondition } from '@/lib/permissions'
import { withPermission } from '@/lib/with-permission'
import { parsePointFilters } from '@/lib/list-filters'

/**
 * 已知的 point_transactions.type 取值（自由文本字段，非 DB 枚举；下拉由 distinctTypes 动态填充）
 * - '等级升级奖励' — cronTask 会员等级升级时发放
 * - '消费赠送' — 订单链净额增加时自动发放（ticket 2026-04-24）
 * - '消费冲销' — 退款导致订单链净额下降时自动冲销（ticket 2026-04-24）
 *
 * DB 层 chk_pt_amount_sign 守护：(amount<0 AND type='消费冲销') OR amount>0（migration 0028）
 * 若未来新增负值 type（如"过期扣减"/"管理员调整"）必须新增 migration 扩展 CHECK 表达式
 */

/**
 * point_transactions.amount + client_wechat_users.points_balance 升 bigint 后（migration 0028）
 * SUM 聚合的 cast 必须配套从 `as int` 改为 `as bigint`，否则总量突破 int4 ±21 亿时 PG 抛
 * `ERROR: integer out of range`，admin /points 页 500。当前业务体量远低于阈值，但仍按
 * schema-as-code 长期防御原则同步升级。
 *
 * pg 驱动 int8 默认返回字符串；Drizzle `sql<bigint>` 标注后调用方需 safeNumber 转，
 * 且超 2^53（Number.MAX_SAFE_INTEGER）会精度丢失，故 safeNumber 内补 console.warn。
 */
function safeNumber(v: bigint | number | string | null | undefined, label: string): number {
  if (v === null || v === undefined) return 0
  const n = typeof v === 'number' ? v : Number(v)
  if (n > Number.MAX_SAFE_INTEGER) {
    console.warn(`[points.stats] ${label} 超 2^53，精度可能丢失`, { raw: v })
  }
  return n
}

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
  session: AuthSession,
  filters: PointTransactionFilters,
): SQL[] {
  const conditions: SQL[] = []

  // scope 数据隔离（基于顾客归属门店）
  const scope = scopeCondition(session, clientWechatUsers.boundStoreId)
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
    // 日期串拼北京字面 timestamp（created_at 库存北京字面）；不经 new Date（date-only 串 UTC 午夜解析→+8h）。
    conditions.push(gte(pointTransactions.createdAt, beijingBoundaryTs(filters.startDate, '00:00:00')))
  }
  if (filters.endDate) {
    conditions.push(lte(pointTransactions.createdAt, beijingBoundaryTs(filters.endDate, '23:59:59')))
  }

  return conditions
}

/**
 * 服务端分页积分流水列表 — DB 级过滤 + LIMIT/OFFSET + 汇总统计
 *
 * 一次 action 调用返回：data（当前页）、total（总记录数）、summary（全局汇总）、distinctTypes（筛选下拉动态值）。
 * 汇总与下拉动态值受相同筛选影响，用户每次筛选看到的是"当前筛选下的"统计值。
 */
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

/** 积分流水导出行 */
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

/** 导出积分流水（全部筛选命中）。LIMIT 10000 防 OOM。 */
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
