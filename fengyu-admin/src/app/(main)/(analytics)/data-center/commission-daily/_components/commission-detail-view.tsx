"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { DatePicker } from "@/components/ui/date-picker"
import { Select, SelectOption } from "@/components/ui/select"
import { ExportButton } from "@/components/ui/export-button"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import { withReturnTo } from "@/lib/return-context"
import {
  COMMISSION_DETAIL_PAGE_SIZES,
  COMMISSION_SOURCES,
  COMMISSION_SOURCE_LABELS,
  commissionExportParams,
} from "@/lib/data-center/commission-daily"
import {
  buildCommissionDetailColumns,
  productLabel,
  type CommissionDetailRow,
} from "@/lib/data-center/commission-columns"
import type { ScopeStoreEntry } from "@/lib/data-center/scope-options"
import type { CommissionDetailResult } from "@/actions/data-center/commission"
import { KpiCard } from "../../_components/kpi-card"
import { MatrixTable, type MatrixColumn } from "../../_components/matrix-table"

/** 改筛选时一并清掉的翻页参数（游标还绑定了筛选签名，这里清掉是为了 URL 干净） */
const CLEAR_PAGING = { after: "", before: "" }

/**
 * 提成明细（#375，从员工提成日报下钻）：员工 / 门店 / 日期 / 提成类型筛选 + 4 张指标卡 + keyset 分页明细表。
 */
export function CommissionDetailView({
  data,
  stores,
  monthStart,
  monthEnd,
}: {
  data: CommissionDetailResult
  /** 当前范围内的门店（下拉；默认下钻时的单据门店，可切到全部） */
  stores: readonly ScopeStoreEntry[]
  monthStart: string
  monthEnd: string
}) {
  const filters = useUrlFilters()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { summary } = data
  // 订单详情的返回地址：本页当前筛选，但去掉本页自己的 returnTo，免得地址层层嵌套变长
  const selfHref = React.useMemo(() => {
    const params = new URLSearchParams(searchParams.toString())
    params.delete("returnTo")
    const qs = params.toString()
    return `${pathname}${qs ? `?${qs}` : ""}`
  }, [pathname, searchParams])

  const columns = React.useMemo<MatrixColumn<CommissionDetailRow>[]>(
    () => buildCommissionDetailColumns({ showEmployee: !data.filters.employeeId }).map((spec) => {
      const column: MatrixColumn<CommissionDetailRow> = { ...spec }
      if (spec.role === "order") {
        column.cell = (row) => {
          if (!data.canLinkOrders) return row.orderId
          const href = row.source === "sale"
            ? (row.paymentId != null ? `/allocations/payments/${row.paymentId}` : null)
            : `/allocations/service/${encodeURIComponent(row.orderId)}`
          return href
            ? <Link href={withReturnTo(href, selfHref)} className="text-[var(--color-brand)] hover:underline">{row.orderId}</Link>
            : row.orderId
        }
      } else if (spec.role === "source") {
        column.cell = (row) => COMMISSION_SOURCE_LABELS[row.source]
      } else if (spec.key === "product") {
        column.cell = (row) => <span title={productLabel(row)} className="block truncate">{productLabel(row)}</span>
      } else if (spec.exportValue && !spec.value) {
        const text = spec.exportValue
        column.cell = (row) => String(text(row) ?? "")
      }
      return column
    }),
    [data.filters.employeeId, data.canLinkOrders, selfHref],
  )

  const employeeKnown = !data.filters.employeeId || data.employeeOptions.some((option) => option.employeeId === data.filters.employeeId)
  const storeKnown = !data.filters.storeId || stores.some((store) => store.storeId === data.filters.storeId)

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="commission-detail-kpis">
        <KpiCard label="提成合计" cell={{ value: summary.commission, unit: "amount" }} />
        <KpiCard label="业绩提成" cell={{ value: summary.sale, unit: "amount" }} />
        <KpiCard label="消耗提成" cell={{ value: summary.service, unit: "amount" }} />
        <KpiCard label="平均提成点" cell={{ value: summary.averageRate, unit: "percent" }} hint="Σ提成 ÷ Σ分配金额（含负数行、0 费率行）" />
      </div>

      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Select
            className="w-72"
            aria-label="员工"
            value={data.filters.employeeId ?? ""}
            onChange={(event) => filters.setMany({ employeeId: event.target.value, ...CLEAR_PAGING })}
          >
            <SelectOption value="">全部员工</SelectOption>
            {!employeeKnown && <SelectOption value={data.filters.employeeId!}>{data.filters.employeeId}（本月在当前范围无提成）</SelectOption>}
            {data.employeeOptions.map((option) => (
              <SelectOption key={option.employeeId} value={option.employeeId}>{option.label}</SelectOption>
            ))}
          </Select>
          <Select
            className="w-48"
            aria-label="门店"
            value={data.filters.storeId ?? ""}
            onChange={(event) => filters.setMany({ storeId: event.target.value, ...CLEAR_PAGING })}
          >
            <SelectOption value="">全部门店</SelectOption>
            {!storeKnown && <SelectOption value={data.filters.storeId!}>{data.filters.storeId}（不在当前范围）</SelectOption>}
            {stores.map((store) => (
              <SelectOption key={store.storeId} value={store.storeId}>{store.storeName}</SelectOption>
            ))}
          </Select>
          <DatePicker
            className="w-40"
            aria-label="日期"
            value={data.filters.date ?? ""}
            min={monthStart}
            max={monthEnd}
            onValueChange={(value) => filters.setMany({ date: value, ...CLEAR_PAGING })}
          />
          {data.filters.date && (
            <Button type="button" variant="outline" size="sm" onClick={() => filters.setMany({ date: "", ...CLEAR_PAGING })}>
              显示全月
            </Button>
          )}
          <Select
            className="w-32"
            aria-label="提成类型"
            value={data.filters.source ?? ""}
            onChange={(event) => filters.setMany({ type: event.target.value, ...CLEAR_PAGING })}
          >
            <SelectOption value="">全部类型</SelectOption>
            {COMMISSION_SOURCES.map((source) => (
              <SelectOption key={source} value={source}>{COMMISSION_SOURCE_LABELS[source]}</SelectOption>
            ))}
          </Select>
          <div className="ml-auto">
            <ExportButton
              exportRequest={{
                exportType: "data-center",
                payload: { view: "report-commission-detail", params: { ...commissionExportParams(searchParams.entries()), month: data.month } },
              }}
            />
          </div>
        </div>

        <MatrixTable
          columns={columns}
          rows={data.rows}
          rowKey={(row) => row.key}
          emptyText="暂无提成明细"
          totals={{
            label: `合计（${summary.count} 条）`,
            values: {
              received: summary.received,
              allocated: summary.allocated,
              commission: summary.commission,
              rate: summary.averageRate,
            },
          }}
        />

        <div className="flex flex-wrap items-center justify-end gap-2 text-sm" data-testid="commission-detail-pager">
          <span className="mr-auto text-[var(--muted-foreground)]">
            共 {summary.count} 条 · {summary.orders} 单{data.customerMasked ? " · 顾客姓名已脱敏" : ""}
          </span>
          <span className="text-[var(--muted-foreground)]">每页</span>
          <Select
            className="w-20"
            aria-label="每页条数"
            value={String(data.pageSize)}
            onChange={(event) => filters.setMany({ size: event.target.value, ...CLEAR_PAGING })}
          >
            {COMMISSION_DETAIL_PAGE_SIZES.map((size) => <SelectOption key={size} value={String(size)}>{size}</SelectOption>)}
          </Select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!data.prevCursor}
            onClick={() => filters.setMany({ before: data.prevCursor ?? "", after: "" })}
          >
            上一页
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!data.nextCursor}
            onClick={() => filters.setMany({ after: data.nextCursor ?? "", before: "" })}
          >
            下一页
          </Button>
        </div>
      </Card>
    </div>
  )
}
