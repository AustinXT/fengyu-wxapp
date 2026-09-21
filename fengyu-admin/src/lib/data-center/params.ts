/**
 * 数据中心 URL 入参解析（纯函数，page.tsx 把 searchParams 解析成 BoardParams）
 * 容错：非法值一律回退默认（month / all / 开启对比），不抛错。
 */
import type { BoardParams, DataCenterScope, TimeRangeInput } from './types'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export const DATA_CENTER_TABS = ['sales', 'customer', 'efficiency', 'product'] as const
export type DataCenterTab = (typeof DATA_CENTER_TABS)[number]

/** 板块中文名：侧边栏菜单项、面包屑末级与页面 h1 共用同一套叫法。 */
export const DATA_CENTER_BOARD_LABELS: Record<DataCenterTab, string> = {
  sales: '销售',
  customer: '客量',
  efficiency: '人效',
  product: '品项',
}

/** 容错解析：非法值回退 sales。裸 `/data-center` 兼容旧 `?tab=` 深链时使用。 */
export function parseTab(raw: string | undefined): DataCenterTab {
  return (DATA_CENTER_TABS as readonly string[]).includes(raw ?? '')
    ? (raw as DataCenterTab)
    : 'sales'
}

/**
 * 严格解析：非法值返回 null。
 * `/data-center/[board]` 用它收口动态段——否则任意 `/data-center/xxx` 都会静默渲染销售板块。
 */
export function parseBoard(raw: string | undefined): DataCenterTab | null {
  return (DATA_CENTER_TABS as readonly string[]).includes(raw ?? '')
    ? (raw as DataCenterTab)
    : null
}

export function parseScope(raw: { scope?: string; scopeId?: string }): DataCenterScope {
  if (raw.scope === 'authorized') return { type: 'authorized' }
  if (raw.scope === 'market' && raw.scopeId) return { type: 'market', id: raw.scopeId }
  if (raw.scope === 'store' && raw.scopeId) return { type: 'store', id: raw.scopeId }
  return { type: 'all' }
}

export function parseTimeRange(raw: { preset?: string; start?: string; end?: string }): TimeRangeInput {
  const p = raw.preset
  if (
    p === 'custom' &&
    raw.start &&
    raw.end &&
    DATE_RE.test(raw.start) &&
    DATE_RE.test(raw.end) &&
    raw.start <= raw.end
  ) {
    return { preset: 'custom', start: raw.start, end: raw.end }
  }
  if (p === 'today' || p === 'week' || p === 'year') return { preset: p }
  return { preset: 'month' } // 默认本月
}

export function parseBoardParams(raw: {
  scope?: string
  scopeId?: string
  preset?: string
  start?: string
  end?: string
  cmp?: string
}): BoardParams {
  return {
    scope: parseScope(raw),
    timeRange: parseTimeRange(raw),
    withComparison: raw.cmp !== '0', // 默认开启同比/环比
  }
}
