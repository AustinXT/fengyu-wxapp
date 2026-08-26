"use client"

import { useState, useCallback } from "react"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import type {
  AdminCardTransaction,
  CardTransactionSummary,
} from "@/lib/types"
import type { MarketStoreFilterOptions } from "@/lib/market-store-filter-types"
import MarketStoreFilter from "@/components/market-store-filter"
import { PreserveListContextLink } from "@/components/return-context"
import { Input } from "@/components/ui/input"
import { DatePicker } from "@/components/ui/date-picker"
import { Select } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { MemberLevelBadge } from "@/components/ui/member-level-badge"
import { Card, CardContent } from "@/components/ui/card"
import { DataTable, type Column } from "@/components/ui/data-table"
import { Pagination } from "@/components/ui/pagination"
import { formatPhone, formatDateTime } from "@/lib/utils"

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100]

/**
 * 类型下拉选项（静态）—— 与 db/schema/enums.ts:cardTransactionTypeEnum 同步。
 * 若枚举扩值（如新增 `退款`/`赠送`），此处需同步更新。
 */
const TYPE_OPTIONS: Array<'充值' | '扣款'> = ['充值', '扣款']

const TYPE_COLORS: Record<string, string> = {
  "充值": "border-[#5E8BB3] text-[#5E8BB3] bg-[#F0F5FA]",
  "扣款": "border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]",
}

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

function formatCurrency(amount: number, withSign = false): string {
  const abs = Math.abs(amount)
  const body = `¥${abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  if (!withSign) return body
  if (amount > 0) return `+${body}`
  if (amount < 0) return `-${body}`
  return body
}

/**
 * 充值卡流水列表页 — 服务端分页 + 汇总统计
 *
 * 数据已在 Server Component 中通过 getCardTransactionsPaginated() 完成 DB 级过滤+分页+汇总。
 * 汇总统计（summary）反映当前筛选条件下的全量统计，而不仅是当前页。
 */
export default function CardTransactionsPage({
  transactions,
  total,
  summary,
  filterOptions,
}: {
  transactions: AdminCardTransaction[]
  total: number
  summary: CardTransactionSummary
  filterOptions: MarketStoreFilterOptions
}) {
  const { get, set, setMany } = useUrlFilters()
  const setFilter = useCallback((key: string, value: string) => {
    setMany({ [key]: value, page: '' })
  }, [setMany])

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

  const columns: Column<AdminCardTransaction>[] = [
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
          {row.customerName ? (
            <PreserveListContextLink
              href={`/customers/${row.userId}`}
              className="font-medium text-[#5E8BB3] hover:underline"
            >
              {row.customerName}
            </PreserveListContextLink>
          ) : (
            <span className="font-medium">—</span>
          )}
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
        <Badge variant="outline" className={TYPE_COLORS[row.type] ?? ""}>
          {row.type}
        </Badge>
      ),
    },
    {
      key: "amount",
      header: "金额",
      cell: (row) => (
        <span
          className={`font-mono font-semibold ${
            row.amount > 0 ? "text-[#3D8A5A]" : row.amount < 0 ? "text-[#D94040]" : "text-[#888]"
          }`}
        >
          {formatCurrency(row.amount, true)}
        </span>
      ),
    },
    {
      key: "balance",
      header: "当前余额",
      cell: (row) => (
        <span className="font-mono text-[#666]">{formatCurrency(row.balance)}</span>
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
        <h1 className="text-2xl font-bold text-[var(--foreground)]">充值卡流水</h1>
      </div>

      {/* 汇总统计 */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
        <StatCard
          label="总充值金额"
          value={formatCurrency(summary.totalRecharge)}
          valueClassName="text-[#3D8A5A]"
        />
        <StatCard
          label="总扣款金额"
          value={formatCurrency(summary.totalDeduct)}
          valueClassName="text-[#D94040]"
        />
        <StatCard
          label="净变动"
          value={formatCurrency(summary.netChange, true)}
          valueClassName={summary.netChange >= 0 ? "text-[#3D8A5A]" : "text-[#D94040]"}
        />
        <StatCard
          label="流水笔数"
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
          {TYPE_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
        <div className="flex items-center gap-2">
          <DatePicker
            value={startDate}
            onValueChange={(value) => setFilter("start", value)}
            className="w-40"
          />
          <span className="text-[#999]">—</span>
          <DatePicker
            value={endDate}
            onValueChange={(value) => setFilter("end", value)}
            className="w-40"
          />
        </div>
        <Input
          placeholder="搜索姓名 / 手机号"
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="max-w-xs"
        />
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
