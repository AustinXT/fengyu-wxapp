"use client"

import { useState, useMemo, useCallback } from "react"
import Link from "next/link"
import type { ProductSku, ProductCategory } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { DataTable, type Column } from "@/components/ui/data-table"
import { Pagination } from "@/components/ui/pagination"
import { Select } from "@/components/ui/select"
import { CategoryCascader } from "@/components/ui/category-cascader"
import { ExportButton } from "@/components/ui/export-button"
import { formatCurrency, formatDate } from "@/lib/utils"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import { PreserveListContextLink } from "@/components/return-context"
import { normalizePage } from "@/lib/paging"

const PAGE_SIZE_OPTIONS = [10, 20, 50]

const KIND_PALETTE = [
  "border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]",
  "border-[#5E8BB3] text-[#5E8BB3] bg-[#F0F5FA]",
  "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]",
  "border-[#888888] text-[#888888] bg-[#F5F5F5]",
  "border-[#C0322A] text-[#C0322A] bg-[#FFF0EE]",
  "border-[#8B5CF6] text-[#8B5CF6] bg-[#F5F0FF]",
  "border-[#EC4899] text-[#EC4899] bg-[#FFF0F5]",
  "border-[#0E7490] text-[#0E7490] bg-[#F0FAFA]",
]


export default function ProductsPageClient({
  skus,
  categories,
  productKinds,
  canCreate,
  canUpdate,
}: {
  skus: ProductSku[]
  categories: ProductCategory[]
  productKinds?: ProductCategory[]
  canCreate: boolean
  canUpdate: boolean
}) {
  const { get, set, setMany } = useUrlFilters()
  const setFilter = useCallback((key: string, value: string) => {
    setMany({ [key]: value, page: '' })
  }, [setMany])

  // 搜索框防抖
  const [searchInput, setSearchInput] = useState(get("q"))
  const debounceRef = useState<ReturnType<typeof setTimeout> | null>(null)
  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value)
    if (debounceRef[0]) clearTimeout(debounceRef[0])
    debounceRef[0] = setTimeout(() => setFilter("q", value), 300)
  }, [setFilter, debounceRef])

  const search = get("q")
  const categoryFilter = get("category")
  const kindFilter = get("kind")
  const statusFilter = get("status", "enabled") // 默认"启用"：URL 无 status 时只显示启用商品

  const page = normalizePage(get("page", "1"))
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(get("size"))) ? Number(get("size")) : 20

  // Build dynamic KIND_COLORS
  const kindColors = useMemo(() => {
    if (!productKinds) return {} as Record<string, string>
    const sorted = [...productKinds].filter(k => k.isValid).sort((a, b) => a.sortOrder - b.sortOrder)
    return Object.fromEntries(sorted.map((k, i) => [k.categoryName, KIND_PALETTE[i % KIND_PALETTE.length]]))
  }, [productKinds])

  const filtered = useMemo(() => {
    let result = skus
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      result = result.filter((s) => s.specName.toLowerCase().includes(q))
    }
    if (categoryFilter) {
      result = result.filter((s) => s.categoryId === categoryFilter)
    }
    if (kindFilter) {
      result = result.filter((s) => s.productKind === kindFilter)
    }
    if (statusFilter === "disabled") {
      result = result.filter((s) => !s.isEnabled)
    } else if (statusFilter !== "all") {
      // 默认 / "enabled"：只显示启用商品
      result = result.filter((s) => s.isEnabled)
    }
    return result
  }, [skus, search, categoryFilter, kindFilter, statusFilter])

  const paged = useMemo(
    () => filtered.slice((page - 1) * pageSize, page * pageSize),
    [filtered, page, pageSize]
  )

  const columns: Column<ProductSku>[] = [
    {
      key: "specName",
      header: "商品名称",
      cell: (row) => <span className="font-medium">{row.specName}</span>,
    },
    {
      key: "categoryName",
      header: "品项分类",
      cell: (row) => {
        const pk = row.productKind as string | undefined
        const cat = row.categoryName
        if (!pk && !cat) return "—"
        return (
          <span>
            {pk && (
              <Badge variant="outline" className={kindColors[pk] ?? KIND_PALETTE[0]}>
                {pk}
              </Badge>
            )}
            {pk && cat && " / "}
            {cat}
          </span>
        )
      },
    },
    {
      key: "productType",
      header: "产品类型",
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
      key: "sessionCount",
      header: "数量",
      cell: (row) => <span>{row.sessionCount == null ? "—" : `${row.sessionCount} ${row.unit}`}</span>,
    },
    {
      key: "purchaseLimit",
      header: "限购",
      cell: (row) => <span>{row.purchaseLimit ?? "不限"}</span>,
    },
    {
      key: "serviceFee",
      header: "手工费",
      cell: (row) => <span>{formatCurrency(row.serviceFee)}</span>,
    },
    {
      key: "isEnabled" as keyof ProductSku,
      header: "状态",
      cell: (row) => (
        <span className={row.isEnabled ? "text-[#3D8A5A]" : "text-[#888888]"}>
          {row.isEnabled ? "启用" : "停用"}
        </span>
      ),
    },
    {
      key: "actions" as keyof ProductSku,
      header: "操作",
      cell: (row) => (
        <div className="flex gap-2">
          {canUpdate && (
            <PreserveListContextLink href={`/products/${row.skuId}`}>
              <Button variant="link" size="sm" className="h-auto p-0">
                编辑
              </Button>
            </PreserveListContextLink>
          )}
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">商品管理</h1>
        <div className="flex gap-2">
          {(canCreate || canUpdate) && (
            <Link href="/products/categories">
              <Button variant="outline">品项分类</Button>
            </Link>
          )}
          {canCreate && (
            <Link href="/products/create">
              <Button>新增商品</Button>
            </Link>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <CategoryCascader
          categories={categories}
          productKinds={productKinds}
          value={categoryFilter}
          kindValue={kindFilter}
          allowEmpty
          placeholder="品项筛选"
          className="w-56"
          onChange={(catId, kind) => {
            setMany({ category: catId, kind, page: '' })
          }}
        />
        <Input
          placeholder="搜索商品名称"
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="max-w-xs"
        />
        <Select
          value={statusFilter}
          onChange={(e) => setFilter("status", e.target.value)}
          className="w-32"
        >
          <option value="enabled">启用</option>
          <option value="disabled">停用</option>
          <option value="all">全部</option>
        </Select>
        <ExportButton
          exportRequest={{
            exportType: "products",
            payload: {
              q: search,
              category: categoryFilter,
              kind: kindFilter,
              status: statusFilter,
            },
          }}
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
