"use client"

import { useState, useMemo } from "react"
import Link from "next/link"
import { MOCK_STORES } from "@/lib/mock-data"
import type { Store } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { DataTable, type Column } from "@/components/ui/data-table"
import { Pagination } from "@/components/ui/pagination"

const PAGE_SIZE = 10

export default function StoresPage() {
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)

  const filtered = useMemo(() => {
    let result = MOCK_STORES
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      result = result.filter(
        (s) =>
          s.storeName.toLowerCase().includes(q) ||
          s.phone?.includes(q)
      )
    }
    return result
  }, [search])

  const paged = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filtered, page]
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
      cell: (row) => (
        <Link href={`/stores/${row.storeId}/edit`}>
          <Button variant="link" size="sm" className="h-auto p-0">
            编辑
          </Button>
        </Link>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">门店管理</h1>
        <Button>新增门店</Button>
      </div>

      <div className="flex items-center gap-3">
        <Input
          placeholder="搜索门店名称 / 电话"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setPage(1)
          }}
          className="max-w-xs"
        />
      </div>

      <DataTable columns={columns} data={paged} />

      <Pagination
        total={filtered.length}
        pageSize={PAGE_SIZE}
        page={page}
        onPageChange={setPage}
      />
    </div>
  )
}
