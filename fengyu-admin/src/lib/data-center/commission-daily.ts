/**
 * 员工提成日报 / 提成明细（#375）的纯逻辑：URL 参数解析、矩阵行装配、明细 keyset 游标。
 *
 * 页面（Server Component）、取数 Server Action、export-worker 三处共用这里，
 * 保证页面看到的与导出件是同一套参数口径。SQL 在 `commission-sql.ts`，列定义在 `commission-columns.ts`。
 */
import { firstQueryValue } from './params'
import { isValidCalendarDate } from './report-period'
import type { SearchQuery } from './entry'
import { DATA_CENTER_REPORTS } from './reports'

// ─── 日报参数 ────────────────────────────────────────────────────────────────

/** 视图：提成合计（默认）/ 双列（业绩 + 消耗）/ 仅业绩 / 仅消耗 */
export const COMMISSION_VIEWS = ['total', 'split', 'sale', 'service'] as const
export type CommissionView = (typeof COMMISSION_VIEWS)[number]
export const COMMISSION_VIEW_LABELS: Record<CommissionView, string> = {
  total: '提成合计',
  split: '双列',
  sale: '仅业绩',
  service: '仅消耗',
}

/** 汇总维度：按员工（行 = 员工 × 单据门店；总部可合并为员工）/ 按岗位 */
export const COMMISSION_GROUPS = ['employee', 'position'] as const
export type CommissionGroup = (typeof COMMISSION_GROUPS)[number]

/** 行键的粒度：员工 × 单据门店 / 员工（总部「按员工合并」）/ 岗位 */
export type CommissionRowGrain = 'employee-store' | 'employee' | 'position'

export interface CommissionDailyOptions {
  view: CommissionView
  group: CommissionGroup
  /** 「按员工合并」开关（仅总部范围生效，由 grainOf 判定） */
  merge: boolean
  /** 员工搜索：姓名 / 岗位 / 门店，空串 = 不搜 */
  search: string
  /** ☆ 隐藏合计为 0 的行（负数行保留）；默认关，交付前待甲方确认 */
  hideZero: boolean
}

const MAX_SEARCH_LENGTH = 50

function pick<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value ?? '') ? (value as T) : fallback
}

export function parseCommissionDailyOptions(query: SearchQuery): CommissionDailyOptions {
  const get = (key: string) => firstQueryValue(query[key])
  return {
    view: pick(get('view'), COMMISSION_VIEWS, 'total'),
    group: pick(get('group'), COMMISSION_GROUPS, 'employee'),
    merge: get('merge') === '1',
    search: (get('q') ?? '').trim().slice(0, MAX_SEARCH_LENGTH),
    hideZero: get('hideZero') === '1',
  }
}

/**
 * 行键粒度。「按员工合并」只在总部（全部）范围提供：非总部范围下同一员工跨店的行本来就只剩授权门店，
 * 合并后门店列「多店（N）」会让人误以为是全域数据。
 */
export function grainOf(options: Pick<CommissionDailyOptions, 'group' | 'merge'>, isAllScope: boolean): CommissionRowGrain {
  if (options.group === 'position') return 'position'
  return options.merge && isAllScope ? 'employee' : 'employee-store'
}

// ─── 矩阵装配 ────────────────────────────────────────────────────────────────

/** 一格：当日业绩提成、消耗提成、去重单数 */
export interface CommissionCell {
  sale: number
  service: number
  orders: number
}

export interface CommissionDailyRow {
  /** 行唯一键：employee-store = `employeeId|storeId`，employee = employeeId，position = 岗位名 */
  key: string
  employeeId: string | null
  employeeName: string
  positionName: string
  /** 单据门店；合并视图下为 null（门店列显示「多店（N）」） */
  storeId: string | null
  storeName: string
  /** 行内涉及的门店数（合并视图的「多店（N）」） */
  storeCount: number
  /** 岗位视图第二列「人数」 */
  employeeCount: number
  /** YYYY-MM-DD → 当日数值；没有提成行的日期不出现（取值时按 0） */
  days: Record<string, CommissionCell>
  total: CommissionCell
}

export interface CommissionDailyTotals {
  days: Record<string, CommissionCell>
  total: CommissionCell
  /** 表尾「合计（N 人）」：去重员工数 */
  employeeCount: number
  /** 表尾「合计（N 个岗位）」/ 行数 */
  rowCount: number
}

/** SQL 聚合结果的一行（GROUPING SETS：(gk,d) / (gk) / (d) / ()） */
export interface CommissionAggregateRecord {
  gk: string | null
  d: string | null
  sale: number | string | null
  service: number | string | null
  orders: number | string | null
  employees: number | string | null
  stores: number | string | null
  employee_id: string | null
  employee_name: string | null
  position_name: string | null
  store_id: string | null
  store_name: string | null
  /** GROUPING(gk)：1 = 该层汇总掉了行键 */
  g_gk: number | string
  /** GROUPING(d)：1 = 该层汇总掉了日期 */
  g_d: number | string
}

function num(value: number | string | null | undefined): number {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

function cellOf(record: CommissionAggregateRecord): CommissionCell {
  return { sale: num(record.sale), service: num(record.service), orders: num(record.orders) }
}

export const EMPTY_CELL: CommissionCell = Object.freeze({ sale: 0, service: 0, orders: 0 }) as CommissionCell

export const NO_POSITION_LABEL = '（无岗位）'

/**
 * 把 GROUPING SETS 的扁平结果装配成矩阵行 + 表尾合计。
 * 表尾合计来自 SQL 的 (d) / () 两层而不是前端逐行相加：去重单数只能由 SQL 给，
 * 金额两种算法结果相同（numeric 精确求和），由单测钉住「行合计 = 各格之和、表尾 = 当列之和」。
 */
export function assembleCommissionMatrix(
  records: readonly CommissionAggregateRecord[],
  grain: CommissionRowGrain,
): { rows: CommissionDailyRow[]; totals: CommissionDailyTotals } {
  const rows = new Map<string, CommissionDailyRow>()
  const totals: CommissionDailyTotals = { days: {}, total: { ...EMPTY_CELL }, employeeCount: 0, rowCount: 0 }

  const rowOf = (gk: string) => {
    let row = rows.get(gk)
    if (!row) {
      row = {
        key: gk,
        employeeId: null,
        employeeName: '',
        positionName: '',
        storeId: null,
        storeName: '',
        storeCount: 0,
        employeeCount: 0,
        days: {},
        total: { ...EMPTY_CELL },
      }
      rows.set(gk, row)
    }
    return row
  }

  for (const record of records) {
    const byKey = num(record.g_gk) === 0
    const byDay = num(record.g_d) === 0
    if (byKey && record.gk != null) {
      const row = rowOf(record.gk)
      if (byDay && record.d) {
        row.days[record.d] = cellOf(record)
      } else if (!byDay) {
        row.total = cellOf(record)
        row.employeeCount = num(record.employees)
        row.storeCount = num(record.stores)
        row.positionName = record.position_name?.trim() || NO_POSITION_LABEL
        if (grain === 'position') {
          row.employeeName = row.positionName
        } else {
          row.employeeId = record.employee_id
          row.employeeName = record.employee_name?.trim() || record.employee_id || ''
          if (grain === 'employee-store') {
            row.storeId = record.store_id
            row.storeName = record.store_name?.trim() || record.store_id || ''
          } else {
            row.storeName = row.storeCount > 1 ? `多店（${row.storeCount}）` : record.store_name?.trim() || record.store_id || ''
          }
        }
      }
    } else if (!byKey && byDay && record.d) {
      totals.days[record.d] = cellOf(record)
    } else if (!byKey && !byDay) {
      totals.total = cellOf(record)
      totals.employeeCount = num(record.employees)
    }
  }

  const list = [...rows.values()]
  totals.rowCount = list.length
  return { rows: list, totals }
}

export function cellTotal(cell: CommissionCell | undefined): number {
  return cell ? cell.sale + cell.service : 0
}

// ─── 明细参数与 keyset 游标 ─────────────────────────────────────────────────

/** 来源类型：销售分配（spia）/ 服务提成（service_commissions）。两表 id 各自自增会撞号，keyset 必须带它。 */
export const COMMISSION_SOURCES = ['sale', 'service'] as const
export type CommissionSource = (typeof COMMISSION_SOURCES)[number]
export const COMMISSION_SOURCE_LABELS: Record<CommissionSource, string> = { sale: '业绩', service: '消耗' }

export const COMMISSION_DETAIL_PAGE_SIZES = [20, 50, 100] as const
export const DEFAULT_COMMISSION_DETAIL_PAGE_SIZE = 50

export interface CommissionDetailFilters {
  /** 空 = 全部员工 */
  employeeId: string | null
  /** 空 = 当前范围内全部门店 */
  storeId: string | null
  /** 当日明细；空 = 全月 */
  date: string | null
  source: CommissionSource | null
}

export interface CommissionDetailKey {
  /** 业务日期 YYYY-MM-DD */
  d: string
  t: CommissionSource
  id: number
}

/** 员工 / 门店 id 长度上限（与库列 varchar(30) / text 相比留足余量）；取值只作参数化绑定，不拼进 SQL */
const MAX_ID_LENGTH = 80

/** 当日参数必须落在所选月份内，否则按全月（手改 URL 不报错，也不能拿它越出期间取数） */
export function parseCommissionDetailFilters(query: SearchQuery, month: { start: string; end: string }): CommissionDetailFilters {
  const get = (key: string) => firstQueryValue(query[key])?.trim()
  const employeeId = get('employeeId')
  const storeId = get('storeId')
  const date = get('date')
  const source = get('type')
  return {
    // 不合法 / 不存在的 id 照原值过滤（得到空明细），不能静默放宽成「全部员工 / 全部门店」
    employeeId: employeeId ? employeeId.slice(0, MAX_ID_LENGTH) : null,
    storeId: storeId ? storeId.slice(0, MAX_ID_LENGTH) : null,
    date: isValidCalendarDate(date) && date >= month.start && date <= month.end ? date : null,
    source: (COMMISSION_SOURCES as readonly string[]).includes(source ?? '') ? (source as CommissionSource) : null,
  }
}

export function parseCommissionDetailPageSize(raw: string | undefined): number {
  const n = Number(raw)
  return (COMMISSION_DETAIL_PAGE_SIZES as readonly number[]).includes(n) ? n : DEFAULT_COMMISSION_DETAIL_PAGE_SIZE
}

/**
 * 游标绑定的筛选签名：换了范围 / 月份 / 员工 / 门店 / 日期 / 类型后，旧游标指向的是另一个集合里的位置，
 * 继续用会从中间开始翻（看起来像漏行）。签名不符就当没有游标、回到第一页。
 */
export function commissionFilterSignature(parts: Record<string, string | null | undefined>): string {
  return Object.keys(parts)
    .sort()
    .map((key) => `${key}=${parts[key] ?? ''}`)
    .join('&')
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): string {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  return new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)))
}

export function encodeCommissionCursor(key: CommissionDetailKey, signature: string): string {
  return toBase64Url(JSON.stringify({ d: key.d, t: key.t, id: key.id, s: signature }))
}

/** 解析失败 / 签名不符 / 字段不合法一律返回 null（回到第一页），不抛错：URL 可被手改 */
export function decodeCommissionCursor(raw: string | undefined | null, signature: string): CommissionDetailKey | null {
  if (!raw || raw.length > 400) return null
  try {
    const parsed = JSON.parse(fromBase64Url(raw)) as Record<string, unknown>
    if (parsed.s !== signature) return null
    const { d, t, id } = parsed
    if (typeof d !== 'string' || !isValidCalendarDate(d)) return null
    if (t !== 'sale' && t !== 'service') return null
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null
    return { d, t, id }
  } catch {
    return null
  }
}

/**
 * 明细排序：(日期 DESC, 来源类型 ASC, 来源表主键 DESC)。纯函数版供单测与导出拼接校验，
 * 与 SQL 的 ORDER BY 同一顺序（'sale' < 'service' 按字典序）。
 */
export function compareCommissionKeys(a: CommissionDetailKey, b: CommissionDetailKey): number {
  if (a.d !== b.d) return a.d < b.d ? 1 : -1
  if (a.t !== b.t) return a.t < b.t ? -1 : 1
  return b.id - a.id
}

// ─── 下钻链接 ────────────────────────────────────────────────────────────────

const DETAIL_PATH = DATA_CENTER_REPORTS.commissionDetail.path

/**
 * 日报 → 明细的链接。范围与月份沿用日报（明细在同一 scope 内再按员工 / 门店收窄）；
 * 合并视图不带门店（不限门店）；日期格带 date，双列视图的业绩 / 消耗格带 type。
 * `returnTo` 让面包屑中间一级「员工提成日报」回到下钻前的筛选状态。
 */
export function commissionDetailHref(input: {
  scope?: string | null
  scopeId?: string | null
  month: string
  employeeId: string
  storeId?: string | null
  date?: string | null
  source?: CommissionSource | null
  returnTo?: string | null
}): string {
  const params = new URLSearchParams()
  if (input.scope) params.set('scope', input.scope)
  if (input.scopeId) params.set('scopeId', input.scopeId)
  params.set('month', input.month)
  params.set('employeeId', input.employeeId)
  if (input.storeId) params.set('storeId', input.storeId)
  if (input.date) params.set('date', input.date)
  if (input.source) params.set('type', input.source)
  if (input.returnTo) params.set('returnTo', input.returnTo)
  return `${DETAIL_PATH}?${params.toString()}`
}

/** 明细页的非取数参数：导出时剔除（游标、分页大小、返回地址——returnTo 可能超过导出参数的 240 字上限） */
export const COMMISSION_NON_FILTER_PARAMS = ['after', 'before', 'size', 'returnTo', 'page'] as const

export function commissionExportParams(entries: Iterable<[string, string]>): Record<string, string> {
  const dropped = new Set<string>(COMMISSION_NON_FILTER_PARAMS)
  return Object.fromEntries(
    [...entries]
      .filter(([key, value]) => !dropped.has(key) && value !== '')
      // 搜索词与页面取数同一截断（手改 URL 的超长 q 不能让导出按另一个关键词取数，也不能撑爆导出参数上限）
      .map(([key, value]) => [key, key === 'q' ? value.trim().slice(0, MAX_SEARCH_LENGTH) : value]),
  )
}
