"use client"

import { useCallback, useMemo, useState } from "react"
import Link from "next/link"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { DataTable, type Column } from "@/components/ui/data-table"
import { Pagination } from "@/components/ui/pagination"
import type { MerchantListItem } from "@/actions/lakala-onboarding"
import type { LakalaOnboardingStatus } from "@/lib/lakala-onboarding-state"

const PAGE_SIZE_OPTIONS = [10, 20, 50]

const STATUS_OPTIONS: Array<{ value: LakalaOnboardingStatus | ""; label: string }> = [
  { value: "", label: "全部状态" },
  { value: "draft", label: "草稿" },
  { value: "contract_signing", label: "合同申请中" },
  { value: "contract_signed", label: "合同已签" },
  { value: "attachments_uploading", label: "附件上传中" },
  { value: "submitted", label: "已提交" },
  { value: "callback_pending", label: "等待回调" },
  { value: "approved", label: "审核通过" },
  { value: "rejected", label: "审核驳回" },
  { value: "under_review", label: "转人工审核" },
  { value: "appealing", label: "复议中" },
  { value: "realname_pending", label: "实名报备中" },
  { value: "completed", label: "已完成" },
  { value: "cancelled", label: "已作废" },
]

const STATUS_LABEL = Object.fromEntries(STATUS_OPTIONS.map((o) => [o.value, o.label])) as Record<string, string>

const STATUS_COLOR: Record<LakalaOnboardingStatus, string> = {
  draft: "border-[#888888] text-[#888888] bg-[#F5F5F5]",
  contract_signing: "border-[#5E8BB3] text-[#5E8BB3] bg-[#F0F5FA]",
  contract_signed: "border-[#5E8BB3] text-[#5E8BB3] bg-[#F0F5FA]",
  attachments_uploading: "border-[#5E8BB3] text-[#5E8BB3] bg-[#F0F5FA]",
  submitted: "border-[#5E8BB3] text-[#5E8BB3] bg-[#F0F5FA]",
  callback_pending: "border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]",
  approved: "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]",
  rejected: "border-[#D94040] text-[#D94040] bg-[#FFF0F0]",
  under_review: "border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]",
  appealing: "border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]",
  realname_pending: "border-[#5E8BB3] text-[#5E8BB3] bg-[#F0F5FA]",
  completed: "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]",
  cancelled: "border-[#888888] text-[#888888] bg-[#F5F5F5]",
}

export default function LakalaOnboardingListPage({
  rows,
  initial,
}: {
  rows: MerchantListItem[]
  initial: { status: string; q: string }
}) {
  const { get, set, setMany } = useUrlFilters()
  const [searchInput, setSearchInput] = useState(get("q", initial.q))
  const debounceRef = useState<ReturnType<typeof setTimeout> | null>(null)

  const setFilter = useCallback(
    (key: string, value: string) => setMany({ [key]: value, page: "" }),
    [setMany],
  )

  const handleSearchChange = useCallback(
    (v: string) => {
      setSearchInput(v)
      if (debounceRef[0]) clearTimeout(debounceRef[0])
      debounceRef[0] = setTimeout(() => setFilter("q", v), 300)
    },
    [setFilter, debounceRef],
  )

  const page = Number(get("page", "1")) || 1
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(get("size"))) ? Number(get("size")) : 20

  const paged = useMemo(() => rows.slice((page - 1) * pageSize, page * pageSize), [rows, page, pageSize])

  const columns: Column<MerchantListItem>[] = [
    {
      key: "merchantName",
      header: "商户名",
      cell: (r) => (
        <Link href={`/lakala-onboarding/${r.id}`} className="text-[var(--primary)] hover:underline">
          {r.merchantName}
          {r.applicantUserId === null ? (
            <span className="ml-2 text-xs text-[#D4820A] border border-[#D4820A] rounded px-1 py-0.5">legacy</span>
          ) : null}
        </Link>
      ),
    },
    {
      key: "onboardingStatus",
      header: "状态",
      cell: (r) => (
        <Badge variant="outline" className={STATUS_COLOR[r.onboardingStatus]}>
          {STATUS_LABEL[r.onboardingStatus] ?? r.onboardingStatus}
        </Badge>
      ),
    },
    {
      key: "merchantNo",
      header: "商户号",
      cell: (r) => <span className="font-mono text-xs">{r.merchantNo ?? "—"}</span>,
    },
    {
      key: "linkedStoreCount",
      header: "绑定门店数",
      cell: (r) => <span>{r.linkedStoreCount}</span>,
    },
    {
      key: "applicantUserId",
      header: "申请人",
      cell: (r) => <span>{r.applicantUserId ?? "—"}</span>,
    },
    {
      key: "createdAt",
      header: "创建时间",
      cell: (r) => <span className="text-xs text-[var(--muted-foreground)]">{r.createdAt?.slice(0, 19).replace("T", " ")}</span>,
    },
    {
      key: "actions",
      header: "操作",
      cell: (r) => (
        <Link href={`/lakala-onboarding/${r.id}`}>
          <Button variant="link" size="sm" className="h-auto p-0">
            查看
          </Button>
        </Link>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">商户入网</h1>
        <Link href="/lakala-onboarding/new">
          <Button>新建入网申请</Button>
        </Link>
      </div>

      <div className="flex items-center gap-3">
        <Select
          value={get("status", initial.status)}
          onChange={(e) => setFilter("status", e.target.value)}
          className="w-40"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <Input
          placeholder="搜索商户名 / 商户号"
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="w-72"
        />
      </div>

      <DataTable columns={columns} data={paged} emptyText="暂无商户入网记录" />

      <Pagination
        total={rows.length}
        page={page}
        pageSize={pageSize}
        onPageChange={(p) => set("page", String(p))}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        onPageSizeChange={(s) => setMany({ size: String(s), page: "" })}
      />
    </div>
  )
}
