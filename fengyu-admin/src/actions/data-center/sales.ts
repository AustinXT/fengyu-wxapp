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
 *   - 组织层级业绩 = SUM(sale_order_performance_events.amount) ∩ status='已支付'
 *     ∩ change_type IN ('首次支付','回款','退款') ∩ sale_order_type IN ('销售单','转换单','充值单')
 *     ∩ performance_date（**一律直读款项归属日期，无回退分支**；#137 收敛 / 迁移 0041。
 *     原「首次按订单归属日、后续流水按真实发生日」表述已失效）
 *   - 生美 = sale_item_performance_events 行级 SUM(amount) WHERE is_shengmei=TRUE
 *   - 实耗 = SUM(unit_real_price * session_used) ∩ service_orders.status='已完成' ∩ service_date；
 *     生美实耗加 is_shengmei=TRUE
 *   - 新增会员（newCustomerRevenue）= customer_type='会员客' AND became_member_at::date >= 区间起
 *     （metrics.md 销售数据页「新增会员」分型），SUM(付款流水 amount)
 *   - 员工数 skills && ARRAY['美容师','养生师'] + hired_at/resigned_at 历史化
 *   - 门店数：当前门店节点启用 + opening_date/closed_at 历史化
 *
 * 流量客业绩（trafficCustomerRevenue，2026-05-26 用户拍板）：
 *   trafficCustomerRevenue = SUM(付款流水 amount) WHERE customer_type = '流量客'
 *   （仅纯流量客，不含体验客/小美客）。已登记 metrics.md §「销售数据页 — 分客型业绩」。
 */

import { db } from '@/db'
import { sql } from 'drizzle-orm'
import { withPermission } from '@/lib/with-permission'
import type { AuthSession } from '@/lib/types'
import type { BoardParams, BreakdownRow, KpiCell, SalesBoardResult } from '@/lib/data-center/types'
import { prepareBoardContext } from '@/lib/data-center/context'
import { scopeFilterSql, scopeStoreSkeletonSql } from '@/lib/data-center/scope-sql'
import { excludeDepositRefundSql } from '@/lib/data-center/consume-filter'
import {
  technicianCountSql,
  technicianByStoreSql,
  technicianDirectByMarketSql,
} from '@/lib/data-center/technician-sql'
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

    /** 业绩：付款流水净现金流，一律按款项业绩归属日期（#137 收敛 / 迁移 0041）。 */
    const runStoreRevenue = async (range: ResolvedRange) =>
      scalar(
        await db.execute(sql`
          SELECT COALESCE(SUM(spe.amount::numeric), 0) AS v
          FROM sale_order_performance_events spe
          WHERE ${scopeFilterSql(session, scope, 'spe.store_id')}
            AND spe.status = '已支付'
            AND spe.change_type IN ('首次支付', '回款', '退款')
            AND spe.sale_order_type IN ('销售单', '转换单', '充值单')
            AND spe.legacy_source IS DISTINCT FROM 'workfine'
            AND spe.performance_date BETWEEN ${range.start} AND ${range.end}
        `),
      )

    /** 生美业绩：逐笔项目业绩事件，历史缺失 receipt 由视图残差补齐。 */
    const runShengmeiRevenue = async (range: ResolvedRange) =>
      scalar(
        await db.execute(sql`
          SELECT COALESCE(SUM(sipe.amount::numeric), 0) AS v
          FROM sale_item_performance_events sipe
          JOIN sale_items si ON si.sale_item_id = sipe.sale_item_id
          JOIN sale_orders so ON so.sale_order_id = sipe.sale_order_id
          WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
            AND so.sale_order_type IN ('销售单', '转换单')
            AND so.status = '已支付'
            AND si.is_shengmei = TRUE
            AND sipe.performance_date BETWEEN ${range.start} AND ${range.end}
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
            AND ${excludeDepositRefundSql('so')}
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
            AND ${excludeDepositRefundSql('so')}
        `),
      )

    /**
     * 新增客业绩（=新增会员业绩）：付款流水 SUM(amount)，
     * 分型 customer_type='会员客' AND became_member_at::date >= 区间起（metrics.md 销售数据页「新增会员」）。
     * NULL became_member_at 不计入新增（与 staff salesData FILTER 中 COALESCE '1970-01-01' < start 归老会员一致）。
     */
    const runNewCustomerRevenue = async (range: ResolvedRange) =>
      scalar(
        await db.execute(sql`
          SELECT COALESCE(SUM(spe.amount::numeric), 0) AS v
          FROM sale_order_performance_events spe
          JOIN sale_orders so ON so.sale_order_id = spe.sale_order_id
          JOIN client_wechat_users c ON c.user_id = so.client_user_id
          WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
            AND spe.status = '已支付'
            AND spe.change_type IN ('首次支付', '回款', '退款')
            AND so.sale_order_type IN ('销售单', '转换单', '充值单')
            AND so.legacy_source IS DISTINCT FROM 'workfine'
            AND c.customer_type = '会员客'
            AND c.became_member_at::date >= ${range.start}
            AND spe.performance_date BETWEEN ${range.start} AND ${range.end}
        `),
      )

    /**
     * 流量客业绩：付款流水 SUM(amount)，customer_type = '流量客'（仅纯流量客；说明见文件头）。
     */
    const runTrafficCustomerRevenue = async (range: ResolvedRange) =>
      scalar(
        await db.execute(sql`
          SELECT COALESCE(SUM(spe.amount::numeric), 0) AS v
          FROM sale_order_performance_events spe
          JOIN sale_orders so ON so.sale_order_id = spe.sale_order_id
          JOIN client_wechat_users c ON c.user_id = so.client_user_id
          WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
            AND spe.status = '已支付'
            AND spe.change_type IN ('首次支付', '回款', '退款')
            AND so.sale_order_type IN ('销售单', '转换单', '充值单')
            AND so.legacy_source IS DISTINCT FROM 'workfine'
            AND c.customer_type = '流量客'
            AND spe.performance_date BETWEEN ${range.start} AND ${range.end}
        `),
      )

    /**
     * 门店数（当前启用 + 历史化）：opening_date <= 区间末 AND (closed_at IS NULL OR closed_at > 区间末)。
     * 单店 scope 也走真实查询，停用门店即使通过 URL 直达也返回 0。
     */
    const runStoreCount = async (range: ResolvedRange): Promise<number | null> => {
      return scalar(
        await db.execute(sql`
          SELECT COUNT(*)::int AS v
          FROM stores s
          JOIN org_nodes o ON s.org_node_id = o.id
          WHERE o.type = '门店'
            AND o.is_active = TRUE
            AND ${scopeFilterSql(session, scope, 's.store_id')}
            AND s.opening_date IS NOT NULL
            AND s.opening_date::date <= ${range.end}
            AND (s.closed_at IS NULL OR s.closed_at::date > ${range.end})
        `),
      )
    }

    /**
     * 员工数（历史化，产能技师）。
     *
     * ⚠️ 口径单源在 `@/lib/data-center/technician-sql`，**人效板 `efficiency.ts` 共用同一份**。
     * 别在这里内联重写成「只按 `s.store_id` 过滤」：那会漏掉直挂市场/部门的产能技师
     * （2026-09 实测 164 vs 150），且会让本板与人效板的同名指标差 14 人（#285 闸门 2 判 P0）。
     */
    const runEmployeeCount = async (range: ResolvedRange) =>
      scalar(await db.execute(technicianCountSql(session, scope, range.end)))

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
      techDirectByMarketRows,
      revRows,
      shengmeiRevRows,
      newRevRows,
      trafficRevRows,
      consRows,
      shengmeiConsRows,
    ] = await Promise.all([
      db.execute(skeleton),
      // 技师人数 by store（有门店归属的部分）—— 与 KPI 同一份 technician-sql 单源
      db.execute(technicianByStoreSql(session, scope, cur.end)),
      // 技师人数 by market（直挂市场/部门、无门店归属的部分），详见 technician-sql 注释
      db.execute(technicianDirectByMarketSql(session, scope, cur.end)),
      // 业绩（付款流水现金流）
      db.execute(sql`
        SELECT spe.store_id, COALESCE(SUM(spe.amount::numeric), 0) AS v
        FROM sale_order_performance_events spe
        WHERE ${scopeFilterSql(session, scope, 'spe.store_id')}
          AND spe.status = '已支付'
          AND spe.change_type IN ('首次支付', '回款', '退款')
          AND spe.sale_order_type IN ('销售单', '转换单', '充值单')
          AND spe.legacy_source IS DISTINCT FROM 'workfine'
          AND spe.performance_date BETWEEN ${cur.start} AND ${cur.end}
        GROUP BY spe.store_id
      `),
      // 生美业绩（行级）
      db.execute(sql`
        SELECT so.store_id, COALESCE(SUM(sipe.amount::numeric), 0) AS v
        FROM sale_item_performance_events sipe
        JOIN sale_items si ON si.sale_item_id = sipe.sale_item_id
        JOIN sale_orders so ON so.sale_order_id = sipe.sale_order_id
        WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
          AND so.sale_order_type IN ('销售单', '转换单')
          AND so.status = '已支付'
          AND si.is_shengmei = TRUE
          AND sipe.performance_date BETWEEN ${cur.start} AND ${cur.end}
        GROUP BY so.store_id
      `),
      // 新增会员业绩（付款流水 + 客型）
      db.execute(sql`
        SELECT so.store_id, COALESCE(SUM(spe.amount::numeric), 0) AS v
        FROM sale_order_performance_events spe
        JOIN sale_orders so ON so.sale_order_id = spe.sale_order_id
        JOIN client_wechat_users c ON c.user_id = so.client_user_id
        WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
          AND spe.status = '已支付'
          AND spe.change_type IN ('首次支付', '回款', '退款')
          AND so.sale_order_type IN ('销售单', '转换单', '充值单')
          AND so.legacy_source IS DISTINCT FROM 'workfine'
          AND c.customer_type = '会员客'
          AND c.became_member_at::date >= ${cur.start}
          AND spe.performance_date BETWEEN ${cur.start} AND ${cur.end}
        GROUP BY so.store_id
      `),
      // 流量客业绩（付款流水 + 客型）
      db.execute(sql`
        SELECT so.store_id, COALESCE(SUM(spe.amount::numeric), 0) AS v
        FROM sale_order_performance_events spe
        JOIN sale_orders so ON so.sale_order_id = spe.sale_order_id
        JOIN client_wechat_users c ON c.user_id = so.client_user_id
        WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
          AND spe.status = '已支付'
          AND spe.change_type IN ('首次支付', '回款', '退款')
          AND so.sale_order_type IN ('销售单', '转换单', '充值单')
          AND so.legacy_source IS DISTINCT FROM 'workfine'
          AND c.customer_type = '流量客'
          AND spe.performance_date BETWEEN ${cur.start} AND ${cur.end}
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
          AND ${excludeDepositRefundSql('so')}
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
          AND ${excludeDepositRefundSql('so')}
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
    const marketRowOf = (marketId: string, marketName: string): MarketAgg => {
      let m = marketMap.get(marketId)
      if (!m) {
        m = {
          marketId,
          marketName,
          storeCount: 0,
          technicianCount: 0,
          storeRevenue: 0,
          shengmeiRevenue: 0,
          newCustomerRevenue: 0,
          trafficCustomerRevenue: 0,
          storeConsume: 0,
          shengmeiConsume: 0,
        }
        marketMap.set(marketId, m)
      }
      return m
    }

    for (const s of storeAggs) {
      const m = marketRowOf(s.marketId, s.marketName)
      m.storeCount += 1
      m.technicianCount += s.technicianCount ?? 0
      m.storeRevenue += s.storeRevenue ?? 0
      m.shengmeiRevenue += s.shengmeiRevenue ?? 0
      m.newCustomerRevenue += s.newCustomerRevenue ?? 0
      m.trafficCustomerRevenue += s.trafficCustomerRevenue ?? 0
      m.storeConsume += s.storeConsume ?? 0
      m.shengmeiConsume += s.shengmeiConsume ?? 0
    }

    /**
     * 并入**直挂市场/部门**的产能技师（#285）。
     *
     * 上面的循环逐门店累加，`store_id IS NULL` 的技师没有任何门店可挂，只走那个循环会被
     * 二次丢失。⚠️ 必须在循环**外**按市场加一次：放进循环会按该市场的门店数重复累加。
     * ⚠️ 用 `marketRowOf` 建行：「品项公司」这类市场底下一个门店都没有，
     * 压根不出现在门店骨架里，只能在这里补出行。
     */
    for (const r of techDirectByMarketRows as Array<Record<string, unknown>>) {
      if (r.market_id == null) continue
      const m = marketRowOf(String(r.market_id), String(r.market_name ?? ''))
      m.technicianCount += Number(r.v ?? 0)
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
