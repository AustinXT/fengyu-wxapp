/**
 * 顾客剩余卡项清单（#371）的纯逻辑：格态判定、行模型、指标卡、搜索 / 显示范围、排序、合计、分页、列定义。
 *
 * 取数 SQL 在 `remaining-cards-query.ts`（一条语句、一个快照），页面、Server Action、异步导出都从这里派生，
 * 所以三层勾稽（行合计 = 各格之和；表尾 = 全部筛选行之和；无搜索时表尾总计 = 指标卡）只依赖本文件的算法。
 *
 * 口径（☆ 为默认，交付前待甲方确认，见 notes/references/metrics.md「顾客剩余卡项清单」）：
 *   - 行 = 顾客 × 卡权益门店（sale_items.store_id）；全局没有计入卡行的顾客按绑定门店出一行
 *   - 剩余次数 = 已付未用（paidUnusedSessionsExpr），剔除已退完 / 已过期的卡行
 *   - 格态：Σ已付未用 > 0 → 有剩余；否则 Σ物理剩余 > 0 → 待付清；否则 → 已服务完；
 *     只剩过期卡 → 已过期（四态合计里并入「未买过」）；没有卡行 → 未买过
 */
import { formatPhoneSafe } from '@/lib/format'
import { resolvePaging } from '@/lib/paging'
import type { MatrixExportColumnSpec } from './matrix-export'
import type { MatrixTotals } from './matrix'
import { parseScope } from './params'
import type { DataCenterScope } from './types'

// ─── 参数 ────────────────────────────────────────────────────────────────────

export const REMAINING_CARDS_PAGE_SIZES = [20, 50, 100] as const
export const REMAINING_CARDS_DEFAULT_PAGE_SIZE = 50

/** 显示范围：全部顾客 / 只看有剩余 */
export type RemainingCardsShow = 'all' | 'remaining'

export interface RemainingCardsParams {
  scope: DataCenterScope
  /** 顾客搜索（姓名 / 门店 / 会员等级模糊；手机号只认完整号码精确匹配） */
  q: string
  show: RemainingCardsShow
  /** 剩余次数排序方向，默认从多到少 */
  direction: 'asc' | 'desc'
  page: number
  pageSize: number
}

/**
 * URL 参数 → 取数参数。页面、Server Action、导出任务共用，三处看同一份筛选。
 * URL 键：scope / scopeId / q / show=remaining / dir=asc / page / size（导出时 page、size 被剔除）。
 */
export function parseRemainingCardsParams(raw: Record<string, string | undefined>): RemainingCardsParams {
  // 每页条数白名单严格按 number 匹配，URL 来的字符串先转数值
  const { page, pageSize } = resolveRemainingCardsPaging(raw.page, Number(raw.size))
  return {
    scope: parseScope({ scope: raw.scope, scopeId: raw.scopeId }),
    q: (raw.q ?? '').trim().slice(0, 50),
    show: raw.show === 'remaining' ? 'remaining' : 'all',
    direction: raw.dir === 'asc' ? 'asc' : 'desc',
    page,
    pageSize,
  }
}

/** 页码 / 每页条数归一（#281 单源 resolvePaging；每页条数白名单与页面下拉一致） */
export function resolveRemainingCardsPaging(page: unknown, pageSize: unknown) {
  return resolvePaging({
    page,
    pageSize,
    defaultPageSize: REMAINING_CARDS_DEFAULT_PAGE_SIZE,
    allowedPageSizes: [...REMAINING_CARDS_PAGE_SIZES],
  })
}

// ─── 取数结果（SQL 行）→ 行模型 ──────────────────────────────────────────────

/** 二级品项字典项（含一级分组与排序权重） */
export interface RemainingCardsCategory {
  /** 列 key 中使用的品项标识；历史无分类卡为 UNCATEGORIZED_KEY */
  categoryId: string
  categoryName: string
  kind: string
  kindSort: number
  sort: number
}

export const UNCATEGORIZED_KEY = '__none__'
const UNCATEGORIZED: Omit<RemainingCardsCategory, 'categoryId'> = {
  categoryName: '未分类',
  kind: '未分类',
  kindSort: Number.MAX_SAFE_INTEGER,
  sort: 0,
}

/** SQL 按（行，二级）聚合后的一格，已剔除已退完的卡行；过期卡行单独计数 */
export interface RemainingCellAggregate {
  categoryId: string | null
  /** 未过期卡行的 Σ已付未用 */
  remaining: number
  /** 未过期卡行的 Σ(物理剩余 − 已付未用)，即欠款未付的次数 */
  unpaid: number
  activeRows: number
  expiredRows: number
  /** 已完成服务单的 Σsession_used（不含折抵转走） */
  served: number
  /** 未关闭转换单转出的次数 */
  convertedOut: number
  deposit: boolean
  /** 未过期卡行所在订单有待审批退款（次数不扣，仅标注） */
  frozen: boolean
}

export interface RemainingCardsSqlRow {
  clientUserId: string
  storeId: string
  storeName: string
  customerName: string | null
  /** 原始手机号：只在服务端用于完整号码匹配，绝不出现在返回值 / 导出里 */
  phone: string | null
  memberLevel: string | null
  customerType: string | null
  /** 无卡顾客（按绑定门店出行）为空数组 */
  cells: RemainingCellAggregate[]
}

export type RemainingCellState = 'remaining' | 'unpaid' | 'done' | 'expired'

export interface RemainingCell {
  state: RemainingCellState
  /** 有剩余时的剩余次数（其余态为 0） */
  remaining: number
  unpaid: number
  served: number
  convertedOut: number
  deposit: boolean
  frozen: boolean
}

/** 返回给页面 / 导出的行（电话已脱敏） */
export interface RemainingCardsRow {
  /** `${clientUserId}:${storeId}`，行唯一键 */
  key: string
  clientUserId: string
  storeId: string
  storeName: string
  customerName: string
  phoneMasked: string
  /** member_level，为空时显示 customer_type（#367 横切约束） */
  level: string
  /** 行剩余合计 = 各「有剩余」格之和 */
  remaining: number
  /** 只含有卡行的格（未买过的格不出现） */
  cells: Record<string, RemainingCell>
}

interface InternalRow extends RemainingCardsRow {
  rawPhone: string
  memberLevel: string
  customerType: string
}

/**
 * 格态判定：先剔除已退完（SQL 已做）与已过期的卡行，按顺序判 有剩余 → 待付清 → 已服务完；
 * 只剩过期卡行时为「已过期」。没有任何卡行的格不产生（= 未买过）。
 */
export function resolveCellState(cell: Pick<RemainingCellAggregate, 'remaining' | 'unpaid' | 'activeRows' | 'expiredRows'>): RemainingCellState | null {
  if (cell.activeRows > 0) {
    if (cell.remaining > 0) return 'remaining'
    if (cell.unpaid > 0) return 'unpaid'
    return 'done'
  }
  return cell.expiredRows > 0 ? 'expired' : null
}

export interface RemainingCardsModel {
  /** 当前范围内有人持卡的二级品项，按（一级 sort_order，二级 sort_order）排 */
  columns: RemainingCardsCategory[]
  rows: InternalRow[]
}

export function categoryKey(categoryId: string | null): string {
  return categoryId ?? UNCATEGORIZED_KEY
}

export function buildRemainingCardsModel(
  sqlRows: readonly RemainingCardsSqlRow[],
  dictionary: readonly RemainingCardsCategory[],
): RemainingCardsModel {
  const byId = new Map(dictionary.map((category) => [category.categoryId, category]))
  const used = new Map<string, RemainingCardsCategory>()

  const rows = sqlRows.map((source): InternalRow => {
    const cells: Record<string, RemainingCell> = {}
    let remaining = 0
    for (const aggregate of source.cells) {
      const state = resolveCellState(aggregate)
      if (!state) continue
      const key = categoryKey(aggregate.categoryId)
      if (!used.has(key)) {
        // 字典里查不到（SKU 挂了已删除的分类）与无分类卡一样归「未分类」列，不丢次数
        const known = aggregate.categoryId ? byId.get(aggregate.categoryId) : undefined
        used.set(key, known ?? { categoryId: key, ...UNCATEGORIZED })
      }
      const cellRemaining = state === 'remaining' ? aggregate.remaining : 0
      remaining += cellRemaining
      cells[key] = {
        state,
        remaining: cellRemaining,
        unpaid: aggregate.unpaid,
        served: aggregate.served,
        convertedOut: aggregate.convertedOut,
        deposit: aggregate.deposit,
        frozen: aggregate.frozen,
      }
    }
    const memberLevel = source.memberLevel ?? ''
    const customerType = source.customerType ?? ''
    return {
      key: `${source.clientUserId}:${source.storeId}`,
      clientUserId: source.clientUserId,
      storeId: source.storeId,
      storeName: source.storeName,
      customerName: source.customerName ?? '',
      phoneMasked: source.phone ? formatPhoneSafe(source.phone) : '',
      level: memberLevel || customerType,
      remaining,
      cells,
      rawPhone: source.phone ?? '',
      memberLevel,
      customerType,
    }
  })

  // 未分类列的 key 本身不在字典里，所以按 used 的值（而不是字典）排序
  const columns = [...used.values()].sort((a, b) =>
    a.kindSort - b.kindSort
    || a.kind.localeCompare(b.kind, 'zh-CN')
    || a.sort - b.sort
    || a.categoryName.localeCompare(b.categoryName, 'zh-CN')
    || (a.categoryId < b.categoryId ? -1 : a.categoryId > b.categoryId ? 1 : 0))

  return { columns, rows }
}

// ─── 指标卡（范围全量，不受搜索 / 显示范围影响）─────────────────────────────

export interface RemainingCardsSummary {
  /** 行数（顾客 × 卡权益门店） */
  rowCount: number
  /** 统计顾客数（去重，多店持卡只算 1 位） */
  customerCount: number
  /** 有剩余卡项顾客 */
  remainingCustomerCount: number
  /** 有剩余卡项顾客占比（0-1；没有顾客时为 null） */
  remainingCustomerRate: number | null
  /** 待服务剩余次数 */
  remainingSessions: number
  /** 待服务剩余涉及的二级品项数 */
  remainingCategoryCount: number
  /** 四态项次 */
  remainingCells: number
  unpaidCells: number
  doneCells: number
  /** 未买过（含已过期）= 行数 × 列数 − 有剩余 − 待付清 − 已服务完 */
  neverCells: number
  expiredCells: number
  /** 列数（二级）与一级分组数 */
  categoryCount: number
  kindCount: number
}

export function summarizeRemainingCards(model: RemainingCardsModel): RemainingCardsSummary {
  const customers = new Set<string>()
  const remainingCustomers = new Set<string>()
  const remainingCategories = new Set<string>()
  let remainingSessions = 0
  let remainingCells = 0
  let unpaidCells = 0
  let doneCells = 0
  let expiredCells = 0
  for (const row of model.rows) {
    customers.add(row.clientUserId)
    if (row.remaining > 0) remainingCustomers.add(row.clientUserId)
    remainingSessions += row.remaining
    for (const [key, cell] of Object.entries(row.cells)) {
      if (cell.state === 'remaining') {
        remainingCells += 1
        remainingCategories.add(key)
      } else if (cell.state === 'unpaid') unpaidCells += 1
      else if (cell.state === 'done') doneCells += 1
      else expiredCells += 1
    }
  }
  const categoryCount = model.columns.length
  const rowCount = model.rows.length
  return {
    rowCount,
    customerCount: customers.size,
    remainingCustomerCount: remainingCustomers.size,
    remainingCustomerRate: customers.size > 0 ? remainingCustomers.size / customers.size : null,
    remainingSessions,
    remainingCategoryCount: remainingCategories.size,
    remainingCells,
    unpaidCells,
    doneCells,
    neverCells: rowCount * categoryCount - remainingCells - unpaidCells - doneCells,
    expiredCells,
    categoryCount,
    kindCount: new Set(model.columns.map((column) => column.kind)).size,
  }
}

// ─── 搜索 / 显示范围 / 排序 ─────────────────────────────────────────────────

/** 完整手机号（11 位、1 开头）。部分号码不按电话匹配，防止从脱敏号码反推（原型 §十.4 的收紧） */
const FULL_PHONE = /^1\d{10}$/

export function filterRemainingCardsRows<T extends InternalRow>(
  rows: readonly T[],
  filter: Pick<RemainingCardsParams, 'q' | 'show'>,
): T[] {
  const q = filter.q.trim().toLowerCase()
  const phone = FULL_PHONE.test(q) ? q : null
  return rows.filter((row) => {
    if (filter.show === 'remaining' && row.remaining <= 0) return false
    if (!q) return true
    if (phone && row.rawPhone === phone) return true
    return [row.customerName, row.storeName, row.memberLevel, row.customerType]
      .some((text) => text.toLowerCase().includes(q))
  })
}

const NAME_COLLATOR = new Intl.Collator('zh-CN')

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 剩余次数（默认从多到少）→ 顾客姓名 → 顾客 id → 门店 id（#282 唯一键兜底） */
export function sortRemainingCardsRows<T extends RemainingCardsRow>(rows: readonly T[], direction: 'asc' | 'desc'): T[] {
  const sign = direction === 'asc' ? 1 : -1
  return [...rows].sort((a, b) =>
    (a.remaining - b.remaining) * sign
    || NAME_COLLATOR.compare(a.customerName, b.customerName)
    || compareText(a.customerName, b.customerName)
    || compareText(a.clientUserId, b.clientUserId)
    || compareText(a.storeId, b.storeId))
}

/** 表尾合计：按传入的全部行（= 当前筛选结果全部分页）逐列求和 */
export function remainingCardsTotals(rows: readonly RemainingCardsRow[], columns: readonly RemainingCardsCategory[]): MatrixTotals {
  const totals: MatrixTotals = { [REMAINING_TOTAL_KEY]: 0 }
  for (const column of columns) totals[columnKey(column)] = 0
  for (const row of rows) {
    totals[REMAINING_TOTAL_KEY] = (totals[REMAINING_TOTAL_KEY] ?? 0) + row.remaining
    for (const [key, cell] of Object.entries(row.cells)) {
      if (cell.state !== 'remaining') continue
      const column = `${CATEGORY_KEY_PREFIX}${key}`
      totals[column] = (totals[column] ?? 0) + cell.remaining
    }
  }
  return totals
}

/** 去掉服务端内部字段（原始电话等）再返回 */
export function toPublicRow(row: InternalRow): RemainingCardsRow {
  return {
    key: row.key,
    clientUserId: row.clientUserId,
    storeId: row.storeId,
    storeName: row.storeName,
    customerName: row.customerName,
    phoneMasked: row.phoneMasked,
    level: row.level,
    remaining: row.remaining,
    cells: row.cells,
  }
}

// ─── 列定义（页面与导出同源）────────────────────────────────────────────────

export const CATEGORY_KEY_PREFIX = 'cat:'
export const REMAINING_TOTAL_KEY = 'remaining'

export function columnKey(column: Pick<RemainingCardsCategory, 'categoryId'>): string {
  return `${CATEGORY_KEY_PREFIX}${column.categoryId}`
}

export const REMAINING_CELL_LABELS: Record<RemainingCellState, string> = {
  remaining: '✓',
  unpaid: '待付清',
  done: '已服务完',
  expired: '已过期',
}

/** 格子悬停说明 */
export function remainingCellHint(cell: RemainingCell | undefined): string {
  if (!cell) return '未买过'
  const main = cell.state === 'remaining'
    ? `剩余 ${cell.remaining} 次未服务（已服务 ${cell.served} 次）`
    : cell.state === 'unpaid'
      ? `未付 ${cell.unpaid} 次`
      : cell.state === 'done'
        ? `已服务完（已服务 ${cell.served} 次${cell.convertedOut > 0 ? `；已折抵转出 ${cell.convertedOut} 次` : ''}）`
        : '已过期'
  const notes = [
    cell.deposit ? '含迁移寄存' : null,
    cell.frozen ? '有在途退款，次数暂未扣减' : null,
  ].filter(Boolean)
  return notes.length ? `${main}；${notes.join('；')}` : main
}

/** 导出格：有剩余写次数；待付清 / 已服务完 / 已过期写文字；未买过留空 */
export function remainingCellExportValue(cell: RemainingCell | undefined): string | number {
  if (!cell) return ''
  return cell.state === 'remaining' ? cell.remaining : REMAINING_CELL_LABELS[cell.state]
}

export const REMAINING_CARDS_FROZEN_WIDTHS = { store: 120, customer: 168, level: 88, remaining: 96 } as const

/**
 * 页面（MatrixTable）与导出共用的列骨架：左冻结 门店 / 顾客 / 会员等级，中间按一级分组的二级列，右冻结剩余合计。
 * 页面在此之上补 cell / tone / cellHint 渲染。
 */
export function remainingCardsColumnSpecs(columns: readonly RemainingCardsCategory[]): MatrixExportColumnSpec<RemainingCardsRow>[] {
  return [
    {
      key: 'store',
      header: '门店',
      freeze: 'left',
      width: REMAINING_CARDS_FROZEN_WIDTHS.store,
      exportValue: (row) => row.storeName,
      exportWidth: 16,
    },
    {
      key: 'customer',
      header: '顾客',
      freeze: 'left',
      width: REMAINING_CARDS_FROZEN_WIDTHS.customer,
      exportValue: (row) => [row.customerName, row.phoneMasked].filter(Boolean).join(' '),
      exportWidth: 22,
    },
    {
      key: 'level',
      header: '会员等级',
      freeze: 'left',
      width: REMAINING_CARDS_FROZEN_WIDTHS.level,
      exportValue: (row) => row.level,
      exportWidth: 12,
    },
    ...columns.map((column): MatrixExportColumnSpec<RemainingCardsRow> => ({
      key: columnKey(column),
      header: column.categoryName,
      group: { key: `kind:${column.kind}`, header: column.kind },
      unit: 'count',
      aggregate: { kind: 'server' },
      value: (row) => (row.cells[column.categoryId]?.state === 'remaining' ? row.cells[column.categoryId].remaining : null),
      exportValue: (row) => remainingCellExportValue(row.cells[column.categoryId]),
      exportWidth: 12,
    })),
    {
      key: REMAINING_TOTAL_KEY,
      header: '剩余次数',
      freeze: 'right',
      width: REMAINING_CARDS_FROZEN_WIDTHS.remaining,
      unit: 'count',
      aggregate: { kind: 'server' },
      value: (row) => row.remaining,
      exportWidth: 12,
    },
  ]
}
