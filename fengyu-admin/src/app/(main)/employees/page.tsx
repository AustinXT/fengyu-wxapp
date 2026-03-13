"use client"

import { useState, useMemo } from "react"
import Link from "next/link"
import { MOCK_EMPLOYEES, MOCK_STORES } from "@/lib/mock-data"
import type { Employee } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { DataTable, type Column } from "@/components/ui/data-table"
import { Pagination } from "@/components/ui/pagination"
import { formatPhone } from "@/lib/utils"

const PAGE_SIZE = 10

export default function EmployeesPage() {
  const [search, setSearch] = useState("")
  const [storeFilter, setStoreFilter] = useState("")
  const [statusFilter, setStatusFilter] = useState("")
  const [page, setPage] = useState(1)

  const filtered = useMemo(() => {
    let result = MOCK_EMPLOYEES
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      result = result.filter(
        (e) =>
          e.name?.toLowerCase().includes(q) ||
          e.employeeId.toLowerCase().includes(q) ||
          e.phone?.includes(q)
      )
    }
    if (storeFilter) {
      result = result.filter((e) => e.storeId === storeFilter)
    }
    if (statusFilter === "active") {
      result = result.filter((e) => !e.isResigned)
    } else if (statusFilter === "resigned") {
      result = result.filter((e) => e.isResigned)
    }
    return result
  }, [search, storeFilter, statusFilter])

  const paged = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filtered, page]
  )

  const columns: Column<Employee>[] = [
    { key: "employeeId", header: "员工编号" },
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
      header: "所属门店",
      cell: (row) => <span>{row.storeName ?? "—"}</span>,
    },
    {
      key: "departmentName",
      header: "部门",
      cell: (row) => <span>{row.departmentName ?? "—"}</span>,
    },
    {
      key: "positionName",
      header: "职位",
      cell: (row) => <span>{row.positionName ?? "—"}</span>,
    },
    {
      key: "isResigned",
      header: "在职状态",
      cell: (row) => (
        <Badge
          variant="outline"
          className={
            row.isResigned
              ? "border-[#888888] text-[#888888] bg-[#F5F5F5]"
              : "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]"
          }
        >
          {row.isResigned ? "已离职" : "在职"}
        </Badge>
      ),
    },
    {
      key: "actions",
      header: "操作",
      cell: (row) => (
        <Link href={`/employees/${row.employeeId}`}>
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
        <h1 className="text-2xl font-bold text-[var(--foreground)]">员工管理</h1>
        <Button>新增员工</Button>
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
          {MOCK_STORES.map((s) => (
            <option key={s.storeId} value={s.storeId}>
              {s.storeName}
            </option>
          ))}
        </Select>
        <Select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value)
            setPage(1)
          }}
          className="w-32"
        >
          <option value="">全部状态</option>
          <option value="active">在职</option>
          <option value="resigned">已离职</option>
        </Select>
        <Input
          placeholder="搜索编号 / 姓名 / 手机号"
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
