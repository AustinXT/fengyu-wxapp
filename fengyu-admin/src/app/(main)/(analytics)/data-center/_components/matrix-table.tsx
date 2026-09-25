"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { cn } from "@/lib/utils"
import { Skeleton } from "@/components/ui/skeleton"
import { Pagination } from "@/components/ui/pagination"
import { formatByUnit } from "@/lib/data-center/format"
import type { MetricUnit } from "@/lib/data-center/types"
import {
  buildMatrixHeaderLayout,
  computeFrozenPositions,
  computeMatrixTotals,
  nextMatrixSort,
  type MatrixColumnSpec,
  type MatrixFrozenPosition,
  type MatrixSort,
  type MatrixTotals,
} from "@/lib/data-center/matrix"

/**
 * 经营明细矩阵表（#368）。与 DataTable 的区别：两行分组表头、左右冻结列、表尾合计行、
 * 市场小计行、服务端分页排序、列头说明。旧 4 板块继续用 DataTable / BreakdownTable，互不影响。
 *
 * 纯逻辑（表头合并、合计口径、冻结偏移）在 lib/data-center/matrix.ts，本组件只渲染。
 */

/** 单元格状态底色：强调（✓ 等）/ 待付清（浅橙）/ 弱化（灰字） */
export type MatrixCellTone = "accent" | "pending" | "muted"

export interface MatrixColumn<T> extends MatrixColumnSpec<T> {
  header: string
  /** 列头说明：悬停「?」浮出，不会被表格的滚动容器裁掉 */
  hint?: string
  /** 冻结列必填；其余列缺省 96px */
  width?: number
  align?: "left" | "center" | "right"
  /** 数值列的缺省格式化单位（cell 未提供时用于表体，也用于合计行）；缺省 amount */
  unit?: MetricUnit
  sortable?: boolean
  /** 周末列：整列浅底 */
  weekend?: boolean
  cell?: (row: T) => React.ReactNode
  tone?: (row: T) => MatrixCellTone | null | undefined
  /** 单元格悬停提示（如「待付清 ¥120.00」），同样渲染在浮层里 */
  cellHint?: (row: T) => string | null | undefined
  /** 合计行自定义渲染；缺省按 unit 格式化，负数红色 */
  formatTotal?: (value: number | null) => React.ReactNode
}

export interface MatrixTablePagination {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  pageSizeOptions?: number[]
  onPageSizeChange?: (size: number) => void
}

export interface MatrixTableProps<T> {
  columns: MatrixColumn<T>[]
  rows: T[]
  /** 行唯一键（顾客 id / 员工 id / 小计行的市场 id 加前缀） */
  rowKey: (row: T) => string
  loading?: boolean
  emptyText?: string
  /** 市场小计行：加粗浅底，不参与客户端合计 */
  isSubtotal?: (row: T) => boolean
  /**
   * 合计行。`values` 是服务端按全量筛选算好的合计：分页时只认它（翻页合计不变），
   * 不分页时它覆盖本地计算（去重计数列必须由它提供）。传 false 不渲染合计行。
   */
  totals?: false | { label?: string; values?: MatrixTotals }
  /** 提供即为服务端分页 */
  pagination?: MatrixTablePagination
  /** 受控排序；排序本身由调用方完成（服务端 ORDER BY 或 sortMatrixRows） */
  sort?: MatrixSort | null
  onSortChange?: (sort: MatrixSort) => void
  /** 表体最大高度（px），超出纵向滚动、表头与合计行吸附 */
  maxHeight?: number
  /**
   * 两行表头各行高度（px），缺省各 36。分组标题或列头含换行（多行文字）时调高，
   * 第二行的 sticky top 与纵向合并格的高度都按它算。
   */
  headerHeights?: readonly [number, number]
  onRowClick?: (row: T) => void
  className?: string
}

const DEFAULT_WIDTH = 96
/** 表头每行的缺省高度；两行表头时第二行的 sticky top = 第一行高度 */
const HEADER_ROW_HEIGHT = 36
const DEFAULT_HEADER_HEIGHTS = [HEADER_ROW_HEIGHT, HEADER_ROW_HEIGHT] as const

/** 含换行的表头文字按行折行显示；其余保持不换行（与原先一致） */
function headerWhitespace(text: string | undefined) {
  return text?.includes("\n") ? "whitespace-pre-line leading-snug" : "whitespace-nowrap"
}

// ─── 浮层提示：portal 到 body + fixed 定位，逃出 overflow:auto 容器的裁剪 ──────

/** 触发点上方不足这么多像素时浮层翻到下方（sticky 表头贴着视口顶部时尤其如此） */
const HINT_FLIP_THRESHOLD = 96

function FloatingHint({ content, children, className }: {
  content: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  const triggerRef = React.useRef<HTMLSpanElement>(null)
  const [position, setPosition] = React.useState<{
    left: number
    top: number
    below: boolean
    container: HTMLElement
  } | null>(null)

  const show = () => {
    const trigger = triggerRef.current
    const rect = trigger?.getBoundingClientRect()
    if (!trigger || !rect) return
    // 浮层最宽 320px、以触发点居中：把中心夹在视口内，贴边的列头说明不会被窗口边缘截断
    const half = 160 + 8
    const center = rect.left + rect.width / 2
    const left = window.innerWidth > half * 2 ? Math.min(Math.max(center, half), window.innerWidth - half) : center
    const below = rect.top < HINT_FLIP_THRESHOLD
    // 表格在模态 <dialog> 里时挂到 dialog 上：挂 body 会被 top layer 盖住（同 date-picker）
    const container = trigger.closest<HTMLElement>("dialog[open]") ?? document.body
    setPosition({ left, top: below ? rect.bottom : rect.top, below, container })
  }
  const hide = () => setPosition(null)

  // 定位是 hover 那一刻的快照：表格或页面一滚动就收起，不留一个飘在原处的浮层
  React.useEffect(() => {
    if (!position) return
    window.addEventListener("scroll", hide, true)
    window.addEventListener("resize", hide)
    return () => {
      window.removeEventListener("scroll", hide, true)
      window.removeEventListener("resize", hide)
    }
  }, [position])

  return (
    <span
      ref={triggerRef}
      className={cn("inline-flex", className)}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {position && createPortal(
        <div
          role="tooltip"
          style={{ left: position.left, top: position.top }}
          data-placement={position.below ? "bottom" : "top"}
          className={cn(
            "pointer-events-none fixed z-[100] w-max max-w-[320px] -translate-x-1/2 whitespace-normal rounded-[var(--radius)] bg-[var(--foreground)] px-3 py-1.5 text-xs leading-relaxed text-[var(--background)] shadow-md",
            position.below ? "translate-y-[6px]" : "-translate-y-[calc(100%+6px)]",
          )}
        >
          {content}
        </div>,
        position.container,
      )}
    </span>
  )
}

function HeaderHint({ hint }: { hint: string }) {
  return (
    <FloatingHint content={hint}>
      <span
        tabIndex={0}
        aria-label={hint}
        className="ml-1 inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-current text-[10px] leading-none opacity-70"
      >
        ?
      </span>
    </FloatingHint>
  )
}

// ─── 单元格状态小部件 ──────────────────────────────────────────────────────────

/** ✓ 强调 */
export function MatrixCheck() {
  return <span className="font-semibold text-[var(--color-brand)]">✓</span>
}

/** 各单位的展示精度（小数位，占比按 0-1 小数计） */
const DISPLAY_DIGITS: Record<MetricUnit, number> = { amount: 2, percent: 4, count: 0 }

/**
 * 按单位格式化的数值，负数红色（退款冲销）。先按展示精度取整再判正负：
 * 退款相抵后的浮点噪声（-2.7e-17）不能显示成一个红色的「-0.00」。
 */
export function MatrixAmount({ value, unit = "amount" }: { value: number | null | undefined; unit?: MetricUnit }) {
  const scale = 10 ** DISPLAY_DIGITS[unit]
  // `|| 0` 顺带把 -0 归成 0
  const shown = value != null && Number.isFinite(value) ? Math.round(value * scale) / scale || 0 : value
  return (
    <span className={cn("tabular-nums", shown != null && shown < 0 && "text-[var(--destructive)]")}>
      {formatByUnit(shown, unit)}
    </span>
  )
}

/** ✓ 与金额双行（频率表：到店 + 当日消费） */
export function MatrixCheckAmount({ checked, amount }: { checked: boolean; amount: number | null | undefined }) {
  return (
    <span className="inline-flex flex-col items-center leading-tight">
      <span>{checked ? <MatrixCheck /> : " "}</span>
      {amount != null && <span className="text-[11px]"><MatrixAmount value={amount} /></span>}
    </span>
  )
}

/** 右上角角标（如「补」「赠」） */
export function MatrixBadge({ badge, children }: { badge: string; children: React.ReactNode }) {
  return (
    <span className="relative inline-block pr-2.5">
      {children}
      <sup className="absolute -top-1 right-0 text-[9px] font-medium text-[var(--color-status-pending)]">{badge}</sup>
    </span>
  )
}

// ─── 表格 ──────────────────────────────────────────────────────────────────────

function stickyStyle(position: MatrixFrozenPosition | undefined, extra?: React.CSSProperties): React.CSSProperties | undefined {
  if (!position) return extra
  return { ...extra, position: "sticky", [position.side]: position.offset }
}

function alignClass(align: MatrixColumn<unknown>["align"]) {
  return align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left"
}

function defaultTotal(value: number | null, unit: MetricUnit) {
  return <MatrixAmount value={value} unit={unit} />
}

function MatrixTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  emptyText = "暂无数据",
  isSubtotal,
  totals,
  pagination,
  sort,
  onSortChange,
  maxHeight = 640,
  headerHeights = DEFAULT_HEADER_HEIGHTS,
  onRowClick,
  className,
}: MatrixTableProps<T>) {
  const layout = React.useMemo(() => buildMatrixHeaderLayout(columns), [columns])
  const frozen = React.useMemo(() => computeFrozenPositions(columns), [columns])
  const columnByKey = React.useMemo(() => new Map(columns.map((column) => [column.key, column])), [columns])
  const totalsConfig = totals || null
  const paginated = !!pagination
  const totalValues = React.useMemo(
    () => totalsConfig
      ? computeMatrixTotals(columns, rows, { paginated, serverTotals: totalsConfig.values, isSubtotal })
      : {},
    [columns, rows, paginated, totalsConfig, isSubtotal],
  )
  const tableWidth = columns.reduce((sum, column) => sum + (column.width ?? DEFAULT_WIDTH), 0)

  // 层级：冻结表头角 / 冻结合计格(z-30) > 表头 / 合计行(z-20) > 冻结表体列(z-10) > 普通单元格。
  // 背景一律不透明，滚过去的内容不会透出来。本函数只管冻结区边缘的阴影，z-index 由各处自己给。
  const frozenEdgeClass = (key: string) => {
    const position = frozen.get(key)
    if (!position) return ""
    return cn(
      position.edge && position.side === "left" && "shadow-[inset_-1px_0_0_var(--border),4px_0_6px_-4px_rgba(0,0,0,0.12)]",
      position.edge && position.side === "right" && "shadow-[inset_1px_0_0_var(--border),-4px_0_6px_-4px_rgba(0,0,0,0.12)]",
    )
  }
  const groupStartClass = (key: string) => layout.groupStartKeys.has(key) && "border-l border-l-[var(--border)]"

  const renderHeaderLabel = (column: MatrixColumn<T>) => {
    const sortable = column.sortable && onSortChange
    const active = sort?.key === column.key ? sort.direction : null
    const label = (
      <>
        {column.header}
        {sortable && (
          <span aria-hidden className={cn("ml-0.5 text-[10px]", active ? "text-[var(--color-brand)]" : "opacity-30")}>
            {active === "asc" ? "▲" : "▼"}
          </span>
        )}
      </>
    )
    return (
      <span className={cn("inline-flex items-center", column.align === "right" && "justify-end", column.align === "center" && "justify-center")}>
        {sortable ? (
          <button
            type="button"
            className="inline-flex items-center hover:text-[var(--foreground)]"
            onClick={() => onSortChange(nextMatrixSort(sort, column.key))}
          >
            {label}
          </button>
        ) : label}
        {column.hint && <HeaderHint hint={column.hint} />}
      </span>
    )
  }

  const bodyCell = (row: T, column: MatrixColumn<T>, subtotal: boolean) => {
    const tone = subtotal ? null : column.tone?.(row)
    const hint = column.cellHint?.(row)
    const content = column.cell
      ? column.cell(row)
      : column.value
        ? <MatrixAmount value={column.value(row)} unit={column.unit ?? "amount"} />
        : "—"
    const position = frozen.get(column.key)
    return (
      <td
        key={column.key}
        data-tone={tone ?? undefined}
        style={stickyStyle(position)}
        className={cn(
          "h-10 px-3 align-middle whitespace-nowrap",
          alignClass(column.align),
          // 背景顺序：状态色 > 小计 > 周末 > 默认。冻结列必须有不透明背景。
          tone === "pending" ? "bg-[#FFF4E0]"
            : subtotal ? "bg-[var(--color-brand-warm)]"
            : column.weekend ? "bg-[#FAFAF7]"
            : "bg-[var(--card)]",
          !tone && !subtotal && "group-hover:bg-[var(--color-brand-light)]",
          tone === "accent" && "font-semibold text-[var(--color-brand)]",
          tone === "muted" && "text-[var(--muted-foreground)]",
          groupStartClass(column.key),
          position && "z-10",
          frozenEdgeClass(column.key),
        )}
      >
        {hint ? <FloatingHint content={hint}>{content}</FloatingHint> : content}
      </td>
    )
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div
        className="relative w-full overflow-auto rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--card)]"
        style={{ maxHeight }}
      >
        <table className="border-separate border-spacing-0 text-sm" style={{ width: tableWidth, minWidth: "100%", tableLayout: "fixed" }}>
          <colgroup>
            {columns.map((column) => <col key={column.key} style={{ width: column.width ?? DEFAULT_WIDTH }} />)}
          </colgroup>
          <thead>
            {layout.rows.map((headerRow, rowIndex) => (
              <tr key={rowIndex}>
                {headerRow.map((cell) => {
                  const column = cell.columnKey ? columnByKey.get(cell.columnKey) : undefined
                  const group = cell.groupKey ? columns[cell.firstLeafIndex].group : undefined
                  // 分组格跨多列（computeFrozenPositions 保证分组不跨冻结边界）：左冻结按首列吸附；
                  // 右冻结必须按**末列**吸附 —— 首列的 right 偏移已含它右边各列的宽度，拿来给整个分组格就错位
                  const lastLeaf = columns[cell.firstLeafIndex + cell.colSpan - 1]
                  const firstPosition = frozen.get(columns[cell.firstLeafIndex].key)
                  const position = firstPosition?.side === "right" ? frozen.get(lastLeaf.key) : firstPosition
                  const edgeKey = firstPosition?.side === "right" ? columns[cell.firstLeafIndex].key : lastLeaf.key
                  const weekend = column
                    ? column.weekend
                    : columns.slice(cell.firstLeafIndex, cell.firstLeafIndex + cell.colSpan).every((leaf) => leaf.weekend)
                  // 分组底色：分组格取自身分组，叶子格取所属分组（不属于任何分组的纵向合并格不上色）
                  const tint = group?.color ?? (column && cell.rowSpan === 1 ? column.group?.color : undefined)
                  const top = rowIndex === 0 ? 0 : headerHeights[0]
                  const height = cell.rowSpan > 1 ? headerHeights[0] + headerHeights[1] : headerHeights[rowIndex] ?? HEADER_ROW_HEIGHT
                  return (
                    <th
                      key={cell.key}
                      colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}
                      rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
                      scope={group ? "colgroup" : "col"}
                      aria-sort={column && sort?.key === column.key ? (sort.direction === "asc" ? "ascending" : "descending") : undefined}
                      style={stickyStyle(position, { top, height, ...(tint ? { backgroundColor: tint } : {}) })}
                      className={cn(
                        "sticky border-b border-[var(--border)] px-3 align-middle text-xs font-medium text-[var(--muted-foreground)]",
                        headerWhitespace(group ? group.header : column?.header),
                        position ? "z-30" : "z-20",
                        weekend ? "bg-[#F0EFEA]" : "bg-[var(--muted)]",
                        group ? "text-center" : alignClass(column?.align),
                        group ? "border-l border-l-[var(--border)]" : column && groupStartClass(column.key),
                        position && frozenEdgeClass(edgeKey),
                      )}
                    >
                      {group ? (
                        <span className="inline-flex items-center">
                          {group.header}
                          {group.hint && <HeaderHint hint={group.hint} />}
                        </span>
                      ) : column ? renderHeaderLabel(column) : null}
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 5 }).map((_, rowIdx) => (
                <tr key={rowIdx}>
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      style={stickyStyle(frozen.get(column.key))}
                      className={cn("h-10 border-b border-[var(--border)] bg-[var(--card)] px-3", frozen.has(column.key) && "z-10", frozenEdgeClass(column.key))}
                    >
                      <Skeleton className="h-4 w-3/4" />
                    </td>
                  ))}
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="h-32 text-center text-[var(--muted-foreground)]">
                  {emptyText}
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const subtotal = isSubtotal?.(row) ?? false
                return (
                  <tr
                    key={rowKey(row)}
                    data-subtotal={subtotal || undefined}
                    className={cn(
                      "group [&>td]:border-b [&>td]:border-[var(--border)]",
                      subtotal && "font-semibold",
                      onRowClick && !subtotal && "cursor-pointer",
                    )}
                    onClick={onRowClick && !subtotal ? () => onRowClick(row) : undefined}
                  >
                    {columns.map((column) => bodyCell(row, column, subtotal))}
                  </tr>
                )
              })
            )}
          </tbody>
          {totalsConfig && !loading && rows.length > 0 && (
            <tfoot>
              <tr data-totals>
                {columns.map((column, index) => {
                  const position = frozen.get(column.key)
                  const value = totalValues[column.key] ?? null
                  const aggregated = (column.aggregate?.kind ?? "none") !== "none" || Object.prototype.hasOwnProperty.call(totalsConfig.values ?? {}, column.key)
                  return (
                    <td
                      key={column.key}
                      style={stickyStyle(position, { bottom: 0 })}
                      className={cn(
                        "sticky h-10 border-t border-[var(--border)] bg-[var(--color-brand-warm)] px-3 align-middle font-semibold whitespace-nowrap",
                        position ? "z-30" : "z-20",
                        alignClass(column.align),
                        groupStartClass(column.key),
                        frozenEdgeClass(column.key),
                      )}
                    >
                      {index === 0
                        ? (totalsConfig.label ?? "合计")
                        : aggregated
                          ? (column.formatTotal ? column.formatTotal(value) : defaultTotal(value, column.unit ?? "amount"))
                          : null}
                    </td>
                  )
                })}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {pagination && (
        <Pagination
          total={pagination.total}
          page={pagination.page}
          pageSize={pagination.pageSize}
          onPageChange={pagination.onPageChange}
          pageSizeOptions={pagination.pageSizeOptions}
          onPageSizeChange={pagination.onPageSizeChange}
        />
      )}
    </div>
  )
}

export { MatrixTable }
