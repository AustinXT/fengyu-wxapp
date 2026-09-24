"use client"

import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react"
import { Input } from "@/components/ui/input"
import { ExportButton } from "@/components/ui/export-button"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import { cn } from "@/lib/utils"
import {
  CATEGORY_KEY_PREFIX,
  REMAINING_CARDS_PAGE_SIZES,
  REMAINING_CELL_LABELS,
  REMAINING_TOTAL_KEY,
  remainingCardsColumnSpecs,
  remainingCellHint,
  type RemainingCardsRow,
  type RemainingCell,
} from "@/lib/data-center/remaining-cards"
import type { RemainingCardsReport } from "@/actions/data-center/remaining-cards"
import { formatByUnit } from "@/lib/data-center/format"
import { KpiCard } from "../../_components/kpi-card"
import { MatrixBadge, MatrixTable, type MatrixColumn, type MatrixCellTone } from "../../_components/matrix-table"

const TONE: Record<RemainingCell["state"], MatrixCellTone> = {
  remaining: "accent",
  unpaid: "pending",
  done: "muted",
  expired: "muted",
}

/** 「待付清」沿用 badge.tsx 的配色（#122 甲方确认的标注），底色由 MatrixTable 的 pending tone 给出 */
function CellContent({ cell }: { cell: RemainingCell | undefined }) {
  // 未买过留空；给一块透明占位，悬停「未买过」才有落点
  if (!cell) return <span className="inline-block h-4 w-8" aria-label="未买过" />
  const label = (
    <span className={cn(cell.state === "unpaid" && "text-xs text-[#D4820A]", cell.state === "remaining" && "text-base")}>
      {REMAINING_CELL_LABELS[cell.state]}
    </span>
  )
  return cell.frozen ? <MatrixBadge badge="冻">{label}</MatrixBadge> : label
}

const LEGEND: { label: string; sample: ReactNode; className?: string }[] = [
  { label: "有剩余", sample: "✓", className: "font-semibold text-[var(--color-brand)]" },
  { label: "待付清", sample: "待付清", className: "bg-[#FFF4E0] text-xs text-[#D4820A]" },
  { label: "已服务完", sample: "已服务完", className: "text-xs text-[var(--muted-foreground)]" },
  { label: "未买过", sample: "空白", className: "text-xs text-[var(--muted-foreground)] opacity-60" },
]

function formatCount(value: number | null) {
  return formatByUnit(value, "count")
}

/**
 * 顾客剩余卡项清单的页面主体（#371）：指标卡 + 搜索 / 显示范围 / 导出 + 矩阵表。
 * 数据由 page.tsx 在服务端按 URL 取好；交互只改 URL，服务端重新取数，pending 期间表格显示骨架。
 */
export function RemainingCardsView({ report }: { report: RemainingCardsReport }) {
  const { get, setMany, searchParams } = useUrlFilters()
  const [pending, startTransition] = useTransition()
  const navigate = useCallback((updates: Record<string, string>) => {
    startTransition(() => setMany(updates))
  }, [setMany])

  const q = get("q")
  const show = get("show") === "remaining" ? "remaining" : "all"
  const direction = get("dir") === "asc" ? "asc" : "desc"
  const [searchInput, setSearchInput] = useState(q)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => setSearchInput(q), [q])
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
  }, [])

  function onSearchChange(value: string) {
    setSearchInput(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => navigate({ q: value.trim(), page: "" }), 400)
  }

  const { summary } = report
  const columns = useMemo<MatrixColumn<RemainingCardsRow>[]>(() => {
    const specs = remainingCardsColumnSpecs(report.columns)
    return specs.map((spec): MatrixColumn<RemainingCardsRow> => {
      if (spec.key === "store") return { ...spec, cell: (row) => row.storeName }
      if (spec.key === "customer") {
        return {
          ...spec,
          cell: (row) => (
            <span className="flex flex-col leading-tight">
              <span className="truncate font-medium">{row.customerName || "—"}</span>
              <span className="text-xs text-[var(--muted-foreground)] tabular-nums">{row.phoneMasked}</span>
            </span>
          ),
        }
      }
      if (spec.key === "level") return { ...spec, cell: (row) => row.level || "—" }
      if (spec.key === REMAINING_TOTAL_KEY) {
        return {
          ...spec,
          align: "right",
          sortable: true,
          hint: "该行各品项「已付未用」次数之和（剔除已退完、已过期的卡）",
          formatTotal: formatCount,
        }
      }
      const categoryId = spec.key.slice(CATEGORY_KEY_PREFIX.length)
      return {
        ...spec,
        width: 88,
        align: "center",
        cell: (row) => <CellContent cell={row.cells[categoryId]} />,
        tone: (row) => {
          const cell = row.cells[categoryId]
          return cell ? TONE[cell.state] : null
        },
        cellHint: (row) => remainingCellHint(row.cells[categoryId]),
        formatTotal: formatCount,
      }
    })
  }, [report.columns])

  const remainingRate = summary.remainingCustomerRate == null
    ? "—"
    : formatByUnit(summary.remainingCustomerRate, "percent")

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="统计顾客数" cell={{ value: summary.customerCount, unit: "count" }} hint="范围内去重顾客，多店持卡只算 1 位" />
        <KpiCard label="有剩余卡项顾客" cell={{ value: summary.remainingCustomerCount, unit: "count" }} hint={`占比 ${remainingRate}`} />
        <KpiCard label="待服务剩余次数" cell={{ value: summary.remainingSessions, unit: "count" }} hint={`涉及 ${summary.remainingCategoryCount} 个二级品项`} />
        <KpiCard label="有余额品项（项次）" cell={{ value: summary.remainingCells, unit: "count" }} />
        <KpiCard label="已服务完（项次）" cell={{ value: summary.doneCells, unit: "count" }} hint={`另有待付清 ${summary.unpaidCells} 项次`} />
        <KpiCard
          label="未买过（项次）"
          cell={{ value: summary.neverCells, unit: "count" }}
          hint={summary.expiredCells > 0 ? `含已过期 ${summary.expiredCells} 项次` : undefined}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          className="w-72"
          aria-label="顾客搜索"
          placeholder="搜索姓名 / 门店 / 会员等级 / 完整手机号"
          value={searchInput}
          onChange={(event) => onSearchChange(event.target.value)}
        />
        <div role="group" aria-label="显示范围" className="flex items-center gap-2">
          {([["all", "全部顾客"], ["remaining", "只看有剩余"]] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={show === key}
              onClick={() => navigate({ show: key === "all" ? "" : key, page: "" })}
              className={cn(
                "px-3 py-1.5 text-sm rounded-[var(--radius)] border transition-colors",
                show === key
                  ? "border-[var(--primary)] text-[var(--primary)] bg-[#FFF0EE]"
                  : "border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-4">
          <ul aria-label="图例" className="flex items-center gap-3 text-xs text-[var(--muted-foreground)]">
            {LEGEND.map((item) => (
              <li key={item.label} className="flex items-center gap-1">
                <span className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded px-1", item.className)}>{item.sample}</span>
                {item.label}
              </li>
            ))}
          </ul>
          <ExportButton
            disabled={pending || report.total === 0}
            exportRequest={{
              exportType: "data-center",
              payload: { view: "report-remaining-cards", params: Object.fromEntries(searchParams.entries()) },
            }}
          />
        </div>
      </div>

      <MatrixTable
        columns={columns}
        rows={report.rows}
        rowKey={(row) => row.key}
        loading={pending}
        emptyText={report.filtered ? "没有符合条件的顾客" : "当前范围内暂无顾客"}
        totals={{ values: report.totals }}
        sort={{ key: REMAINING_TOTAL_KEY, direction }}
        onSortChange={(next) => navigate({ dir: next.direction === "asc" ? "asc" : "", page: "" })}
        pagination={{
          page: report.page,
          pageSize: report.pageSize,
          total: report.total,
          onPageChange: (page) => navigate({ page: page === 1 ? "" : String(page) }),
          pageSizeOptions: [...REMAINING_CARDS_PAGE_SIZES],
          onPageSizeChange: (size) => navigate({ size: String(size), page: "" }),
        }}
      />
    </div>
  )
}
