"use client"

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"
import { Input } from "@/components/ui/input"
import { ExportButton } from "@/components/ui/export-button"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import { cn } from "@/lib/utils"
import {
  CUSTOMER_FREQUENCY_DEFAULT_SORT,
  CUSTOMER_FREQUENCY_PAGE_SIZES,
  CUSTOMER_FREQUENCY_SEARCH_MAX_LENGTH,
  CUSTOMER_FREQUENCY_TIERS,
  FREQUENCY_AMOUNT_KEY,
  FREQUENCY_VISIT_DAYS_KEY,
  customerFrequencyColumnSpecs,
  frequencyAmountCell,
  frequencyCellHint,
  type CustomerFrequencyRow,
} from "@/lib/data-center/customer-frequency"
import type { CustomerFrequencyReport } from "@/actions/data-center/customer-frequency"
import { formatByUnit } from "@/lib/data-center/format"
import { REPORT_MIN_MONTH } from "@/lib/data-center/report-period"
import type { KpiCell } from "@/lib/data-center/types"
import { KpiGrid, type KpiGridItem } from "../../_components/kpi-card"
import { MatrixCheckAmount, MatrixTable, type MatrixColumn } from "../../_components/matrix-table"

function percent(value: number | null) {
  return value == null ? "—" : formatByUnit(value, "percent")
}

function tierRange(tier: (typeof CUSTOMER_FREQUENCY_TIERS)[number]) {
  return tier.max === null ? `≥${tier.min} 天` : `${tier.min}~${tier.max} 天`
}

/**
 * 顾客频率表的页面主体（#370）：9 张指标卡 + 搜索 / 只看有到店 / 导出 + 顾客 × 当月日历矩阵。
 * 数据由 page.tsx 在服务端按 URL 取好；交互只改 URL，服务端重新取数，pending 期间表格显示骨架。
 */
export function CustomerFrequencyView({ report }: { report: CustomerFrequencyReport }) {
  const { get, setMany, searchParams } = useUrlFilters()
  const [pending, startTransition] = useTransition()
  const navigate = useCallback((updates: Record<string, string>) => {
    startTransition(() => setMany(updates))
  }, [setMany])

  const q = get("q")
  const show = get("show") === "visited" ? "visited" : "all"
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
  const kpis: Record<string, KpiCell> = {
    customerCount: { value: summary.customerCount, unit: "count" },
    visitedCount: { value: summary.visitedCount, unit: "count" },
    ...Object.fromEntries(CUSTOMER_FREQUENCY_TIERS.map((tier) => [tier.key, { value: summary.tiers[tier.key].count, unit: "count" }])),
    visitTotal: { value: summary.visitTotal, unit: "count" },
    visitsPerVisitor: { value: summary.visitsPerVisitor, unit: "amount" },
    amountTotal: { value: summary.amountTotal, unit: "amount" },
    consumeTotal: { value: summary.consumeTotal, unit: "amount" },
  }
  const kpiItems: KpiGridItem[] = [
    { key: "customerCount", label: "统计顾客数（位）", hint: "范围内全部绑店顾客，含本月未到店" },
    { key: "visitedCount", label: "本月有到店顾客（位）", hint: `到店率 ${percent(summary.visitRate)}` },
    ...CUSTOMER_FREQUENCY_TIERS.map((tier) => ({
      key: tier.key,
      label: `${tier.label}顾客（${tierRange(tier)}）`,
      hint: `占有到店顾客 ${percent(summary.tiers[tier.key].share)}`,
    })),
    { key: "visitTotal", label: "本月到店总人次", hint: "同一顾客同一天只算 1 次" },
    { key: "visitsPerVisitor", label: "人均到店（次）", hint: "到店总人次 ÷ 有到店顾客" },
    { key: "amountTotal", label: "本月消费合计（元）", hint: "实收款项，按款项归属日期，退款冲减" },
    { key: "consumeTotal", label: "本月消耗合计（元）", hint: `消耗 / 消费 ${percent(summary.consumeRatio)}` },
  ]

  const columns = useMemo<MatrixColumn<CustomerFrequencyRow>[]>(() => {
    return customerFrequencyColumnSpecs(report.month).map((spec): MatrixColumn<CustomerFrequencyRow> => {
      if (spec.day) {
        const key = String(spec.day.day)
        return {
          ...spec,
          align: "center",
          weekend: spec.day.weekend,
          cell: (row) => {
            const cell = row.days[key]
            if (!cell) return null
            return <MatrixCheckAmount checked={cell.visited} amount={frequencyAmountCell(cell)} />
          },
          cellHint: (row) => frequencyCellHint(row.days[key]),
        }
      }
      if (spec.key === "name") return { ...spec, cell: (row) => <span className="truncate font-medium">{row.customerName || "—"}</span> }
      if (spec.key === "phone") return { ...spec, cell: (row) => <span className="tabular-nums">{row.phoneMasked || "—"}</span> }
      if (spec.key === "level") return { ...spec, cell: (row) => row.level || "—" }
      if (spec.key === "store") return { ...spec, cell: (row) => <span className="truncate">{row.storeName || "—"}</span> }
      if (spec.key === FREQUENCY_VISIT_DAYS_KEY) {
        return { ...spec, align: "right", sortable: true, hint: "本月到店天数：服务日与支付日的并集，同一天只算 1 次" }
      }
      if (spec.key === FREQUENCY_AMOUNT_KEY) {
        return { ...spec, align: "right", sortable: true, hint: "当月每日消费之和（含没到店但有款项的日子）" }
      }
      return spec
    })
  }, [report.month])

  const sort = report.sort
  const isDefaultSort = (next: { key: string; direction: string }) =>
    next.key === CUSTOMER_FREQUENCY_DEFAULT_SORT.key && next.direction === CUSTOMER_FREQUENCY_DEFAULT_SORT.direction

  return (
    <div className="flex flex-col gap-4">
      <KpiGrid items={kpiItems} kpis={kpis} columns={3} />

      <div className="flex flex-wrap items-center gap-3">
        <Input
          className="w-64"
          aria-label="顾客搜索"
          placeholder="搜索姓名 / 完整手机号"
          maxLength={CUSTOMER_FREQUENCY_SEARCH_MAX_LENGTH}
          value={searchInput}
          onChange={(event) => onSearchChange(event.target.value)}
        />
        <div role="group" aria-label="显示范围" className="flex items-center gap-2">
          {([["all", "全部顾客"], ["visited", "只看有到店"]] as const).map(([key, label]) => (
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
          <p aria-label="图例" className="text-xs text-[var(--muted-foreground)]">
            <span className="font-semibold text-[var(--color-brand)]">✓</span> 当日到店（含消费到店），下方数字为当日消费金额；周末列浅底；
            交易跟着顾客走，单店 / 市场视图的消费、消耗含顾客在其它门店的交易
          </p>
          <ExportButton
            disabled={pending || report.total === 0}
            exportRequest={{
              exportType: "data-center",
              // 月份钉进导出参数：URL 缺省 month 时页面显示的是「上月」，不钉的话任务排队跨月或下月重试会导出另一个月
              payload: { view: "report-customer-frequency", params: { ...Object.fromEntries(searchParams.entries()), month: report.month } },
            }}
          />
        </div>
      </div>

      <MatrixTable
        columns={columns}
        rows={report.rows}
        rowKey={(row) => row.clientUserId}
        loading={pending}
        emptyText={
          report.beforeDataStart
            ? `所选月份早于系统数据起点（${REPORT_MIN_MONTH}），暂无数据`
            : report.filtered ? "没有符合条件的顾客" : "当前范围内暂无绑店顾客"
        }
        totals={{ values: report.totals }}
        sort={sort}
        onSortChange={(next) => navigate(isDefaultSort(next)
          ? { sort: "", dir: "", page: "" }
          : { sort: next.key, dir: next.direction === "asc" ? "asc" : "", page: "" })}
        pagination={{
          page: report.page,
          pageSize: report.pageSize,
          total: report.total,
          onPageChange: (page) => navigate({ page: page === 1 ? "" : String(page) }),
          pageSizeOptions: [...CUSTOMER_FREQUENCY_PAGE_SIZES],
          onPageSizeChange: (size) => navigate({ size: String(size), page: "" }),
        }}
      />
    </div>
  )
}
