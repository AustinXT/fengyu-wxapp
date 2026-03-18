"use client"

import { useState, useMemo, useCallback } from "react"
import Link from "next/link"
import type { Product, ProductKind, ProductCategory } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { DataTable, type Column } from "@/components/ui/data-table"
import { Pagination } from "@/components/ui/pagination"
import { formatCurrency, formatDate } from "@/lib/utils"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"

const PAGE_SIZE_OPTIONS = [10, 20, 50]

const KIND_COLORS: Record<ProductKind, string> = {
  "福利活动": "border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]",
  "护理项目": "border-[#5E8BB3] text-[#5E8BB3] bg-[#F0F5FA]",
  "家居产品": "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]",
  "充值卡": "border-[#888888] text-[#888888] bg-[#F5F5F5]",
}

const PRODUCT_KINDS: ProductKind[] = ["福利活动", "护理项目", "家居产品", "充值卡"]

export default function ProductsPageClient({
  products,
  categories,
}: {
  products: Product[]
  categories: ProductCategory[]
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
  const filteredCategories = useMemo(() => {
    if (!kindFilter) return categories
    return categories.filter((c) => c.productKind === kindFilter)
  }, [categories, kindFilter])

  const page = Number(get("page", "1"))
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(get("size"))) ? Number(get("size")) : 20

  const filtered = useMemo(() => {
    let result = products
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      result = result.filter((p) => p.name.toLowerCase().includes(q))
    }
    if (categoryFilter) {
      result = result.filter((p) => p.categoryId === categoryFilter)
    }
    if (kindFilter) {
      result = result.filter((p) => p.productKind === kindFilter)
    }
    return result
  }, [products, search, categoryFilter, kindFilter])

  const paged = useMemo(
    () => filtered.slice((page - 1) * pageSize, page * pageSize),
    [filtered, page, pageSize]
  )

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
      header: "品项分类",
      cell: (row) => <span>{row.categoryName ?? "—"}</span>,
    },
    {
      key: "productKind",
      header: "商品类型",
      cell: (row) =>
        row.productKind ? (
          <Badge variant="outline" className={KIND_COLORS[row.productKind]}>
            {row.productKind}
          </Badge>
        ) : (
          "—"
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
        <div className="flex gap-2">
          <Link href={`/products/${row.productId}`}>
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
        <Select
          value={kindFilter}
          onChange={(e) => {
            const newKind = e.target.value
            if (categoryFilter) {
              const cat = categories.find((c) => c.categoryId === categoryFilter)
              if (cat && newKind && cat.productKind !== newKind) {
                setMany({ kind: newKind, category: '', page: '' })
                return
              }
            }
            setFilter("kind", newKind)
          }}
          className="w-32"
        >
          <option value="">全部类型</option>
          {PRODUCT_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </Select>
        <Select
          value={categoryFilter}
          onChange={(e) => {
            const catId = e.target.value
            if (catId) {
              const cat = categories.find((c) => c.categoryId === catId)
              if (cat) {
                setMany({ category: catId, kind: cat.productKind, page: '' })
                return
              }
            }
            setFilter("category", catId)
          }}
          className="w-40"
        >
          <option value="">全部品项</option>
          {filteredCategories.map((c) => (
            <option key={c.categoryId} value={c.categoryId}>
              {c.categoryName}
            </option>
          ))}
        </Select>
        <Input
          placeholder="搜索商品名称"
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
