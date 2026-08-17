'use server'

/**
 * 数据中心 — 品项板块取数 action（getProductBoard）
 *
 * 口径权威：notes/references/metrics.md
 *   - §「品项顾客周期子页（mgmt-product-cycle）」（持卡截面 + daily_agg→qualifying_days→
 *     first_entry→period_agg→xinzeng/fugou/tiyan CTE 链）
 *   - §「品项顾客周期子页 → 3. 二级品项（category_name）粒度」（admin 独有的二级下钻扩展）
 *   - §「品项维度汇总」（一级=product_kind，二级=category_name）
 *
 * 移植源（CloudBase 纯 JS 原生 SQL，禁止 import，照搬口径成 admin Drizzle raw SQL）：
 *   fengyu-staff/cloudfunctions/staffApi/routes/mgmt-product.js
 *     - cardHolders：持卡人数 + 占比（截面快照，不随 period 变化）
 *     - cycleStats：体验/新增/复购全套 CTE（区间维度，时间轴 paid_at）
 *
 * ★ 口径红线（consistency.product.test.ts 字面量守护，禁止偏离）：
 *   - 持卡 = si.product_type = '疗程卡'（product_type enum 2026-05-21 已 3→2 值，单品并入疗程卡，
 *     无 '单品' 字面量，与 mgmt-product.js 实际实现一致）∩ si.remaining_sessions > 0；DISTINCT client。
 *   - 持卡 sale_order_type IN ('销售单','转换单','寄存单')（寄存单为 WorkFine 剩余次数初始化纳入）。
 *   - 占比分母 = memberCount（client_wechat_users.became_member_at IS NOT NULL ∩ scope by bound_store_id，
 *     持卡为截面，不带 $date 守卫）。
 *   - 达标日（qualifying day）= SUM(sale_item_performance_events.amount)
 *     在 (client_user_id, store_id, 分组键, performance_date)
 *     分组下 >= threshold（getMemberThreshold，默认 1980/1990）。
 *   - entry_date = 全历史（截至 endDate）最早达标日，跨店合并；新增 = entry_date 落区间；
 *     复购 = 区间内有达标日（threshold 共用）；体验 = 区间内有购买但全历史无达标日。新增 ⊆ 复购。
 *   - cycleStats 基础过滤 sale_order_type IN ('销售单','转换单') ∩ status='已支付'。
 *   - scope 用 so.store_id；客户维度（memberCount）用 c.bound_store_id。
 *
 * ★ 一级/二级筛选（admin 独有，staff 仅一级 product_kind）：
 *   - 都不选 / 仅选一级 → 分组键 = pc.product_kind（仅选一级时额外 WHERE pc.product_kind = $kind）
 *   - 选到二级 → 分组键 = pc.category_name（WHERE pc.product_kind = $kind AND pc.category_name = $name）
 *   口径与一级完全同构，唯一差异是分组键（daily_agg/first_entry 的 GROUP BY 维度同步替换）。
 *
 * 性能：daily_agg 全历史扫描（paid_at <= endDate 无下界）；持卡截面 + cycle 区间分多查询。
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
 * 持卡人数（DISTINCT client）：si.product_type = '疗程卡' ∩ remaining_sessions > 0
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
      AND si.product_type = '疗程卡'
      AND si.remaining_sessions > 0
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
// 体验 / 新增 / 复购（区间维度，时间轴 paid_at）
// 单标量 runner（供 withComparison 跑本期/上期/去年同期）。
// 每个 range 自包含：daily_agg 用 paid_at <= range.end（全历史下界），period_agg 用 BETWEEN。
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
             BOOL_OR(sipe.amount::numeric > 0) AS has_purchase
      FROM sale_item_performance_events sipe
      JOIN sale_items si ON si.sale_item_id = sipe.sale_item_id
      JOIN sale_orders so ON so.sale_order_id = sipe.sale_order_id
      JOIN product_skus sk ON sk.sku_id = si.sku_id
      JOIN product_categories pc ON pc.category_id = sk.category_id
      WHERE ${sc}
        AND so.sale_order_type IN ('销售单', '转换单')
        AND so.status = '已支付'
        AND so.client_user_id IS NOT NULL
        AND ${filter}
        AND sipe.performance_date <= ${range.end}
      GROUP BY so.client_user_id, so.store_id, ${groupCol}, sipe.performance_date
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
      SELECT client_user_id, store_id, grp, purchase_date, day_received, has_purchase
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
      WHERE pa.has_purchase
        AND NOT EXISTS (
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

type BreakdownGroup = 'market' | 'store'

type CycleAgg = Omit<ProductStoreAgg, 'cardHolders'>

/**
 * 持卡人数（截面）按市场/门店归组。
 * 市场级直接 COUNT(DISTINCT client)，避免把跨店持卡顾客从门店行再次相加。
 */
async function queryCardHoldersByGroup(
  session: AuthSession,
  scope: DataCenterScope,
  filter: SQL,
  group: BreakdownGroup,
): Promise<Map<string, number>> {
  const skeleton = scopeStoreSkeletonSql(session, scope)
  const groupId = group === 'market' ? sql.raw('sk.market_id') : sql.raw('sk.store_id')
  const rows = await db.execute(sql`
    WITH skel AS (${skeleton})
    SELECT ${groupId} AS group_id, COUNT(DISTINCT so.client_user_id) AS v
    FROM sale_items si
    JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
    JOIN skel sk ON sk.store_id = so.store_id
    JOIN product_skus sku ON sku.sku_id = si.sku_id
    JOIN product_categories pc ON pc.category_id = sku.category_id
    WHERE si.product_type = '疗程卡'
      AND si.remaining_sessions > 0
      AND so.sale_order_type IN ('销售单', '转换单', '寄存单')
      AND so.status = '已支付'
      AND so.client_user_id IS NOT NULL
      AND ${filter}
    GROUP BY ${groupId}
  `)
  const m = new Map<string, number>()
  for (const raw of rows as unknown[]) {
    const r = raw as Record<string, unknown>
    const id = String(r.group_id ?? '')
    if (id) m.set(id, num(r.v))
  }
  return m
}

/** 会员数按市场/门店归组（占比分母，bound_store_id；绑定门店唯一）。 */
async function queryMemberCountByGroup(
  session: AuthSession,
  scope: DataCenterScope,
  group: BreakdownGroup,
): Promise<Map<string, number>> {
  const skeleton = scopeStoreSkeletonSql(session, scope)
  const groupId = group === 'market' ? sql.raw('sk.market_id') : sql.raw('sk.store_id')
  const rows = await db.execute(sql`
    WITH skel AS (${skeleton})
    SELECT ${groupId} AS group_id, COUNT(*) AS v
    FROM client_wechat_users c
    JOIN skel sk ON sk.store_id = c.bound_store_id
    WHERE c.bound_store_id IS NOT NULL
      AND c.became_member_at IS NOT NULL
    GROUP BY ${groupId}
  `)
  const m = new Map<string, number>()
  for (const raw of rows as unknown[]) {
    const r = raw as Record<string, unknown>
    const id = String(r.group_id ?? '')
    if (id) m.set(id, num(r.v))
  }
  return m
}

/**
 * 体验/新增/复购人数 + 新增业绩 + 复购业绩，按市场/门店归组（单查，全套 CTE）。
 *
 * 门店行保留原有的全 scope 跨店 first_entry 合并规则；市场行在每个市场内合并
 * first_entry，并在市场内按顾客去重。这样同一顾客跨市场仍分别归属，跨同市场门店
 * 不会重复累计人数。
 */
async function queryCycleByGroup(
  session: AuthSession,
  scope: DataCenterScope,
  range: ResolvedRange,
  threshold: number,
  groupCol: SQL,
  filter: SQL,
  group: BreakdownGroup,
): Promise<Map<string, CycleAgg>> {
  const skeleton = scopeStoreSkeletonSql(session, scope)
  const groupId = group === 'market' ? sql.raw('sk.market_id') : sql.raw('sk.store_id')
  // 门店明细沿用全 scope 跨店首次达标；市场明细在市场内独立判定，跨市场分别归属。
  const entryGroupId = group === 'market' ? sql.raw('sk.market_id::text') : sql.raw("'all'")
  const rows = await db.execute(sql`
    WITH skel AS (${skeleton}),
    daily_agg AS (
      SELECT so.client_user_id,
             so.store_id,
             ${groupId} AS group_id,
             ${entryGroupId} AS entry_group_id,
             ${groupCol} AS grp,
             sipe.performance_date AS purchase_date,
             SUM(sipe.amount::numeric) AS day_received,
             BOOL_OR(sipe.amount::numeric > 0) AS has_purchase
      FROM sale_item_performance_events sipe
      JOIN sale_items si ON si.sale_item_id = sipe.sale_item_id
      JOIN sale_orders so ON so.sale_order_id = sipe.sale_order_id
      JOIN skel sk ON sk.store_id = so.store_id
      JOIN product_skus sku ON sku.sku_id = si.sku_id
      JOIN product_categories pc ON pc.category_id = sku.category_id
      WHERE so.sale_order_type IN ('销售单', '转换单')
        AND so.status = '已支付'
        AND so.client_user_id IS NOT NULL
        AND ${filter}
        AND sipe.performance_date <= ${range.end}
      GROUP BY so.client_user_id, so.store_id, ${groupId}, ${entryGroupId}, ${groupCol}, sipe.performance_date
    ),
    qualifying_days AS (
      SELECT client_user_id, store_id, group_id, entry_group_id, grp, purchase_date
      FROM daily_agg
      WHERE day_received >= ${threshold}
    ),
    first_entry AS (
      SELECT client_user_id, entry_group_id, grp, MIN(purchase_date) AS entry_date
      FROM qualifying_days
      GROUP BY client_user_id, entry_group_id, grp
    ),
    period_agg AS (
      SELECT client_user_id, store_id, group_id, entry_group_id, grp, purchase_date, day_received, has_purchase
      FROM daily_agg
      WHERE purchase_date BETWEEN ${range.start} AND ${range.end}
    ),
    xinzeng AS (
      SELECT client_user_id, entry_group_id, grp
      FROM first_entry
      WHERE entry_date BETWEEN ${range.start} AND ${range.end}
    ),
    fugou AS (
      SELECT DISTINCT q.client_user_id, q.entry_group_id, q.grp
      FROM qualifying_days q
      JOIN first_entry f
        ON f.client_user_id = q.client_user_id
       AND f.entry_group_id = q.entry_group_id
       AND f.grp = q.grp
      WHERE q.purchase_date BETWEEN ${range.start} AND ${range.end}
    ),
    tiyan AS (
      SELECT DISTINCT pa.client_user_id, pa.group_id, pa.entry_group_id, pa.grp
      FROM period_agg pa
      WHERE pa.has_purchase
        AND NOT EXISTS (
        SELECT 1 FROM first_entry f
        WHERE f.client_user_id = pa.client_user_id
          AND f.entry_group_id = pa.entry_group_id
          AND f.grp = pa.grp
      )
    ),
    -- 每组内人数 DISTINCT client；新增/复购业绩仍按该组的实际消费事件汇总。
    trial_group AS (
      SELECT t.group_id,
             COUNT(DISTINCT t.client_user_id) AS cnt
      FROM tiyan t
      GROUP BY t.group_id
    ),
    new_group AS (
      SELECT pa.group_id,
             COUNT(DISTINCT pa.client_user_id) AS cnt,
             COALESCE(SUM(pa.day_received), 0) AS revenue
      FROM period_agg pa
      JOIN xinzeng x
        ON x.client_user_id = pa.client_user_id
       AND x.entry_group_id = pa.entry_group_id
       AND x.grp = pa.grp
      GROUP BY pa.group_id
    ),
    repurchase_group AS (
      SELECT pa.group_id,
             COUNT(DISTINCT pa.client_user_id) AS cnt,
             COALESCE(SUM(pa.day_received), 0) AS revenue
      FROM period_agg pa
      JOIN fugou fg
        ON fg.client_user_id = pa.client_user_id
       AND fg.entry_group_id = pa.entry_group_id
       AND fg.grp = pa.grp
      GROUP BY pa.group_id
    ),
    -- 期内有消费的所有分组（并集），LEFT JOIN 各客群聚合避免 FULL OUTER 链路漏行
    group_ids AS (
      SELECT DISTINCT group_id FROM period_agg
    )
    SELECT
      s.group_id AS group_id,
      COALESCE(t.cnt, 0) AS trial_count,
      COALESCE(n.cnt, 0) AS new_count,
      COALESCE(n.revenue, 0) AS new_revenue,
      COALESCE(r.cnt, 0) AS repurchase_count,
      COALESCE(r.revenue, 0) AS repurchase_revenue
    FROM group_ids s
    LEFT JOIN trial_group t ON t.group_id = s.group_id
    LEFT JOIN new_group n ON n.group_id = s.group_id
    LEFT JOIN repurchase_group r ON r.group_id = s.group_id
  `)
  const m = new Map<string, CycleAgg>()
  for (const raw of rows as unknown[]) {
    const r = raw as Record<string, unknown>
    const id = String(r.group_id ?? '')
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
    repurchaseRate: safeDiv(agg.repurchaseCount, agg.cardHolders),
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
    // 复购率 = 复购人数 / 持卡人数（持卡为截面分母）
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

    const [
      cardByStore,
      memberByStore,
      cycleByStore,
      cardByMarket,
      memberByMarket,
      cycleByMarket,
    ] = await Promise.all([
      queryCardHoldersByGroup(session, scope, filter, 'store'),
      queryMemberCountByGroup(session, scope, 'store'),
      queryCycleByGroup(session, scope, cur, threshold, groupCol, filter, 'store'),
      queryCardHoldersByGroup(session, scope, filter, 'market'),
      queryMemberCountByGroup(session, scope, 'market'),
      queryCycleByGroup(session, scope, cur, threshold, groupCol, filter, 'market'),
    ])

    const toAgg = (id: string, cardMap: Map<string, number>, cycleMap: Map<string, CycleAgg>): ProductStoreAgg => {
      const cycle = cycleMap.get(id)
      return {
        cardHolders: cardMap.get(id) ?? 0,
        trialCount: cycle?.trialCount ?? 0,
        newCount: cycle?.newCount ?? 0,
        newRevenue: cycle?.newRevenue ?? 0,
        repurchaseCount: cycle?.repurchaseCount ?? 0,
        repurchaseRevenue: cycle?.repurchaseRevenue ?? 0,
      }
    }

    // 门店级聚合
    const storeAggs = skeleton.map((s) => {
      const agg = toAgg(s.storeId, cardByStore, cycleByStore)
      return { ...s, agg, memberCount: memberByStore.get(s.storeId) ?? 0 }
    })

    const byStore: BreakdownRow[] = storeAggs.map((s) => ({
      groupId: s.storeId,
      groupName: s.storeName,
      marketName: s.marketName,
      metrics: buildMetrics(s.agg, s.memberCount),
    }))

    // 市场人数直接由 SQL 按 market_id + 顾客去重，不能由门店行相加。
    const marketGroups = new Map<string, { name: string }>()
    for (const s of storeAggs) {
      if (!marketGroups.has(s.marketId)) marketGroups.set(s.marketId, { name: s.marketName })
    }

    const byMarket: BreakdownRow[] = Array.from(marketGroups.entries()).map(([id, market]) => ({
      groupId: id,
      groupName: market.name,
      metrics: buildMetrics(toAgg(id, cardByMarket, cycleByMarket), memberByMarket.get(id) ?? 0),
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
