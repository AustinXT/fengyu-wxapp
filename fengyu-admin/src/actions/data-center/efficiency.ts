'use server'

/**
 * 数据中心 — 人效板块 action（getEfficiencyBoard）
 *
 * 三段产出：
 *   1. kpis     —— 人均派生 KPI（人均业绩/实耗/收入/会员量/项目数 + 店长人均会员/员工数）
 *   2. byMarket —— 按市场人效明细（店长/技师人数 + 各项人均）
 *   3. storeRankings / staffRankings —— 门店榜 / 员工榜（Record<metric, RankingRow[]>）
 *
 * 口径权威：notes/references/metrics.md
 *   - §「员工排行榜归属」6 指标（业绩/实耗/客流/项目数/新会员/收入）
 *   - §「门店状况 / 人效」原始指标（会员数 / 员工数）
 *   - §「派生指标」人均 ×11（人均业绩/生美业绩/实耗/生美实耗/客流/客量/新客/项目数/提成收入 等）
 *
 * 移植源（照搬口径，禁止 import；CloudBase 纯 JS 原生 SQL → admin Drizzle raw SQL）：
 *   fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js
 *     - storeRanking: rankingRevenue / rankingConsume / rankingRetainedMember /
 *       rankingNewMember / rankingProjectCount（+ assignRanks 并列跳号 + timeWindowPeriod）
 *     - staffRanking: producerEmployeesCte + staffRankingRevenue/Consume/NewMember/
 *       ProjectCount/Income
 *     - summary: queryMemberCount / queryEmployeeCount（人均分母口径）
 *
 * ★★ 关键改造：排名榜跟随顶部时间维度
 *   staff 端 ranking 用 timeWindowPeriod(col, period)（固定 month/lastMonth/year 锚 NOW()）。
 *   本板块改吃 TimeRange 区间：所有 ranking 子查询的时间过滤改成
 *   `col::date BETWEEN ${cur.start} AND ${cur.end}`，跟随顶部 today/week/month/year/custom。
 *   其余口径（归属字段、role_type、is_void、assignRanks 并列跳号）原样移植。
 *   排名榜不算同比环比。
 *
 * ★ 口径红线（consistency.efficiency.test.ts 字面量守护，禁止偏离）：
 *   - 业绩(员工) = SUM(sale_allocations.total_amount) 归 employee_id ∩
 *     role_type IN ('美容师','养生师') ∩ is_void=FALSE ∩ 销售单/转换单 ∩ 已支付回款分配
 *   - 实耗(员工) = SUM(service_items.unit_real_price * session_used) 归 employee_id ∩ 已完成
 *   - 收入 = 销售提成 SUM(sale_allocations.commission_amount) + 服务提成 SUM(service_commissions.commission_amount)
 *   - 新会员 = became_member_at 归 bound_employee_id；项目数 sales_category IN ('自销自耗','他销自耗')
 *   - 产能员工 producer_employees：hired_at/resigned_at 历史化（2026-05-20 起不再用 skills 过滤，
 *     以 role_type 自然过滤 + 末尾 value>0 排除零值；与 mgmt-dashboard.js producerEmployeesCte 一致）
 *
 * ⚠️ 偏离 metrics.md 说明：
 *   - 「店长人数 managerCount」「技师人数 technicianCount」是本 admin 人效板块新增的 byMarket 头数指标，
 *     metrics.md 无对端定义，无 staff 对端 SQL。口径：
 *       店长人数 = 在营门店数（2026-05-26 用户拍板：每店一店长口径，按 stores 在营计数，不依赖 position_name；
 *         opening_date/closed_at 按区间末 cur.end 历史化，与 sales.ts storeCount 一致）。
 *         故 managerAvgX = 每店平均 X（m.income 本就是门店全部产能员工提成合计 → managerAvgIncome = 每店平均产能收入）。
 *       技师 = staff_wechat_users.skills && ARRAY['美容师','养生师']（= metrics.md employeeCount「产能技师在职数」），
 *         按区间末 hired_at/resigned_at 历史化。
 *   - 人均派生分母「员工数」= 技师（产能技师）口径，与 metrics.md §派生指标分母 employeeCount 对齐。
 *   - 「人均项目数 empAvgProjects / techAvgProjects」分子用 metrics.md 项目数口径
 *     （sales_category IN ('自销自耗','他销自耗')，非生美过滤）；任务描述「生美项目」措辞按 metrics.md 项目数对齐。
 *   - 分母（员工数 / 店长数）采用「区间末快照」历史化口径（与 sales.ts storeCount/employeeCount 一致），
 *     而非 metrics.md 的双口径 day/month（本板块只有单一 TimeRange，取区间末快照最自洽）。
 */

import { db } from '@/db'
import { sql } from 'drizzle-orm'
import { withPermission } from '@/lib/with-permission'
import type { AuthSession } from '@/lib/types'
import type {
  BoardParams,
  BreakdownRow,
  EfficiencyBoardResult,
  KpiCell,
  RankingRow,
} from '@/lib/data-center/types'
import { prepareBoardContext } from '@/lib/data-center/context'
import { scopeFilterSql, scopeStoreSkeletonSql } from '@/lib/data-center/scope-sql'
import { excludeDepositRefundSql } from '@/lib/data-center/consume-filter'

/** db.execute 返回数组，取首行标量并 Number 化（null→0，分母聚合无行时按 0 处理） */
function scalar(rows: unknown, key = 'v'): number {
  const r = (rows as Array<Record<string, unknown>>)[0]
  if (!r || r[key] == null) return 0
  const n = Number(r[key])
  return Number.isFinite(n) ? n : 0
}

/** 人均/店均派生：分子 / 分母；分母<=0 → null（前端 '--'） */
function ratio(num: number | null, den: number | null): number | null {
  if (num == null || den == null || den <= 0) return null
  return num / den
}

function paidAllocationDateBetween(
  paymentAlias: string,
  orderAlias: string,
  start: string,
  end: string,
) {
  return sql`(
    (${sql.raw(`${paymentAlias}.id`)} IS NOT NULL
      AND ${sql.raw(`${paymentAlias}.status`)} = '已支付'
      AND ${sql.raw(`${paymentAlias}.paid_at`)}::date BETWEEN ${start} AND ${end})
    OR
    (${sql.raw(`${paymentAlias}.id`)} IS NULL
      AND ${sql.raw(`${orderAlias}.status`)} = '已支付'
      AND ${sql.raw(`${orderAlias}.paid_at`)}::date BETWEEN ${start} AND ${end})
  )`
}

/** 行表 → store_id → value 映射 */
function toMap(rows: unknown): Map<string, number> {
  const m = new Map<string, number>()
  for (const r of rows as Array<Record<string, unknown>>) {
    m.set(String(r.store_id), Number(r.v ?? 0))
  }
  return m
}

/**
 * 同值并列 RANK 跳号语义（移植 staff assignRanks，标准 SQL RANK()）：
 * [200,100,50] → 1/2/3；[100,100,50] → 1/1/3。调用前 rows 必须已按 value DESC 排序。
 */
function assignRanks(rows: Array<Omit<RankingRow, 'rank'>>): RankingRow[] {
  let rank = 0
  let lastValue: number | null = null
  return rows.map((row, idx) => {
    if (row.value !== lastValue) {
      rank = idx + 1
      lastValue = row.value
    }
    return { ...row, rank }
  })
}

export const getEfficiencyBoard = withPermission(
  'data_center:dashboard',
  async (session: AuthSession, params: BoardParams): Promise<EfficiencyBoardResult> => {
    const ctx = await prepareBoardContext(session, params)
    const { scope } = ctx
    const cur = ctx.comparison.current

    // ═══════════════════════════════════════════════════════════════════
    //  Part A — 全局聚合标量（KPI 分子/分母用，单一区间，不算同比环比）
    // ═══════════════════════════════════════════════════════════════════

    /** 业绩（员工归属，全局合计）= SUM(sale_allocations.total_amount) */
    const qRevenueTotal = db.execute(sql`
      SELECT COALESCE(SUM(sa.total_amount::numeric), 0) AS v
      FROM sale_allocations sa
      JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
      JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
      LEFT JOIN sale_order_payments sop ON sop.id = sa.sale_payment_id
      WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
        AND sa.is_void = FALSE
        AND sa.role_type IN ('美容师', '养生师')
        AND so.sale_order_type IN ('销售单', '转换单')
        AND ${paidAllocationDateBetween('sop', 'so', cur.start, cur.end)}
    `)

    /** 实耗（员工归属，全局合计）= SUM(unit_real_price * session_used) ∩ 已完成 */
    const qConsumeTotal = db.execute(sql`
      SELECT COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS v
      FROM service_items sit
      JOIN service_orders so ON so.service_order_id = sit.service_order_id
      WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
        AND so.status = '已完成'
        AND so.service_date BETWEEN ${cur.start} AND ${cur.end}
        AND ${excludeDepositRefundSql('so')}
    `)

    /** 销售提成（全局合计）= SUM(sale_allocations.commission_amount) */
    const qSalesCommTotal = db.execute(sql`
      SELECT COALESCE(SUM(sa.commission_amount::numeric), 0) AS v
      FROM sale_allocations sa
      JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
      JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
      LEFT JOIN sale_order_payments sop ON sop.id = sa.sale_payment_id
      WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
        AND sa.is_void = FALSE
        AND so.sale_order_type IN ('销售单', '转换单')
        AND ${paidAllocationDateBetween('sop', 'so', cur.start, cur.end)}
    `)

    /** 服务提成（全局合计）= SUM(service_commissions.commission_amount) */
    const qServiceCommTotal = db.execute(sql`
      SELECT COALESCE(SUM(sc.commission_amount::numeric), 0) AS v
      FROM service_commissions sc
      JOIN service_items sit ON sit.service_item_id = sc.service_item_id
      JOIN service_orders so ON so.service_order_id = sit.service_order_id
      WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
        AND sc.is_void = FALSE
        AND so.status = '已完成'
        AND so.service_date BETWEEN ${cur.start} AND ${cur.end}
    `)

    /** 客流（全局，有效到店）= COUNT(DISTINCT client_user_id) ∩ 已完成 ∩ service_date */
    const qFootfallTotal = db.execute(sql`
      SELECT COUNT(DISTINCT so.client_user_id) AS v
      FROM service_orders so
      WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
        AND so.status = '已完成'
        AND so.client_user_id IS NOT NULL
        AND so.service_date BETWEEN ${cur.start} AND ${cur.end}
    `)

    /** 项目数（全局）= SUM(session_used) ∩ sales_category IN ('自销自耗','他销自耗') ∩ 已完成 */
    const qProjectCountTotal = db.execute(sql`
      SELECT COALESCE(SUM(sit.session_used), 0) AS v
      FROM service_orders so
      JOIN service_items sit ON sit.service_order_id = so.service_order_id
      WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
        AND so.status = '已完成'
        AND sit.sales_category IN ('自销自耗', '他销自耗')
        AND so.service_date BETWEEN ${cur.start} AND ${cur.end}
        AND ${excludeDepositRefundSql('so')}
    `)

    /**
     * 会员数（截面快照，按区间末历史化）= COUNT(became_member_at::date <= cur.end)
     * 对齐 metrics.md / staff queryMemberCount，scope by bound_store_id。
     */
    const qMemberCount = db.execute(sql`
      SELECT COUNT(*) AS v
      FROM client_wechat_users c
      WHERE ${scopeFilterSql(session, scope, 'c.bound_store_id')}
        AND c.became_member_at IS NOT NULL
        AND c.became_member_at::date <= ${cur.end}
    `)

    /**
     * 员工数 = 技师（产能技师，区间末历史化）：skills && ARRAY['美容师','养生师']
     *   ∩ hired_at <= 区间末 ∩ (resigned_at IS NULL OR resigned_at > 区间末)。
     * 对齐 metrics.md employeeCount（人均派生分母）。
     */
    const qTechnicianCount = db.execute(sql`
      SELECT COUNT(*)::int AS v
      FROM staff_wechat_users s
      WHERE ${scopeFilterSql(session, scope, 's.store_id')}
        AND s.skills && ARRAY['美容师','养生师']::text[]
        AND s.hired_at IS NOT NULL
        AND s.hired_at::date <= ${cur.end}
        AND (s.resigned_at IS NULL OR s.resigned_at::date > ${cur.end})
    `)

    /**
     * 店长数 = 在营门店数（2026-05-26 用户拍板：每店一店长口径，不再按 position_name 识别）。
     * 区间末历史化：opening_date <= 区间末 ∩ (closed_at IS NULL OR closed_at > 区间末)，与 sales.ts storeCount 一致。
     */
    const qManagerCount = db.execute(sql`
      SELECT COUNT(*)::int AS v
      FROM stores s
      JOIN org_nodes o ON s.org_node_id = o.id AND o.type = '门店'
      WHERE ${scopeFilterSql(session, scope, 's.store_id')}
        AND s.opening_date IS NOT NULL
        AND s.opening_date::date <= ${cur.end}
        AND (s.closed_at IS NULL OR s.closed_at::date > ${cur.end})
    `)

    // ═══════════════════════════════════════════════════════════════════
    //  Part B — 按门店分组聚合（byMarket 明细用，JS 内按 market 合并）
    // ═══════════════════════════════════════════════════════════════════

    const skeleton = scopeStoreSkeletonSql(session, scope)

    const qStoreSkeleton = db.execute(skeleton)

    /** 店长数 by store = 每个在营门店恒为 1（每店一店长口径，2026-05-26 用户拍板） */
    const qManagerByStore = db.execute(sql`
      SELECT s.store_id, 1::int AS v
      FROM stores s
      JOIN org_nodes o ON s.org_node_id = o.id AND o.type = '门店'
      WHERE ${scopeFilterSql(session, scope, 's.store_id')}
        AND s.opening_date IS NOT NULL
        AND s.opening_date::date <= ${cur.end}
        AND (s.closed_at IS NULL OR s.closed_at::date > ${cur.end})
    `)

    /** 技师数 by store */
    const qTechByStore = db.execute(sql`
      SELECT s.store_id, COUNT(*)::int AS v
      FROM staff_wechat_users s
      WHERE ${scopeFilterSql(session, scope, 's.store_id')}
        AND s.skills && ARRAY['美容师','养生师']::text[]
        AND s.hired_at IS NOT NULL
        AND s.hired_at::date <= ${cur.end}
        AND (s.resigned_at IS NULL OR s.resigned_at::date > ${cur.end})
      GROUP BY s.store_id
    `)

    /** 业绩 by store（员工归属 total_amount） */
    const qRevenueByStore = db.execute(sql`
      SELECT so.store_id, COALESCE(SUM(sa.total_amount::numeric), 0) AS v
      FROM sale_allocations sa
      JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
      JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
      LEFT JOIN sale_order_payments sop ON sop.id = sa.sale_payment_id
      WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
        AND sa.is_void = FALSE
        AND sa.role_type IN ('美容师', '养生师')
        AND so.sale_order_type IN ('销售单', '转换单')
        AND ${paidAllocationDateBetween('sop', 'so', cur.start, cur.end)}
      GROUP BY so.store_id
    `)

    /** 实耗 by store */
    const qConsumeByStore = db.execute(sql`
      SELECT so.store_id, COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS v
      FROM service_items sit
      JOIN service_orders so ON so.service_order_id = sit.service_order_id
      WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
        AND so.status = '已完成'
        AND so.service_date BETWEEN ${cur.start} AND ${cur.end}
        AND ${excludeDepositRefundSql('so')}
      GROUP BY so.store_id
    `)

    /** 生美实耗 by store */
    const qShengmeiConsumeByStore = db.execute(sql`
      SELECT so.store_id, COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS v
      FROM service_items sit
      JOIN service_orders so ON so.service_order_id = sit.service_order_id
      WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
        AND so.status = '已完成'
        AND sit.is_shengmei = TRUE
        AND so.service_date BETWEEN ${cur.start} AND ${cur.end}
        AND ${excludeDepositRefundSql('so')}
      GROUP BY so.store_id
    `)

    /** 销售提成 by store */
    const qSalesCommByStore = db.execute(sql`
      SELECT so.store_id, COALESCE(SUM(sa.commission_amount::numeric), 0) AS v
      FROM sale_allocations sa
      JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
      JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
      LEFT JOIN sale_order_payments sop ON sop.id = sa.sale_payment_id
      WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
        AND sa.is_void = FALSE
        AND so.sale_order_type IN ('销售单', '转换单')
        AND ${paidAllocationDateBetween('sop', 'so', cur.start, cur.end)}
      GROUP BY so.store_id
    `)

    /** 服务提成 by store */
    const qServiceCommByStore = db.execute(sql`
      SELECT so.store_id, COALESCE(SUM(sc.commission_amount::numeric), 0) AS v
      FROM service_commissions sc
      JOIN service_items sit ON sit.service_item_id = sc.service_item_id
      JOIN service_orders so ON so.service_order_id = sit.service_order_id
      WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
        AND sc.is_void = FALSE
        AND so.status = '已完成'
        AND so.service_date BETWEEN ${cur.start} AND ${cur.end}
      GROUP BY so.store_id
    `)

    /** 客流 by store */
    const qFootfallByStore = db.execute(sql`
      SELECT so.store_id, COUNT(DISTINCT so.client_user_id) AS v
      FROM service_orders so
      WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
        AND so.status = '已完成'
        AND so.client_user_id IS NOT NULL
        AND so.service_date BETWEEN ${cur.start} AND ${cur.end}
      GROUP BY so.store_id
    `)

    /** 项目数 by store */
    const qProjectByStore = db.execute(sql`
      SELECT so.store_id, COALESCE(SUM(sit.session_used), 0) AS v
      FROM service_orders so
      JOIN service_items sit ON sit.service_order_id = so.service_order_id
      WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
        AND so.status = '已完成'
        AND sit.sales_category IN ('自销自耗', '他销自耗')
        AND so.service_date BETWEEN ${cur.start} AND ${cur.end}
        AND ${excludeDepositRefundSql('so')}
      GROUP BY so.store_id
    `)

    // ═══════════════════════════════════════════════════════════════════
    //  Part C — 门店排名榜（5 metric，TimeRange 区间 + assignRanks）
    // ═══════════════════════════════════════════════════════════════════
    // 移植 staff storeRanking：stores JOIN org_nodes 拿市场名，LEFT JOIN 业务表（含零业绩门店）。
    // 时间过滤改 BETWEEN cur.start/end（关键改造，替代 timeWindowPeriod）。
    // scope 过滤复用 scopeFilterSql 命中 s.store_id（市场/门店/admin）。

    const qStoreRankRevenue = db.execute(sql`
      SELECT s.store_id, s.store_name, o.name AS market_name,
        COALESCE(SUM(so.received::numeric - COALESCE(so.refunded_amount, 0)::numeric), 0) AS value
      FROM stores s
      JOIN org_nodes o_store ON s.org_node_id = o_store.id
      JOIN org_nodes o ON o_store.parent_id = o.id
      LEFT JOIN sale_orders so
        ON so.store_id = s.store_id
        AND so.sale_order_type IN ('销售单', '转换单')
        AND so.status = '已支付'
        AND so.legacy_source IS DISTINCT FROM 'workfine'
        AND so.paid_at::date BETWEEN ${cur.start} AND ${cur.end}
      WHERE ${scopeFilterSql(session, scope, 's.store_id')}
      GROUP BY s.store_id, s.store_name, o.name
      ORDER BY value DESC, s.store_name ASC
    `)

    const qStoreRankConsume = db.execute(sql`
      SELECT s.store_id, s.store_name, o.name AS market_name,
        COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS value
      FROM stores s
      JOIN org_nodes o_store ON s.org_node_id = o_store.id
      JOIN org_nodes o ON o_store.parent_id = o.id
      LEFT JOIN service_orders so2
        ON so2.store_id = s.store_id
        AND so2.status = '已完成'
        AND so2.service_date BETWEEN ${cur.start} AND ${cur.end}
        AND ${excludeDepositRefundSql('so2')}
      LEFT JOIN service_items sit ON sit.service_order_id = so2.service_order_id
      WHERE ${scopeFilterSql(session, scope, 's.store_id')}
      GROUP BY s.store_id, s.store_name, o.name
      ORDER BY value DESC, s.store_name ASC
    `)

    const qStoreRankRetainedMember = db.execute(sql`
      SELECT s.store_id, s.store_name, o.name AS market_name,
        COUNT(DISTINCT c.user_id) AS value
      FROM stores s
      JOIN org_nodes o_store ON s.org_node_id = o_store.id
      JOIN org_nodes o ON o_store.parent_id = o.id
      LEFT JOIN client_wechat_users c
        ON c.bound_store_id = s.store_id
        AND c.became_member_at IS NOT NULL
        AND c.became_member_at::date <= ${cur.end}
        AND EXISTS (
          SELECT 1 FROM service_orders so
          WHERE so.client_user_id = c.user_id
            AND so.status = '已完成'
            AND so.service_date BETWEEN (${cur.end}::date - INTERVAL '90 days') AND ${cur.end}
        )
      WHERE ${scopeFilterSql(session, scope, 's.store_id')}
      GROUP BY s.store_id, s.store_name, o.name
      ORDER BY value DESC, s.store_name ASC
    `)

    const qStoreRankNewMember = db.execute(sql`
      SELECT s.store_id, s.store_name, o.name AS market_name,
        COUNT(c.user_id) AS value
      FROM stores s
      JOIN org_nodes o_store ON s.org_node_id = o_store.id
      JOIN org_nodes o ON o_store.parent_id = o.id
      LEFT JOIN client_wechat_users c
        ON c.bound_store_id = s.store_id
        AND c.became_member_at IS NOT NULL
        AND c.became_member_at::date BETWEEN ${cur.start} AND ${cur.end}
      WHERE ${scopeFilterSql(session, scope, 's.store_id')}
      GROUP BY s.store_id, s.store_name, o.name
      ORDER BY value DESC, s.store_name ASC
    `)

    const qStoreRankProjectCount = db.execute(sql`
      SELECT s.store_id, s.store_name, o.name AS market_name,
        COALESCE(SUM(sit.session_used), 0) AS value
      FROM stores s
      JOIN org_nodes o_store ON s.org_node_id = o_store.id
      JOIN org_nodes o ON o_store.parent_id = o.id
      LEFT JOIN service_orders so2
        ON so2.store_id = s.store_id
        AND so2.status = '已完成'
        AND so2.service_date BETWEEN ${cur.start} AND ${cur.end}
        AND ${excludeDepositRefundSql('so2')}
      LEFT JOIN service_items sit
        ON sit.service_order_id = so2.service_order_id
        AND sit.sales_category IN ('自销自耗', '他销自耗')
      WHERE ${scopeFilterSql(session, scope, 's.store_id')}
      GROUP BY s.store_id, s.store_name, o.name
      ORDER BY value DESC, s.store_name ASC
    `)

    // ═══════════════════════════════════════════════════════════════════
    //  Part D — 员工排名榜（5 metric，producer_employees CTE + TimeRange 区间）
    // ═══════════════════════════════════════════════════════════════════
    // 移植 staff staffRanking：producer_employees（hired_at/resigned_at 历史化，无 skills 过滤）
    // LEFT JOIN 各 metric 子查询；末尾 WHERE value > 0 排除零值员工。
    // 时间过滤改 BETWEEN cur.start/end（关键改造）。
    // 产能员工锚点：staff 用 NOW()，本板块用区间末 cur.end（与人均分母历史化口径一致）。
    // scope 命中 sw.store_id。

    /**
     * producer_employees CTE 头部（与 staff producerEmployeesCte 同构，锚点改 cur.end）。
     * 额外 JOIN org_nodes 拿员工所属市场名（RankingRow.marketName 用，员工榜「所属市场」列）。
     */
    const producerCte = sql`
      WITH producer_employees AS (
        SELECT sw.employee_id, sw.name AS employee_name, sw.store_id, s.store_name,
               sw.position_name, o_mkt.name AS market_name
        FROM staff_wechat_users sw
        LEFT JOIN stores s ON s.store_id = sw.store_id
        LEFT JOIN org_nodes o_store ON s.org_node_id = o_store.id AND o_store.type = '门店'
        LEFT JOIN org_nodes o_mkt ON o_store.parent_id = o_mkt.id
        WHERE sw.hired_at IS NOT NULL
          AND sw.hired_at::date <= ${cur.end}
          AND (sw.resigned_at IS NULL OR sw.resigned_at::date > ${cur.end})
          AND ${scopeFilterSql(session, scope, 'sw.store_id')}
      )
    `

    const qStaffRankRevenue = db.execute(sql`
      ${producerCte},
      revenue_by_emp AS (
        SELECT sa.employee_id, COALESCE(SUM(sa.total_amount::numeric), 0) AS v
        FROM sale_allocations sa
        JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
        JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
        LEFT JOIN sale_order_payments sop ON sop.id = sa.sale_payment_id
        WHERE sa.is_void = FALSE
          AND sa.role_type IN ('美容师', '养生师')
          AND so.sale_order_type IN ('销售单', '转换单')
          AND ${paidAllocationDateBetween('sop', 'so', cur.start, cur.end)}
        GROUP BY sa.employee_id
      )
      SELECT pe.employee_id, pe.employee_name, pe.store_id, pe.store_name, pe.market_name,
        COALESCE(r.v, 0)::numeric AS value
      FROM producer_employees pe
      LEFT JOIN revenue_by_emp r ON r.employee_id = pe.employee_id
      WHERE COALESCE(r.v, 0) > 0
      ORDER BY value DESC, pe.employee_name ASC, pe.employee_id ASC
    `)

    const qStaffRankConsume = db.execute(sql`
      ${producerCte},
      consume_by_emp AS (
        SELECT sit.employee_id, COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS v
        FROM service_items sit
        JOIN service_orders so2 ON so2.service_order_id = sit.service_order_id
        WHERE so2.status = '已完成'
          AND so2.service_date BETWEEN ${cur.start} AND ${cur.end}
          AND ${excludeDepositRefundSql('so2')}
        GROUP BY sit.employee_id
      )
      SELECT pe.employee_id, pe.employee_name, pe.store_id, pe.store_name, pe.market_name,
        COALESCE(c.v, 0)::numeric AS value
      FROM producer_employees pe
      LEFT JOIN consume_by_emp c ON c.employee_id = pe.employee_id
      WHERE COALESCE(c.v, 0) > 0
      ORDER BY value DESC, pe.employee_name ASC, pe.employee_id ASC
    `)

    const qStaffRankNewMember = db.execute(sql`
      ${producerCte},
      new_member_by_emp AS (
        SELECT c.bound_employee_id AS employee_id, COUNT(*) AS v
        FROM client_wechat_users c
        WHERE c.bound_employee_id IS NOT NULL
          AND c.became_member_at IS NOT NULL
          AND c.became_member_at::date BETWEEN ${cur.start} AND ${cur.end}
        GROUP BY c.bound_employee_id
      )
      SELECT pe.employee_id, pe.employee_name, pe.store_id, pe.store_name, pe.market_name,
        COALESCE(n.v, 0)::numeric AS value
      FROM producer_employees pe
      LEFT JOIN new_member_by_emp n ON n.employee_id = pe.employee_id
      WHERE COALESCE(n.v, 0) > 0
      ORDER BY value DESC, pe.employee_name ASC, pe.employee_id ASC
    `)

    const qStaffRankProjectCount = db.execute(sql`
      ${producerCte},
      project_by_emp AS (
        SELECT sit.employee_id, COALESCE(SUM(sit.session_used), 0) AS v
        FROM service_items sit
        JOIN service_orders so2 ON so2.service_order_id = sit.service_order_id
        WHERE so2.status = '已完成'
          AND sit.sales_category IN ('自销自耗', '他销自耗')
          AND so2.service_date BETWEEN ${cur.start} AND ${cur.end}
          AND ${excludeDepositRefundSql('so2')}
        GROUP BY sit.employee_id
      )
      SELECT pe.employee_id, pe.employee_name, pe.store_id, pe.store_name, pe.market_name,
        COALESCE(p.v, 0)::numeric AS value
      FROM producer_employees pe
      LEFT JOIN project_by_emp p ON p.employee_id = pe.employee_id
      WHERE COALESCE(p.v, 0) > 0
      ORDER BY value DESC, pe.employee_name ASC, pe.employee_id ASC
    `)

    const qStaffRankIncome = db.execute(sql`
      ${producerCte},
      sales_comm AS (
        SELECT sa.employee_id, COALESCE(SUM(sa.commission_amount::numeric), 0) AS v
        FROM sale_allocations sa
        JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
        JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
        LEFT JOIN sale_order_payments sop ON sop.id = sa.sale_payment_id
        WHERE sa.is_void = FALSE
          AND so.sale_order_type IN ('销售单', '转换单')
          AND ${paidAllocationDateBetween('sop', 'so', cur.start, cur.end)}
        GROUP BY sa.employee_id
      ),
      service_comm AS (
        SELECT sc.employee_id, COALESCE(SUM(sc.commission_amount::numeric), 0) AS v
        FROM service_commissions sc
        JOIN service_items sit ON sit.service_item_id = sc.service_item_id
        JOIN service_orders so2 ON so2.service_order_id = sit.service_order_id
        WHERE sc.is_void = FALSE
          AND so2.status = '已完成'
          AND so2.service_date BETWEEN ${cur.start} AND ${cur.end}
        GROUP BY sc.employee_id
      )
      SELECT pe.employee_id, pe.employee_name, pe.store_id, pe.store_name, pe.market_name,
        (COALESCE(sc1.v, 0) + COALESCE(sc2.v, 0))::numeric AS value
      FROM producer_employees pe
      LEFT JOIN sales_comm sc1 ON sc1.employee_id = pe.employee_id
      LEFT JOIN service_comm sc2 ON sc2.employee_id = pe.employee_id
      WHERE COALESCE(sc1.v, 0) + COALESCE(sc2.v, 0) > 0
      ORDER BY value DESC, pe.employee_name ASC, pe.employee_id ASC
    `)

    // ═══════════════════════════════════════════════════════════════════
    //  Part E — 按技师人效明细（员工粒度，单查询多 CTE，列出全部产能员工）
    // ═══════════════════════════════════════════════════════════════════
    // 复用 producer_employees（hired_at/resigned_at 历史化）。销售额/实耗各按
    // sales_category 四枚举值 FILTER 摊平成 4 列；byStaff 装配处：销售额按 4 枚举值
    // 原样展示（之和=当月业绩），实耗 4 列求和为单列「实耗合计」。
    // ⚠️ 员工维度口径：实耗不做 sales_category 排除（metrics.md「他销他耗/生态合作不
    //    计本店实耗」是门店口径，技师实际服务即计入其个人实耗）。
    //    项目数沿用员工榜口径（仅自销自耗+他销自耗，受一致性测试守护）。
    // 销售额 4 列之和 = 当月业绩 revenue（同一 sale_allocations 口径，仅拆分维度不同）。
    const qStaffDetail = db.execute(sql`
      ${producerCte},
      revenue_by_emp_cat AS (
        SELECT sa.employee_id,
          COALESCE(SUM(sa.total_amount::numeric), 0) AS total,
          COALESCE(SUM(sa.total_amount::numeric) FILTER (WHERE si.sales_category = '自销自耗'), 0) AS sale_zxzh,
          COALESCE(SUM(sa.total_amount::numeric) FILTER (WHERE si.sales_category = '他销自耗'), 0) AS sale_txzh,
          COALESCE(SUM(sa.total_amount::numeric) FILTER (WHERE si.sales_category = '他销他耗'), 0) AS sale_txth,
          COALESCE(SUM(sa.total_amount::numeric) FILTER (WHERE si.sales_category = '生态合作'), 0) AS sale_eco
        FROM sale_allocations sa
        JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
        JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
        LEFT JOIN sale_order_payments sop ON sop.id = sa.sale_payment_id
        WHERE sa.is_void = FALSE
          AND sa.role_type IN ('美容师', '养生师')
          AND so.sale_order_type IN ('销售单', '转换单')
          AND ${paidAllocationDateBetween('sop', 'so', cur.start, cur.end)}
        GROUP BY sa.employee_id
      ),
      consume_by_emp_cat AS (
        SELECT sit.employee_id,
          COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used) FILTER (WHERE sit.sales_category = '自销自耗'), 0) AS consume_zxzh,
          COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used) FILTER (WHERE sit.sales_category = '他销自耗'), 0) AS consume_txzh,
          COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used) FILTER (WHERE sit.sales_category = '他销他耗'), 0) AS consume_txth,
          COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used) FILTER (WHERE sit.sales_category = '生态合作'), 0) AS consume_eco
        FROM service_items sit
        JOIN service_orders so2 ON so2.service_order_id = sit.service_order_id
        WHERE so2.status = '已完成'
          AND so2.service_date BETWEEN ${cur.start} AND ${cur.end}
          AND ${excludeDepositRefundSql('so2')}
        GROUP BY sit.employee_id
      ),
      new_member_by_emp AS (
        SELECT c.bound_employee_id AS employee_id, COUNT(*) AS v
        FROM client_wechat_users c
        WHERE c.bound_employee_id IS NOT NULL
          AND c.became_member_at IS NOT NULL
          AND c.became_member_at::date BETWEEN ${cur.start} AND ${cur.end}
        GROUP BY c.bound_employee_id
      ),
      project_by_emp AS (
        SELECT sit.employee_id, COALESCE(SUM(sit.session_used), 0) AS v
        FROM service_items sit
        JOIN service_orders so2 ON so2.service_order_id = sit.service_order_id
        WHERE so2.status = '已完成'
          AND sit.sales_category IN ('自销自耗', '他销自耗')
          AND so2.service_date BETWEEN ${cur.start} AND ${cur.end}
          AND ${excludeDepositRefundSql('so2')}
        GROUP BY sit.employee_id
      ),
      service_count_by_emp AS (
        SELECT sit.employee_id,
          COUNT(DISTINCT so2.client_user_id) AS headcount,
          COUNT(DISTINCT sit.service_order_id) AS visits
        FROM service_items sit
        JOIN service_orders so2 ON so2.service_order_id = sit.service_order_id
        WHERE so2.status = '已完成'
          AND so2.service_date BETWEEN ${cur.start} AND ${cur.end}
        GROUP BY sit.employee_id
      )
      SELECT pe.employee_id, pe.employee_name, pe.store_name, pe.position_name, pe.market_name,
        COALESCE(r.total, 0)::numeric AS revenue,
        COALESCE(r.sale_zxzh, 0)::numeric AS sale_zxzh,
        COALESCE(r.sale_txzh, 0)::numeric AS sale_txzh,
        COALESCE(r.sale_txth, 0)::numeric AS sale_txth,
        COALESCE(r.sale_eco, 0)::numeric AS sale_eco,
        COALESCE(c.consume_zxzh, 0)::numeric AS consume_zxzh,
        COALESCE(c.consume_txzh, 0)::numeric AS consume_txzh,
        COALESCE(c.consume_txth, 0)::numeric AS consume_txth,
        COALESCE(c.consume_eco, 0)::numeric AS consume_eco,
        COALESCE(nm.v, 0)::int AS new_member,
        COALESCE(p.v, 0)::int AS project_count,
        COALESCE(scnt.headcount, 0)::int AS service_headcount,
        COALESCE(scnt.visits, 0)::int AS service_visits
      FROM producer_employees pe
      LEFT JOIN revenue_by_emp_cat r ON r.employee_id = pe.employee_id
      LEFT JOIN consume_by_emp_cat c ON c.employee_id = pe.employee_id
      LEFT JOIN new_member_by_emp nm ON nm.employee_id = pe.employee_id
      LEFT JOIN project_by_emp p ON p.employee_id = pe.employee_id
      LEFT JOIN service_count_by_emp scnt ON scnt.employee_id = pe.employee_id
      ORDER BY revenue DESC, pe.employee_name ASC, pe.employee_id ASC
    `)

    // ── 并行执行全部查询 ──────────────────────────────────────────────
    const [
      // Part A
      revenueTotalR, consumeTotalR, salesCommTotalR, serviceCommTotalR,
      footfallTotalR, projectCountTotalR, memberCountR, technicianCountR, managerCountR,
      // Part B
      skelRows, managerByStoreR, techByStoreR, revenueByStoreR, consumeByStoreR,
      shengmeiConsumeByStoreR, salesCommByStoreR, serviceCommByStoreR,
      footfallByStoreR, projectByStoreR,
      // Part C
      storeRankRevenueR, storeRankConsumeR, storeRankRetainedR, storeRankNewMemberR, storeRankProjectR,
      // Part D
      staffRankRevenueR, staffRankConsumeR, staffRankNewMemberR, staffRankProjectR, staffRankIncomeR,
      // Part E
      staffDetailR,
    ] = await Promise.all([
      qRevenueTotal, qConsumeTotal, qSalesCommTotal, qServiceCommTotal,
      qFootfallTotal, qProjectCountTotal, qMemberCount, qTechnicianCount, qManagerCount,
      qStoreSkeleton, qManagerByStore, qTechByStore, qRevenueByStore, qConsumeByStore,
      qShengmeiConsumeByStore, qSalesCommByStore, qServiceCommByStore,
      qFootfallByStore, qProjectByStore,
      qStoreRankRevenue, qStoreRankConsume, qStoreRankRetainedMember, qStoreRankNewMember, qStoreRankProjectCount,
      qStaffRankRevenue, qStaffRankConsume, qStaffRankNewMember, qStaffRankProjectCount, qStaffRankIncome,
      qStaffDetail,
    ])

    // ── KPI 装配（人均派生，分母为 0 → null）───────────────────────────
    const revenueTotal = scalar(revenueTotalR)
    const consumeTotal = scalar(consumeTotalR)
    const incomeTotal = scalar(salesCommTotalR) + scalar(serviceCommTotalR)
    const footfallTotal = scalar(footfallTotalR)
    const projectCountTotal = scalar(projectCountTotalR)
    const memberCount = scalar(memberCountR)
    const technicianCount = scalar(technicianCountR)
    const managerCount = scalar(managerCountR)

    const mk = (value: number | null, unit: 'amount' | 'count'): KpiCell => ({ value, unit })

    const kpis: Record<string, KpiCell> = {
      managerAvgMembers: mk(ratio(memberCount, managerCount), 'count'),
      managerAvgEmployees: mk(ratio(technicianCount, managerCount), 'count'),
      empAvgRevenue: mk(ratio(revenueTotal, technicianCount), 'amount'),
      empAvgConsume: mk(ratio(consumeTotal, technicianCount), 'amount'),
      empAvgIncome: mk(ratio(incomeTotal, technicianCount), 'amount'),
      empAvgMembers: mk(ratio(footfallTotal, technicianCount), 'count'),
      empAvgProjects: mk(ratio(projectCountTotal, technicianCount), 'count'),
    }

    // ── byMarket 装配（按门店聚合到市场，再算各项人均）──────────────────
    const managerMap = toMap(managerByStoreR)
    const techMap = toMap(techByStoreR)
    const revMap = toMap(revenueByStoreR)
    const consMap = toMap(consumeByStoreR)
    const shengmeiConsMap = toMap(shengmeiConsumeByStoreR)
    const salesCommMap = toMap(salesCommByStoreR)
    const serviceCommMap = toMap(serviceCommByStoreR)
    const footfallMap = toMap(footfallByStoreR)
    const projectMap = toMap(projectByStoreR)

    type MarketAgg = {
      marketId: string
      marketName: string
      managerCount: number
      technicianCount: number
      revenue: number
      consume: number
      shengmeiConsume: number
      income: number
      footfall: number
      projectCount: number
    }
    const marketMap = new Map<string, MarketAgg>()
    for (const r of skelRows as Array<Record<string, unknown>>) {
      const storeId = String(r.store_id)
      const marketId = String(r.market_id ?? '')
      let m = marketMap.get(marketId)
      if (!m) {
        m = {
          marketId,
          marketName: String(r.market_name ?? ''),
          managerCount: 0,
          technicianCount: 0,
          revenue: 0,
          consume: 0,
          shengmeiConsume: 0,
          income: 0,
          footfall: 0,
          projectCount: 0,
        }
        marketMap.set(marketId, m)
      }
      m.managerCount += managerMap.get(storeId) ?? 0
      m.technicianCount += techMap.get(storeId) ?? 0
      m.revenue += revMap.get(storeId) ?? 0
      m.consume += consMap.get(storeId) ?? 0
      m.shengmeiConsume += shengmeiConsMap.get(storeId) ?? 0
      m.income += (salesCommMap.get(storeId) ?? 0) + (serviceCommMap.get(storeId) ?? 0)
      m.footfall += footfallMap.get(storeId) ?? 0
      m.projectCount += projectMap.get(storeId) ?? 0
    }

    const byMarket: BreakdownRow[] = Array.from(marketMap.values()).map((m) => ({
      groupId: m.marketId,
      groupName: m.marketName,
      metrics: {
        managerCount: m.managerCount,
        managerAvgIncome: ratio(m.income, m.managerCount),
        technicianCount: m.technicianCount,
        techAvgRevenue: ratio(m.revenue, m.technicianCount),
        techAvgConsume: ratio(m.consume, m.technicianCount),
        techAvgShengmeiConsume: ratio(m.shengmeiConsume, m.technicianCount),
        techAvgIncome: ratio(m.income, m.technicianCount),
        techAvgMembers: ratio(m.footfall, m.technicianCount),
        techAvgProjects: ratio(m.projectCount, m.technicianCount),
      },
    }))

    // ── 排名榜装配（assignRanks 并列跳号）──────────────────────────────
    const mapStoreRank = (rows: unknown): RankingRow[] =>
      assignRanks(
        (rows as Array<Record<string, unknown>>).map((r) => ({
          id: String(r.store_id),
          name: String(r.store_name ?? ''),
          marketName: r.market_name == null ? undefined : String(r.market_name),
          value: Number(r.value ?? 0),
        })),
      )

    const mapStaffRank = (rows: unknown): RankingRow[] =>
      assignRanks(
        (rows as Array<Record<string, unknown>>).map((r) => ({
          id: String(r.employee_id),
          name: String(r.employee_name ?? ''),
          marketName: r.market_name == null ? undefined : String(r.market_name),
          value: Number(r.value ?? 0),
        })),
      )

    const storeRankings: Record<string, RankingRow[]> = {
      revenue: mapStoreRank(storeRankRevenueR),
      consume: mapStoreRank(storeRankConsumeR),
      retainedMember: mapStoreRank(storeRankRetainedR),
      newMember: mapStoreRank(storeRankNewMemberR),
      projectCount: mapStoreRank(storeRankProjectR),
    }

    const staffRankings: Record<string, RankingRow[]> = {
      revenue: mapStaffRank(staffRankRevenueR),
      consume: mapStaffRank(staffRankConsumeR),
      newMember: mapStaffRank(staffRankNewMemberR),
      projectCount: mapStaffRank(staffRankProjectR),
      income: mapStaffRank(staffRankIncomeR),
    }

    // ── byStaff 装配（按技师人效明细，labels 带门店/职级）─────────────────
    const byStaff: BreakdownRow[] = (staffDetailR as Array<Record<string, unknown>>).map((r) => ({
      groupId: String(r.employee_id),
      groupName: String(r.employee_name ?? ''),
      marketName: r.market_name == null ? undefined : String(r.market_name),
      labels: {
        store: r.store_name == null ? '' : String(r.store_name),
        position: r.position_name == null ? '' : String(r.position_name),
      },
      // 销/耗各 4 枚举值在 SQL 已算好。销售额按 salesCategoryEnum 4 枚举值原样展示
      // （4 列之和 = 当月业绩 revenue），实耗合并为单列「实耗合计」（员工维度全口径，
      // 含他销他耗/生态合作；现实数据几乎只有「自销自耗·耗」非零，拆 4 列意义不大）。
      metrics: {
        revenue: Number(r.revenue ?? 0),
        saleZxzh: Number(r.sale_zxzh ?? 0), // 自销自耗(销售额)
        saleTxzh: Number(r.sale_txzh ?? 0), // 他销自耗
        saleTxth: Number(r.sale_txth ?? 0), // 他销他耗
        saleEco: Number(r.sale_eco ?? 0), // 生态合作
        consumeTotal: // 实耗合计 = 4 枚举值实耗之和
          Number(r.consume_zxzh ?? 0) + Number(r.consume_txzh ?? 0) +
          Number(r.consume_txth ?? 0) + Number(r.consume_eco ?? 0),
        newMember: Number(r.new_member ?? 0),
        projectCount: Number(r.project_count ?? 0),
        serviceHeadcount: Number(r.service_headcount ?? 0),
        serviceVisits: Number(r.service_visits ?? 0),
      },
    }))

    return {
      ...ctx.meta,
      kpis,
      byMarket,
      byStaff,
      storeRankings,
      staffRankings,
    }
  },
)
