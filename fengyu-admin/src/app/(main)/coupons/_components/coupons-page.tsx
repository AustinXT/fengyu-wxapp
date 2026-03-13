"use client"

import { useState, useMemo } from "react"
import Link from "next/link"
import type { CouponTemplate, CouponType } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { DataTable, type Column } from "@/components/ui/data-table"
import { Pagination } from "@/components/ui/pagination"
import { formatCurrency, formatDate } from "@/lib/utils"

const PAGE_SIZE = 10

const COUPON_TYPE_COLORS: Record<CouponType, string> = {
  "现金券": "border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]",
  "项目券": "border-[#5E8BB3] text-[#5E8BB3] bg-[#F0F5FA]",
  "折扣券": "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]",
}

function formatDiscount(tpl: CouponTemplate): string {
  if (tpl.couponType === "折扣券") {
    return `${(parseFloat(tpl.discountValue) * 10).toFixed(1)}折`
  }
  return formatCurrency(tpl.discountValue)
}

function formatValidity(tpl: CouponTemplate): string {
  if (tpl.validityMode === "days" && tpl.validDays) {
    return `领取后${tpl.validDays}天`
  }
  if (tpl.validFrom && tpl.validTo) {
    return `${formatDate(tpl.validFrom)} ~ ${formatDate(tpl.validTo)}`
  }
  return "—"
}

interface CouponsPageProps {
  templates: CouponTemplate[]
}

export default function CouponsPage({ templates }: CouponsPageProps) {
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)

  const filtered = useMemo(() => {
    if (!search.trim()) return templates
    const q = search.trim().toLowerCase()
    return templates.filter((t) =>
      t.name.toLowerCase().includes(q)
    )
  }, [templates, search])

  const paged = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filtered, page]
  )

  const columns: Column<CouponTemplate>[] = [
    {
      key: "name",
      header: "券名称",
      cell: (row) => <span className="font-medium">{row.name}</span>,
    },
    {
      key: "couponType",
      header: "券类型",
      cell: (row) => (
        <Badge variant="outline" className={COUPON_TYPE_COLORS[row.couponType]}>
          {row.couponType}
        </Badge>
      ),
    },
    {
      key: "discountValue",
      header: "面值/折扣",
      cell: (row) => <span className="font-medium">{formatDiscount(row)}</span>,
    },
    {
      key: "minSpend",
      header: "使用条件",
      cell: (row) =>
        row.minSpend && parseFloat(row.minSpend) > 0
          ? `满${formatCurrency(row.minSpend)}可用`
          : "无门槛",
    },
    {
      key: "validity",
      header: "有效期",
      cell: (row) => <span>{formatValidity(row)}</span>,
    },
    {
      key: "totalCount",
      header: "已发/总量",
      cell: (row) => (
        <span>
          0 / {row.totalCount ?? "不限"}
        </span>
      ),
    },
    {
      key: "isActive",
      header: "状态",
      cell: (row) => (
        <Badge
          variant="outline"
          className={
            row.isActive
              ? "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]"
              : "border-[#888888] text-[#888888] bg-[#F5F5F5]"
          }
        >
          {row.isActive ? "启用" : "停用"}
        </Badge>
      ),
    },
    {
      key: "actions",
      header: "操作",
      cell: (row) => (
        <div className="flex gap-2">
          <Link href={`/coupons/${row.templateId}`}>
            <Button variant="link" size="sm" className="h-auto p-0">
              详情
            </Button>
          </Link>
          <Button variant="link" size="sm" className="h-auto p-0">
            编辑
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">优惠券管理</h1>
        <Link href="/coupons/create">
          <Button>新增优惠券</Button>
        </Link>
      </div>

      <div className="flex items-center gap-3">
        <Input
          placeholder="搜索券名称"
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
