/**
 * 顾客频率表（#370）的纯逻辑：参数、行模型、指标卡、搜索 / 只看有到店、排序、合计、分页、列定义、导出格。
 *
 * 取数 SQL 在 `customer-frequency-query.ts`（一条语句、一个快照）；页面、Server Action、异步导出都从这里派生。
 * 金额一律按「分」累加（整数），本月消费合计才能和销售板「总业绩」逐分对上，不带浮点累加误差。
 *
 * 口径见 customer-frequency-query.ts 文件头与 notes/references/metrics.md「顾客频率表」。
 */
import { formatPhoneSafe } from '@/lib/format'
import { resolvePaging } from '@/lib/paging'
import type { ExportCell } from '@/export-worker/xlsx-writer'
import type { CustomerFrequencySourceRow } from './customer-frequency-query'
import { listMonthDays, type MatrixMonthDay, type MatrixSort, type MatrixTotals } from './matrix'
import type { MatrixExportColumnSpec } from './matrix-export'
import { parseScope } from './params'
import { parseReportMonth, REPORT_MIN_MONTH, type ReportMonthPeriod } from './report-period'
import type { DataCenterScope } from './types'

// ─── 常量 ────────────────────────────────────────────────────────────────────

/**
 * ☆ 到店频次分档（按到店**天数**，#298 / §十.8①；交付前待甲方确认）。
 * 只统计本月有到店的顾客，0 次不入任何一档，所以 低 + 中 + 高 = 有到店顾客。`max: null` = 不设上限。
 */
export const CUSTOMER_FREQUENCY_TIERS = [
  { key: 'low', label: '低频', min: 1, max: 2 },
  { key: 'mid', label: '中频', min: 3, max: 4 },
  { key: 'high', label: '高频', min: 5, max: null },
] as const satisfies ReadonlyArray<{ key: string; label: string; min: number; max: number | null }>

export type CustomerFrequencyTierKey = (typeof CUSTOMER_FREQUENCY_TIERS)[number]['key']

export const CUSTOMER_FREQUENCY_PAGE_SIZES = [20, 50, 100] as const
export const CUSTOMER_FREQUENCY_DEFAULT_PAGE_SIZE = 50

/** 可排序列（URL `sort=`）。默认按本月到店次数降序。 */
export const CUSTOMER_FREQUENCY_SORT_KEYS = ['visitDays', 'amount'] as const
export type CustomerFrequencySortKey = (typeof CUSTOMER_FREQUENCY_SORT_KEYS)[number]
export const CUSTOMER_FREQUENCY_DEFAULT_SORT: CustomerFrequencyParams['sort'] = { key: 'visitDays', direction: 'desc' }

/** 顾客搜索最长字数（页面输入框 maxLength 与服务端截断同一个值） */
export const CUSTOMER_FREQUENCY_SEARCH_MAX_LENGTH = 50

/** 列 key */
export const FREQUENCY_DAY_KEY_PREFIX = 'day:'
export const FREQUENCY_VISIT_DAYS_KEY = 'visitDays'
export const FREQUENCY_AMOUNT_KEY = 'amount'

// ─── 参数 ────────────────────────────────────────────────────────────────────

export type CustomerFrequencyShow = 'all' | 'visited'

export interface CustomerFrequencyParams {
  scope: DataCenterScope
  period: ReportMonthPeriod
  /** 顾客搜索：姓名模糊；手机号只认完整号码精确匹配 */
  q: string
  show: CustomerFrequencyShow
  sort: MatrixSort & { key: CustomerFrequencySortKey }
  page: number
  pageSize: number
}

function isSortKey(value: string | undefined): value is CustomerFrequencySortKey {
  return (CUSTOMER_FREQUENCY_SORT_KEYS as readonly string[]).includes(value ?? '')
}

/**
 * URL 参数 → 取数参数。页面、Server Action、导出任务共用，三处看同一份筛选。
 * URL 键：scope / scopeId / month / q / show=visited / sort / dir / page / size（导出时 page、size 被剔除）。
 * 排序 key 不在白名单回落默认（URL 可被手改，不值得整页报错）。
 */
export function parseCustomerFrequencyParams(
  input: Record<string, string | undefined>,
  today?: string,
): CustomerFrequencyParams {
  // Server Action 可被直接调用，入参原样到达：非字符串一律当缺省，不让 .trim() / .match() 抛成 500
  const raw = (key: string): string | undefined => (typeof input[key] === 'string' ? input[key] : undefined)
  const { page, pageSize } = resolveCustomerFrequencyPaging(raw('page'), Number(raw('size')))
  const sortKey = raw('sort')
  const sort = isSortKey(sortKey)
    ? { key: sortKey, direction: raw('dir') === 'asc' ? 'asc' as const : 'desc' as const }
    : CUSTOMER_FREQUENCY_DEFAULT_SORT
  return {
    scope: parseScope({ scope: raw('scope'), scopeId: raw('scopeId') }),
    period: parseReportMonth({ month: raw('month') }, today),
    q: (raw('q') ?? '').trim().slice(0, CUSTOMER_FREQUENCY_SEARCH_MAX_LENGTH),
    show: raw('show') === 'visited' ? 'visited' : 'all',
    sort,
    page,
    pageSize,
  }
}

/** 页码 / 每页条数归一（#281 单源 resolvePaging；每页条数白名单与页面下拉一致） */
export function resolveCustomerFrequencyPaging(page: unknown, pageSize: unknown) {
  return resolvePaging({
    page,
    pageSize,
    defaultPageSize: CUSTOMER_FREQUENCY_DEFAULT_PAGE_SIZE,
    allowedPageSizes: [...CUSTOMER_FREQUENCY_PAGE_SIZES],
  })
}

/** 早于系统数据起点的月份（URL 手工传入）：不取数，页面显示空表 + 数据起点提示 */
export function isBeforeFrequencyDataStart(month: string): boolean {
  return month < REPORT_MIN_MONTH
}

// ─── 行模型 ──────────────────────────────────────────────────────────────────

/** 一个日历格。没有任何事件的日子不出现在 `days` 里（留空）。 */
export interface FrequencyCell {
  /** 当日到店（服务日 ∪ 支付日）→ ✓ */
  visited: boolean
  /** 当日款项净额（元）；null = 当日没有款项 */
  amount: number | null
  /** 当日实耗（元）；null = 当日没有计入消耗的服务 */
  consume: number | null
  /** 当日服务项目 */
  items: string[]
  /** 发生门店（到店单据门店 ∪ 款项门店） */
  stores: string[]
}

/** 返回给页面 / 导出的一行（手机号已脱敏） */
export interface CustomerFrequencyRow {
  clientUserId: string
  customerName: string
  phoneMasked: string
  /** member_level，为空时 customer_type（#367 横切约束） */
  level: string
  storeName: string
  /** 键 = 日（1~31 的字符串） */
  days: Record<string, FrequencyCell>
  visitDays: number
  /** 本月消费合计（元） */
  amount: number
  /** 本月消耗合计（元，不单列，仅供指标卡） */
  consume: number
}

/** 服务端内部行：多带原始手机号（只用于完整号码匹配）与分为单位的合计 */
export interface CustomerFrequencyModelRow extends CustomerFrequencyRow {
  rawPhone: string
  amountCents: number
  consumeCents: number
}

function toCents(value: string | null): number | null {
  if (value == null || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null
}

/** 把 SQL 行（顾客 × 日）折叠成「一位顾客一行」。行顺序按 clientUserId，后续排序再定。 */
export function buildCustomerFrequencyRows(source: readonly CustomerFrequencySourceRow[]): CustomerFrequencyModelRow[] {
  const byClient = new Map<string, CustomerFrequencyModelRow>()
  for (const item of source) {
    let row = byClient.get(item.clientUserId)
    if (!row) {
      row = {
        clientUserId: item.clientUserId,
        customerName: item.customerName ?? '',
        phoneMasked: item.phone ? formatPhoneSafe(normalizePhone(item.phone)) : '',
        rawPhone: normalizePhone(item.phone),
        level: item.memberLevel || item.customerType || '',
        storeName: item.storeName ?? '',
        days: {},
        visitDays: 0,
        amount: 0,
        consume: 0,
        amountCents: 0,
        consumeCents: 0,
      }
      byClient.set(item.clientUserId, row)
    }
    if (!item.day) continue
    const day = String(Number(item.day.slice(8, 10)))
    const amountCents = toCents(item.amount)
    const consumeCents = toCents(item.consume)
    row.days[day] = {
      visited: item.visited,
      amount: amountCents == null ? null : amountCents / 100,
      consume: consumeCents == null ? null : consumeCents / 100,
      items: item.items,
      stores: item.stores,
    }
    if (item.visited) row.visitDays += 1
    row.amountCents += amountCents ?? 0
    row.consumeCents += consumeCents ?? 0
  }
  const rows = Array.from(byClient.values())
  for (const row of rows) {
    row.amount = row.amountCents / 100
    row.consume = row.consumeCents / 100
  }
  return rows
}

export function tierOf(visitDays: number): CustomerFrequencyTierKey | null {
  for (const tier of CUSTOMER_FREQUENCY_TIERS) {
    if (visitDays >= tier.min && (tier.max === null || visitDays <= tier.max)) return tier.key
  }
  return null
}

// ─── 指标卡 ──────────────────────────────────────────────────────────────────

export interface CustomerFrequencySummary {
  /** ☆ 范围内全部绑店顾客（含 0 次到店） */
  customerCount: number
  visitedCount: number
  /** 有到店 ÷ 统计顾客数；统计顾客数为 0 → null */
  visitRate: number | null
  tiers: Record<CustomerFrequencyTierKey, { count: number; share: number | null }>
  /** 到店总人次 = 各行到店天数之和 */
  visitTotal: number
  /** 人均到店 = 到店总人次 ÷ 有到店顾客 */
  visitsPerVisitor: number | null
  amountTotal: number
  consumeTotal: number
  /** 消耗 / 消费；消费合计 ≤ 0 → null */
  consumeRatio: number | null
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null
}

/** 指标卡：按范围全量计算，不受搜索、只看有到店、分页影响 */
export function summarizeCustomerFrequency(rows: readonly CustomerFrequencyModelRow[]): CustomerFrequencySummary {
  const tierCounts: Record<CustomerFrequencyTierKey, number> = { low: 0, mid: 0, high: 0 }
  let visitedCount = 0
  let visitTotal = 0
  let amountCents = 0
  let consumeCents = 0
  for (const row of rows) {
    const tier = tierOf(row.visitDays)
    if (tier) tierCounts[tier] += 1
    if (row.visitDays > 0) visitedCount += 1
    visitTotal += row.visitDays
    amountCents += row.amountCents
    consumeCents += row.consumeCents
  }
  const tiers = Object.fromEntries(
    CUSTOMER_FREQUENCY_TIERS.map((tier) => [tier.key, { count: tierCounts[tier.key], share: ratio(tierCounts[tier.key], visitedCount) }]),
  ) as CustomerFrequencySummary['tiers']
  return {
    customerCount: rows.length,
    visitedCount,
    visitRate: ratio(visitedCount, rows.length),
    tiers,
    visitTotal,
    visitsPerVisitor: ratio(visitTotal, visitedCount),
    amountTotal: amountCents / 100,
    consumeTotal: consumeCents / 100,
    consumeRatio: ratio(consumeCents, amountCents),
  }
}

// ─── 搜索 / 排序 / 合计 ──────────────────────────────────────────────────────

const FULL_PHONE = /^1\d{10}$/

/**
 * 手机号归一成 11 位：去掉空格 / 连字符 / +86、0086、86 前缀（WorkFine 导入的号码有这类脏格式），
 * 归一不出 11 位手机号的原样返回（只会精确匹配不上，不会误配）。
 */
export function normalizePhone(phone: string | null | undefined): string {
  const digits = (phone ?? '').replace(/[\s-]/g, '').replace(/^(?:\+|00)?86(?=1\d{10}$)/, '')
  return digits
}

/** 导出说明里回显的搜索词：完整手机号脱敏，其余原样（导出件不得出现明文手机号） */
export function displaySearchTerm(q: string): string {
  // 先归一再判：粘贴的 +86 / 带空格号码也是完整手机号，不能原样回显
  const phone = normalizePhone(q)
  return FULL_PHONE.test(phone) ? formatPhoneSafe(phone) : q
}

/** 搜索与「只看有到店」：只影响表格行与导出行，不影响指标卡 */
export function filterCustomerFrequencyRows(
  rows: readonly CustomerFrequencyModelRow[],
  params: Pick<CustomerFrequencyParams, 'q' | 'show'>,
): CustomerFrequencyModelRow[] {
  const q = params.q
  const normalized = normalizePhone(q)
  const phone = FULL_PHONE.test(normalized) ? normalized : null
  const name = q.toLowerCase()
  return rows.filter((row) => {
    if (params.show === 'visited' && row.visitDays === 0) return false
    if (!q) return true
    if (phone) return row.rawPhone === phone
    return row.customerName.toLowerCase().includes(name)
  })
}

/**
 * 排序：所选列按方向，另一汇总列降序次之，最后按顾客 id 升序兜底（#282，翻页不重复不漏行）。
 * 默认 = 到店次数降序 → 消费降序 → 顾客 id。
 */
export function sortCustomerFrequencyRows(
  rows: readonly CustomerFrequencyModelRow[],
  sort: CustomerFrequencyParams['sort'],
): CustomerFrequencyModelRow[] {
  const sign = sort.direction === 'asc' ? 1 : -1
  const primary = sort.key === 'amount' ? (row: CustomerFrequencyModelRow) => row.amountCents : (row: CustomerFrequencyModelRow) => row.visitDays
  const secondary = sort.key === 'amount' ? (row: CustomerFrequencyModelRow) => row.visitDays : (row: CustomerFrequencyModelRow) => row.amountCents
  return [...rows].sort((a, b) =>
    (primary(a) - primary(b)) * sign
    || secondary(b) - secondary(a)
    || (a.clientUserId < b.clientUserId ? -1 : a.clientUserId > b.clientUserId ? 1 : 0),
  )
}

/** 表尾合计：当前筛选结果全部分页之和（不是本页小计） */
export function customerFrequencyTotals(rows: readonly CustomerFrequencyModelRow[]): MatrixTotals {
  let visitDays = 0
  let amountCents = 0
  for (const row of rows) {
    visitDays += row.visitDays
    amountCents += row.amountCents
  }
  return { [FREQUENCY_VISIT_DAYS_KEY]: visitDays, [FREQUENCY_AMOUNT_KEY]: amountCents / 100 }
}

/** 剥掉服务端内部字段（原始手机号、分为单位的合计），Server Action 只返回这个形状 */
export function toPublicFrequencyRow(row: CustomerFrequencyModelRow): CustomerFrequencyRow {
  return {
    clientUserId: row.clientUserId,
    customerName: row.customerName,
    phoneMasked: row.phoneMasked,
    level: row.level,
    storeName: row.storeName,
    days: row.days,
    visitDays: row.visitDays,
    amount: row.amount,
    consume: row.consume,
  }
}

// ─── 单元格 ──────────────────────────────────────────────────────────────────

/** 金额按分判零：退款相抵后的 0 不显示金额 */
export function hasCellAmount(cell: FrequencyCell | undefined): cell is FrequencyCell & { amount: number } {
  return cell?.amount != null && Math.round(cell.amount * 100) !== 0
}

/** 悬停提示：当日消耗、服务项目、发生门店。空格没有提示。 */
export function frequencyCellHint(cell: FrequencyCell | undefined): string | null {
  if (!cell) return null
  // 没到店、款项又相抵为 0 的日子页面上是空格，悬停也不该冒出一条「未到店」
  if (!cell.visited && !hasCellAmount(cell)) return null
  const parts: string[] = []
  if (!cell.visited) parts.push('当日未到店（仅有款项归属到这一天）')
  if (hasCellAmount(cell)) parts.push(`当日消费 ¥${cell.amount.toFixed(2)}`)
  if (cell.consume != null) parts.push(`当日消耗 ¥${cell.consume.toFixed(2)}`)
  if (cell.items.length > 0) parts.push(`服务项目：${cell.items.join('、')}`)
  if (cell.stores.length > 0) parts.push(`发生门店：${cell.stores.join('、')}`)
  return parts.length > 0 ? parts.join('；') : null
}

// ─── 列定义 ──────────────────────────────────────────────────────────────────

export type FrequencyColumnSpec = MatrixExportColumnSpec<CustomerFrequencyRow> & { day?: MatrixMonthDay }

/** 页面列骨架：左 4 列冻结 + 当月 1~N 日 + 右侧两列汇总冻结 */
export function customerFrequencyColumnSpecs(month: string): FrequencyColumnSpec[] {
  const dayGroup = { key: 'days', header: '本月日历' }
  const totalGroup = { key: 'month-total', header: '本月合计' }
  return [
    { key: 'name', header: '姓名', width: 88, freeze: 'left', exportValue: (row) => row.customerName },
    { key: 'phone', header: '电话', width: 116, freeze: 'left', exportValue: (row) => row.phoneMasked, exportWidth: 14 },
    { key: 'level', header: '会员等级', width: 88, freeze: 'left', exportValue: (row) => row.level, exportWidth: 10 },
    { key: 'store', header: '所属门店', width: 104, freeze: 'left', exportValue: (row) => row.storeName },
    ...listMonthDays(month).map((day): FrequencyColumnSpec => ({
      key: `${FREQUENCY_DAY_KEY_PREFIX}${day.day}`,
      header: String(day.day),
      group: dayGroup,
      width: 64,
      day,
    })),
    {
      key: FREQUENCY_VISIT_DAYS_KEY,
      header: '到店次数',
      group: totalGroup,
      width: 88,
      freeze: 'right',
      unit: 'count',
      value: (row) => row.visitDays,
      aggregate: { kind: 'sum' },
      exportWidth: 10,
    },
    {
      key: FREQUENCY_AMOUNT_KEY,
      header: '消费合计',
      group: totalGroup,
      width: 112,
      freeze: 'right',
      unit: 'amount',
      value: (row) => row.amount,
      aggregate: { kind: 'sum' },
      exportWidth: 14,
    },
  ]
}

/** ✓ 与当日金额（页面格文案同源；导出形态见 frequencyExportColumnSpecs） */
export function frequencyVisitMark(cell: FrequencyCell | undefined): ExportCell {
  return cell?.visited ? '✓' : ''
}

export function frequencyAmountCell(cell: FrequencyCell | undefined): number | null {
  return hasCellAmount(cell) ? cell.amount : null
}

/**
 * 导出列：日期格拆成「到店 / 金额」两列（导出形态 ②），金额保持数值型，Excel 里可直接求和。
 *   - 到店且金额为 0 → 「到店」列 ✓、「金额」列空
 *   - 没到店但有金额（只有退款、归属日与支付日不在同一天）→ 「到店」列空、「金额」列写数
 * 其余列与页面同一份列骨架（表头、分组、单位、合计口径不漂移）。
 */
export function frequencyExportColumnSpecs(month: string): FrequencyColumnSpec[] {
  return customerFrequencyColumnSpecs(month).flatMap((spec): FrequencyColumnSpec[] => {
    if (!spec.day) return [spec]
    const day = spec.day
    const key = String(day.day)
    const group = { key: `day-${key}`, header: `${day.day}日` }
    return [
      { key: `${spec.key}:visit`, header: '到店', group, exportValue: (row) => frequencyVisitMark(row.days[key]), exportWidth: 5 },
      {
        key: `${spec.key}:amount`,
        header: '金额',
        group,
        unit: 'amount',
        value: (row) => frequencyAmountCell(row.days[key]),
        exportWidth: 11,
      },
    ]
  })
}
