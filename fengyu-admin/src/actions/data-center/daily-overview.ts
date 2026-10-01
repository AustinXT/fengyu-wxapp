'use server'

/**
 * 数据中心 — 日常数据一览表 action（getDailyOverview，#369）
 *
 * 口径权威：notes/references/metrics.md §「日常数据一览表」；纯逻辑（拆分、尾差吸收、列定义）在
 * `lib/data-center/daily-overview.ts`。
 *
 * SQL 在 `lib/data-center/daily-overview-sql.ts`（口径红线见该文件头，consistency.daily-overview.test.ts 整段等值守护）。
 */

import { db } from '@/db'
import { withPermission } from '@/lib/with-permission'
import type { AuthSession } from '@/lib/types'
import { resolveScopeName, validateScope } from '@/lib/data-center/context'
import { dailyOverviewQueries, performanceTotalSql, serviceTotalSql } from '@/lib/data-center/daily-overview-sql'
import { parseScope } from '@/lib/data-center/params'
import { parseReportRange, type ReportRangePeriod } from '@/lib/data-center/report-period'
import { loadStoreDataStarts } from '@/lib/data-center/data-start-query'
import { isRangeBeforeScopeStart } from '@/lib/data-center/data-start'
import { resolveDeltaDisplay } from '@/lib/delta-display'
import {
  buildDailyOverview,
  computeDailyOverviewKpis,
  type DailyOverviewData,
  type DailyOverviewInput,
} from '@/lib/data-center/daily-overview'
import type { DataCenterScope, KpiCell, ResolvedRange } from '@/lib/data-center/types'

/** URL 参数原样传入（页面 searchParams / 导出任务 payload.params），服务端自己解析与校验。 */
export interface DailyOverviewParams {
  scope?: string
  scopeId?: string
  period?: string
  start?: string
  end?: string
}

export type DailyOverviewKpiKey = 'performanceTotal' | 'serviceTotal' | 'selfShare' | 'ecoShare' | 'averagePerStore'

export interface DailyOverviewResult {
  data: DailyOverviewData
  kpis: Record<DailyOverviewKpiKey, KpiCell>
  storeCount: number
  period: Pick<ReportRangePeriod, 'label' | 'current' | 'previous'>
  scope: { type: DataCenterScope['type']; name: string }
}

type Row = Record<string, unknown>

function asRows(result: unknown): Row[] {
  return result as Row[]
}

function scalar(result: unknown): number {
  const value = Number(asRows(result)[0]?.v ?? 0)
  return Number.isFinite(value) ? value : 0
}

async function loadInput(session: AuthSession, scope: DataCenterScope, range: ResolvedRange): Promise<DailyOverviewInput> {
  const queries = dailyOverviewQueries(session, scope, range)
  const [storeRows, categoryRows, performanceRows, rechargeRows, serviceRows] = await Promise.all([
    db.execute(queries.stores),
    db.execute(queries.categories),
    db.execute(queries.performance),
    db.execute(queries.recharge),
    db.execute(queries.service),
  ])

  const text = (value: unknown) => (value == null ? null : String(value))
  const performance = asRows(performanceRows)
  return {
    stores: asRows(storeRows).map((row) => ({
      storeId: String(row.store_id),
      storeName: String(row.store_name ?? ''),
      marketId: String(row.market_id ?? ''),
      marketName: String(row.market_name ?? ''),
    })),
    categories: asRows(categoryRows).map((row) => ({
      categoryId: String(row.category_id),
      categoryName: String(row.category_name ?? ''),
      productKind: text(row.product_kind),
      sortOrder: Number(row.sort_order ?? 0),
      isValid: row.is_valid !== false,
    })),
    performanceTotals: performance
      .filter((row) => row.kind === 'total')
      .map((row) => ({ storeId: String(row.store_id), amount: String(row.amount ?? '0') })),
    performanceParts: performance
      .filter((row) => row.kind === 'part')
      .map((row) => ({
        storeId: String(row.store_id),
        salesCategory: text(row.sales_category),
        categoryId: text(row.category_id),
        amount: String(row.amount ?? '0'),
      })),
    recharge: asRows(rechargeRows).map((row) => ({ storeId: String(row.store_id), amount: String(row.amount ?? '0') })),
    service: asRows(serviceRows).map((row) => ({
      storeId: String(row.store_id),
      salesCategory: text(row.sales_category),
      amount: String(row.amount ?? '0'),
    })),
  }
}

/** 解析 URL 参数：scope 与区间都按报表页同一套规则（非法值回落默认，不抛错）。 */
function parseParams(params: DailyOverviewParams): { scope: DataCenterScope; period: ReportRangePeriod } {
  return {
    scope: parseScope({ scope: params.scope, scopeId: params.scopeId }),
    period: parseReportRange({ period: params.period, start: params.start, end: params.end }),
  }
}

export const getDailyOverview = withPermission(
  'data_center:dashboard',
  async (session: AuthSession, params: DailyOverviewParams): Promise<DailyOverviewResult> => {
    const { scope, period } = parseParams(params)
    await validateScope(session, scope)

    const [input, previousPerformance, previousService, starts, scopeName] = await Promise.all([
      loadInput(session, scope, period.current),
      db.execute(performanceTotalSql(session, scope, period.previous)).then(scalar),
      db.execute(serviceTotalSql(session, scope, period.previous)).then(scalar),
      // 起点只用来判较上期是否跨割点：取不到时降级（基期置 null 出「--」），不能让整页 / 导出失败
      loadStoreDataStarts().catch((error: unknown) => {
        console.error('[daily-overview] 数据起点取数失败，本次较上期一律显示「--」', error)
        return null
      }),
      resolveScopeName(scope),
    ])

    const data = buildDailyOverview(input)
    const values = computeDailyOverviewKpis(data)

    // 基期开始日早于范围数据起点（含只覆盖一部分）→ 基期值置 null，resolveDeltaDisplay 输出「--」。
    // 例：默认上月 2026-08 的基期 2026-07 早于 07-08，不置 null 会出 +614% 这种割点伪增幅。
    const basePerformance = !starts || isRangeBeforeScopeStart(period.previous, 'performance', input.stores, starts)
      ? null
      : previousPerformance
    const baseService = !starts || isRangeBeforeScopeStart(period.previous, 'service', input.stores, starts)
      ? null
      : previousService

    const kpis: Record<DailyOverviewKpiKey, KpiCell> = {
      performanceTotal: {
        value: values.performanceTotal,
        mom: resolveDeltaDisplay(values.performanceTotal, basePerformance),
        unit: 'amount',
      },
      serviceTotal: {
        value: values.serviceTotal,
        mom: resolveDeltaDisplay(values.serviceTotal, baseService),
        unit: 'amount',
      },
      selfShare: { value: values.selfShare, unit: 'percent' },
      ecoShare: { value: values.ecoShare, unit: 'percent' },
      averagePerStore: { value: values.averagePerStore, unit: 'amount' },
    }

    return {
      data,
      kpis,
      storeCount: values.storeCount,
      period: { label: period.label, current: period.current, previous: period.previous },
      scope: { type: scope.type, name: scopeName },
    }
  },
)
