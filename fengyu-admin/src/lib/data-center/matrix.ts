/**
 * 经营明细矩阵表（#368）的纯逻辑：分组表头、合计行、冻结列偏移、稳定排序、月内日期列。
 *
 * 页面组件 `data-center/_components/matrix-table.tsx` 与单测共用这里，React 层只负责渲染。
 * 只覆盖 5 张经营明细页已知的形态（两行表头、左 1~4 列 + 右侧合计列冻结、表尾合计、市场小计），
 * 不做任意深度表头等没人用的通用能力。
 */

/** 列的合计口径。缺省 `none`：合计行该列留空。 */
export type MatrixAggregate<T> =
  /** 可加列：合计 = 逐行求和（小计行不参与，否则同一笔钱会被算两遍） */
  | { kind: 'sum' }
  /**
   * 比率列：合计 = Σ分子 ÷ Σ分母，**不取各行比率的平均**。分母合计为 0 时给 null。
   * 分子分母用访问器取，允许它们不是页面上展示的列。
   */
  | { kind: 'ratio'; numerator: (row: T) => number | null | undefined; denominator: (row: T) => number | null | undefined }
  /** 只认服务端口径（去重计数，如美容师人数 #297）：逐行相加没有意义，服务端不给就留空 */
  | { kind: 'server' }
  | { kind: 'none' }

export interface MatrixColumnGroup {
  /** 分组身份。相邻且 key 相同的列合并为一个分组表头；同名不同组（如两个「合计」）靠 key 区分 */
  key: string
  header: string
  hint?: string
}

/** 纯逻辑层关心的列属性（React 层的 MatrixColumn 是它的超集）。 */
export interface MatrixColumnSpec<T> {
  key: string
  group?: MatrixColumnGroup
  /** 列宽（px）。冻结列必须给，否则算不出 sticky 偏移 */
  width?: number
  freeze?: 'left' | 'right'
  value?: (row: T) => number | null | undefined
  aggregate?: MatrixAggregate<T>
}

/** 左侧最多冻结 4 列（#368：顾客 × 品项表的左侧是 姓名/电话/等级/门店） */
export const MATRIX_MAX_LEFT_FROZEN = 4

// ─── 分组表头 ────────────────────────────────────────────────────────────────

export interface MatrixHeaderCell {
  /** 分组格用 `group:<groupKey>`，叶子格用列 key */
  key: string
  /** 分组格指向分组，叶子格指向列 */
  groupKey?: string
  columnKey?: string
  colSpan: number
  rowSpan: number
  /** 首个叶子列在列数组中的下标（用于冻结偏移、分隔线） */
  firstLeafIndex: number
}

export interface MatrixHeaderLayout {
  /** 表头行数：没有任何分组时 1 行，否则 2 行 */
  depth: 1 | 2
  rows: MatrixHeaderCell[][]
  /** 每个分组首列的 key —— 这些列左侧画分隔线（表头与表体都画） */
  groupStartKeys: Set<string>
}

/**
 * 把叶子列排成 1~2 行表头：
 * - 相邻同组列合并为第一行的一个 colSpan 格，第二行放各自的叶子表头；
 * - 不属于任何分组的列在两行表头下 rowSpan=2 纵向合并。
 *
 * 同一分组被别的列隔开会抛错：那一定是列定义拼错了，静默渲染成两个同名分组只会让表头和数据错位。
 */
export function buildMatrixHeaderLayout<T>(columns: readonly MatrixColumnSpec<T>[]): MatrixHeaderLayout {
  const groupStartKeys = new Set<string>()
  const grouped = columns.some((column) => column.group)
  if (!grouped) {
    return {
      depth: 1,
      rows: [columns.map((column, index) => ({
        key: column.key,
        columnKey: column.key,
        colSpan: 1,
        rowSpan: 1,
        firstLeafIndex: index,
      }))],
      groupStartKeys,
    }
  }

  const top: MatrixHeaderCell[] = []
  const bottom: MatrixHeaderCell[] = []
  const closedGroups = new Set<string>()
  let current: MatrixHeaderCell | null = null

  columns.forEach((column, index) => {
    const groupKey = column.group?.key
    if (current && current.groupKey !== groupKey) {
      closedGroups.add(current.groupKey!)
      current = null
    }
    if (!groupKey) {
      top.push({ key: column.key, columnKey: column.key, colSpan: 1, rowSpan: 2, firstLeafIndex: index })
      return
    }
    if (current) {
      current.colSpan += 1
    } else {
      if (closedGroups.has(groupKey)) {
        throw new Error(`INVALID_STATE: 矩阵表分组「${groupKey}」的列不相邻`)
      }
      current = { key: `group:${groupKey}`, groupKey, colSpan: 1, rowSpan: 1, firstLeafIndex: index }
      top.push(current)
      groupStartKeys.add(column.key)
    }
    bottom.push({ key: column.key, columnKey: column.key, colSpan: 1, rowSpan: 1, firstLeafIndex: index })
  })

  return { depth: 2, rows: [top, bottom], groupStartKeys }
}

// ─── 冻结列 ──────────────────────────────────────────────────────────────────

export interface MatrixFrozenPosition {
  side: 'left' | 'right'
  /** 距该侧边缘的 px 偏移（CSS left / right） */
  offset: number
  /** 冻结区最靠内的一列：画阴影分隔滚动区 */
  edge: boolean
}

/**
 * 算每个冻结列的 sticky 偏移。左冻结列必须是前缀、右冻结列必须是后缀 ——
 * 中间夹着一个冻结列时 sticky 会把它钉在错误位置并盖住别的列，直接抛错。
 */
export function computeFrozenPositions<T>(
  columns: readonly MatrixColumnSpec<T>[],
): Map<string, MatrixFrozenPosition> {
  const positions = new Map<string, MatrixFrozenPosition>()
  let leftCount = 0
  while (leftCount < columns.length && columns[leftCount].freeze === 'left') leftCount += 1
  let rightStart = columns.length
  while (rightStart > leftCount && columns[rightStart - 1].freeze === 'right') rightStart -= 1

  for (let index = leftCount; index < rightStart; index += 1) {
    if (columns[index].freeze) {
      throw new Error(`INVALID_STATE: 冻结列「${columns[index].key}」必须位于左侧前缀或右侧后缀`)
    }
  }
  if (leftCount > MATRIX_MAX_LEFT_FROZEN) {
    throw new Error(`INVALID_STATE: 左侧最多冻结 ${MATRIX_MAX_LEFT_FROZEN} 列`)
  }

  const widthOf = (column: MatrixColumnSpec<T>) => {
    if (!column.width || column.width <= 0) {
      throw new Error(`INVALID_STATE: 冻结列「${column.key}」必须指定正数宽度`)
    }
    return column.width
  }

  let offset = 0
  for (let index = 0; index < leftCount; index += 1) {
    positions.set(columns[index].key, { side: 'left', offset, edge: index === leftCount - 1 })
    offset += widthOf(columns[index])
  }
  offset = 0
  for (let index = columns.length - 1; index >= rightStart; index -= 1) {
    positions.set(columns[index].key, { side: 'right', offset, edge: index === rightStart })
    offset += widthOf(columns[index])
  }
  return positions
}

// ─── 合计行 ──────────────────────────────────────────────────────────────────

export type MatrixTotals = Record<string, number | null>

export interface ComputeMatrixTotalsOptions<T> {
  /**
   * 服务端按**全量筛选**算好的合计。给了某列就一律以它为准（去重计数只能来自这里）。
   */
  serverTotals?: MatrixTotals
  /**
   * 服务端分页时为 true：当前页只是全量的一段，逐行求和得到的是「本页小计」而不是合计，
   * 所以只认 serverTotals，缺的列留空，绝不拿本页数据去凑。
   */
  paginated: boolean
  /** 市场小计行：不参与求和，否则同一笔钱被算两遍 */
  isSubtotal?: (row: T) => boolean
}

function finite(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value)
}

function sumOf<T>(rows: readonly T[], accessor: (row: T) => number | null | undefined): number | null {
  let total = 0
  let seen = false
  for (const row of rows) {
    const value = accessor(row)
    if (!finite(value)) continue
    total += value
    seen = true
  }
  // 全空（而不是全 0）的列合计也是空，不伪造一个 0
  return seen || rows.length === 0 ? total : null
}

export function computeMatrixTotals<T>(
  columns: readonly MatrixColumnSpec<T>[],
  rows: readonly T[],
  options: ComputeMatrixTotalsOptions<T>,
): MatrixTotals {
  const detailRows = options.isSubtotal ? rows.filter((row) => !options.isSubtotal!(row)) : rows
  const totals: MatrixTotals = {}
  for (const column of columns) {
    const server = options.serverTotals
    if (server && Object.prototype.hasOwnProperty.call(server, column.key)) {
      const value = server[column.key]
      totals[column.key] = finite(value) ? value : null
      continue
    }
    const aggregate = column.aggregate ?? { kind: 'none' }
    if (options.paginated || aggregate.kind === 'none' || aggregate.kind === 'server') {
      totals[column.key] = null
      continue
    }
    if (aggregate.kind === 'sum') {
      totals[column.key] = column.value ? sumOf(detailRows, column.value) : null
      continue
    }
    const numerator = sumOf(detailRows, aggregate.numerator)
    const denominator = sumOf(detailRows, aggregate.denominator)
    totals[column.key] = numerator != null && denominator ? numerator / denominator : null
  }
  return totals
}

// ─── 排序 ────────────────────────────────────────────────────────────────────

export type MatrixSortDirection = 'asc' | 'desc'

export interface MatrixSort {
  key: string
  direction: MatrixSortDirection
}

/** 点表头的切换：换列从降序开始（报表看「谁最多」），同列降 ↔ 升 */
export function nextMatrixSort(current: MatrixSort | null | undefined, key: string): MatrixSort {
  if (current?.key === key && current.direction === 'desc') return { key, direction: 'asc' }
  return { key, direction: 'desc' }
}

/**
 * 客户端稳定排序（不分页的小表用；分页表由服务端排序，见 matrix-order.ts）。
 * - 空值无论升降序都排最后，与 SQL `NULLS LAST` 一致；
 * - 排序值相同时按 rowKey 升序兜底（#282），同一数据集多次排序结果恒定。
 */
export function sortMatrixRows<T>(
  rows: readonly T[],
  sortValue: (row: T) => number | string | null | undefined,
  direction: MatrixSortDirection,
  rowKey: (row: T) => string,
): T[] {
  const sign = direction === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const left = sortValue(a)
    const right = sortValue(b)
    const leftMissing = left == null || (typeof left === 'number' && Number.isNaN(left))
    const rightMissing = right == null || (typeof right === 'number' && Number.isNaN(right))
    if (leftMissing !== rightMissing) return leftMissing ? 1 : -1
    if (!leftMissing && !rightMissing && left !== right) {
      const order = typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right), 'zh-CN')
      if (order !== 0) return order * sign
    }
    const leftKey = rowKey(a)
    const rightKey = rowKey(b)
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
}

// ─── 日期列 ──────────────────────────────────────────────────────────────────

export interface MatrixMonthDay {
  /** YYYY-MM-DD */
  date: string
  day: number
  weekend: boolean
}

/**
 * 自然月内的日期列（频率表、提成日报）。按日历日期直接算，不经过本地时区的 Date，
 * 服务器 / 浏览器时区不同也不会错一天（#291）。
 */
export function listMonthDays(month: string): MatrixMonthDay[] {
  const match = /^(\d{4})-(\d{2})$/.exec(month)
  if (!match) throw new Error(`INVALID_PARAMS: 月份格式应为 YYYY-MM：${month}`)
  const year = Number(match[1])
  const monthIndex = Number(match[2]) - 1
  if (monthIndex < 0 || monthIndex > 11) throw new Error(`INVALID_PARAMS: 月份格式应为 YYYY-MM：${month}`)
  const dayCount = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
  return Array.from({ length: dayCount }, (_, offset) => {
    const day = offset + 1
    const weekday = new Date(Date.UTC(year, monthIndex, day)).getUTCDay()
    return {
      date: `${match[1]}-${match[2]}-${String(day).padStart(2, '0')}`,
      day,
      weekend: weekday === 0 || weekday === 6,
    }
  })
}
