/**
 * 数据中心 URL 入参解析（纯函数，page.tsx 把 searchParams 解析成 BoardParams）
 * 容错：非法值一律回退默认（month / all / 开启对比），不抛错。
 */
import { isValidCalendarDate } from '@/lib/calendar-date'
import type { BoardParams, DataCenterScope, TimeRangeInput, TimeRangePreset } from './types'

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

/**
 * 单个门店 id 的合法字符与长度（逗号是多店分隔符）。实测来源：sync-workfine 16 位十六进制、
 * 后台新建 `store-<毫秒时间戳>`、e2e 夹具 `TE2L2_STORE` 等，均 ≤ 20 字符。
 * 上限 40 与导出参数的 scopeId 长度上限（MAX_SCOPE_STORES × 41）联动。
 * ⚠️ 不符合本正则的 store_id 无法进入任何多店编码（整串回落 all → 入口跳默认范围）。后台 createStore 目前不校验
 *    id 格式（follow-up：复用本正则校验）；新增门店 id 生成规则时须同时满足这里。
 */
export const MAX_STORE_ID_LENGTH = 40
const STORE_ID_RE = /^[A-Za-z0-9_-]{1,40}$/

/**
 * 多店 scope 对象的形状是否合法（服务端边界用）：数组、2 ≤ 长度 ≤ MAX_SCOPE_STORES、每个 id 合法且不重复。
 * server action 直接收客户端传来的 scope 对象、不经过 parseScope，必须在 validateScope 再校验一次——
 * 否则 `ids: []` 会拼出 `IN ()` 语法错误，超长列表会撞 PG 绑定参数上限（admin / 总部没有权限 IN 兜底）。
 */
export function isValidStoresScopeIds(ids: unknown): ids is string[] {
  return (
    Array.isArray(ids) &&
    ids.length >= 2 &&
    ids.length <= MAX_SCOPE_STORES &&
    ids.every((id) => typeof id === 'string' && STORE_ID_RE.test(id)) &&
    new Set(ids).size === ids.length
  )
}

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


/**
 * 自定义区间：起止都是合法日历日期（@/lib/calendar-date，1900–2100）且不倒挂才构造出来，否则 null（#308）。
 * 返回的 start/end 是 branded `CalendarDate`——这是得到 custom `TimeRangeInput` 的唯一正路。
 */
export function toCustomRange(start: unknown, end: unknown): Extract<TimeRangeInput, { preset: 'custom' }> | null {
  return isValidCalendarDate(start) && isValidCalendarDate(end) && start <= end ? { preset: 'custom', start, end } : null
}

export function isValidCustomRange(start: unknown, end: unknown): boolean {
  return toCustomRange(start, end) !== null
}

/** 非自定义预设白名单：以 Record 穷举，TimeRangePreset 增删预设时 tsc 会逼着这里同步。 */
const FIXED_PRESETS: Record<Exclude<TimeRangePreset, 'custom'>, true> = { today: true, week: true, month: true, year: true }

function isFixedPreset(preset: unknown): preset is Exclude<TimeRangePreset, 'custom'> {
  return typeof preset === 'string' && Object.hasOwn(FIXED_PRESETS, preset)
}

/**
 * 服务端边界的时间参数解析（#308）：非自定义预设按 FIXED_PRESETS 白名单（Object.hasOwn，原型链属性名不中）原样重建，custom 须经 `toCustomRange`（单源日历校验 + 不倒挂），
 * 其余一律 null——调用方据 null 报 INVALID_PARAMS。
 * server action 直接收客户端传来的 timeRange 对象、不经过 parseTimeRange，必须在 prepareBoardContext 再解析一次——
 * 否则 `2026-02-30` 会让 resolveTimeRange 算出 NaN 天数 / `NaN-NaN-NaN` 区间进 SQL（做法同 #376 的多店复检）。
 * 刻意写成「构造」而不是 `tr is TimeRangeInput` 类型谓词：谓词等于凭空认定 branded 日期，会绕开单源（calendar-date.test 守护）。
 */
export function toTimeRangeInput(tr: unknown): TimeRangeInput | null {
  if (typeof tr !== 'object' || tr === null) return null
  const { preset, start, end } = tr as { preset?: unknown; start?: unknown; end?: unknown }
  if (preset === 'custom') return toCustomRange(start, end)
  if (isFixedPreset(preset)) return { preset }
  return null
}

/** URL 层解析：非法自定义区间（位数对但日历不对、年份越界、倒挂）回落本月，不抛错。 */
export function parseTimeRange(raw: { preset?: string; start?: string; end?: string }): TimeRangeInput {
  const p = raw.preset
  const custom = p === 'custom' ? toCustomRange(raw.start, raw.end) : null
  if (custom) return custom
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
