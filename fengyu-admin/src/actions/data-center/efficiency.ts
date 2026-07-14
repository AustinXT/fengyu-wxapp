'use server'



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


function scalar(rows: unknown, key = 'v'): number {
  const r = (rows as Array<Record<string, unknown>>)[0]
  if (!r || r[key] == null) return 0
  const n = Number(r[key])
  return Number.isFinite(n) ? n : 0
}


function ratio(num: number | null, den: number | null): number | null {
  if (num == null || den == null || den <= 0) return null
  return num / den
}


function toMap(rows: unknown): Map<string, number> {
  const m = new Map<string, number>()
  for (const r of rows as Array<Record<string, unknown>>) {
    m.set(String(r.store_id), Number(r.v ?? 0))
  }
  return m
}


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

    
    
    

    
    const qRevenueTotal = db.execute(sql`
      SELECT COALESCE(SUM(sa.total_amount::numeric), 0) AS v
      FROM sale_allocations sa
      JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
      JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
      WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
        AND sa.is_void = FALSE
        AND sa.role_type IN ('美容师', '养生师')
        AND so.sale_order_type IN ('销售单', '转换单')
        AND so.status = '已支付'
        AND so.paid_at::date BETWEEN ${cur.start} AND ${cur.end}
    `)

    
    const qConsumeTotal = db.execute(sql`
      SELECT COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS v
      FROM service_items sit
      JOIN service_orders so ON so.service_order_id = sit.service_order_id
      WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
        AND so.status = '已完成'
        AND so.service_date BETWEEN ${cur.start} AND ${cur.end}
        AND ${excludeDepositRefundSql('so')}
    `)

    
    const qSalesCommTotal = db.execute(sql`
      SELECT COALESCE(SUM(sa.commission_amount::numeric), 0) AS v
      FROM sale_allocations sa
      JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
      JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
      WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
        AND sa.is_void = FALSE
        AND so.sale_order_type IN ('销售单', '转换单')
        AND so.status = '已支付'
        AND so.paid_at::date BETWEEN ${cur.start} AND ${cur.end}
    `)

    
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

    
    const qFootfallTotal = db.execute(sql`
      SELECT COUNT(DISTINCT so.client_user_id) AS v
      FROM service_orders so
      WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
        AND so.status = '已完成'
        AND so.client_user_id IS NOT NULL
        AND so.service_date BETWEEN ${cur.start} AND ${cur.end}
    `)

    
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

    
    const qMemberCount = db.execute(sql`
      SELECT COUNT(*) AS v
      FROM client_wechat_users c
      WHERE ${scopeFilterSql(session, scope, 'c.bound_store_id')}
        AND c.became_member_at IS NOT NULL
        AND c.became_member_at::date <= ${cur.end}
    `)

    
    const qTechnicianCount = db.execute(sql`
      SELECT COUNT(*)::int AS v
      FROM staff_wechat_users s
      WHERE ${scopeFilterSql(session, scope, 's.store_id')}
        AND s.skills && ARRAY['美容师','养生师']::text[]
        AND s.hired_at IS NOT NULL
        AND s.hired_at::date <= ${cur.end}
        AND (s.resigned_at IS NULL OR s.resigned_at::date > ${cur.end})
    `)

    
    const qManagerCount = db.execute(sql`
      SELECT COUNT(*)::int AS v
      FROM stores s
      JOIN org_nodes o ON s.org_node_id = o.id AND o.type = '门店'
      WHERE ${scopeFilterSql(session, scope, 's.store_id')}
        AND s.opening_date IS NOT NULL
        AND s.opening_date::date <= ${cur.end}
        AND (s.closed_at IS NULL OR s.closed_at::date > ${cur.end})
    `)

    
    
    

    const skeleton = scopeStoreSkeletonSql(session, scope)

    const qStoreSkeleton = db.execute(skeleton)

    
    const qManagerByStore = db.execute(sql`
      SELECT s.store_id, 1::int AS v
      FROM stores s
      JOIN org_nodes o ON s.org_node_id = o.id AND o.type = '门店'
      WHERE ${scopeFilterSql(session, scope, 's.store_id')}
        AND s.opening_date IS NOT NULL
        AND s.opening_date::date <= ${cur.end}
        AND (s.closed_at IS NULL OR s.closed_at::date > ${cur.end})
    `)

    
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

    
    const qRevenueByStore = db.execute(sql`
      SELECT so.store_id, COALESCE(SUM(sa.total_amount::numeric), 0) AS v
      FROM sale_allocations sa
      JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
      JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
      WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
        AND sa.is_void = FALSE
        AND sa.role_type IN ('美容师', '养生师')
        AND so.sale_order_type IN ('销售单', '转换单')
        AND so.status = '已支付'
        AND so.paid_at::date BETWEEN ${cur.start} AND ${cur.end}
      GROUP BY so.store_id
    `)

    
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

    
    const qSalesCommByStore = db.execute(sql`
      SELECT so.store_id, COALESCE(SUM(sa.commission_amount::numeric), 0) AS v
      FROM sale_allocations sa
      JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
      JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
      WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
        AND sa.is_void = FALSE
        AND so.sale_order_type IN ('销售单', '转换单')
        AND so.status = '已支付'
        AND so.paid_at::date BETWEEN ${cur.start} AND ${cur.end}
      GROUP BY so.store_id
    `)

    
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

    
    const qFootfallByStore = db.execute(sql`
      SELECT so.store_id, COUNT(DISTINCT so.client_user_id) AS v
      FROM service_orders so
      WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
        AND so.status = '已完成'
        AND so.client_user_id IS NOT NULL
        AND so.service_date BETWEEN ${cur.start} AND ${cur.end}
      GROUP BY so.store_id
    `)

    
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
        WHERE sa.is_void = FALSE
          AND sa.role_type IN ('美容师', '养生师')
          AND so.sale_order_type IN ('销售单', '转换单')
          AND so.status = '已支付'
          AND so.paid_at::date BETWEEN ${cur.start} AND ${cur.end}
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
        WHERE sa.is_void = FALSE
          AND so.sale_order_type IN ('销售单', '转换单')
          AND so.status = '已支付'
          AND so.paid_at::date BETWEEN ${cur.start} AND ${cur.end}
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
        WHERE sa.is_void = FALSE
          AND sa.role_type IN ('美容师', '养生师')
          AND so.sale_order_type IN ('销售单', '转换单')
          AND so.status = '已支付'
          AND so.paid_at::date BETWEEN ${cur.start} AND ${cur.end}
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

    
    const [
      
      revenueTotalR, consumeTotalR, salesCommTotalR, serviceCommTotalR,
      footfallTotalR, projectCountTotalR, memberCountR, technicianCountR, managerCountR,
      
      skelRows, managerByStoreR, techByStoreR, revenueByStoreR, consumeByStoreR,
      shengmeiConsumeByStoreR, salesCommByStoreR, serviceCommByStoreR,
      footfallByStoreR, projectByStoreR,
      
      storeRankRevenueR, storeRankConsumeR, storeRankRetainedR, storeRankNewMemberR, storeRankProjectR,
      
      staffRankRevenueR, staffRankConsumeR, staffRankNewMemberR, staffRankProjectR, staffRankIncomeR,
      
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

    
    const byStaff: BreakdownRow[] = (staffDetailR as Array<Record<string, unknown>>).map((r) => ({
      groupId: String(r.employee_id),
      groupName: String(r.employee_name ?? ''),
      marketName: r.market_name == null ? undefined : String(r.market_name),
      labels: {
        store: r.store_name == null ? '' : String(r.store_name),
        position: r.position_name == null ? '' : String(r.position_name),
      },
      
      
      
      metrics: {
        revenue: Number(r.revenue ?? 0),
        saleZxzh: Number(r.sale_zxzh ?? 0), 
        saleTxzh: Number(r.sale_txzh ?? 0), 
        saleTxth: Number(r.sale_txth ?? 0), 
        saleEco: Number(r.sale_eco ?? 0), 
        consumeTotal: 
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
