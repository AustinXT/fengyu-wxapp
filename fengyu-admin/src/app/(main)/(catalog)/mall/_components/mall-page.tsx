"use client"

import { useState, useMemo, useCallback } from "react"
import Link from "next/link"
import type { MallCategory, Product } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DataTable, type Column } from "@/components/ui/data-table"
import { Pagination } from "@/components/ui/pagination"
import { MallCategoryCascader } from "@/components/ui/mall-category-cascader"
import { ExportButton } from "@/components/ui/export-button"
import { formatCurrency, formatDate } from "@/lib/utils"
import { PreserveListContextLink } from "@/components/return-context"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"

const PAGE_SIZE_OPTIONS = [10, 20, 50]

export default function MallPageClient({
  categories,
  products,
  canCreate,
  canUpdate,
}: {
  categories: MallCategory[]
  products: Product[]
  canCreate: boolean
  canUpdate: boolean
}) {
  const { get, set, setMany } = useUrlFilters()
  const [searchInput, setSearchInput] = useState(get("q"))
  const debounceRef = useState<ReturnType<typeof setTimeout> | null>(null)
  const search = get("q")
  const catFilter = get("category")
  const page = Math.max(1, Number(get("page", "1")) || 1)
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(get("size"))) ? Number(get("size")) : 20

  const filteredProducts = useMemo(() => {
    let result = products
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      result = result.filter((p) => p.name.toLowerCase().includes(q))
    }
    if (catFilter) {
      result = result.filter((p) => p.categoryId === catFilter)
    }
    return result
  }, [products, search, catFilter])

  const pagedProducts = useMemo(
    () => filteredProducts.slice((page - 1) * pageSize, page * pageSize),
    [filteredProducts, page, pageSize],
  )

  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value)
    if (debounceRef[0]) clearTimeout(debounceRef[0])
    debounceRef[0] = setTimeout(() => setMany({ q: value, page: "" }), 300)
  }, [debounceRef, setMany])

  const columns: Column<Product>[] = [
    {
      key: "coverImage",
      header: "封面图",
      cell: (row) =>
        row.coverImage ? (
          <img
            src={row.coverImage}
            alt={row.name}
            className="h-10 w-10 rounded-[var(--radius)] object-cover"
          />
        ) : (
          <div className="h-10 w-10 rounded-[var(--radius)] bg-[var(--muted)] flex items-center justify-center text-xs text-[var(--muted-foreground)]">
            无图
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
      cell: (row) => (
        <span>
          {row.categoryGroup && row.categoryName
            ? `${row.categoryGroup} / ${row.categoryName}`
            : row.categoryName ?? "—"}
        </span>
      ),
    },
    {
      key: "isBundle",
      header: "套餐",
      cell: (row) => (
        <span>{row.isBundle ? "是" : "—"}</span>
      ),
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
      key: "isVisible",
      header: "状态",
      cell: (row) => (
        <span className={row.isVisible ? "text-[#5E8BB3]" : "text-[#888888]"}>
          {row.isVisible ? "展示中" : "未展示"}
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
        canUpdate && (
          <PreserveListContextLink href={`/mall/${row.productId}`}>
            <Button variant="link" size="sm" className="h-auto p-0">
              编辑
            </Button>
          </PreserveListContextLink>
        )
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">商城管理</h1>
        <div className="flex gap-2">
          {(canCreate || canUpdate) && (
            <Link href="/mall/categories">
              <Button variant="outline">商城分类</Button>
            </Link>
          )}
          {canCreate && (
            <Link href="/mall/create">
              <Button>新增商品</Button>
            </Link>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <MallCategoryCascader
          categories={categories}
          value={catFilter}
          onChange={(id) => setMany({ category: id, page: "" })}
          allowEmpty
          placeholder="全部分类"
          className="w-56"
        />
        <Input
          placeholder="搜索商品名称"
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="max-w-xs"
        />
        <ExportButton
          exportRequest={{
            exportType: "mall-products",
            payload: {
              q: search.trim(),
              category: catFilter,
            },
          }}
        />
      </div>

      <DataTable columns={columns} data={pagedProducts} />

      <Pagination
        total={filteredProducts.length}
        pageSize={pageSize}
        page={page}
        onPageChange={(next) => set("page", next === 1 ? "" : String(next))}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        onPageSizeChange={(size) => setMany({ size: String(size), page: "" })}
      />
    </div>
  )
}
