'use server'



import { db } from '@/db'
import { sql, type SQL } from 'drizzle-orm'
import { withPermission } from '@/lib/with-permission'
import { prepareBoardContext } from '@/lib/data-center/context'
import { scopeFilterSql, scopeStoreSkeletonSql } from '@/lib/data-center/scope-sql'
import { withComparison } from '@/lib/data-center/comparison'
import { getMemberThreshold } from '@/lib/member-threshold'
import type { AuthSession } from '@/lib/types'
import type {
  BreakdownRow,
  DataCenterScope,
  KpiCell,
  ProductBoardParams,
  ProductBoardResult,
  ResolvedRange,
} from '@/lib/data-center/types'


const num = (v: unknown): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}
const round2 = (v: unknown): number => Math.round(num(v) * 100) / 100

const first = (rows: unknown): Record<string, unknown> =>
  ((rows as unknown[])[0] as Record<string, unknown>) ?? {}

const safeDiv = (a: number, b: number): number | null => (b > 0 ? a / b : null)


function resolveGrouping(params: ProductBoardParams): { groupCol: SQL; filter: SQL } {
  const kind = params.productKind?.trim() || ''
  const category = params.categoryName?.trim() || ''
  if (category) {
    return {
      groupCol: sql.raw('pc.category_name'),
      filter: sql`pc.product_kind = ${kind} AND pc.category_name = ${category}`,
    }
  }
  if (kind) {
    return {
      groupCol: sql.raw('pc.product_kind'),
      filter: sql`pc.product_kind = ${kind}`,
    }
  }
  return {
    groupCol: sql.raw('pc.product_kind'),
    filter: sql`pc.product_kind IS NOT NULL`,
  }
}




async function queryFilterOptions(): Promise<Array<{ kind: string; categories: string[] }>> {
  const rows = await db.execute(sql`
    SELECT DISTINCT pc.product_kind AS kind, pc.category_name AS category
    FROM product_categories pc
    WHERE pc.product_kind IS NOT NULL
    ORDER BY pc.product_kind, pc.category_name
  `)
  const map = new Map<string, string[]>()
  for (const raw of rows as unknown[]) {
    const r = raw as Record<string, unknown>
    const kind = String(r.kind ?? '')
    const category = String(r.category ?? '')
    if (!kind) continue
    if (!map.has(kind)) map.set(kind, [])
    if (category && !map.get(kind)!.includes(category)) map.get(kind)!.push(category)
  }
  return Array.from(map.entries()).map(([kind, categories]) => ({ kind, categories }))
}






async function queryCardHolders(
  session: AuthSession,
  scope: DataCenterScope,
  filter: SQL,
): Promise<number> {
  const sc = scopeFilterSql(session, scope, 'so.store_id')
  const rows = await db.execute(sql`
    SELECT COUNT(DISTINCT so.client_user_id) AS v
    FROM sale_items si
    JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
    JOIN product_skus sk ON sk.sku_id = si.sku_id
    JOIN product_categories pc ON pc.category_id = sk.category_id
    WHERE ${sc}
      AND si.product_type = '疗程卡'
      AND si.remaining_sessions > 0
      AND so.sale_order_type IN ('销售单', '转换单', '寄存单')
      AND so.status = '已支付'
      AND so.client_user_id IS NOT NULL
      AND ${filter}
  `)
  return num(first(rows).v)
}


async function queryMemberCount(session: AuthSession, scope: DataCenterScope): Promise<number> {
  const sc = scopeFilterSql(session, scope, 'c.bound_store_id')
  const rows = await db.execute(sql`
    SELECT COUNT(*) AS v
    FROM client_wechat_users c
    WHERE ${sc}
      AND c.became_member_at IS NOT NULL
  `)
  return num(first(rows).v)
}







type CycleGroup = 'trial' | 'new' | 'repurchase'


async function queryCycle(
  session: AuthSession,
  scope: DataCenterScope,
  range: ResolvedRange,
  threshold: number,
  groupCol: SQL,
  filter: SQL,
  group: CycleGroup,
  metric: 'count' | 'revenue',
): Promise<number> {
  const sc = scopeFilterSql(session, scope, 'so.store_id')
  const rows = await db.execute(sql`
    WITH daily_agg AS (
      SELECT so.client_user_id,
             so.store_id,
             ${groupCol} AS grp,
             so.paid_at::date AS purchase_date,
             SUM(si.received::numeric) AS day_received
      FROM sale_items si
      JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
      JOIN product_skus sk ON sk.sku_id = si.sku_id
      JOIN product_categories pc ON pc.category_id = sk.category_id
      WHERE ${sc}
        AND so.sale_order_type IN ('销售单', '转换单')
        AND so.status = '已支付'
        AND so.client_user_id IS NOT NULL
        AND ${filter}
        AND so.paid_at::date <= ${range.end}
      GROUP BY so.client_user_id, so.store_id, ${groupCol}, so.paid_at::date
    ),
    qualifying_days AS (
      SELECT client_user_id, store_id, grp, purchase_date
      FROM daily_agg
      WHERE day_received >= ${threshold}
    ),
    first_entry AS (
      SELECT client_user_id, grp, MIN(purchase_date) AS entry_date
      FROM qualifying_days
      GROUP BY client_user_id, grp
    ),
    period_agg AS (
      SELECT client_user_id, store_id, grp, purchase_date, day_received
      FROM daily_agg
      WHERE purchase_date BETWEEN ${range.start} AND ${range.end}
    ),
    xinzeng AS (
      SELECT client_user_id, grp
      FROM first_entry
      WHERE entry_date BETWEEN ${range.start} AND ${range.end}
    ),
    fugou AS (
      SELECT DISTINCT q.client_user_id, q.grp
      FROM qualifying_days q
      JOIN first_entry f ON f.client_user_id = q.client_user_id AND f.grp = q.grp
      WHERE q.purchase_date BETWEEN ${range.start} AND ${range.end}
    ),
    tiyan AS (
      SELECT DISTINCT pa.client_user_id, pa.grp
      FROM period_agg pa
      WHERE NOT EXISTS (
        SELECT 1 FROM first_entry f
        WHERE f.client_user_id = pa.client_user_id AND f.grp = pa.grp
      )
    ),
    cohort AS (
      ${
        group === 'trial'
          ? sql`SELECT client_user_id, grp FROM tiyan`
          : group === 'new'
            ? sql`SELECT client_user_id, grp FROM xinzeng`
            : sql`SELECT client_user_id, grp FROM fugou`
      }
    )
    SELECT
      COUNT(DISTINCT c.client_user_id) AS count,
      COALESCE(SUM(pa.day_received), 0) AS revenue
    FROM cohort c
    LEFT JOIN period_agg pa
      ON pa.client_user_id = c.client_user_id AND pa.grp = c.grp
  `)
  const r = first(rows)
  return metric === 'count' ? num(r.count) : round2(r.revenue)
}





interface ProductStoreAgg {
  cardHolders: number
  trialCount: number
  newCount: number
  newRevenue: number
  repurchaseCount: number
  repurchaseRevenue: number
}


async function queryCardHoldersByStore(
  session: AuthSession,
  scope: DataCenterScope,
  filter: SQL,
): Promise<Map<string, number>> {
  const sc = scopeFilterSql(session, scope, 'so.store_id')
  const rows = await db.execute(sql`
    SELECT so.store_id, COUNT(DISTINCT so.client_user_id) AS v
    FROM sale_items si
    JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
    JOIN product_skus sk ON sk.sku_id = si.sku_id
    JOIN product_categories pc ON pc.category_id = sk.category_id
    WHERE ${sc}
      AND si.product_type = '疗程卡'
      AND si.remaining_sessions > 0
      AND so.sale_order_type IN ('销售单', '转换单', '寄存单')
      AND so.status = '已支付'
      AND so.client_user_id IS NOT NULL
      AND ${filter}
    GROUP BY so.store_id
  `)
  const m = new Map<string, number>()
  for (const raw of rows as unknown[]) {
    const r = raw as Record<string, unknown>
    const id = String(r.store_id ?? '')
    if (id) m.set(id, num(r.v))
  }
  return m
}


async function queryMemberCountByStore(
  session: AuthSession,
  scope: DataCenterScope,
): Promise<Map<string, number>> {
  const sc = scopeFilterSql(session, scope, 'c.bound_store_id')
  const rows = await db.execute(sql`
    SELECT c.bound_store_id AS store_id, COUNT(*) AS v
    FROM client_wechat_users c
    WHERE ${sc}
      AND c.bound_store_id IS NOT NULL
      AND c.became_member_at IS NOT NULL
    GROUP BY c.bound_store_id
  `)
  const m = new Map<string, number>()
  for (const raw of rows as unknown[]) {
    const r = raw as Record<string, unknown>
    const id = String(r.store_id ?? '')
    if (id) m.set(id, num(r.v))
  }
  return m
}


async function queryCycleByStore(
  session: AuthSession,
  scope: DataCenterScope,
  range: ResolvedRange,
  threshold: number,
  groupCol: SQL,
  filter: SQL,
): Promise<
  Map<
    string,
    {
      trialCount: number
      newCount: number
      newRevenue: number
      repurchaseCount: number
      repurchaseRevenue: number
    }
  >
> {
  const sc = scopeFilterSql(session, scope, 'so.store_id')
  const rows = await db.execute(sql`
    WITH daily_agg AS (
      SELECT so.client_user_id,
             so.store_id,
             ${groupCol} AS grp,
             so.paid_at::date AS purchase_date,
             SUM(si.received::numeric) AS day_received
      FROM sale_items si
      JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
      JOIN product_skus sk ON sk.sku_id = si.sku_id
      JOIN product_categories pc ON pc.category_id = sk.category_id
      WHERE ${sc}
        AND so.sale_order_type IN ('销售单', '转换单')
        AND so.status = '已支付'
        AND so.client_user_id IS NOT NULL
        AND ${filter}
        AND so.paid_at::date <= ${range.end}
      GROUP BY so.client_user_id, so.store_id, ${groupCol}, so.paid_at::date
    ),
    qualifying_days AS (
      SELECT client_user_id, store_id, grp, purchase_date
      FROM daily_agg
      WHERE day_received >= ${threshold}
    ),
    first_entry AS (
      SELECT client_user_id, grp, MIN(purchase_date) AS entry_date
      FROM qualifying_days
      GROUP BY client_user_id, grp
    ),
    period_agg AS (
      SELECT client_user_id, store_id, grp, purchase_date, day_received
      FROM daily_agg
      WHERE purchase_date BETWEEN ${range.start} AND ${range.end}
    ),
    xinzeng AS (
      SELECT client_user_id, grp
      FROM first_entry
      WHERE entry_date BETWEEN ${range.start} AND ${range.end}
    ),
    fugou AS (
      SELECT DISTINCT q.client_user_id, q.grp
      FROM qualifying_days q
      JOIN first_entry f ON f.client_user_id = q.client_user_id AND f.grp = q.grp
      WHERE q.purchase_date BETWEEN ${range.start} AND ${range.end}
    ),
    tiyan AS (
      SELECT DISTINCT pa.client_user_id, pa.grp
      FROM period_agg pa
      WHERE NOT EXISTS (
        SELECT 1 FROM first_entry f
        WHERE f.client_user_id = pa.client_user_id AND f.grp = pa.grp
      )
    ),
    -- 期内每个门店每个客群的人数（DISTINCT client per store）+ 业绩（该门店该客群消费）
    trial_store AS (
      SELECT pa.store_id,
             COUNT(DISTINCT pa.client_user_id) AS cnt
      FROM period_agg pa
      JOIN tiyan t ON t.client_user_id = pa.client_user_id AND t.grp = pa.grp
      GROUP BY pa.store_id
    ),
    new_store AS (
      SELECT pa.store_id,
             COUNT(DISTINCT pa.client_user_id) AS cnt,
             COALESCE(SUM(pa.day_received), 0) AS revenue
      FROM period_agg pa
      JOIN xinzeng x ON x.client_user_id = pa.client_user_id AND x.grp = pa.grp
      GROUP BY pa.store_id
    ),
    repurchase_store AS (
      SELECT pa.store_id,
             COUNT(DISTINCT pa.client_user_id) AS cnt,
             COALESCE(SUM(pa.day_received), 0) AS revenue
      FROM period_agg pa
      JOIN fugou fg ON fg.client_user_id = pa.client_user_id AND fg.grp = pa.grp
      GROUP BY pa.store_id
    ),
    -- 期内有消费的所有门店（并集），LEFT JOIN 各客群聚合避免 FULL OUTER 链路漏行
    store_ids AS (
      SELECT DISTINCT store_id FROM period_agg
    )
    SELECT
      s.store_id AS store_id,
      COALESCE(t.cnt, 0) AS trial_count,
      COALESCE(n.cnt, 0) AS new_count,
      COALESCE(n.revenue, 0) AS new_revenue,
      COALESCE(r.cnt, 0) AS repurchase_count,
      COALESCE(r.revenue, 0) AS repurchase_revenue
    FROM store_ids s
    LEFT JOIN trial_store t ON t.store_id = s.store_id
    LEFT JOIN new_store n ON n.store_id = s.store_id
    LEFT JOIN repurchase_store r ON r.store_id = s.store_id
  `)
  const m = new Map<
    string,
    {
      trialCount: number
      newCount: number
      newRevenue: number
      repurchaseCount: number
      repurchaseRevenue: number
    }
  >()
  for (const raw of rows as unknown[]) {
    const r = raw as Record<string, unknown>
    const id = String(r.store_id ?? '')
    if (!id) continue
    m.set(id, {
      trialCount: num(r.trial_count),
      newCount: num(r.new_count),
      newRevenue: round2(r.new_revenue),
      repurchaseCount: num(r.repurchase_count),
      repurchaseRevenue: round2(r.repurchase_revenue),
    })
  }
  return m
}


function buildMetrics(agg: ProductStoreAgg, memberCount: number): Record<string, number | null> {
  return {
    cardHolders: agg.cardHolders,
    cardHolderRate: safeDiv(agg.cardHolders, memberCount),
    trialCount: agg.trialCount,
    newCount: agg.newCount,
    newRevenue: agg.newRevenue,
    newAvgTicket: safeDiv(round2(agg.newRevenue), agg.newCount),
    repurchaseCount: agg.repurchaseCount,
    repurchaseRevenue: agg.repurchaseRevenue,
    repurchaseRate: safeDiv(agg.repurchaseCount, agg.cardHolders),
  }
}





export const getProductBoard = withPermission(
  'data_center:dashboard',
  async (session: AuthSession, params: ProductBoardParams): Promise<ProductBoardResult> => {
    const ctx = await prepareBoardContext(session, params)
    const { scope, comparison, enabled } = ctx
    const cur = comparison.current

    const { groupCol, filter } = resolveGrouping(params)
    const threshold = await getMemberThreshold()

    
    const filterOptions = await queryFilterOptions()

    
    
    
    const cycleRunner =
      (group: CycleGroup, metric: 'count' | 'revenue') => (r: ResolvedRange) =>
        queryCycle(session, scope, r, threshold, groupCol, filter, group, metric)

    const [
      cardHoldersTotal,
      memberCountTotal,
      trialCount,
      newCount,
      newRevenue,
      repurchaseCount,
      repurchaseRevenue,
    ] = await Promise.all([
      queryCardHolders(session, scope, filter),
      queryMemberCount(session, scope),
      withComparison(cycleRunner('trial', 'count'), comparison, 'count', enabled),
      withComparison(cycleRunner('new', 'count'), comparison, 'count', enabled),
      withComparison(cycleRunner('new', 'revenue'), comparison, 'amount', enabled),
      withComparison(cycleRunner('repurchase', 'count'), comparison, 'count', enabled),
      withComparison(cycleRunner('repurchase', 'revenue'), comparison, 'amount', enabled),
    ])

    
    const cardHolders: KpiCell = { value: cardHoldersTotal, unit: 'count' }
    const cardHolderRate: KpiCell = {
      value: safeDiv(cardHoldersTotal, memberCountTotal),
      unit: 'percent',
    }
    
    const newAvgTicket: KpiCell = {
      value: safeDiv(round2(newRevenue.value ?? 0), newCount.value ?? 0),
      unit: 'amount',
    }
    const repurchaseAvgTicket: KpiCell = {
      value: safeDiv(round2(repurchaseRevenue.value ?? 0), repurchaseCount.value ?? 0),
      unit: 'amount',
    }
    
    const repurchaseRate: KpiCell = {
      value: safeDiv(repurchaseCount.value ?? 0, cardHoldersTotal),
      unit: 'percent',
    }

    const kpis: Record<string, KpiCell> = {
      cardHolders,
      cardHolderRate,
      trialCount,
      newCount,
      newRevenue,
      newAvgTicket,
      repurchaseCount,
      repurchaseRevenue,
      repurchaseAvgTicket,
      repurchaseRate,
    }

    
    const skelRows = (await db.execute(scopeStoreSkeletonSql(session, scope))) as unknown[]
    const skeleton = skelRows.map((raw) => {
      const r = raw as Record<string, unknown>
      return {
        marketId: String(r.market_id ?? ''),
        marketName: String(r.market_name ?? ''),
        storeId: String(r.store_id ?? ''),
        storeName: String(r.store_name ?? ''),
      }
    })

    const [cardByStore, memberByStore, cycleByStore] = await Promise.all([
      queryCardHoldersByStore(session, scope, filter),
      queryMemberCountByStore(session, scope),
      queryCycleByStore(session, scope, cur, threshold, groupCol, filter),
    ])

    
    const storeAggs = skeleton.map((s) => {
      const cyc = cycleByStore.get(s.storeId)
      const agg: ProductStoreAgg = {
        cardHolders: cardByStore.get(s.storeId) ?? 0,
        trialCount: cyc?.trialCount ?? 0,
        newCount: cyc?.newCount ?? 0,
        newRevenue: cyc?.newRevenue ?? 0,
        repurchaseCount: cyc?.repurchaseCount ?? 0,
        repurchaseRevenue: cyc?.repurchaseRevenue ?? 0,
      }
      return { ...s, agg, memberCount: memberByStore.get(s.storeId) ?? 0 }
    })

    const byStore: BreakdownRow[] = storeAggs.map((s) => ({
      groupId: s.storeId,
      groupName: s.storeName,
      marketName: s.marketName,
      metrics: buildMetrics(s.agg, s.memberCount),
    }))

    
    type MarketAcc = { name: string; agg: ProductStoreAgg; memberCount: number }
    const marketMap = new Map<string, MarketAcc>()
    for (const s of storeAggs) {
      let m = marketMap.get(s.marketId)
      if (!m) {
        m = {
          name: s.marketName,
          agg: {
            cardHolders: 0,
            trialCount: 0,
            newCount: 0,
            newRevenue: 0,
            repurchaseCount: 0,
            repurchaseRevenue: 0,
          },
          memberCount: 0,
        }
        marketMap.set(s.marketId, m)
      }
      m.agg.cardHolders += s.agg.cardHolders
      m.agg.trialCount += s.agg.trialCount
      m.agg.newCount += s.agg.newCount
      m.agg.newRevenue += s.agg.newRevenue
      m.agg.repurchaseCount += s.agg.repurchaseCount
      m.agg.repurchaseRevenue += s.agg.repurchaseRevenue
      m.memberCount += s.memberCount
    }

    const byMarket: BreakdownRow[] = Array.from(marketMap.entries()).map(([id, m]) => ({
      groupId: id,
      groupName: m.name,
      metrics: buildMetrics(
        { ...m.agg, newRevenue: round2(m.agg.newRevenue), repurchaseRevenue: round2(m.agg.repurchaseRevenue) },
        m.memberCount,
      ),
    }))

    
    byStore.sort((a, b) => a.groupName.localeCompare(b.groupName, 'zh-Hans-CN'))
    byMarket.sort((a, b) => a.groupName.localeCompare(b.groupName, 'zh-Hans-CN'))

    return {
      ...ctx.meta,
      filterOptions,
      selected: {
        productKind: params.productKind?.trim() || null,
        categoryName: params.categoryName?.trim() || null,
      },
      kpis,
      byMarket,
      byStore,
    }
  },
)
