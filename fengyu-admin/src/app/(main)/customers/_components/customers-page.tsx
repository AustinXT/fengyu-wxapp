"use client"

import { useState, useMemo } from "react"
import Link from "next/link"
import type { Customer, Store } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { DataTable, type Column } from "@/components/ui/data-table"
import { Pagination } from "@/components/ui/pagination"
import { formatPhone } from "@/lib/utils"

const PAGE_SIZE = 10

const MEMBER_LEVEL_COLORS: Record<string, string> = {
  "钻石": "border-[#5E8BB3] text-[#5E8BB3] bg-[#F0F5FA]",
  "金卡": "border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]",
  "银卡": "border-[#888888] text-[#888888] bg-[#F5F5F5]",
  "新客": "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]",
}

const MEMBER_LEVELS = ["钻石", "金卡", "银卡", "新客"]

interface CustomersPageProps {
  customers: Customer[]
  stores: Store[]
}

export default function CustomersPage({ customers, stores }: CustomersPageProps) {
  const [search, setSearch] = useState("")
  const [storeFilter, setStoreFilter] = useState("")
  const [levelFilter, setLevelFilter] = useState("")
  const [page, setPage] = useState(1)

  const filtered = useMemo(() => {
    let result = customers
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      result = result.filter(
        (c) =>
          c.name?.toLowerCase().includes(q) ||
          c.phone?.includes(q)
      )
    }
    if (storeFilter) {
      result = result.filter((c) => c.boundStoreId === storeFilter)
    }
    if (levelFilter) {
      result = result.filter((c) => c.memberLevel === levelFilter)
    }
    return result
  }, [customers, search, storeFilter, levelFilter])

  const paged = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filtered, page]
  )

  const columns: Column<Customer>[] = [
    {
      key: "name",
      header: "姓名",
      cell: (row) => <span className="font-medium">{row.name ?? "—"}</span>,
    },
    {
      key: "phone",
      header: "手机号",
      cell: (row) => <span>{row.phone ? formatPhone(row.phone) : "—"}</span>,
    },
    {
      key: "storeName",
      header: "归属门店",
      cell: (row) => <span>{row.storeName ?? "—"}</span>,
    },
    {
      key: "memberLevel",
      header: "会员等级",
      cell: (row) =>
        row.memberLevel ? (
          <Badge
            variant="outline"
            className={MEMBER_LEVEL_COLORS[row.memberLevel] ?? ""}
          >
            {row.memberLevel}
          </Badge>
        ) : (
          "—"
        ),
    },
    {
      key: "category",
      header: "顾客分类",
      cell: (row) => <span>{row.category ?? "—"}</span>,
    },
    {
      key: "employeeName",
      header: "所属美容师",
      cell: (row) => <span>{row.employeeName ?? "—"}</span>,
    },
    {
      key: "actions",
      header: "操作",
      cell: (row) => (
        <Link href={`/customers/${row.userId}`}>
          <Button variant="link" size="sm" className="h-auto p-0">
            详情
          </Button>
        </Link>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">顾客管理</h1>
        <Button>新增顾客</Button>
      </div>

      <div className="flex items-center gap-3">
        <Select
          value={storeFilter}
          onChange={(e) => {
            setStoreFilter(e.target.value)
            setPage(1)
          }}
          className="w-40"
        >
          <option value="">全部门店</option>
          {stores.map((s) => (
            <option key={s.storeId} value={s.storeId}>
              {s.storeName}
            </option>
          ))}
        </Select>
        <Select
          value={levelFilter}
          onChange={(e) => {
            setLevelFilter(e.target.value)
            setPage(1)
          }}
          className="w-32"
        >
          <option value="">全部等级</option>
          {MEMBER_LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </Select>
        <Input
          placeholder="搜索姓名 / 手机号"
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
