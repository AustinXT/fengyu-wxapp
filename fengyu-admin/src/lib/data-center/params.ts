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

/** query 里有任何重复 key（Next 给成数组）。 */
export function hasRepeatedQueryKey(query: Record<string, string | string[] | undefined>): boolean {
  return Object.values(query).some(Array.isArray)
}

/**
 * 把 searchParams 压成单值 query：每个 key 取首值、丢掉空串、剔除 `tab`（板块已由路径承载）。
 *
 * 必须压平的理由：服务端在这里按**首值**判定 scope，而板块组件（client）用
 * `Object.fromEntries(searchParams.entries())` 取的是**末值**。`?scope=store&scope=all` 会让
 * 服务端认为 scope 合法而放行、客户端却解析成 'all' 被 validateScope 拒掉，
 * 最终就是那句「数据加载失败」。两边必须看同一份 query。
 */
export function singleValueQuery(
  query: Record<string, string | string[] | undefined>,
  drop: readonly string[] = [],
): URLSearchParams {
  return collapseQuery(query, ['tab', ...drop])
}

/**
 * `singleValueQuery` 去掉「剔除 tab」这条板块专属规则后的通用版：每个 key 取首值、丢空串、剔除 `drop`。
 *
 * 经营明细报表页（#367）的 `tab` 可能是页内视角参数，不能像板块页那样当遗留深链参数丢掉。
 */
export function collapseQuery(
  query: Record<string, string | string[] | undefined>,
  drop: readonly string[] = [],
): URLSearchParams {
  const next = new URLSearchParams()
  for (const [key, raw] of Object.entries(query)) {
    if (drop.includes(key)) continue
    const value = firstQueryValue(raw)
    if (!value) continue
    next.set(key, value)
  }
  return next
}

/** 多店范围最多可选的门店数（prod 在营门店 40 余家，留足余量；防超长 IN 列表） */
export const MAX_SCOPE_STORES = 200

/** 单个门店 id 的合法字符（store_id 实测为 `store-<数字>` / 字母数字编码；逗号是多店分隔符） */
const STORE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/

/**
 * 解析多店的 `scopeId` 逗号串：去重升序。任一段为空 / 非法字符 / 超过上限 → null。
 * 严格解析（导出）据 null 报 INVALID_PARAMS，宽松解析（页面）回落 'all' 走默认范围。
 */
export function parseStoreIdList(raw: string | undefined): string[] | null {
  if (!raw) return null
  const parts = raw.split(',')
  if (parts.some((id) => !STORE_ID_RE.test(id))) return null
  const ids = Array.from(new Set(parts)).sort()
  return ids.length > MAX_SCOPE_STORES ? null : ids
}

/** 由门店 id 集合构造范围：1 家即单店，≥2 家为多店（ids 去重升序）。空集返回 null。 */
export function scopeFromStoreIds(storeIds: readonly string[]): DataCenterScope | null {
  const ids = Array.from(new Set(storeIds)).sort()
  if (ids.length === 0) return null
  return ids.length === 1 ? { type: 'store', id: ids[0] } : { type: 'stores', ids }
}

export function parseScope(raw: { scope?: string; scopeId?: string }): DataCenterScope {
  if (raw.scope === 'authorized') return { type: 'authorized' }
  if (raw.scope === 'market' && raw.scopeId) return { type: 'market', id: raw.scopeId }
  if (raw.scope === 'store' && raw.scopeId) return { type: 'store', id: raw.scopeId }
  if (raw.scope === 'stores') {
    const ids = parseStoreIdList(raw.scopeId)
    if (ids) return scopeFromStoreIds(ids) ?? { type: 'all' }
  }
  return { type: 'all' }
}

/**
 * 范围 → URL 参数（`parseScope` 的逆）。'all' 为空对象（即不带 scope）。
 * 页面链接、导出参数、游标签名一律经此编码，多店的 id 顺序固定为升序。
 */
export function scopeToParams(scope: DataCenterScope): { scope?: string; scopeId?: string } {
  if (scope.type === 'all') return {}
  if (scope.type === 'authorized') return { scope: 'authorized' }
  if (scope.type === 'stores') return { scope: 'stores', scopeId: [...scope.ids].sort().join(',') }
  return { scope: scope.type, scopeId: scope.id }
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
