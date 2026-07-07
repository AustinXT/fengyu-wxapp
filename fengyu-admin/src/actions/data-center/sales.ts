'use server'



import { db } from '@/db'
import { sql } from 'drizzle-orm'
import { withPermission } from '@/lib/with-permission'
import type { AuthSession } from '@/lib/types'
import type { BoardParams, BreakdownRow, KpiCell, SalesBoardResult } from '@/lib/data-center/types'
import { prepareBoardContext } from '@/lib/data-center/context'
import { scopeFilterSql, scopeStoreSkeletonSql } from '@/lib/data-center/scope-sql'
import { excludeDepositRefundSql } from '@/lib/data-center/consume-filter'
import { withComparison } from '@/lib/data-center/comparison'
import type { ResolvedRange } from '@/lib/data-center/types'


function scalar(rows: unknown, key = 'v'): number | null {
  const r = (rows as Array<Record<string, unknown>>)[0]
  if (!r || r[key] == null) return null
  const n = Number(r[key])
  return Number.isFinite(n) ? n : null
}


function perStore(total: number | null, storeCount: number | null): number | null {
  if (total == null || storeCount == null || storeCount <= 0) return null
  return total / storeCount
}

export const getSalesBoard = withPermission(
  'data_center:dashboard',
  async (session: AuthSession, params: BoardParams): Promise<SalesBoardResult> => {
    const ctx = await prepareBoardContext(session, params)
    const { scope } = ctx
    const cur = ctx.comparison.current

    

    
    const runStoreRevenue = async (range: ResolvedRange) =>
      scalar(
        await db.execute(sql`
          SELECT COALESCE(SUM(so.received::numeric - COALESCE(so.refunded_amount, 0)::numeric), 0) AS v
          FROM sale_orders so
          WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
            AND so.sale_order_type IN ('销售单', '转换单')
            AND so.status = '已支付'
            AND so.legacy_source IS DISTINCT FROM 'workfine'
            AND so.paid_at::date BETWEEN ${range.start} AND ${range.end}
        `),
      )

    
    const runShengmeiRevenue = async (range: ResolvedRange) =>
      scalar(
        await db.execute(sql`
          SELECT COALESCE(SUM(si.received::numeric), 0) AS v
          FROM sale_orders so
          JOIN sale_items si ON si.sale_order_id = so.sale_order_id
          WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
            AND so.sale_order_type IN ('销售单', '转换单')
            AND so.status = '已支付'
            AND si.is_shengmei = TRUE
            AND so.paid_at::date BETWEEN ${range.start} AND ${range.end}
        `),
      )

    
    const runStoreConsume = async (range: ResolvedRange) =>
      scalar(
        await db.execute(sql`
          SELECT COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS v
          FROM service_orders so
          JOIN service_items sit ON sit.service_order_id = so.service_order_id
          JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
          WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
            AND so.status = '已完成'
            AND so.service_date BETWEEN ${range.start} AND ${range.end}
            AND ${excludeDepositRefundSql('so')}
        `),
      )

    
    const runShengmeiConsume = async (range: ResolvedRange) =>
      scalar(
        await db.execute(sql`
          SELECT COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS v
          FROM service_orders so
          JOIN service_items sit ON sit.service_order_id = so.service_order_id
          JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
          WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
            AND so.status = '已完成'
            AND sit.is_shengmei = TRUE
            AND so.service_date BETWEEN ${range.start} AND ${range.end}
            AND ${excludeDepositRefundSql('so')}
        `),
      )

    
    const runNewCustomerRevenue = async (range: ResolvedRange) =>
      scalar(
        await db.execute(sql`
          SELECT COALESCE(SUM(si.received::numeric), 0) AS v
          FROM sale_orders so
          JOIN sale_items si ON si.sale_order_id = so.sale_order_id
          JOIN client_wechat_users c ON c.user_id = so.client_user_id
          WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
            AND so.sale_order_type IN ('销售单', '转换单')
            AND so.status = '已支付'
            AND c.customer_type = '会员客'
            AND c.became_member_at::date >= ${range.start}
            AND so.paid_at::date BETWEEN ${range.start} AND ${range.end}
        `),
      )

    
    const runTrafficCustomerRevenue = async (range: ResolvedRange) =>
      scalar(
        await db.execute(sql`
          SELECT COALESCE(SUM(si.received::numeric), 0) AS v
          FROM sale_orders so
          JOIN sale_items si ON si.sale_order_id = so.sale_order_id
          JOIN client_wechat_users c ON c.user_id = so.client_user_id
          WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
            AND so.sale_order_type IN ('销售单', '转换单')
            AND so.status = '已支付'
            AND c.customer_type = '流量客'
            AND so.paid_at::date BETWEEN ${range.start} AND ${range.end}
        `),
      )

    
    const runStoreCount = async (range: ResolvedRange): Promise<number | null> => {
      if (scope.type === 'store') return 1
      return scalar(
        await db.execute(sql`
          SELECT COUNT(*)::int AS v
          FROM stores s
          JOIN org_nodes o ON s.org_node_id = o.id
          WHERE o.type = '门店'
            AND ${scopeFilterSql(session, scope, 's.store_id')}
            AND s.opening_date IS NOT NULL
            AND s.opening_date::date <= ${range.end}
            AND (s.closed_at IS NULL OR s.closed_at::date > ${range.end})
        `),
      )
    }

    
    const runEmployeeCount = async (range: ResolvedRange) =>
      scalar(
        await db.execute(sql`
          SELECT COUNT(*)::int AS v
          FROM staff_wechat_users s
          WHERE ${scopeFilterSql(session, scope, 's.store_id')}
            AND s.skills && ARRAY['美容师','养生师']::text[]
            AND s.hired_at IS NOT NULL
            AND s.hired_at::date <= ${range.end}
            AND (s.resigned_at IS NULL OR s.resigned_at::date > ${range.end})
        `),
      )

    
    const [
      storeRevenue,
      shengmeiRevenue,
      storeConsume,
      shengmeiConsume,
      newCustomerRevenue,
      trafficCustomerRevenue,
      storeCount,
      employeeCount,
    ] = await Promise.all([
      withComparison(runStoreRevenue, ctx.comparison, 'amount', ctx.enabled),
      withComparison(runShengmeiRevenue, ctx.comparison, 'amount', ctx.enabled),
      withComparison(runStoreConsume, ctx.comparison, 'amount', ctx.enabled),
      withComparison(runShengmeiConsume, ctx.comparison, 'amount', ctx.enabled),
      withComparison(runNewCustomerRevenue, ctx.comparison, 'amount', ctx.enabled),
      withComparison(runTrafficCustomerRevenue, ctx.comparison, 'amount', ctx.enabled),
      withComparison(runStoreCount, ctx.comparison, 'count', ctx.enabled),
      withComparison(runEmployeeCount, ctx.comparison, 'count', ctx.enabled),
    ])

    
    
    const revenuePerStore: KpiCell = {
      value: perStore(storeRevenue.value, storeCount.value),
      unit: 'amount',
    }
    const shengmeiRevenuePerStore: KpiCell = {
      value: perStore(shengmeiRevenue.value, storeCount.value),
      unit: 'amount',
    }
    const consumePerStore: KpiCell = {
      value: perStore(storeConsume.value, storeCount.value),
      unit: 'amount',
    }

    const kpis: Record<string, KpiCell> = {
      storeRevenue,
      shengmeiRevenue,
      storeConsume,
      shengmeiConsume,
      newCustomerRevenue,
      trafficCustomerRevenue,
      revenuePerStore,
      shengmeiRevenuePerStore,
      consumePerStore,
      storeCount,
      employeeCount,
    }

    
    
    

    const skeleton = scopeStoreSkeletonSql(session, scope)

    type StoreAgg = {
      storeId: string
      storeName: string
      marketId: string
      marketName: string
      technicianCount: number | null
      storeRevenue: number | null
      shengmeiRevenue: number | null
      newCustomerRevenue: number | null
      trafficCustomerRevenue: number | null
      storeConsume: number | null
      shengmeiConsume: number | null
    }

    const [
      skelRows,
      techRows,
      revRows,
      shengmeiRevRows,
      newRevRows,
      trafficRevRows,
      consRows,
      shengmeiConsRows,
    ] = await Promise.all([
      db.execute(skeleton),
      
      db.execute(sql`
        SELECT s.store_id, COUNT(*)::int AS v
        FROM staff_wechat_users s
        WHERE ${scopeFilterSql(session, scope, 's.store_id')}
          AND s.skills && ARRAY['美容师','养生师']::text[]
          AND s.hired_at IS NOT NULL
          AND s.hired_at::date <= ${cur.end}
          AND (s.resigned_at IS NULL OR s.resigned_at::date > ${cur.end})
        GROUP BY s.store_id
      `),
      
      db.execute(sql`
        SELECT so.store_id, COALESCE(SUM(so.received::numeric - COALESCE(so.refunded_amount, 0)::numeric), 0) AS v
        FROM sale_orders so
        WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
          AND so.sale_order_type IN ('销售单', '转换单')
          AND so.status = '已支付'
          AND so.legacy_source IS DISTINCT FROM 'workfine'
          AND so.paid_at::date BETWEEN ${cur.start} AND ${cur.end}
        GROUP BY so.store_id
      `),
      
      db.execute(sql`
        SELECT so.store_id, COALESCE(SUM(si.received::numeric), 0) AS v
        FROM sale_orders so
        JOIN sale_items si ON si.sale_order_id = so.sale_order_id
        WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
          AND so.sale_order_type IN ('销售单', '转换单')
          AND so.status = '已支付'
          AND si.is_shengmei = TRUE
          AND so.paid_at::date BETWEEN ${cur.start} AND ${cur.end}
        GROUP BY so.store_id
      `),
      
      db.execute(sql`
        SELECT so.store_id, COALESCE(SUM(si.received::numeric), 0) AS v
        FROM sale_orders so
        JOIN sale_items si ON si.sale_order_id = so.sale_order_id
        JOIN client_wechat_users c ON c.user_id = so.client_user_id
        WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
          AND so.sale_order_type IN ('销售单', '转换单')
          AND so.status = '已支付'
          AND c.customer_type = '会员客'
          AND c.became_member_at::date >= ${cur.start}
          AND so.paid_at::date BETWEEN ${cur.start} AND ${cur.end}
        GROUP BY so.store_id
      `),
      
      db.execute(sql`
        SELECT so.store_id, COALESCE(SUM(si.received::numeric), 0) AS v
        FROM sale_orders so
        JOIN sale_items si ON si.sale_order_id = so.sale_order_id
        JOIN client_wechat_users c ON c.user_id = so.client_user_id
        WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
          AND so.sale_order_type IN ('销售单', '转换单')
          AND so.status = '已支付'
          AND c.customer_type = '流量客'
          AND so.paid_at::date BETWEEN ${cur.start} AND ${cur.end}
        GROUP BY so.store_id
      `),
      
      db.execute(sql`
        SELECT so.store_id, COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS v
        FROM service_orders so
        JOIN service_items sit ON sit.service_order_id = so.service_order_id
        JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
        WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
          AND so.status = '已完成'
          AND so.service_date BETWEEN ${cur.start} AND ${cur.end}
          AND ${excludeDepositRefundSql('so')}
        GROUP BY so.store_id
      `),
      
      db.execute(sql`
        SELECT so.store_id, COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS v
        FROM service_orders so
        JOIN service_items sit ON sit.service_order_id = so.service_order_id
        JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
        WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
          AND so.status = '已完成'
          AND sit.is_shengmei = TRUE
          AND so.service_date BETWEEN ${cur.start} AND ${cur.end}
          AND ${excludeDepositRefundSql('so')}
        GROUP BY so.store_id
      `),
    ])

    
    const toMap = (rows: unknown): Map<string, number> => {
      const m = new Map<string, number>()
      for (const r of rows as Array<Record<string, unknown>>) {
        const id = String(r.store_id)
        m.set(id, Number(r.v ?? 0))
      }
      return m
    }
    const techMap = toMap(techRows)
    const revMap = toMap(revRows)
    const shengmeiRevMap = toMap(shengmeiRevRows)
    const newRevMap = toMap(newRevRows)
    const trafficRevMap = toMap(trafficRevRows)
    const consMap = toMap(consRows)
    const shengmeiConsMap = toMap(shengmeiConsRows)

    
    const storeAggs: StoreAgg[] = (skelRows as Array<Record<string, unknown>>).map((r) => {
      const storeId = String(r.store_id)
      return {
        storeId,
        storeName: String(r.store_name ?? ''),
        marketId: String(r.market_id ?? ''),
        marketName: String(r.market_name ?? ''),
        technicianCount: techMap.get(storeId) ?? 0,
        storeRevenue: revMap.get(storeId) ?? 0,
        shengmeiRevenue: shengmeiRevMap.get(storeId) ?? 0,
        newCustomerRevenue: newRevMap.get(storeId) ?? 0,
        trafficCustomerRevenue: trafficRevMap.get(storeId) ?? 0,
        storeConsume: consMap.get(storeId) ?? 0,
        shengmeiConsume: shengmeiConsMap.get(storeId) ?? 0,
      }
    })

    
    const byStore: BreakdownRow[] = storeAggs.map((s) => ({
      groupId: s.storeId,
      groupName: s.storeName,
      marketName: s.marketName,
      metrics: {
        technicianCount: s.technicianCount,
        storeRevenue: s.storeRevenue,
        shengmeiRevenue: s.shengmeiRevenue,
        newCustomerRevenue: s.newCustomerRevenue,
        trafficCustomerRevenue: s.trafficCustomerRevenue,
        storeConsume: s.storeConsume,
        shengmeiConsume: s.shengmeiConsume,
      },
    }))

    
    type MarketAgg = {
      marketId: string
      marketName: string
      storeCount: number
      technicianCount: number
      storeRevenue: number
      shengmeiRevenue: number
      newCustomerRevenue: number
      trafficCustomerRevenue: number
      storeConsume: number
      shengmeiConsume: number
    }
    const marketMap = new Map<string, MarketAgg>()
    for (const s of storeAggs) {
      let m = marketMap.get(s.marketId)
      if (!m) {
        m = {
          marketId: s.marketId,
          marketName: s.marketName,
          storeCount: 0,
          technicianCount: 0,
          storeRevenue: 0,
          shengmeiRevenue: 0,
          newCustomerRevenue: 0,
          trafficCustomerRevenue: 0,
          storeConsume: 0,
          shengmeiConsume: 0,
        }
        marketMap.set(s.marketId, m)
      }
      m.storeCount += 1
      m.technicianCount += s.technicianCount ?? 0
      m.storeRevenue += s.storeRevenue ?? 0
      m.shengmeiRevenue += s.shengmeiRevenue ?? 0
      m.newCustomerRevenue += s.newCustomerRevenue ?? 0
      m.trafficCustomerRevenue += s.trafficCustomerRevenue ?? 0
      m.storeConsume += s.storeConsume ?? 0
      m.shengmeiConsume += s.shengmeiConsume ?? 0
    }

    const byMarket: BreakdownRow[] = Array.from(marketMap.values()).map((m) => ({
      groupId: m.marketId,
      groupName: m.marketName,
      metrics: {
        storeCount: m.storeCount,
        technicianCount: m.technicianCount,
        storeRevenue: m.storeRevenue,
        shengmeiRevenue: m.shengmeiRevenue,
        revenuePerStore: perStore(m.storeRevenue, m.storeCount),
        shengmeiRevenuePerStore: perStore(m.shengmeiRevenue, m.storeCount),
        newCustomerRevenue: m.newCustomerRevenue,
        trafficCustomerRevenue: m.trafficCustomerRevenue,
        storeConsume: m.storeConsume,
        shengmeiConsume: m.shengmeiConsume,
        consumePerStore: perStore(m.storeConsume, m.storeCount),
        shengmeiConsumePerStore: perStore(m.shengmeiConsume, m.storeCount),
      },
    }))

    return {
      ...ctx.meta,
      kpis,
      byMarket,
      byStore,
    }
  },
)
