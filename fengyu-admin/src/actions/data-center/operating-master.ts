'use server'

/**
 * 数据中心 — 经营数据主表（#372）取数 action。
 *
 * 行 = 账号权限内、且在筛选范围内的在营门店（`scopeStoreSkeletonSql`，与各板块明细同一骨架）；
 * 列定义、小计 / 合计装配在 `lib/data-center/operating-master.ts`（页面与导出共用）。
 *
 * 口径（metrics.md §经营数据主表）：
 *   - P 当月完成 / R 年度累计：与销售板门店「总业绩」逐字同谓词（consistency.operating-master.test 守护），
 *     R 只是把区间换成当年 1 月 1 日 ~ 所选月末，故 R = 各月 P 之和、1 月 R = P。
 *     不接 WorkFine 历史单（`legacy_source IS DISTINCT FROM 'workfine'`）。
 *   - W 总实耗 / X 生美实耗：与销售板门店「总实耗」「生美实耗」逐字同谓词；X 读 service_items.is_shengmei
 *     快照（#378 在修错标，修好后数字随之变化，本页不另做处理）。
 *   - V 生美项目数：SUM(session_used) ∩ 已完成 ∩ 生美 ∩ 剔除寄存单退款专用单。
 *   - D 美容师人数：technician-sql 单源，`pool='beautician'`（在职历史化与双轨归属同产能技师，#297 口径不动）。
 *   - E 保有会员（#373）：与客量板「有效保有会员」（customer.ts queryRetainedMembers）逐字同谓词，
 *     截至统计时点 T = min(所选月末, 今天)，按顾客**绑定门店**归店；F / H = E 人群里当月到店天数（#298 visitDaysSql，
 *     service_date 轴、不限到店门店）≥1 / ≥2。
 *   - K / L 被经营（#373）：(下单门店, 顾客) 在年度 / 当月的款项净额 ≥ 会员门槛（getMemberThreshold，#292）。
 *     款项 = P 的谓词只把 sale_order_type 收窄到 ('销售单', '转换单')——不含充值、寄存单；change_type 不含储值卡抵扣。
 *   - S / T / U 客流（#373）：(服务门店, 顾客, service_date) 去重的到店天数；T = 当天在该店的服务单核销过体验项目
 *     （sale_items.is_experience），U = S − T。**不读** service_orders.service_order_type（开单时快照，已过时）。
 *   - 日期一律按 DATE 列与 'YYYY-MM-DD' 字符串比较，不依赖会话时区（#291）；各查询都不加 >0 过滤（#290）。
 */

import { db } from '@/db'
import { sql, type SQL } from 'drizzle-orm'
import { withPermission } from '@/lib/with-permission'
import type { AuthSession } from '@/lib/types'
import { resolveScopeName, validateScope } from '@/lib/data-center/context'
import { scopeFilterSql, scopeStoreSkeletonSql } from '@/lib/data-center/scope-sql'
import { excludeDepositRefundSql } from '@/lib/data-center/consume-filter'
import { technicianByStoreSql } from '@/lib/data-center/technician-sql'
import { visitDaysSql } from '@/lib/data-center/visit-days'
import { getMemberThreshold } from '@/lib/member-threshold'
import { isValidMonth, monthRange } from '@/lib/data-center/report-period'
import { shanghaiToday } from '@/lib/data-center/time-range'
import { DATA_CENTER_DASHBOARD_ACTION } from '@/lib/data-center/reports'
import {
  buildOperatingMasterTable,
  retainedAsOf,
  ytdRange,
  type OperatingMasterMetricKey,
  type OperatingMasterMetrics,
  type OperatingMasterStore,
  type OperatingMasterTable,
} from '@/lib/data-center/operating-master'
import type { DataCenterScope, ResolvedRange } from '@/lib/data-center/types'

export interface OperatingMasterParams {
  scope: DataCenterScope
  /** YYYY-MM */
  month: string
}

export interface OperatingMasterResult extends OperatingMasterTable {
  month: string
  range: ResolvedRange
  ytd: ResolvedRange
  /** 统计时点 T = min(所选月末, 今天)：E 保有会员截至这一天 */
  asOf: string
  scopeName: string
}

/** 当月 / 年度业绩：与 sales.ts 门店明细「业绩（付款流水现金流）」同谓词，仅区间不同 */
function revenueByStoreSql(session: AuthSession, scope: DataCenterScope, range: ResolvedRange): SQL {
  return sql`
        SELECT spe.store_id, COALESCE(SUM(spe.amount::numeric), 0) AS v
        FROM sale_order_performance_events spe
        WHERE ${scopeFilterSql(session, scope, 'spe.store_id')}
          AND spe.status = '已支付'
          AND spe.change_type IN ('首次支付', '回款', '退款')
          AND spe.sale_order_type IN ('销售单', '转换单', '充值单')
          AND spe.legacy_source IS DISTINCT FROM 'workfine'
          AND spe.performance_date BETWEEN ${range.start} AND ${range.end}
        GROUP BY spe.store_id
      `
}

/**
 * K / L 被经营人头：(下单门店, 顾客) 区间内款项净额 ≥ 门槛。款项谓词 = revenueByStoreSql 只把类型收窄到销售单 + 转换单
 * （consistency.operating-master 守护）。门槛比较放在外层 WHERE，不用 HAVING。
 */
function managedByStoreSql(session: AuthSession, scope: DataCenterScope, range: ResolvedRange, threshold: number): SQL {
  return sql`
        SELECT t.store_id, COUNT(*) AS v
        FROM (
          SELECT spe.store_id, so.client_user_id, SUM(spe.amount::numeric) AS amount
          FROM sale_order_performance_events spe
          JOIN sale_orders so ON so.sale_order_id = spe.sale_order_id
          WHERE ${scopeFilterSql(session, scope, 'spe.store_id')}
            AND spe.status = '已支付'
            AND spe.change_type IN ('首次支付', '回款', '退款')
            AND spe.sale_order_type IN ('销售单', '转换单')
            AND spe.legacy_source IS DISTINCT FROM 'workfine'
            AND spe.performance_date BETWEEN ${range.start} AND ${range.end}
            AND so.client_user_id IS NOT NULL
          GROUP BY spe.store_id, so.client_user_id
        ) t
        WHERE t.amount >= ${threshold}
        GROUP BY t.store_id
      `
}

export const getOperatingMaster = withPermission(
  DATA_CENTER_DASHBOARD_ACTION,
  async (session: AuthSession, params: OperatingMasterParams): Promise<OperatingMasterResult> => {
    if (!isValidMonth(params.month)) throw new Error('INVALID_PARAMS: 月份格式应为 YYYY-MM')
    // 与页面收口一致（parseReportMonth 把未来月份回落默认）：直调 action / 伪造导出参数也不查未来月
    if (params.month > shanghaiToday().slice(0, 7)) throw new Error('INVALID_PARAMS: 不能查询未来月份')
    await validateScope(session, params.scope)
    const { scope, month } = params
    const cur = monthRange(month)
    const ytd = ytdRange(month)
    const asOf = retainedAsOf(month)
    const threshold = await getMemberThreshold()

    const [
      scopeName, skelRows, beauticianRows, revRows, ytdRevRows, projectRows, consRows, shengmeiConsRows,
      retainedRows, managedMonthRows, managedYearRows, footfallRows,
    ] =
      await Promise.all([
        resolveScopeName(scope),
        // 门店骨架：市场按组织树排序权重，门店按名称；store_id 兜底保证顺序恒定（#282）
        db.execute(sql`
          SELECT sk.store_id, sk.store_name, sk.market_id, sk.market_name
          FROM (${scopeStoreSkeletonSql(session, scope)}) sk
          JOIN org_nodes mkt ON mkt.id = sk.market_id
          ORDER BY mkt.sort_order ASC NULLS LAST, sk.market_name ASC, sk.market_id ASC,
                   sk.store_name ASC, sk.store_id ASC
        `),
        // D 美容师人数：technician-sql 单源，只换人池
        db.execute(technicianByStoreSql(session, scope, cur.end, 'beautician')),
        // P 当月完成
        db.execute(revenueByStoreSql(session, scope, cur)),
        // R 年度累计达成
        db.execute(revenueByStoreSql(session, scope, ytd)),
        // V 生美项目数
        db.execute(sql`
          SELECT so.store_id, COALESCE(SUM(sit.session_used), 0) AS v
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
        // W 实耗
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
        // X 生美实耗
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
        // E 保有会员 / F 回店1次 / H 回店≥2次
        db.execute(sql`
          WITH retained AS (
            SELECT DISTINCT c.bound_store_id AS store_id, so.client_user_id
            FROM service_orders so
            JOIN client_wechat_users c ON c.user_id = so.client_user_id
            WHERE ${scopeFilterSql(session, scope, 'c.bound_store_id')}
              AND so.status = '已完成'
              AND so.client_user_id IS NOT NULL
              AND so.service_date BETWEEN (${asOf}::date - INTERVAL '90 days')::date AND ${asOf}
              AND c.became_member_at IS NOT NULL
              AND c.became_member_at::date <= ${asOf}
          ),
          month_visits AS (
            SELECT vd.client_user_id, COUNT(*) AS days
            FROM (${visitDaysSql({ axis: 'service_date', scope: sql`TRUE`, range: cur })}) vd
            GROUP BY vd.client_user_id
          )
          SELECT r.store_id,
                 COUNT(*) AS retained,
                 COUNT(*) FILTER (WHERE mv.days >= 1) AS once,
                 COUNT(*) FILTER (WHERE mv.days >= 2) AS twice
          FROM retained r
          LEFT JOIN month_visits mv ON mv.client_user_id = r.client_user_id
          GROUP BY r.store_id
        `),
        // L 被经营当月
        db.execute(managedByStoreSql(session, scope, cur, threshold)),
        // K 被经营年度
        db.execute(managedByStoreSql(session, scope, ytd, threshold)),
        // S 服务到店天数 / T 售前到店天数
        db.execute(sql`
          WITH visit_days AS (
            SELECT so.store_id, so.client_user_id, so.service_date,
                   BOOL_OR(EXISTS (
                     SELECT 1
                     FROM service_items sit
                     JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
                     WHERE sit.service_order_id = so.service_order_id
                       AND si.is_experience = TRUE
                   )) AS pre_sale
            FROM service_orders so
            WHERE ${scopeFilterSql(session, scope, 'so.store_id')}
              AND so.status = '已完成'
              AND so.client_user_id IS NOT NULL
              AND so.service_date BETWEEN ${cur.start} AND ${cur.end}
              AND ${excludeDepositRefundSql('so')}
            GROUP BY so.store_id, so.client_user_id, so.service_date
          )
          SELECT store_id, COUNT(*) AS footfall, COUNT(*) FILTER (WHERE pre_sale) AS pre_sale
          FROM visit_days
          GROUP BY store_id
        `),
      ])

    const metrics = new Map<string, Partial<OperatingMasterMetrics>>()
    /** @param target 指标键（读结果列 `v`），或「结果列 → 指标键」映射（一条查询出多列时） */
    const collect = (rows: unknown, target: OperatingMasterMetricKey | Record<string, OperatingMasterMetricKey>) => {
      const fields = typeof target === 'string' ? { v: target } : target
      for (const row of rows as Array<Record<string, unknown>>) {
        // 原生 SQL 的 numeric / bigint 回来是字符串，一律 Number()
        const id = String(row.store_id)
        const next = { ...metrics.get(id) }
        for (const [column, metricKey] of Object.entries(fields)) next[metricKey] = Number(row[column] ?? 0)
        metrics.set(id, next)
      }
    }
    collect(beauticianRows, 'beauticianCount')
    collect(revRows, 'monthRevenue')
    collect(ytdRevRows, 'ytdRevenue')
    collect(projectRows, 'shengmeiProjectCount')
    collect(consRows, 'monthConsume')
    collect(shengmeiConsRows, 'shengmeiConsume')
    collect(retainedRows, { retained: 'retainedMembers', once: 'returnOnceHeads', twice: 'returnTwiceHeads' })
    collect(managedMonthRows, 'managedMonthCustomers')
    collect(managedYearRows, 'managedYearCustomers')
    collect(footfallRows, { footfall: 'monthFootfall', pre_sale: 'preSaleFootfall' })
    // U 售后 = S − T（同一行查询的两个计数，恒 ≥ 0）
    for (const [id, values] of metrics) {
      metrics.set(id, { ...values, afterSaleFootfall: (values.monthFootfall ?? 0) - (values.preSaleFootfall ?? 0) })
    }

    const stores: OperatingMasterStore[] = (skelRows as Array<Record<string, unknown>>).map((row) => ({
      storeId: String(row.store_id),
      storeName: String(row.store_name ?? ''),
      marketId: String(row.market_id ?? ''),
      marketName: String(row.market_name ?? ''),
    }))

    return { month, range: cur, ytd, asOf, scopeName, ...buildOperatingMasterTable(stores, metrics) }
  },
)
