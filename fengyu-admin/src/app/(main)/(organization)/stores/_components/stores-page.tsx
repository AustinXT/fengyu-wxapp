"use client"

import { useState, useMemo, useCallback } from "react"
import Link from "next/link"
import type { Store } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { DataTable, type Column } from "@/components/ui/data-table"
import { Pagination } from "@/components/ui/pagination"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import { PreserveListContextLink } from "@/components/return-context"
import { normalizePage } from "@/lib/paging"

const PAGE_SIZE_OPTIONS = [10, 20, 50]

export default function StoresPage({
  stores,
  canCreate,
  canUpdate,
}: {
  stores: Store[]
  canCreate: boolean
  canUpdate: boolean
}) {
  const { get, set, setMany } = useUrlFilters()
  const setFilter = useCallback((key: string, value: string) => {
    setMany({ [key]: value, page: '' })
  }, [setMany])

  const [searchInput, setSearchInput] = useState(get("q"))
  const debounceRef = useState<ReturnType<typeof setTimeout> | null>(null)
  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value)
    if (debounceRef[0]) clearTimeout(debounceRef[0])
    debounceRef[0] = setTimeout(() => setFilter("q", value), 300)
  }, [setFilter, debounceRef])

  const search = get("q")
  const marketFilter = get("market")
  const page = normalizePage(get("page", "1"))
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(get("size"))) ? Number(get("size")) : 20

  const markets = useMemo(() => {
    const names = [...new Set(stores.map((s) => s.marketName).filter(Boolean))] as string[]
    return names.sort()
  }, [stores])

  const filtered = useMemo(() => {
    let result = stores
    if (marketFilter) {
      result = result.filter((s) => s.marketName === marketFilter)
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      result = result.filter(
        (s) =>
          s.storeName.toLowerCase().includes(q) ||
          s.phone?.includes(q)
      )
    }
    return result
  }, [search, marketFilter, stores])

  const paged = useMemo(
    () => filtered.slice((page - 1) * pageSize, page * pageSize),
    [filtered, page, pageSize]
  )

  const columns: Column<Store>[] = [
    { key: "storeName", header: "门店名称" },
    { key: "marketName", header: "所属市场" },
    {
      key: "isClosed",
      header: "营业状态",
      cell: (row) => (
        <Badge
          variant="outline"
          className={
            row.isClosed
              ? "border-[#888888] text-[#888888] bg-[#F5F5F5]"
              : "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]"
          }
        >
          {row.isClosed ? "已关店" : "营业中"}
        </Badge>
      ),
    },
    {
      key: "bedCount",
      header: "床位数",
      cell: (row) => <span>{row.bedCount ?? "—"}</span>,
    },
    {
      key: "phone",
      header: "联系电话",
      cell: (row) => <span>{row.phone ?? "—"}</span>,
    },
    {
      key: "actions",
      header: "操作",
      cell: (row) => canUpdate ? (
          <PreserveListContextLink href={`/stores/${row.storeId}/edit`}>
            <Button variant="link" size="sm" className="h-auto p-0">
              编辑
            </Button>
          </PreserveListContextLink>
        ) : null,
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">门店管理</h1>
        {canCreate && <Link href="/stores/create"><Button>新增门店</Button></Link>}
      </div>

      <div className="flex items-center gap-3">
        <Select
          value={marketFilter}
          onChange={(e) => setFilter("market", e.target.value)}
          className="w-40"
        >
          <option value="">全部市场</option>
          {markets.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </Select>
        <Input
          placeholder="搜索门店名称 / 电话"
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="max-w-xs"
        />
      </div>

      <DataTable columns={columns} data={paged} />

      <Pagination
        total={filtered.length}
        pageSize={pageSize}
        page={page}
        onPageChange={(p) => set("page", p === 1 ? "" : String(p))}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        onPageSizeChange={(size) => setMany({ size: String(size), page: '' })}
      />
    </div>
  )
}
