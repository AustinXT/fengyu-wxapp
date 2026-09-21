/**
 * 数据中心 URL 入参解析（纯函数，page.tsx 把 searchParams 解析成 BoardParams）
 * 容错：非法值一律回退默认（month / all / 开启对比），不抛错。
 */
import type { BoardParams, DataCenterScope, TimeRangeInput } from './types'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export const DATA_CENTER_TABS = ['sales', 'customer', 'efficiency', 'product'] as const
export type DataCenterTab = (typeof DATA_CENTER_TABS)[number]

/**
 * 板块中文名：页面 h1 直接读它；侧边栏（menu.ts）与面包屑（breadcrumb-nav.tsx）出于各自文件的
 * 既有写法仍是独立字面量，靠 menu.test / breadcrumb-nav.test 的守护保持与本表一致。
 */
export const DATA_CENTER_BOARD_LABELS: Record<DataCenterTab, string> = {
  sales: '销售',
  customer: '客量',
  efficiency: '人效',
  product: '品项',
}

/**
 * 板块解析：非法值返回 null，**不回退**。
 *
 * 这里刻意只有严格版一个函数：`/data-center/[board]` 靠它收口动态段，
 * 而容错回退（旧 `?tab=` 深链）由调用方显式写 `?? 'sales'`。
 * 若再提供一个容错版双胞胎，后人拿容错版去校验动态段就会让任意
 * `/data-center/xxx` 静默渲染销售板块，而 tsc / ESLint / 单测都拦不住这种退化。
 */
export function parseBoard(raw: string | undefined): DataCenterTab | null {
  return (DATA_CENTER_TABS as readonly string[]).includes(raw ?? '')
    ? (raw as DataCenterTab)
    : null
}

/**
 * Next 对重复 query key（`?scope=a&scope=b`）给的是 `string[]` 而非 `string`。
 * 直接丢给 `URLSearchParams.set` 会被 `String(array)` 压成 `"a,b"` 这种谁都认不出的脏值，
 * 一律取首值收口。
 */
export function firstQueryValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw
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
