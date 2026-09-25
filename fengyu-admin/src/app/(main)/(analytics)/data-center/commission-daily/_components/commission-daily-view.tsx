"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { AlertCircle } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { ExportButton } from "@/components/ui/export-button"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import { formatAmount, formatCount, formatPercent } from "@/lib/data-center/format"
import { monthRange } from "@/lib/data-center/report-period"
import {
  COMMISSION_VIEWS,
  COMMISSION_VIEW_LABELS,
  cellTotal,
  commissionDetailHref,
  commissionExportParams,
  type CommissionCell,
  type CommissionDailyRow,
} from "@/lib/data-center/commission-daily"
import {
  buildCommissionDailyColumns,
  commissionDailyTotalsMap,
  commissionTotalsLabel,
  type CommissionDailyColumn,
} from "@/lib/data-center/commission-columns"
import type { CommissionDailyResult } from "@/actions/data-center/commission"
import { cn } from "@/lib/utils"
import { KpiCard } from "../../_components/kpi-card"
import { MatrixAmount, MatrixTable, type MatrixColumn } from "../../_components/matrix-table"

const SEARCH_DEBOUNCE_MS = 300

function cellHint(cell: CommissionCell | undefined): string {
  const value = cell ?? { sale: 0, service: 0, orders: 0 }
  return `业绩 ${formatAmount(value.sale)} + 消耗 ${formatAmount(value.service)} = ${formatAmount(cellTotal(value))}（${value.orders} 单）`
}

/**
 * 员工提成日报（#375）：视图 / 汇总维度 / 搜索 / 隐藏 0 行控件 + 6 张指标卡 + 矩阵表。
 * 所有控件写 URL，由服务端重新取数（排序也在服务端完成，与导出同一顺序）。
 */
export function CommissionDailyView({ data, today }: { data: CommissionDailyResult; today: string }) {
  const filters = useUrlFilters()
  const setFilter = filters.set
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { options, grain, kpis, totals } = data
  const returnTo = `${pathname}${searchParams.size > 0 ? `?${searchParams.toString()}` : ""}`
  const scopeParam = searchParams.get("scope")
  const scopeIdParam = searchParams.get("scopeId")

  const [search, setSearch] = React.useState(options.search)
  React.useEffect(() => setSearch(options.search), [options.search])
  React.useEffect(() => {
    if (search.trim() === options.search) return
    const timer = window.setTimeout(() => setFilter("q", search.trim()), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [search, options.search, setFilter])

  const specs = React.useMemo(
    () => buildCommissionDailyColumns({ month: data.month, view: options.view, grain, today }),
    [data.month, options.view, grain, today],
  )

  const drill = React.useCallback(
    (row: CommissionDailyRow, extra: { date?: string; source?: "sale" | "service" } = {}) =>
      row.employeeId
        ? commissionDetailHref({
            scope: scopeParam,
            scopeId: scopeIdParam,
            month: data.month,
            employeeId: row.employeeId,
            storeId: grain === "employee-store" ? row.storeId : null,
            date: extra.date,
            source: extra.source,
            returnTo,
          })
        : null,
    [scopeParam, scopeIdParam, data.month, grain, returnTo],
  )

  const columns = React.useMemo<MatrixColumn<CommissionDailyRow>[]>(() => {
    const muted = (row: CommissionDailyRow) => (cellTotal(row.total) === 0 ? "muted" as const : null)
    return specs.map((spec: CommissionDailyColumn): MatrixColumn<CommissionDailyRow> => {
      const base: MatrixColumn<CommissionDailyRow> = { ...spec, sortable: true, tone: muted }
      if (spec.role === "name") {
        return {
          ...base,
          cell: (row) => {
            const href = drill(row)
            return href ? <Link href={href} className="text-[var(--color-brand)] hover:underline">{row.employeeName}</Link> : row.employeeName
          },
        }
      }
      if (spec.role === "position") return { ...base, cell: (row) => row.positionName }
      if (spec.role === "store") return { ...base, cell: (row) => row.storeName }
      if (spec.role === "employees") return { ...base, cell: (row) => formatCount(row.employeeCount) }
      if (!spec.day || !spec.value) return base

      const day = spec.day
      const source = spec.part === "sale" || spec.part === "service" ? spec.part : undefined
      const cellOf = (row: CommissionDailyRow) => (day === "total" ? row.total : row.days[day])
      const future = day !== "total" && day > today
      return {
        ...base,
        cellHint: future ? undefined : (row) => cellHint(cellOf(row)),
        cell: (row) => {
          const amount = <MatrixAmount value={spec.value!(row)} />
          if (future) return amount
          // 岗位视图不下钻；点日期格进当日明细，点本期合计进整月明细
          const href = drill(row, { date: day === "total" ? undefined : day, source })
          return href ? <Link href={href} className="hover:underline">{amount}</Link> : amount
        },
      }
    })
  }, [specs, drill, today])

  const totalsValues = React.useMemo(() => commissionDailyTotalsMap(specs, totals), [specs, totals])

  const pendingHref = React.useMemo(() => {
    const range = monthRange(data.month)
    // 与待分配提示同口径：款项归属日期（/allocations 的默认 dateBasis）落在所选月
    const params = new URLSearchParams({ tab: "sale", allocStatus: "待分配", from: range.start, to: range.end })
    if (scopeParam === "market" && scopeIdParam) params.set("market", scopeIdParam)
    if (scopeParam === "store" && scopeIdParam) params.set("store", scopeIdParam)
    return `/allocations?${params.toString()}`
  }, [data.month, scopeParam, scopeIdParam])

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6" data-testid="commission-kpis">
        <KpiCard label="本月提成合计" cell={{ value: kpis.total, unit: "amount" }} />
        <KpiCard label="业绩提成" cell={{ value: kpis.sale, unit: "amount" }} hint={`占比 ${formatPercent(kpis.saleShare)}`} />
        <KpiCard label="消耗提成" cell={{ value: kpis.service, unit: "amount" }} hint={`占比 ${formatPercent(kpis.serviceShare)}`} />
        <KpiCard
          label="有提成员工数"
          cell={{ value: kpis.earningEmployees, unit: "count" }}
          hint={`净提成大于 0；范围内共 ${formatCount(kpis.employees)} 位`}
        />
        <KpiCard
          label="人均提成"
          cell={{ value: kpis.perTechnician, unit: "amount" }}
          hint={`÷ 产能技师 ${formatCount(kpis.technicianCount)} 人（同人效板；非超管的总部账号不含无门店市场的直挂技师）`}
        />
        <KpiCard label="单均提成" cell={{ value: kpis.perOrder, unit: "amount" }} hint={`÷ ${formatCount(kpis.orders)} 单（含 0 提成订单）`} />
      </div>

      {data.pending.count > 0 && (
        <div className="flex items-center gap-2 text-sm text-[var(--color-status-pending)]" data-testid="commission-pending">
          <AlertCircle className="size-4" />
          <span>
            本月待分配 {formatCount(data.pending.count)} 笔 / ¥{formatAmount(data.pending.amount)}，分配后本页数字会随之变化
          </span>
          {data.canLinkAllocations && (
            <Link href={pendingHref} className="text-[var(--color-brand)] hover:underline">去分配</Link>
          )}
        </div>
      )}

      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1" role="group" aria-label="视图">
            {COMMISSION_VIEWS.map((view) => (
              <button
                key={view}
                type="button"
                aria-pressed={options.view === view}
                onClick={() => filters.setMany({ view: view === "total" ? "" : view, sort: "", dir: "" })}
                className={cn(
                  "rounded-[var(--radius)] border px-3 py-1.5 text-sm transition-colors",
                  options.view === view
                    ? "border-[var(--primary)] bg-[#FFF0EE] text-[var(--primary)]"
                    : "border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
                )}
              >
                {COMMISSION_VIEW_LABELS[view]}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1" role="group" aria-label="汇总维度">
            {(["employee", "position"] as const).map((group) => (
              <button
                key={group}
                type="button"
                aria-pressed={options.group === group}
                onClick={() => filters.setMany({ group: group === "employee" ? "" : group, sort: "", dir: "" })}
                className={cn(
                  "rounded-[var(--radius)] border px-3 py-1.5 text-sm transition-colors",
                  options.group === group
                    ? "border-[var(--primary)] bg-[#FFF0EE] text-[var(--primary)]"
                    : "border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
                )}
              >
                {group === "employee" ? "按员工" : "按岗位"}
              </button>
            ))}
          </div>
          {data.isAllScope && options.group === "employee" && (
            <span className="flex items-center gap-2 text-sm">
              <Switch
                aria-label="按员工合并"
                checked={options.merge}
                onCheckedChange={(checked) => filters.setMany({ merge: checked ? "1" : "", sort: "", dir: "" })}
              />
              <span>按员工合并</span>
            </span>
          )}
          <span className="flex items-center gap-2 text-sm">
            <Switch
              aria-label="隐藏 0 提成行"
              checked={options.hideZero}
              onCheckedChange={(checked) => filters.set("hideZero", checked ? "1" : "")}
            />
            <span title="只隐藏本期合计为 0 的行，负数行保留">隐藏 0 提成行</span>
          </span>
          <Input
            className="w-56"
            aria-label="员工搜索"
            placeholder="搜索姓名 / 岗位 / 门店"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="ml-auto">
            <ExportButton
              exportRequest={{
                exportType: "data-center",
                payload: { view: "report-commission-daily", params: commissionExportParams(searchParams.entries()) },
              }}
            />
          </div>
        </div>

        <MatrixTable
          columns={columns}
          rows={data.rows}
          rowKey={(row) => row.key}
          emptyText="本月暂无提成数据"
          sort={data.sort}
          onSortChange={(sort) => filters.setMany({ sort: sort.key === "total" && sort.direction === "desc" ? "" : sort.key, dir: sort.key === "total" && sort.direction === "desc" ? "" : sort.direction })}
          totals={{ label: commissionTotalsLabel(grain, totals), values: totalsValues }}
        />
        <div className="text-xs text-[var(--muted-foreground)]" data-testid="commission-footer">
          {data.month} · 共 {formatCount(totals.total.orders)} 单
          {grain !== "position" && " · 按单据门店切分；员工排行榜展示的是个人全域产出，两者数值不同"}
        </div>
      </Card>
    </div>
  )
}
