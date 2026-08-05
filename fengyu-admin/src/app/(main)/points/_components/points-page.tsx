"use client"

import { useState, useCallback } from "react"
import { useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import type {
  PointTransaction,
  PointTransactionSummary,
} from "@/lib/types"
import type { MarketStoreFilterOptions } from "@/lib/market-store-filter-types"
import MarketStoreFilter from "@/components/market-store-filter"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { MemberLevelBadge } from "@/components/ui/member-level-badge"
import { Card, CardContent } from "@/components/ui/card"
import { DataTable, type Column } from "@/components/ui/data-table"
import { Pagination } from "@/components/ui/pagination"
import { formatPhone, formatDateTime } from "@/lib/utils"
import { ExportButton } from "@/components/ui/export-button"
import { exportPointTransactions } from "@/actions/points"
import { exportToXlsx, fmtDateTime } from "@/lib/export-xlsx"

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100]

function StatCard({ label, value, valueClassName }: { label: string; value: string; valueClassName?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-sm text-[var(--muted-foreground)]">{label}</div>
        <div className={`mt-1 text-2xl font-semibold ${valueClassName ?? ""}`}>{value}</div>
      </CardContent>
    </Card>
  )
}

/**
 * 积分流水列表页 — 服务端分页 + 汇总统计
 *
 * 数据已在 Server Component 中通过 getPointTransactionsPaginated() 完成 DB 级过滤+分页+汇总。
 * 汇总统计（summary）反映当前筛选条件下的全量统计，而不仅是当前页。
 */
export default function PointsPage({
  transactions,
  total,
  summary,
  distinctTypes,
  filterOptions,
}: {
  transactions: PointTransaction[]
  total: number
  summary: PointTransactionSummary
  distinctTypes: string[]
  filterOptions: MarketStoreFilterOptions
}) {
  const { get, set, setMany } = useUrlFilters()
  const searchParams = useSearchParams()
  const setFilter = useCallback((key: string, value: string) => {
    setMany({ [key]: value, page: '' })
  }, [setMany])

  /** 导出当前筛选命中的全部积分流水（跨分页） */
  const handleExport = useCallback(async () => {
    const raw = Object.fromEntries(searchParams.entries())
    const { rows } = await exportPointTransactions(raw)
    if (rows.length === 0) {
      toast.info("当前筛选无数据可导出")
      return
    }
    await exportToXlsx({
      filename: "积分流水",
      sheetName: "积分流水",
      columns: [
        { header: "时间", width: 20, accessor: (r) => fmtDateTime(r.createdAt) },
        { header: "顾客", accessor: (r) => r.customerName },
        { header: "顾客手机", width: 14, accessor: (r) => r.customerPhone },
        { header: "会员等级", width: 10, accessor: (r) => r.memberLevel },
        { header: "归属门店", width: 18, accessor: (r) => r.storeName },
        { header: "类型", width: 14, accessor: (r) => r.type },
        { header: "变动积分", accessor: (r) => r.amount },
        { header: "关联订单", width: 22, accessor: (r) => r.refOrderId },
      ],
      rows,
    })
  }, [searchParams])

  const marketFilter = get("market")
  const storeFilter = get("store")
  const typeFilter = get("type")
  const startDate = get("start")
  const endDate = get("end")
  const currentPage = Math.max(1, Number(get("page", "1")) || 1)
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(get("size"))) ? Number(get("size")) : 20

  // 搜索防抖
  const [searchInput, setSearchInput] = useState(get("q"))
  const debounceRef = useState<ReturnType<typeof setTimeout> | null>(null)
  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value)
    if (debounceRef[0]) clearTimeout(debounceRef[0])
    debounceRef[0] = setTimeout(() => setFilter("q", value), 300)
  }, [setFilter, debounceRef])

  const formatAmount = (amount: number) => {
    const sign = amount > 0 ? "+" : ""
    return `${sign}${amount.toLocaleString()}`
  }

  const columns: Column<PointTransaction>[] = [
    {
      key: "createdAt",
      header: "时间",
      cell: (row) => <span className="whitespace-nowrap text-[#666]">{formatDateTime(row.createdAt) || "—"}</span>,
    },
    {
      key: "customerName",
      header: "顾客",
      cell: (row) => (
        <div className="flex flex-col">
          <span className="font-medium">{row.customerName ?? "—"}</span>
          <span className="text-xs text-[#999]">{row.customerPhone ? formatPhone(row.customerPhone) : "—"}</span>
        </div>
      ),
    },
    {
      key: "memberLevel",
      header: "会员等级",
      cell: (row) =>
        row.memberLevel ? (
          <MemberLevelBadge level={row.memberLevel} />
        ) : (
          "—"
        ),
    },
    {
      key: "store",
      header: "归属门店",
      cell: (row) => (
        <div className="flex flex-col">
          <span>{row.storeName ?? "—"}</span>
          {row.marketName && <span className="text-xs text-[#999]">{row.marketName}</span>}
        </div>
      ),
    },
    {
      key: "type",
      header: "类型",
      cell: (row) => (
        <Badge variant="outline" className="text-[#5E8BB3] border-[#5E8BB3] bg-[#F0F5FA]">
          {row.type}
        </Badge>
      ),
    },
    {
      key: "amount",
      header: "变动",
      cell: (row) => (
        <span
          className={`font-mono font-semibold ${
            row.amount > 0 ? "text-[#3D8A5A]" : row.amount < 0 ? "text-[#D94040]" : "text-[#888]"
          }`}
        >
          {formatAmount(row.amount)}
        </span>
      ),
    },
    {
      key: "refOrderId",
      header: "关联订单",
      cell: (row) => (
        <span className="text-xs font-mono text-[#666]">{row.refOrderId ?? "—"}</span>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">积分流水</h1>
      </div>

      {/* 汇总统计 */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
        <StatCard
          label="总获取积分"
          value={summary.totalEarn.toLocaleString()}
          valueClassName="text-[#3D8A5A]"
        />
        <StatCard
          label="总消耗积分"
          value={summary.totalSpend.toLocaleString()}
          valueClassName="text-[#D94040]"
        />
        <StatCard
          label="净变动"
          value={`${summary.netChange >= 0 ? "+" : ""}${summary.netChange.toLocaleString()}`}
          valueClassName={summary.netChange >= 0 ? "text-[#3D8A5A]" : "text-[#D94040]"}
        />
        <StatCard
          label="交易笔数"
          value={summary.txnCount.toLocaleString()}
        />
        <StatCard
          label="涉及顾客数"
          value={summary.userCount.toLocaleString()}
        />
      </div>

      {/* 筛选区 */}
      <div className="flex flex-wrap items-center gap-3">
        <MarketStoreFilter
          options={filterOptions}
          marketValue={marketFilter}
          storeValue={storeFilter}
          onMarketChange={(value) => setMany({ market: value, store: '', page: '' })}
          onStoreChange={(value) => setFilter("store", value)}
        />
        <Select
          value={typeFilter}
          onChange={(e) => setFilter("type", e.target.value)}
          className="w-36"
        >
          <option value="">全部类型</option>
          {distinctTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
        <div className="flex items-center gap-2">
          <Input
            type="date"
            value={startDate}
            onChange={(e) => setFilter("start", e.target.value)}
            className="w-40"
          />
          <span className="text-[#999]">—</span>
          <Input
            type="date"
            value={endDate}
            onChange={(e) => setFilter("end", e.target.value)}
            className="w-40"
          />
        </div>
        <Input
          placeholder="搜索姓名 / 手机号"
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="max-w-xs"
        />
        <ExportButton onExport={handleExport} />
      </div>

      <DataTable columns={columns} data={transactions} />

      <Pagination
        total={total}
        pageSize={pageSize}
        page={currentPage}
        onPageChange={(p) => set("page", p === 1 ? "" : String(p))}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        onPageSizeChange={(size) => setMany({ size: String(size), page: '' })}
      />
    </div>
  )
}
