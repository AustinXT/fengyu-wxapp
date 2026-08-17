'use server'

/**
 * 数据中心 — 品项板块取数 action（getProductBoard）
 *
 * 口径权威：notes/references/metrics.md
 *   - §「品项顾客周期子页（mgmt-product-cycle）」（持卡截面 + daily_agg→qualifying_days /
 *     repurchase_qualifying_days→first_entry→period_agg→xinzeng/fugou/tiyan CTE 链）
 *   - §「品项顾客周期子页 → 3. 二级品项（category_name）粒度」（admin 独有的二级下钻扩展）
 *   - §「品项维度汇总」（一级=product_kind，二级=category_name）
 *
 * 移植源（CloudBase 纯 JS 原生 SQL，禁止 import，照搬口径成 admin Drizzle raw SQL）：
 *   fengyu-staff/cloudfunctions/staffApi/routes/mgmt-product.js
 *     - cardHolders：持卡人数 + 占比（截面快照，不随 period 变化）
 *     - cycleStats：体验/新增/复购全套 CTE（区间维度，时间轴为支付事件业绩归属日）
 *
 * ★ 口径红线（consistency.product.test.ts 字面量守护，禁止偏离）：
 *   - 持卡 = si.paid_sessions > 0；DISTINCT client。不再按 product_type 过滤。
 *   - 持卡 sale_order_type IN ('销售单','转换单','寄存单')（寄存单为 WorkFine 剩余次数初始化纳入）。
 *   - 占比分母 = memberCount（client_wechat_users.became_member_at IS NOT NULL ∩ scope by bound_store_id，
 *     持卡为截面，不带 $date 守卫）。
 *   - 进入达标日 = 销售单/转换单/寄存单的 SUM(sale_item_performance_events.amount) 在
 *     (client_user_id, store_id, 分组键, purchase_date) 分组下 >= threshold。
 *   - 复购达标日与区间业绩只统计销售单/转换单；寄存单只作为进入基线，不能触发复购。
 *   - purchase_date = sale_item_performance_events.performance_date。
 *   - entry_date = 全历史（截至 endDate）最早达标日，跨店合并；新增 = entry_date 落区间；
 *     复购 = 区间内 entry_date 后再次达标（threshold 共用）；体验 = 区间内有购买但全历史无达标日。
 *   - cycleStats 基础过滤 sale_order_type IN ('销售单','转换单','寄存单') ∩ 排除已关闭/已作废/未审核/待审批/支付失败；
 *     不要求 status='已支付'，received 达标即计入。
 *   - scope 用 so.store_id；客户维度（memberCount）用 c.bound_store_id。
 *
 * ★ 一级/二级筛选（admin 独有，staff 仅一级 product_kind）：
 *   - 都不选 / 仅选一级 → 分组键 = pc.product_kind（仅选一级时额外 WHERE pc.product_kind = $kind）
 *   - 选到二级 → 分组键 = pc.category_name（WHERE pc.product_kind = $kind AND pc.category_name = $name）
 *   口径与一级完全同构，唯一差异是分组键（daily_agg/first_entry 的 GROUP BY 维度同步替换）。
 *
 * 性能：daily_agg 全历史扫描（purchase_date <= endDate 无下界）；持卡截面 + cycle 区间分多查询。
 */

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

// ── 工具 ──────────────────────────────────────────────────────────────
const num = (v: unknown): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}
const round2 = (v: unknown): number => Math.round(num(v) * 100) / 100
/** 取数组首行（db.execute 返回数组） */
const first = (rows: unknown): Record<string, unknown> =>
  ((rows as unknown[])[0] as Record<string, unknown>) ?? {}
/** 安全除法（分母 <= 0 → null，前端 '--'） */
const safeDiv = (a: number, b: number): number | null => (b > 0 ? a / b : null)

/**
 * 品项分组键 + WHERE 过滤片段（一级 product_kind / 二级 category_name 切换）。
 *   - categoryName 非空（必附 productKind）→ 分组键 pc.category_name，过滤一级+二级
 *   - productKind 非空 → 分组键 pc.product_kind，过滤一级
 *   - 都不选 → 分组键 pc.product_kind，无品项过滤（仅守卫 product_kind IS NOT NULL）
 */
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

// =====================================================================
// 筛选器数据源：一级品项 + 其下二级品项名
// =====================================================================
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

// =====================================================================
// 持卡人数（截面快照，不随 period 变化）
// =====================================================================

/**
 * 持卡人数（DISTINCT client）：si.paid_sessions > 0，不按 product_type 过滤
 *   ∩ sale_order_type IN ('销售单','转换单','寄存单') ∩ status='已支付' ∩ scope（so.store_id）
 *   ∩ 品项过滤（一级/二级）。截面快照，无时间区间。
 */
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
      AND si.paid_sessions > 0
      AND so.sale_order_type IN ('销售单', '转换单', '寄存单')
      AND so.status = '已支付'
      AND so.client_user_id IS NOT NULL
      AND ${filter}
  `)
  return num(first(rows).v)
}

/** 会员数（占比分母）：became_member_at IS NOT NULL ∩ scope（bound_store_id），截面（不带 $date 守卫）。 */
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

// =====================================================================
// 体验 / 新增 / 复购（区间维度，时间轴 purchase_date）
// 单标量 runner（供 withComparison 跑本期/上期/去年同期）。
// 每个 range 自包含：daily_agg 用 purchase_date <= range.end（全历史下界），period_agg 用 BETWEEN。
// =====================================================================

type CycleGroup = 'trial' | 'new' | 'repurchase'

/**
 * 单一品项粒度（已被 filter 收窄为单组）的体验/新增/复购人数 + 业绩。
 * 返回 { count, revenue }（按 group 取对应段）。
 */
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
             sipe.performance_date AS purchase_date,
             SUM(sipe.amount::numeric) AS day_received,
             COALESCE(
               SUM(sipe.amount::numeric) FILTER (
                 WHERE so.sale_order_type IN ('销售单', '转换单')
               ),
               0
             ) AS purchase_received
      FROM sale_item_performance_events sipe
      JOIN sale_items si ON si.sale_item_id = sipe.sale_item_id
      JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
      JOIN product_skus sk ON sk.sku_id = si.sku_id
      JOIN product_categories pc ON pc.category_id = sk.category_id
      WHERE ${sc}
        AND so.sale_order_type IN ('销售单', '转换单', '寄存单')
        AND so.status NOT IN ('已关闭', '已作废', '未审核', '待审批', '支付失败')
        AND so.client_user_id IS NOT NULL
        AND ${filter}
        AND sipe.performance_date <= ${range.end}
      GROUP BY so.client_user_id, so.store_id, ${groupCol}, sipe.performance_date
      HAVING SUM(sipe.amount::numeric) > 0
    ),
    qualifying_days AS (
      SELECT client_user_id, store_id, grp, purchase_date
      FROM daily_agg
      WHERE day_received >= ${threshold}
    ),
    repurchase_qualifying_days AS (
      SELECT client_user_id, store_id, grp, purchase_date
      FROM daily_agg
      WHERE purchase_received >= ${threshold}
    ),
    first_entry AS (
      SELECT client_user_id, grp, MIN(purchase_date) AS entry_date
      FROM qualifying_days
      GROUP BY client_user_id, grp
    ),
    period_agg AS (
      SELECT client_user_id, store_id, grp, purchase_date, purchase_received AS day_received
      FROM daily_agg
      WHERE purchase_date BETWEEN ${range.start} AND ${range.end}
        AND purchase_received > 0
    ),
    xinzeng AS (
      SELECT client_user_id, grp, entry_date
      FROM first_entry
      WHERE entry_date BETWEEN ${range.start} AND ${range.end}
    ),
    fugou AS (
      SELECT DISTINCT q.client_user_id, q.grp
      FROM repurchase_qualifying_days q
      JOIN xinzeng x ON x.client_user_id = q.client_user_id AND x.grp = q.grp
      WHERE q.purchase_date BETWEEN ${range.start} AND ${range.end}
        AND q.purchase_date > x.entry_date
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

// =====================================================================
// 明细表（byMarket / byStore）：scope 骨架逐组聚合，不做同比环比
// =====================================================================

interface ProductStoreAgg {
  cardHolders: number
  trialCount: number
  newCount: number
  newRevenue: number
  repurchaseCount: number
  repurchaseRevenue: number
}

/**
 * 持卡人数（截面）按 store_id 归组（DISTINCT client per store；同一顾客跨店各算一次）。
 */
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
      AND si.paid_sessions > 0
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

/** 会员数按 store_id 归组（占比分母，bound_store_id）。 */
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

/**
 * 体验/新增/复购人数 + 新增业绩 + 复购业绩，按 store_id 归组（单查，全套 CTE）。
 *
 * store_id 归组采用 period_agg.store_id（消费发生的门店）。同一顾客在该品项的
 * entry_date 仍跨店合并（first_entry 不带 store_id），但人数落到「期内消费发生的门店」，
 * 与 KPI 总量（DISTINCT client 跨店去重）口径上的差异：明细各门店人数相加 ≥ KPI 总量
 * （同顾客跨门店购买会在多店各计一次），与 sales 板块明细的归组语义一致（业务接受）。
 */
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
             sipe.performance_date AS purchase_date,
             SUM(sipe.amount::numeric) AS day_received,
             COALESCE(
               SUM(sipe.amount::numeric) FILTER (
                 WHERE so.sale_order_type IN ('销售单', '转换单')
               ),
               0
             ) AS purchase_received
      FROM sale_item_performance_events sipe
      JOIN sale_items si ON si.sale_item_id = sipe.sale_item_id
      JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
      JOIN product_skus sk ON sk.sku_id = si.sku_id
      JOIN product_categories pc ON pc.category_id = sk.category_id
      WHERE ${sc}
        AND so.sale_order_type IN ('销售单', '转换单', '寄存单')
        AND so.status NOT IN ('已关闭', '已作废', '未审核', '待审批', '支付失败')
        AND so.client_user_id IS NOT NULL
        AND ${filter}
        AND sipe.performance_date <= ${range.end}
      GROUP BY so.client_user_id, so.store_id, ${groupCol}, sipe.performance_date
      HAVING SUM(sipe.amount::numeric) > 0
    ),
    qualifying_days AS (
      SELECT client_user_id, store_id, grp, purchase_date
      FROM daily_agg
      WHERE day_received >= ${threshold}
    ),
    repurchase_qualifying_days AS (
      SELECT client_user_id, store_id, grp, purchase_date
      FROM daily_agg
      WHERE purchase_received >= ${threshold}
    ),
    first_entry AS (
      SELECT client_user_id, grp, MIN(purchase_date) AS entry_date
      FROM qualifying_days
      GROUP BY client_user_id, grp
    ),
    period_agg AS (
      SELECT client_user_id, store_id, grp, purchase_date, purchase_received AS day_received
      FROM daily_agg
      WHERE purchase_date BETWEEN ${range.start} AND ${range.end}
        AND purchase_received > 0
    ),
    xinzeng AS (
      SELECT client_user_id, grp, entry_date
      FROM first_entry
      WHERE entry_date BETWEEN ${range.start} AND ${range.end}
    ),
    fugou AS (
      SELECT DISTINCT q.client_user_id, q.grp
      FROM repurchase_qualifying_days q
      JOIN xinzeng x ON x.client_user_id = q.client_user_id AND x.grp = q.grp
      WHERE q.purchase_date BETWEEN ${range.start} AND ${range.end}
        AND q.purchase_date > x.entry_date
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

/** 组装一行 metrics（持卡/体验/新增/复购 + 派生客单价/占比/复购率） */
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
    repurchaseRate: safeDiv(agg.repurchaseCount, agg.newCount),
  }
}

// =====================================================================
// 入口
// =====================================================================

export const getProductBoard = withPermission(
  'data_center:dashboard',
  async (session: AuthSession, params: ProductBoardParams): Promise<ProductBoardResult> => {
    const ctx = await prepareBoardContext(session, params)
    const { scope, comparison, enabled } = ctx
    const cur = comparison.current

    const { groupCol, filter } = resolveGrouping(params)
    const threshold = await getMemberThreshold()

    // ── 筛选器数据源（独立查询，与 scope 无关）────────────────────
    const filterOptions = await queryFilterOptions()

    // ── KPI ────────────────────────────────────────────────────
    // 持卡 / 占比为截面快照（不随 period 变化），不走 withComparison（只出 value）。
    // 体验 / 新增 / 复购为区间维度，走 withComparison（同比/环比）。
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

    // 持卡 / 占比（截面，仅 value）
    const cardHolders: KpiCell = { value: cardHoldersTotal, unit: 'count' }
    const cardHolderRate: KpiCell = {
      value: safeDiv(cardHoldersTotal, memberCountTotal),
      unit: 'percent',
    }
    // 客单价 / 复购率派生（自上面已算的 value；防除零 → null）
    const newAvgTicket: KpiCell = {
      value: safeDiv(round2(newRevenue.value ?? 0), newCount.value ?? 0),
      unit: 'amount',
    }
    const repurchaseAvgTicket: KpiCell = {
      value: safeDiv(round2(repurchaseRevenue.value ?? 0), repurchaseCount.value ?? 0),
      unit: 'amount',
    }
    // 复购率 = 复购人数 / 品项进入人数
    const repurchaseRate: KpiCell = {
      value: safeDiv(repurchaseCount.value ?? 0, newCount.value ?? 0),
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

    // ── 明细表（byMarket / byStore，仅当期）────────────────────────
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

    // 门店级聚合
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

    // 按市场聚合（在 JS 内按 marketId 求和；占比/客单价/复购率重新派生）
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

    // 稳定排序：按 groupName
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
