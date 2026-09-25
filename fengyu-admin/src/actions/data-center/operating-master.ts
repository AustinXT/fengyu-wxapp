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
 *   - 不读 service_orders.service_order_type（售前 / 售后快照已过时，S–U 待 #373）。
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
import { isValidMonth, monthRange } from '@/lib/data-center/report-period'
import { shanghaiToday } from '@/lib/data-center/time-range'
import { DATA_CENTER_DASHBOARD_ACTION } from '@/lib/data-center/reports'
import {
  buildOperatingMasterTable,
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

    const [scopeName, skelRows, beauticianRows, revRows, ytdRevRows, projectRows, consRows, shengmeiConsRows] =
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
      ])

    const metrics = new Map<string, Partial<OperatingMasterMetrics>>()
    const collect = (rows: unknown, key: OperatingMasterMetricKey) => {
      for (const row of rows as Array<Record<string, unknown>>) {
        // 原生 SQL 的 numeric / bigint 回来是字符串，一律 Number()
        const id = String(row.store_id)
        metrics.set(id, { ...metrics.get(id), [key]: Number(row.v ?? 0) })
      }
    }
    collect(beauticianRows, 'beauticianCount')
    collect(revRows, 'monthRevenue')
    collect(ytdRevRows, 'ytdRevenue')
    collect(projectRows, 'shengmeiProjectCount')
    collect(consRows, 'monthConsume')
    collect(shengmeiConsRows, 'shengmeiConsume')

    const stores: OperatingMasterStore[] = (skelRows as Array<Record<string, unknown>>).map((row) => ({
      storeId: String(row.store_id),
      storeName: String(row.store_name ?? ''),
      marketId: String(row.market_id ?? ''),
      marketName: String(row.market_name ?? ''),
    }))

    return { month, range: cur, ytd, scopeName, ...buildOperatingMasterTable(stores, metrics) }
  },
)
