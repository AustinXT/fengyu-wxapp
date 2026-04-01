"use client"

import { useState, useMemo, useCallback } from "react"
import Link from "next/link"
import type { MallCategory, Product } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DataTable, type Column } from "@/components/ui/data-table"
import { Pagination } from "@/components/ui/pagination"
import { formatCurrency, formatDate } from "@/lib/utils"

const PAGE_SIZE_OPTIONS = [10, 20, 50]

export default function MallPageClient({
  categories,
  products,
}: {
  categories: MallCategory[]
  products: Product[]
}) {
  const [searchInput, setSearchInput] = useState("")
  const [catFilter, setCatFilter] = useState("")
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

  const filteredProducts = useMemo(() => {
    let result = products
    if (searchInput.trim()) {
      const q = searchInput.trim().toLowerCase()
      result = result.filter((p) => p.name.toLowerCase().includes(q))
    }
    if (catFilter) {
      result = result.filter((p) => p.categoryId === catFilter)
    }
    return result
  }, [products, searchInput, catFilter])

  const pagedProducts = useMemo(
    () => filteredProducts.slice((page - 1) * pageSize, page * pageSize),
    [filteredProducts, page, pageSize],
  )

  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value)
    setPage(1)
  }, [])

  const columns: Column<Product>[] = [
    {
      key: "coverImage",
      header: "封面图",
      cell: () => (
        <div className="h-10 w-10 rounded-[var(--radius)] bg-[var(--muted)] flex items-center justify-center text-xs text-[var(--muted-foreground)]">
          图
        </div>
      ),
    },
    {
      key: "name",
      header: "商品名称",
      cell: (row) => <span className="font-medium">{row.name}</span>,
    },
    {
      key: "categoryName",
      header: "商城分类",
      cell: (row) => <span>{row.categoryName ?? "—"}</span>,
    },
    {
      key: "price",
      header: "标价",
      cell: (row) => <span>{formatCurrency(row.price)}</span>,
    },
    {
      key: "specialPrice",
      header: "会员价",
      cell: (row) => (
        <span className={row.specialPrice ? "text-[#C0322A]" : ""}>
          {row.specialPrice ? formatCurrency(row.specialPrice) : "—"}
        </span>
      ),
    },
    {
      key: "validEnd",
      header: "有效期",
      cell: (row) => (
        <span>
          {row.validStart ? formatDate(row.validStart) : "—"} ~{" "}
          {row.validEnd ? formatDate(row.validEnd) : "长期"}
        </span>
      ),
    },
    {
      key: "skuCount",
      header: "规格数",
      cell: (row) => <span>{row.skuCount ?? 0}</span>,
    },
    {
      key: "actions",
      header: "操作",
      cell: (row) => (
        <Link href={`/products/${row.productId}`}>
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
        <h1 className="text-2xl font-bold text-[var(--foreground)]">商城管理</h1>
        <div className="flex gap-2">
          <Link href="/mall/categories">
            <Button variant="outline">商城分类</Button>
          </Link>
          <Link href="/products/create">
            <Button>新增商品</Button>
          </Link>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <select
          className="h-9 rounded-[var(--radius)] border border-[var(--input)] bg-transparent px-3 text-sm"
          value={catFilter}
          onChange={(e) => { setCatFilter(e.target.value); setPage(1) }}
        >
          <option value="">全部分类</option>
          {categories.filter((c) => c.isValid).map((c) => (
            <option key={c.categoryId} value={c.categoryId}>
              {c.categoryName}
            </option>
          ))}
        </select>
        <Input
          placeholder="搜索商品名称"
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="max-w-xs"
        />
      </div>

      <DataTable columns={columns} data={pagedProducts} />

      <Pagination
        total={filteredProducts.length}
        pageSize={pageSize}
        page={page}
        onPageChange={setPage}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        onPageSizeChange={(size) => { setPageSize(size); setPage(1) }}
      />
    </div>
  )
}
