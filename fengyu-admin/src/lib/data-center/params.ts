
import type { BoardParams, DataCenterScope, TimeRangeInput } from './types'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export const DATA_CENTER_TABS = ['sales', 'customer', 'efficiency', 'product'] as const
export type DataCenterTab = (typeof DATA_CENTER_TABS)[number]

export function parseTab(raw: string | undefined): DataCenterTab {
  return (DATA_CENTER_TABS as readonly string[]).includes(raw ?? '')
    ? (raw as DataCenterTab)
    : 'sales'
}

export function parseScope(raw: { scope?: string; scopeId?: string }): DataCenterScope {
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
  return { preset: 'month' } 
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
    withComparison: raw.cmp !== '0', 
  }
}
