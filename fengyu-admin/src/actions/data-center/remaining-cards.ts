'use server'

/**
 * 数据中心 — 顾客剩余卡项清单（#371）取数 action。
 *
 * 权限：`data_center:dashboard` + `data_center:customer_detail` 由同一条角色授权同时提供
 * （withAllPermissions，与页面闸门 getCustomerDetailScopeOptions、导出视图
 * DATA_CENTER_VIEW_REQUIRED_ACTIONS['report-remaining-cards'] 同一组常量）。
 * 导出 worker 在导出人的权限快照下调用 exportRemainingCardsReport，同样过这道闸门。
 *
 * SQL 在 lib/data-center/remaining-cards-query.ts，格态 / 指标 / 搜索 / 排序在 lib/data-center/remaining-cards.ts。
 * 返回值里的电话一律脱敏；原始电话只在服务端用于完整号码匹配。
 */
import { withAllPermissions } from '@/lib/with-permission'
import { validateScope } from '@/lib/data-center/context'
import { loadRemainingCardsSnapshot } from '@/lib/data-center/remaining-cards-query'
import {
  buildRemainingCardsModel,
  filterRemainingCardsRows,
  parseRemainingCardsParams,
  remainingCardsTotals,
  resolveRemainingCardsPaging,
  sortRemainingCardsRows,
  summarizeRemainingCards,
  toPublicRow,
  type RemainingCardsCategory,
  type RemainingCardsParams,
  type RemainingCardsRow,
  type RemainingCardsSummary,
} from '@/lib/data-center/remaining-cards'
import { DATA_CENTER_CUSTOMER_DETAIL_ACTIONS } from '@/lib/data-center/reports'
import { shanghaiToday } from '@/lib/data-center/time-range'
import type { MatrixTotals } from '@/lib/data-center/matrix'
import type { AuthSession } from '@/lib/types'

export interface RemainingCardsReport {
  columns: RemainingCardsCategory[]
  /** 当前页 */
  rows: RemainingCardsRow[]
  /** 当前搜索 / 显示范围筛出的行数（分页总数） */
  total: number
  /** 筛出的顾客数（去重） */
  filteredCustomerCount: number
  /** 是否有搜索或「只看有剩余」 */
  filtered: boolean
  page: number
  pageSize: number
  /** 表尾合计：当前筛选结果全部分页逐列之和 */
  totals: MatrixTotals
  /** 指标卡：范围全量，不受搜索与显示范围影响 */
  summary: RemainingCardsSummary
  /** 快照日（上海日界，判定过期用） */
  asOf: string
}

async function loadFiltered(session: AuthSession, params: RemainingCardsParams) {
  await validateScope(session, params.scope)
  const asOf = shanghaiToday()
  const snapshot = await loadRemainingCardsSnapshot(session, params.scope, asOf)
  const model = buildRemainingCardsModel(snapshot.rows, snapshot.categories)
  const rows = sortRemainingCardsRows(filterRemainingCardsRows(model.rows, params), params.direction)
  return { model, rows, asOf }
}

/** 页面取数：服务端分页，URL 参数原样传入（见 parseRemainingCardsParams） */
export const getRemainingCardsReport = withAllPermissions(
  DATA_CENTER_CUSTOMER_DETAIL_ACTIONS,
  async (session, raw: Record<string, string | undefined>): Promise<RemainingCardsReport> => {
    const params = parseRemainingCardsParams(raw)
    const { model, rows, asOf } = await loadFiltered(session, params)
    // 页码越界（筛选变窄后停在旧页码）回到末页
    const pageCount = Math.max(1, Math.ceil(rows.length / params.pageSize))
    const { page, offset } = resolveRemainingCardsPaging(Math.min(params.page, pageCount), params.pageSize)
    return {
      columns: model.columns,
      rows: rows.slice(offset, offset + params.pageSize).map(toPublicRow),
      total: rows.length,
      filteredCustomerCount: new Set(rows.map((row) => row.clientUserId)).size,
      filtered: params.q !== '' || params.show === 'remaining',
      page,
      pageSize: params.pageSize,
      totals: remainingCardsTotals(rows, model.columns),
      summary: summarizeRemainingCards(model),
      asOf,
    }
  },
)

export interface RemainingCardsExport {
  columns: RemainingCardsCategory[]
  rows: RemainingCardsRow[]
  totals: MatrixTotals
  params: Pick<RemainingCardsParams, 'scope' | 'q' | 'show'>
  asOf: string
}

/** 导出取数：当前搜索与显示范围筛出的全部行（不分页），合计同页面表尾 */
export const exportRemainingCardsReport = withAllPermissions(
  DATA_CENTER_CUSTOMER_DETAIL_ACTIONS,
  async (session, raw: Record<string, string | undefined>): Promise<RemainingCardsExport> => {
    const params = parseRemainingCardsParams(raw)
    const { model, rows, asOf } = await loadFiltered(session, params)
    return {
      columns: model.columns,
      rows: rows.map(toPublicRow),
      totals: remainingCardsTotals(rows, model.columns),
      params: { scope: params.scope, q: params.q, show: params.show },
      asOf,
    }
  },
)
