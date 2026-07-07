"use client"

import { useState, useMemo, useCallback } from "react"
import Link from "next/link"
import type { ProductSku, ProductCategory } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { DataTable, type Column } from "@/components/ui/data-table"
import { Pagination } from "@/components/ui/pagination"
import { CategoryCascader } from "@/components/ui/category-cascader"
import { ExportButton } from "@/components/ui/export-button"
import { exportToXlsx } from "@/lib/export-xlsx"
import { formatCurrency, formatDate } from "@/lib/utils"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import { toast } from "sonner"

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
}: {
  skus: ProductSku[]
  categories: ProductCategory[]
  productKinds?: ProductCategory[]
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
  const categoryFilter = get("category")
  const kindFilter = get("kind")

  const page = Number(get("page", "1"))
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(get("size"))) ? Number(get("size")) : 20

  
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
    return result
  }, [skus, search, categoryFilter, kindFilter])

  const paged = useMemo(
    () => filtered.slice((page - 1) * pageSize, page * pageSize),
    [filtered, page, pageSize]
  )

  
  const handleExport = useCallback(async () => {
    if (filtered.length === 0) {
      toast.info("当前筛选无数据可导出")
      return
    }
    await exportToXlsx({
      filename: "商品",
      sheetName: "商品",
      columns: [
        { header: "商品名称", width: 28, accessor: (r) => r.specName },
        { header: "品项分类", width: 20, accessor: (r) => [r.productKind, r.categoryName].filter(Boolean).join(" / ") },
        { header: "产品类型", accessor: (r) => r.productType },
        { header: "是否生美", accessor: (r) => (r.isShengmei == null ? "" : r.isShengmei ? "是" : "否") },
        { header: "经营类型", accessor: (r) => r.salesCategory ?? "" },
        { header: "项目系列", accessor: (r) => r.projectSeriesName ?? "" },
        { header: "标价", accessor: (r) => (r.price != null ? Number(r.price) : "") },
        { header: "会员价", accessor: (r) => (r.specialPrice != null ? Number(r.specialPrice) : "") },
        { header: "次数", accessor: (r) => r.sessionCount ?? "" },
        { header: "手工费", accessor: (r) => (r.serviceFee != null ? Number(r.serviceFee) : "") },
        { header: "状态", width: 10, accessor: (r) => (r.isEnabled ? "启用" : "停用") },
      ],
      rows: filtered,
    })
  }, [filtered])

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
      header: "次数",
      cell: (row) => <span>{row.sessionCount ?? "—"}</span>,
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
          <Link href={`/products/${row.skuId}`}>
            <Button variant="link" size="sm" className="h-auto p-0">
              详情
            </Button>
          </Link>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">商品管理</h1>
        <div className="flex gap-2">
          <Link href="/products/categories">
            <Button variant="outline">品项分类</Button>
          </Link>
          <Link href="/products/create">
            <Button>新增商品</Button>
          </Link>
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
        <ExportButton onExport={handleExport} />
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
