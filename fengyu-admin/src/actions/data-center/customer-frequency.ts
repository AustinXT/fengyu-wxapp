'use server'

/**
 * 数据中心 — 顾客频率表（#370）取数 action。
 *
 * 权限：`data_center:dashboard` + `data_center:customer_detail` 由同一条角色授权同时提供
 * （withAllPermissions，与页面闸门 getCustomerDetailScopeOptions、导出视图
 * DATA_CENTER_VIEW_REQUIRED_ACTIONS['report-customer-frequency'] 同一组常量）。
 * 导出 worker 在导出人的权限快照下调用 exportCustomerFrequencyReport，同样过这道闸门。
 *
 * SQL 在 lib/data-center/customer-frequency-query.ts，行模型 / 指标 / 搜索 / 排序在 lib/data-center/customer-frequency.ts。
 * 返回值里的电话一律脱敏；原始电话只在服务端用于完整号码匹配。
 */
import { withAllPermissions } from '@/lib/with-permission'
import { validateScope } from '@/lib/data-center/context'
import { loadCustomerFrequencySource } from '@/lib/data-center/customer-frequency-query'
import {
  buildCustomerFrequencyRows,
  customerFrequencyTotals,
  displaySearchTerm,
  filterCustomerFrequencyRows,
  isBeforeFrequencyDataStart,
  parseCustomerFrequencyParams,
  resolveCustomerFrequencyPaging,
  sortCustomerFrequencyRows,
  summarizeCustomerFrequency,
  toPublicFrequencyRow,
  type CustomerFrequencyParams,
  type CustomerFrequencyRow,
  type CustomerFrequencySummary,
} from '@/lib/data-center/customer-frequency'
import { DATA_CENTER_CUSTOMER_DETAIL_ACTIONS } from '@/lib/data-center/reports'
import type { MatrixTotals } from '@/lib/data-center/matrix'
import type { ResolvedRange } from '@/lib/data-center/types'
import type { AuthSession } from '@/lib/types'

export interface CustomerFrequencyReport {
  month: string
  /** 当前页 */
  rows: CustomerFrequencyRow[]
  /** 当前搜索 / 只看有到店筛出的行数（分页总数） */
  total: number
  /** 是否有搜索或「只看有到店」 */
  filtered: boolean
  /** 所选月份早于系统数据起点：不取数，页面显示空表 + 数据起点提示 */
  beforeDataStart: boolean
  page: number
  pageSize: number
  sort: CustomerFrequencyParams['sort']
  /** 表尾合计：当前筛选结果全部分页之和 */
  totals: MatrixTotals
  /** 指标卡：范围全量，不受搜索、开关、分页影响 */
  summary: CustomerFrequencySummary
}

async function loadFiltered(session: AuthSession, params: CustomerFrequencyParams) {
  await validateScope(session, params.scope)
  const beforeDataStart = isBeforeFrequencyDataStart(params.period.month)
  const all = beforeDataStart
    ? []
    : buildCustomerFrequencyRows(await loadCustomerFrequencySource(session, params.scope, params.period.current))
  const rows = sortCustomerFrequencyRows(filterCustomerFrequencyRows(all, params), params.sort)
  return { all, rows, beforeDataStart }
}

/** 页面取数：服务端分页，URL 参数原样传入（见 parseCustomerFrequencyParams） */
export const getCustomerFrequencyReport = withAllPermissions(
  DATA_CENTER_CUSTOMER_DETAIL_ACTIONS,
  async (session, raw: Record<string, string | undefined>): Promise<CustomerFrequencyReport> => {
    const params = parseCustomerFrequencyParams(raw)
    const { all, rows, beforeDataStart } = await loadFiltered(session, params)
    // 页码越界（筛选变窄后停在旧页码）回到末页
    const pageCount = Math.max(1, Math.ceil(rows.length / params.pageSize))
    const { page, offset } = resolveCustomerFrequencyPaging(Math.min(params.page, pageCount), params.pageSize)
    return {
      month: params.period.month,
      rows: rows.slice(offset, offset + params.pageSize).map(toPublicFrequencyRow),
      total: rows.length,
      filtered: params.q !== '' || params.show === 'visited',
      beforeDataStart,
      page,
      pageSize: params.pageSize,
      sort: params.sort,
      totals: customerFrequencyTotals(rows),
      summary: summarizeCustomerFrequency(all),
    }
  },
)

export interface CustomerFrequencyExport {
  rows: CustomerFrequencyRow[]
  totals: MatrixTotals
  /** searchLabel = 回显用的搜索词（完整手机号已脱敏）；原始 q 只在服务端用于过滤，不出 action */
  params: Pick<CustomerFrequencyParams, 'scope' | 'show'> & { searchLabel: string; month: string; monthLabel: string; range: ResolvedRange }
}

/** 导出取数：当前搜索与开关筛出的全部行（不分页、同页面排序），合计同页面表尾 */
export const exportCustomerFrequencyReport = withAllPermissions(
  DATA_CENTER_CUSTOMER_DETAIL_ACTIONS,
  async (session, raw: Record<string, string | undefined>): Promise<CustomerFrequencyExport> => {
    const params = parseCustomerFrequencyParams(raw)
    const { rows } = await loadFiltered(session, params)
    return {
      rows: rows.map(toPublicFrequencyRow),
      totals: customerFrequencyTotals(rows),
      params: {
        scope: params.scope,
        searchLabel: displaySearchTerm(params.q),
        show: params.show,
        month: params.period.month,
        monthLabel: params.period.label,
        range: params.period.current,
      },
    }
  },
)
