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
 *   其余口径（归属字段、is_void、assignRanks 并列跳号）原样移植。
 *   排名榜不算同比环比。
 *
 * ★ 口径红线（consistency.efficiency.test.ts 字面量守护，禁止偏离）：
 *   - 业绩**有两套口径，按聚合粒度分**（2026-09-23 #285 修正，别再混用）：
 *       · Part A/B 全局大卡 + by store（喂 empAvgRevenue / byMarket.techAvgRevenue）
 *         = SUM(sale_order_performance_events.amount) ∩ 已支付 ∩ 首次支付/回款/退款 ∩
 *           销售单/转换单/**充值单** ∩ `legacy_source IS DISTINCT FROM 'workfine'` ∩ performance_date 区间。
 *           ⚠️ 该列生产全表 NULL，**必须用 IS DISTINCT FROM**；写成 `<> 'workfine'` 走三值逻辑
 *           会把每一行都判成 NULL，结果恒为 0.00。
 *         与 Part C 门店排名榜 / sales.ts runStoreRevenue / staff queryStoreRevenue 同源。
 *       · Part D/E 员工榜 + 按技师人效明细
 *         = SUM(sale_payment_item_allocations.allocated_amount) 归 employee_id ∩
 *           is_void=FALSE ∩ 销售单/转换单 ∩ 已支付回款分配；不按 role_type 白名单截断。
 *     ⚠️ `allocated_amount` 是**角色归属额**，只在 GROUP BY employee_id 时才是钱。
 *     2026-07-27 `23405ddf` 换表时把 Part A/B 一并留在了 allocation 口径（并把守护断言
 *     反向钉死），导致 KPI 与同页门店榜差 111 万、虚高 32.3%，直到 #285 才纠正。
 *     恢复 role_type 白名单**不是**修法（实测仍差 −4.45%，只是偶然的部分去重）。
 *   - 实耗(员工) = SUM(unit_real_price * session_used * service_commissions.allocation_ratio)
 *     归 service_commissions.employee_id ∩ is_void=FALSE ∩ 已完成（2026-09-03 改，见下「员工归属口径」）
 *   - 收入 = 销售提成 SUM(sale_payment_item_allocations.commission_amount) + 服务提成 SUM(service_commissions.commission_amount)
 *   - 新会员 = became_member_at 归 bound_employee_id；项目数 sales_category IN ('自销自耗','他销自耗')
 *
 * ★ 员工归属口径（2026-09-03 变更，两端镜像 staff mgmt-dashboard.js）
 *   实耗 / 项目数 / 客量人次 的员工归属从 service_items.employee_id 改为 service_commissions.employee_id。
 *   原因：service_items.employee_id 是开单时选定的负责美容师，全仓无任何路径可修改；门店事后用
 *   「营业额分配-服务提成」改归属时改不动它，导致实耗记在没拿这单提成的人头上
 *   （2026-09 生产实测 103 项 / 7.7 万元错位，占当月实耗 23%）。
 *   ⚠️ 所有 role_type 各算一份（用户拍板，不做角色去重）：同一项目同时挂美容师 + 品项老师时
 *   两人各全额计入，故**员工榜/明细表合计会大于门店实耗**（2026-09 实测高约 25%）。
 *   门店榜 / 全局大卡实耗（Part A/B）仍走 service_items 原口径，不受影响。
 *   - 产能员工 producer_employees：hired_at/resigned_at 历史化；与 mgmt-dashboard.js
 *     producerEmployeesCte 一致。**入榜口径见 Part D 段头**（2026-09-24 #290 起为
 *     `pe.has_skills OR COALESCE(v,0) <> 0`，取代 2026-05-20 的 `value > 0`）。
 *     ⚠️ 候选池仍**不用** skills 白名单截断（`skills && ARRAY['美容师','养生师']` 会漏 27.8%）；
 *     `has_skills` 是「有任意技能标签」的非空判定，与白名单是两回事，别混为一谈。
 *
 * ⚠️ 偏离 metrics.md 说明：
 *   - 「店长人数 managerCount」「技师人数 technicianCount」是本 admin 人效板块新增的 byMarket 头数指标，
 *     metrics.md 无对端定义，无 staff 对端 SQL。口径：
 *       店长人数 = 在营门店数（2026-05-26 用户拍板：每店一店长口径，按 stores 在营计数，不依赖 position_name；
 *         opening_date/closed_at 按区间末 cur.end 历史化，与 sales.ts storeCount 一致）。
 *         故 managerAvgX = 每店平均 X（m.income 本就是门店全部产能员工提成合计 → managerAvgIncome = 每店平均产能收入）。
 *       技师 = staff_wechat_users.skills && ARRAY['美容师','养生师']（= metrics.md employeeCount「产能技师在职数」），
 *         按区间末 hired_at/resigned_at 历史化。
 *         ⚠️ **含直挂市场/部门的技师**（2026-09-23 #285 修正）：组织归属双轨，只按 store_id
 *         过滤会漏掉 13 名 store_id IS NULL 的在职产能技师（集团 150 vs 164，虚高 +9.33%）。
 *         归属规则单源在 `@/lib/data-center/technician-sql`（销售板共用同一份），与 Part D `producer_base` 对齐；
 *         单店 scope 下直挂者不出现（`orgAnchorScopeSql` 返回 FALSE），与员工榜同语义。
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
import { scopeFilterSql, scopeStoreSkeletonSql, orgAnchorScopeSql } from '@/lib/data-center/scope-sql'
import { excludeDepositRefundSql } from '@/lib/data-center/consume-filter'
import {
  technicianCountSql,
  technicianByStoreSql,
  technicianDirectByMarketSql,
} from '@/lib/data-center/technician-sql'

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

function performanceEventDateBetween(
  eventAlias: string,
  start: string,
  end: string,
) {
  return sql`${sql.raw(`${eventAlias}.status`)} = '已支付'
    AND ${sql.raw(`${eventAlias}.performance_date`)} BETWEEN ${start} AND ${end}`
}

/** 行表 → store_id / market_id → value 映射 */
function toMap(rows: unknown): Map<string, number> {
  const m = new Map<string, number>()
  for (const r of rows as Array<Record<string, unknown>>) {
    const id = r.store_id ?? r.market_id
    if (id != null) m.set(String(id), Number(r.v ?? 0))
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

    /**
     * 业绩（门店口径，全局合计）= SUM(sale_order_performance_events.amount)
     *
     * ⚠️ 禁止改回 SUM(spia.allocated_amount)（#285）：`allocated_amount` 是**角色归属额**不是钱。
     * 写入侧 staffApi/routes/allocation.js 按 (sale_item_id, role_type) **分池**校验「池内 Σratio ≤ 1」，
     * 单 receipt 挂几个角色就有几个独立的 100% 池 —— ratio 合计 2.0 / 3.0 是设计允许的正常形态。
     * 按 employee_id 分组时它是对的（Part D 员工榜保留该口径）；去掉 GROUP BY 跨员工求和，
     * 同一笔钱就被算了 2~3 次（2026-09-01~09-21 集团实测虚高 +32.30%，且 950 张零分配 receipt
     * 反向漏计 → 偏差不同向，**无法用统一系数校正**）。
     *
     * 谓词集与下列四处**逐字对齐**，任一处漂移都会让 KPI 与同页门店排行榜对不上账：
     *   - 同文件 Part C `qStoreRankRevenue`（同页门店排名榜-业绩）
     *   - `sales.ts` `runStoreRevenue`（销售板总业绩 = metrics.md 的 storeRevenue）
     *   - staff `mgmt-dashboard.js` `queryStoreRevenue`（两端同名指标同源）
     * 缺 `充值单` / `change_type` / `legacy_source` 任一条都会与门店榜产生差额。
     */
    const qRevenueTotal = db.execute(sql`
      SELECT COALESCE(SUM(spe.amount::numeric), 0) AS v
      FROM sale_order_performance_events spe
      WHERE ${scopeFilterSql(session, scope, 'spe.store_id')}
        AND spe.change_type IN ('首次支付', '回款', '退款')
        AND spe.sale_order_type IN ('销售单', '转换单', '充值单')
        AND spe.legacy_source IS DISTINCT FROM 'workfine'
        AND ${performanceEventDateBetween('spe', cur.start, cur.end)}
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

    /** 销售提成（全局合计）= SUM(sale_payment_item_allocations.commission_amount) */
    const qSalesCommTotal = db.execute(sql`
      SELECT COALESCE(SUM(spia.commission_amount::numeric), 0) AS v
      FROM sale_payment_item_allocations spia
      JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id
      JOIN sale_items si ON si.sale_item_id = spir.sale_item_id
      JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
      JOIN sale_order_performance_events spe ON spe.sale_payment_id = spir.sale_payment_id
      WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
        AND spia.is_void = FALSE
        AND so.sale_order_type IN ('销售单', '转换单')
        AND ${performanceEventDateBetween('spe', cur.start, cur.end)}
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
     * 员工数 = 产能技师（含直挂市场/部门者），人均派生分母。
     *
     * ⚠️ 口径单源在 `@/lib/data-center/technician-sql`，**销售板 `sales.ts` 共用同一份**。
     * 别在这里内联重写：#285 之前两个板块各写一份只按 `store_id` 过滤的查询，
     * 只修一处会让同一个数据中心的两个板块技师数差 14 人（闸门 2 codex 判 P0）。
     */
    const qTechnicianCount = db.execute(technicianCountSql(session, scope, cur.end))

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
    //  Part B — 门店事件聚合 + 市场内去重客流（byMarket 明细用）
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

    /** 技师数 by store（有门店归属的部分）—— 与 Part A 同一份 technician-sql 单源 */
    const qTechByStore = db.execute(technicianByStoreSql(session, scope, cur.end))

    /** 技师数 by market（直挂市场/部门、无门店归属的部分）—— 详见 technician-sql 的注释 */
    const qTechDirectByMarket = db.execute(technicianDirectByMarketSql(session, scope, cur.end))

    /**
     * 业绩 by store（门店口径）—— 与 Part A `qRevenueTotal` 同谓词集，仅多一个 GROUP BY。
     * 该 map 喂给 byMarket 的 `techAvgRevenue`，故必须与全局大卡同源，否则「按市场人效」
     * 与 KPI 大卡自相矛盾（#285）。
     * 分组列用 `spe.store_id`（非 `so.store_id`）与 Part C 对齐。二者**定义恒等**：
     * 视图 `sale_order_performance_events` 就是 `sale_order_payments JOIN sale_orders so`
     * 再把 `so.store_id` 原样投影出来（`pg_get_viewdef` 可查），不是"实测出来零不一致"的经验结论。
     */
    const qRevenueByStore = db.execute(sql`
      SELECT spe.store_id, COALESCE(SUM(spe.amount::numeric), 0) AS v
      FROM sale_order_performance_events spe
      WHERE ${scopeFilterSql(session, scope, 'spe.store_id')}
        AND spe.change_type IN ('首次支付', '回款', '退款')
        AND spe.sale_order_type IN ('销售单', '转换单', '充值单')
        AND spe.legacy_source IS DISTINCT FROM 'workfine'
        AND ${performanceEventDateBetween('spe', cur.start, cur.end)}
      GROUP BY spe.store_id
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
      SELECT so.store_id, COALESCE(SUM(spia.commission_amount::numeric), 0) AS v
      FROM sale_payment_item_allocations spia
      JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id
      JOIN sale_items si ON si.sale_item_id = spir.sale_item_id
      JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
      JOIN sale_order_performance_events spe ON spe.sale_payment_id = spir.sale_payment_id
      WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
        AND spia.is_void = FALSE
        AND so.sale_order_type IN ('销售单', '转换单')
        AND ${performanceEventDateBetween('spe', cur.start, cur.end)}
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

    /**
     * 客流 by market：市场内 DISTINCT 顾客，不能由门店去重客流相加。
     * 金额、实耗、项目数仍保留各门店事件汇总；这里只有人数需要跨店再去重。
     */
    const qFootfallByMarket = db.execute(sql`
      WITH skel AS (${skeleton})
      SELECT sk.market_id, COUNT(DISTINCT so.client_user_id) AS v
      FROM service_orders so
      JOIN skel sk ON sk.store_id = so.store_id
      WHERE so.status = '已完成'
        AND so.client_user_id IS NOT NULL
        AND so.service_date BETWEEN ${cur.start} AND ${cur.end}
      GROUP BY sk.market_id
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
        COALESCE(SUM(spe.amount::numeric), 0) AS value
      FROM stores s
      JOIN org_nodes o_store ON s.org_node_id = o_store.id
      JOIN org_nodes o ON o_store.parent_id = o.id
      LEFT JOIN sale_order_performance_events spe
        ON spe.store_id = s.store_id
        AND spe.sale_order_type IN ('销售单', '转换单', '充值单')
        AND spe.legacy_source IS DISTINCT FROM 'workfine'
        AND spe.status = '已支付'
        AND spe.change_type IN ('首次支付', '回款', '退款')
        AND spe.performance_date BETWEEN ${cur.start} AND ${cur.end}
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
    // 移植 staff staffRanking：producer_employees（hired_at/resigned_at 历史化）
    // LEFT JOIN 各 metric 子查询；末尾 WHERE 见下方「入榜口径」。
    // 时间过滤改 BETWEEN cur.start/end（关键改造）。
    //
    // ★ 入榜口径（2026-09-24 用户拍板，#290）：`pe.has_skills OR COALESCE(v,0) <> 0`
    //   ——「有技能标签的员工无条件入榜（含零值/负值），无标签者仅在有非零产能时入榜」。
    //
    //   2026-05-20 P0-4 曾用 `WHERE COALESCE(v,0) > 0` 替代被删的 skills 白名单，语义是
    //   「无业绩不入榜」。但 `> 0` 比「无业绩」宽：它连**有**业绩而净额为负（退款冲销超过
    //   新单）的员工一并吞掉，与「退款负数冲销不删行」硬口径冲突 —— 同板块门店榜（Part C）
    //   从不按 value 剔行，且该「不剔负」纪律已被 consistency.efficiency.test.ts 的
    //   fail-closed 断言钉死，Part D 是同一缺陷唯一未被守护的一侧。
    //   2026-09-01~22 生产实测：2 人被吞（唐杰 −10,260.00 / 万淑婷 −642.00）。
    //
    //   候选池改用 has_skills 而非白名单 `skills && ARRAY['美容师','养生师']`：后者实测会把
    //   品项老师 1,061,191.30 / 推广部 231,767.01 / 售前老师 97,728.00 共 139 万（27.8%）
    //   排出榜单，且与 2026-09-03「品项老师/养生部应当入榜」的放宽改造直接矛盾。
    //
    //   ⚠️ `OR COALESCE(v,0) <> 0` 这半边是**防漏算兜底**，不是冗余：`skills` 是
    //   optional/nullable（schemas.ts:50），漏填就会静默掉出榜单 —— 2026-05-20 正是栽在
    //   这里（当时 skills 1174/2020 为空，漏算 33% 业绩）。全历史仍存反例：skills 空却有
    //   allocation 的 1 人 42,624.00、有服务提成的 3 人 269.40。「skills 空 ⇒ 零产能」
    //   是当期巧合，不是数据约束，故兜底必须保留。
    // 产能员工锚点：staff 用 NOW()，本板块用区间末 cur.end（与人均分母历史化口径一致）。
    // scope 命中 sw.store_id。

    /**
     * producer_employees CTE 头部（与 staff producerEmployeesCte 同构，锚点改 cur.end）。
     * 额外 JOIN org_nodes 拿员工所属市场名（RankingRow.marketName 用，员工榜「所属市场」列）。
     *
     * ★ 2026-09-03 放宽：候选池 = 门店员工 ∪ 直挂组织节点员工（品项公司品项老师 / 各市场
     *   养生部养生师等 store_id 为空的产能人员）。三段兜底与 staff 端镜像：
     *     1. store_id  —— 档案 store_id 空但直挂门店节点时反查该门店；
     *     2. 展示名    —— store_name 空时显示直挂节点名（「品项公司」「养生部」），不留空白列；
     *     3. 可见性锚  —— anchor_market_id = 直挂节点自身（若为市场）或其父节点，交
     *        orgAnchorScopeSql 判定；品项公司下无门店：汇总范围仅 admin/总部可见，
     *        直接授权到品项公司的账号以市场范围可见（#399）。
     */
    const producerCte = sql`
      WITH producer_base AS (
        SELECT sw.employee_id, sw.name AS employee_name,
               COALESCE(sw.store_id, ds.store_id) AS store_id,
               COALESCE(s.store_name, ds.store_name, o.name) AS store_name,
               sw.position_name,
               COALESCE(
                 o_mkt.name,
                 CASE WHEN o.type = '市场' THEN o.name WHEN op.type = '市场' THEN op.name END
               ) AS market_name,
               CASE WHEN o.type = '市场' THEN o.id
                    WHEN op.type = '市场' THEN op.id
                    ELSE NULL END AS anchor_market_id,
               (COALESCE(cardinality(array_remove(array_remove(sw.skills, ''), NULL)), 0) > 0) AS has_skills
        FROM staff_wechat_users sw
        LEFT JOIN stores s ON s.store_id = sw.store_id
        LEFT JOIN org_nodes o_store ON s.org_node_id = o_store.id AND o_store.type = '门店'
        LEFT JOIN org_nodes o_mkt ON o_store.parent_id = o_mkt.id
        LEFT JOIN org_nodes o ON o.id = sw.org_node_id
        LEFT JOIN org_nodes op ON op.id = o.parent_id
        LEFT JOIN stores ds ON ds.org_node_id = sw.org_node_id
        WHERE sw.hired_at IS NOT NULL
          AND sw.hired_at::date <= ${cur.end}
          AND (sw.resigned_at IS NULL OR sw.resigned_at::date > ${cur.end})
      ),
      producer_employees AS (
        SELECT pb.employee_id, pb.employee_name, pb.store_id, pb.store_name,
               pb.position_name, pb.market_name, pb.has_skills
        FROM producer_base pb
        WHERE (pb.store_id IS NOT NULL AND ${scopeFilterSql(session, scope, 'pb.store_id')})
           OR (pb.store_id IS NULL AND ${orgAnchorScopeSql(session, scope)})
      )
    `

    const qStaffRankRevenue = db.execute(sql`
      ${producerCte},
      revenue_by_emp AS (
        SELECT spia.employee_id, COALESCE(SUM(spia.allocated_amount::numeric), 0) AS v
        FROM sale_payment_item_allocations spia
        JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id
        JOIN sale_items si ON si.sale_item_id = spir.sale_item_id
        JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
        JOIN sale_order_performance_events spe ON spe.sale_payment_id = spir.sale_payment_id
        WHERE spia.is_void = FALSE
          AND so.sale_order_type IN ('销售单', '转换单')
          AND ${performanceEventDateBetween('spe', cur.start, cur.end)}
        GROUP BY spia.employee_id
      )
      SELECT pe.employee_id, pe.employee_name, pe.store_id, pe.store_name, pe.market_name,
        COALESCE(r.v, 0)::numeric AS value
      FROM producer_employees pe
      LEFT JOIN revenue_by_emp r ON r.employee_id = pe.employee_id
      WHERE (pe.has_skills OR COALESCE(r.v, 0) <> 0)
      ORDER BY (COALESCE(r.v, 0) <> 0) DESC, COALESCE(r.v, 0) DESC, pe.employee_name ASC, pe.employee_id ASC
    `)

    // 实耗(员工)：2026-09-03 起归属改 service_commissions（见文件头「员工归属口径」说明）。
    //
    // ⚠️ 与 staff `mgmt-dashboard.js staffRankingConsume` **并非逐字镜像**（原注释称「镜像」
    //    不准确，2026-09-24 #290 闸门 2 订正）：staff 侧的 `consume_by_emp` 多挂一个
    //    `JOIN sale_items si ON si.sale_item_id = sit.sale_item_id`，而 `si` 在其 SELECT/WHERE
    //    中零引用 —— 是旧口径残留，现在唯一作用是 INNER 存在性过滤。
    //    生产实测（当期 + 全历史）`service_items.sale_item_id` 无空值、无悬空引用，
    //    故两端当前结果一致；但它是**潜在分裂点**（无数据库约束保证该列非空）。
    //    删它属口径改动、超出 #290 范围，已转范围外报告，勿在本文件单边"对齐"。
    const qStaffRankConsume = db.execute(sql`
      ${producerCte},
      consume_by_emp AS (
        SELECT sc.employee_id,
          COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used * sc.allocation_ratio), 0) AS v
        FROM service_commissions sc
        JOIN service_items sit ON sit.service_item_id = sc.service_item_id
        JOIN service_orders so2 ON so2.service_order_id = sit.service_order_id
        WHERE sc.is_void = FALSE
          AND so2.status = '已完成'
          AND so2.service_date BETWEEN ${cur.start} AND ${cur.end}
          AND ${excludeDepositRefundSql('so2')}
        GROUP BY sc.employee_id
      )
      SELECT pe.employee_id, pe.employee_name, pe.store_id, pe.store_name, pe.market_name,
        COALESCE(c.v, 0)::numeric AS value
      FROM producer_employees pe
      LEFT JOIN consume_by_emp c ON c.employee_id = pe.employee_id
      WHERE (pe.has_skills OR COALESCE(c.v, 0) <> 0)
      ORDER BY (COALESCE(c.v, 0) <> 0) DESC, COALESCE(c.v, 0) DESC, pe.employee_name ASC, pe.employee_id ASC
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
      WHERE (pe.has_skills OR COALESCE(n.v, 0) <> 0)
      ORDER BY (COALESCE(n.v, 0) <> 0) DESC, COALESCE(n.v, 0) DESC, pe.employee_name ASC, pe.employee_id ASC
    `)

    // 项目数(员工)：归属同上改 service_commissions；次数为计数指标不乘 allocation_ratio，
    // 内层 DISTINCT 防同一员工同一项目多 role_type 重复累加（镜像 staff staffRankingProjectCount）。
    const qStaffRankProjectCount = db.execute(sql`
      ${producerCte},
      project_by_emp AS (
        SELECT employee_id, COALESCE(SUM(session_used), 0) AS v
        FROM (
          SELECT DISTINCT sc.employee_id, sit.service_item_id, sit.session_used
          FROM service_commissions sc
          JOIN service_items sit ON sit.service_item_id = sc.service_item_id
          JOIN service_orders so2 ON so2.service_order_id = sit.service_order_id
          WHERE sc.is_void = FALSE
            AND so2.status = '已完成'
            AND sit.sales_category IN ('自销自耗', '他销自耗')
            AND so2.service_date BETWEEN ${cur.start} AND ${cur.end}
            AND ${excludeDepositRefundSql('so2')}
        ) t
        GROUP BY employee_id
      )
      SELECT pe.employee_id, pe.employee_name, pe.store_id, pe.store_name, pe.market_name,
        COALESCE(p.v, 0)::numeric AS value
      FROM producer_employees pe
      LEFT JOIN project_by_emp p ON p.employee_id = pe.employee_id
      WHERE (pe.has_skills OR COALESCE(p.v, 0) <> 0)
      ORDER BY (COALESCE(p.v, 0) <> 0) DESC, COALESCE(p.v, 0) DESC, pe.employee_name ASC, pe.employee_id ASC
    `)

    const qStaffRankIncome = db.execute(sql`
      ${producerCte},
      sales_comm AS (
        SELECT spia.employee_id, COALESCE(SUM(spia.commission_amount::numeric), 0) AS v
        FROM sale_payment_item_allocations spia
        JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id
        JOIN sale_items si ON si.sale_item_id = spir.sale_item_id
        JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
        JOIN sale_order_performance_events spe ON spe.sale_payment_id = spir.sale_payment_id
        WHERE spia.is_void = FALSE
          AND so.sale_order_type IN ('销售单', '转换单')
          AND ${performanceEventDateBetween('spe', cur.start, cur.end)}
        GROUP BY spia.employee_id
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
      WHERE (pe.has_skills OR COALESCE(sc1.v, 0) + COALESCE(sc2.v, 0) <> 0)
      ORDER BY (COALESCE(sc1.v, 0) + COALESCE(sc2.v, 0) <> 0) DESC, COALESCE(sc1.v, 0) + COALESCE(sc2.v, 0) DESC, pe.employee_name ASC, pe.employee_id ASC
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
    // 销售额 4 列之和 = 当月业绩 revenue（同一 receipt 子分配口径，仅拆分维度不同）。
    // 2026-09-03：实耗 / 项目数 / 客量人次 三项归属随员工榜一并改 service_commissions
    //    （见文件头「员工归属口径」）；销售额侧不动，仍走 sale_payment_item_allocations。
    const qStaffDetail = db.execute(sql`
      ${producerCte},
      revenue_by_emp_cat AS (
        SELECT spia.employee_id,
          COALESCE(SUM(spia.allocated_amount::numeric), 0) AS total,
          COALESCE(SUM(spia.allocated_amount::numeric) FILTER (WHERE si.sales_category = '自销自耗'), 0) AS sale_zxzh,
          COALESCE(SUM(spia.allocated_amount::numeric) FILTER (WHERE si.sales_category = '他销自耗'), 0) AS sale_txzh,
          COALESCE(SUM(spia.allocated_amount::numeric) FILTER (WHERE si.sales_category = '他销他耗'), 0) AS sale_txth,
          COALESCE(SUM(spia.allocated_amount::numeric) FILTER (WHERE si.sales_category = '生态合作'), 0) AS sale_eco
        FROM sale_payment_item_allocations spia
        JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id
        JOIN sale_items si ON si.sale_item_id = spir.sale_item_id
        JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
        JOIN sale_order_performance_events spe ON spe.sale_payment_id = spir.sale_payment_id
        WHERE spia.is_void = FALSE
          AND so.sale_order_type IN ('销售单', '转换单')
          AND ${performanceEventDateBetween('spe', cur.start, cur.end)}
        GROUP BY spia.employee_id
      ),
      consume_by_emp_cat AS (
        SELECT sc.employee_id,
          COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used * sc.allocation_ratio) FILTER (WHERE sit.sales_category = '自销自耗'), 0) AS consume_zxzh,
          COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used * sc.allocation_ratio) FILTER (WHERE sit.sales_category = '他销自耗'), 0) AS consume_txzh,
          COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used * sc.allocation_ratio) FILTER (WHERE sit.sales_category = '他销他耗'), 0) AS consume_txth,
          COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used * sc.allocation_ratio) FILTER (WHERE sit.sales_category = '生态合作'), 0) AS consume_eco
        FROM service_commissions sc
        JOIN service_items sit ON sit.service_item_id = sc.service_item_id
        JOIN service_orders so2 ON so2.service_order_id = sit.service_order_id
        WHERE sc.is_void = FALSE
          AND so2.status = '已完成'
          AND so2.service_date BETWEEN ${cur.start} AND ${cur.end}
          AND ${excludeDepositRefundSql('so2')}
        GROUP BY sc.employee_id
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
        SELECT employee_id, COALESCE(SUM(session_used), 0) AS v
        FROM (
          SELECT DISTINCT sc.employee_id, sit.service_item_id, sit.session_used
          FROM service_commissions sc
          JOIN service_items sit ON sit.service_item_id = sc.service_item_id
          JOIN service_orders so2 ON so2.service_order_id = sit.service_order_id
          WHERE sc.is_void = FALSE
            AND so2.status = '已完成'
            AND sit.sales_category IN ('自销自耗', '他销自耗')
            AND so2.service_date BETWEEN ${cur.start} AND ${cur.end}
            AND ${excludeDepositRefundSql('so2')}
        ) t
        GROUP BY employee_id
      ),
      service_count_by_emp AS (
        SELECT sc.employee_id,
          COUNT(DISTINCT so2.client_user_id) AS headcount,
          COUNT(DISTINCT sit.service_order_id) AS visits
        FROM service_commissions sc
        JOIN service_items sit ON sit.service_item_id = sc.service_item_id
        JOIN service_orders so2 ON so2.service_order_id = sit.service_order_id
        WHERE sc.is_void = FALSE
          AND so2.status = '已完成'
          AND so2.service_date BETWEEN ${cur.start} AND ${cur.end}
        GROUP BY sc.employee_id
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
      skelRows, managerByStoreR, techByStoreR, techDirectByMarketR, revenueByStoreR, consumeByStoreR,
      shengmeiConsumeByStoreR, salesCommByStoreR, serviceCommByStoreR,
      footfallByMarketR, projectByStoreR,
      // Part C
      storeRankRevenueR, storeRankConsumeR, storeRankRetainedR, storeRankNewMemberR, storeRankProjectR,
      // Part D
      staffRankRevenueR, staffRankConsumeR, staffRankNewMemberR, staffRankProjectR, staffRankIncomeR,
      // Part E
      staffDetailR,
    ] = await Promise.all([
      qRevenueTotal, qConsumeTotal, qSalesCommTotal, qServiceCommTotal,
      qFootfallTotal, qProjectCountTotal, qMemberCount, qTechnicianCount, qManagerCount,
      qStoreSkeleton, qManagerByStore, qTechByStore, qTechDirectByMarket, qRevenueByStore, qConsumeByStore,
      qShengmeiConsumeByStore, qSalesCommByStore, qServiceCommByStore,
      qFootfallByMarket, qProjectByStore,
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

    // ── byMarket 装配（事件指标按门店汇总；客流直接取市场去重值）─────────
    const managerMap = toMap(managerByStoreR)
    const techMap = toMap(techByStoreR)
    const revMap = toMap(revenueByStoreR)
    const consMap = toMap(consumeByStoreR)
    const shengmeiConsMap = toMap(shengmeiConsumeByStoreR)
    const salesCommMap = toMap(salesCommByStoreR)
    const serviceCommMap = toMap(serviceCommByStoreR)
    const footfallByMarketMap = toMap(footfallByMarketR)
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
      projectCount: number
    }
    const marketMap = new Map<string, MarketAgg>()
    const marketRowOf = (marketId: string, marketName: string): MarketAgg => {
      let m = marketMap.get(marketId)
      if (!m) {
        m = {
          marketId,
          marketName,
          managerCount: 0,
          technicianCount: 0,
          revenue: 0,
          consume: 0,
          shengmeiConsume: 0,
          income: 0,
          projectCount: 0,
        }
        marketMap.set(marketId, m)
      }
      return m
    }

    for (const r of skelRows as Array<Record<string, unknown>>) {
      const storeId = String(r.store_id)
      const m = marketRowOf(String(r.market_id ?? ''), String(r.market_name ?? ''))
      m.managerCount += managerMap.get(storeId) ?? 0
      m.technicianCount += techMap.get(storeId) ?? 0
      m.revenue += revMap.get(storeId) ?? 0
      m.consume += consMap.get(storeId) ?? 0
      m.shengmeiConsume += shengmeiConsMap.get(storeId) ?? 0
      m.income += (salesCommMap.get(storeId) ?? 0) + (serviceCommMap.get(storeId) ?? 0)
      m.projectCount += projectMap.get(storeId) ?? 0
    }

    /**
     * 并入**直挂市场/部门**的产能技师（#285）。
     *
     * 上面的循环是逐门店累加的，`store_id IS NULL` 的技师没有任何门店可挂，只走那个循环
     * 会把他们二次丢失 —— 这正是分母缺口的成因（2026-09 实测南昌凤御漏 8 人、昭通凤御漏 4 人）。
     *
     * ⚠️ 必须在循环**外**按市场加一次：放进循环会按该市场的门店数重复累加。
     * ⚠️ 用 `marketRowOf` 建行：「品项公司」这类市场底下一个门店都没有，
     * 压根不出现在门店骨架 skelRows 里，只能在这里补出行（表现为新增一行 1 技师 / 0 业绩）。
     */
    for (const r of techDirectByMarketR as Array<Record<string, unknown>>) {
      if (r.market_id == null) continue
      const m = marketRowOf(String(r.market_id), String(r.market_name ?? ''))
      m.technicianCount += Number(r.v ?? 0)
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
        techAvgMembers: ratio(footfallByMarketMap.get(m.marketId) ?? 0, m.technicianCount),
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
