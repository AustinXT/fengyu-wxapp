'use server'

/**
 * 数据中心 — 销售板块 action（getSalesBoard）
 *
 * 口径权威：notes/references/metrics.md（业绩 / 生美业绩 / 实耗 / 生美实耗 /
 *   销售数据页「分客型业绩 / 实耗」/ 门店数 / 员工数）。
 *
 * 移植源（照搬口径，禁止 import；CloudBase 纯 JS 原生 SQL → admin Drizzle raw SQL）：
 *   fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js
 *     - summary: queryStoreRevenue / queryShengmeiRevenue / queryStoreConsume /
 *       queryShengmeiConsume / queryEmployeeCount / queryStoreCount
 *     - salesData: 分客型业绩（小美/新增会员/老会员）+ 分客型实耗
 *
 * ★ 口径红线（consistency.sales.test.ts 字面量守护，禁止偏离）：
 *   - 营业额 = SUM(received - COALESCE(refunded_amount,0)) ∩ sale_order_type IN ('销售单','转换单')
 *     ∩ status='已支付' ∩ paid_at（2026-04-26 sale-order-domain-refactor，与 dashboard.ts 同口径）
 *   - 生美 = sale_items 行级 SUM(received) WHERE is_shengmei=TRUE
 *   - 实耗 = SUM(unit_real_price * session_used) ∩ service_orders.status='已完成' ∩ service_date；
 *     生美实耗加 is_shengmei=TRUE
 *   - 新增会员（newCustomerRevenue）= customer_type='会员客' AND became_member_at::date >= 区间起
 *     （metrics.md 销售数据页「新增会员」分型），SUM(si.received)
 *   - 员工数 skills && ARRAY['美容师','养生师'] + hired_at/resigned_at 历史化
 *   - 门店数 opening_date/closed_at 历史化
 *
 * 流量客业绩（trafficCustomerRevenue，2026-05-26 用户拍板）：
 *   trafficCustomerRevenue = SUM(si.received) WHERE customer_type = '流量客'
 *   （仅纯流量客，不含体验客/小美客）。已登记 metrics.md §「销售数据页 — 分客型业绩」。
 */

import { db } from '@/db'
import { sql } from 'drizzle-orm'
import { withPermission } from '@/lib/with-permission'
import type { AuthSession } from '@/lib/types'
import type { BoardParams, BreakdownRow, KpiCell, SalesBoardResult } from '@/lib/data-center/types'
import { prepareBoardContext } from '@/lib/data-center/context'
import { scopeFilterSql, scopeStoreSkeletonSql } from '@/lib/data-center/scope-sql'
import { withComparison } from '@/lib/data-center/comparison'
import type { ResolvedRange } from '@/lib/data-center/types'

/** db.execute 返回数组，取首行标量并 Number 化（null→null） */
function scalar(rows: unknown, key = 'v'): number | null {
  const r = (rows as Array<Record<string, unknown>>)[0]
  if (!r || r[key] == null) return null
  const n = Number(r[key])
  return Number.isFinite(n) ? n : null
}

/** 店均派生：分子 / 门店数；门店数<=0 → null（前端 '--'） */
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

    // ── 区间标量 runner（KPI 用，按区间复算以支持同比/环比）────────────────

    /** 业绩：SUM(received - refunded_amount) ∩ 销售单/转换单 ∩ 已支付 ∩ paid_at */
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

    /** 生美业绩：sale_items 行级 SUM(received) WHERE is_shengmei=TRUE */
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

    /** 实耗：SUM(unit_real_price * session_used) ∩ 已完成 ∩ service_date */
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
        `),
      )

    /** 生美实耗：实耗 + sit.is_shengmei=TRUE */
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
        `),
      )

    /**
     * 新增客业绩（=新增会员业绩）：sale_items SUM(received)，
     * 分型 customer_type='会员客' AND became_member_at::date >= 区间起（metrics.md 销售数据页「新增会员」）。
     * NULL became_member_at 不计入新增（与 staff salesData FILTER 中 COALESCE '1970-01-01' < start 归老会员一致）。
     */
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

    /**
     * 流量客业绩：sale_items SUM(received)，customer_type = '流量客'（仅纯流量客；说明见文件头）。
     */
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

    /**
     * 门店数（历史化）：opening_date <= 区间末 AND (closed_at IS NULL OR closed_at > 区间末)。
     * scope=store 短路返回 1（对齐 staff queryStoreCount）。store 维度无 scope 过滤需求。
     */
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

    /**
     * 员工数（历史化，产能技师）：skills && ARRAY['美容师','养生师']
     *   ∩ hired_at <= 区间末 ∩ (resigned_at IS NULL OR resigned_at > 区间末)。
     */
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

    // ── KPI 卡片（同比/环比走 withComparison）────────────────────────────────
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

    // 店均派生（amount）：分子本期值 / 本期门店数；门店数<=0 → null（前端 '--'）。
    // 仅出 value、不算同比环比（派生的 delta 易误导，且 metrics.md 未要求店均 KPI 带对比）。
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

    // ── 明细表（按市场 / 按门店；不算同比环比）────────────────────────────────
    // 思路对齐 staff 多 query：各指标分别 GROUP BY store_id 单查，JS 按 store/market 合并；
    // 严禁 sale_items × service_items 同表 JOIN（笛卡尔膨胀）。

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
      // 技师人数（产能技师，截至区间末历史化），按 store_id 分组
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
      // 业绩（订单层）
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
      // 生美业绩（行级）
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
      // 新增会员业绩（行级 + 客型）
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
      // 流量客业绩（行级 + 客型）
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
      // 实耗
      db.execute(sql`
        SELECT so.store_id, COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS v
        FROM service_orders so
        JOIN service_items sit ON sit.service_order_id = so.service_order_id
        JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
        WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
          AND so.status = '已完成'
          AND so.service_date BETWEEN ${cur.start} AND ${cur.end}
        GROUP BY so.store_id
      `),
      // 生美实耗
      db.execute(sql`
        SELECT so.store_id, COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS v
        FROM service_orders so
        JOIN service_items sit ON sit.service_order_id = so.service_order_id
        JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
        WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
          AND so.status = '已完成'
          AND sit.is_shengmei = TRUE
          AND so.service_date BETWEEN ${cur.start} AND ${cur.end}
        GROUP BY so.store_id
      `),
    ])

    // 把各指标行表转成 store_id → value 的映射
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

    // 骨架行（scope 内所有门店，含零业绩）→ StoreAgg 列表
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

    // 按门店明细
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

    // 按市场明细（在 JS 内按 marketId 聚合，门店数=骨架行计数，技师人数/各业绩求和）
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
