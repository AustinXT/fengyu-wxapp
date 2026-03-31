"use client"

import { useState, useMemo, useCallback } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import type { MallCategory, Product } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { DataTable, type Column } from "@/components/ui/data-table"
import { Pagination } from "@/components/ui/pagination"
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { createMallCategory, updateMallCategory } from "@/actions/products"
import { formatCurrency, formatDate } from "@/lib/utils"

const PAGE_SIZE_OPTIONS = [10, 20, 50]

interface CategoryFormData {
  categoryName: string
  sortOrder: number
  isValid: boolean
}

const emptyForm: CategoryFormData = {
  categoryName: "",
  sortOrder: 0,
  isValid: true,
}

export default function MallPageClient({
  categories,
  products,
}: {
  categories: MallCategory[]
  products: Product[]
}) {
  const router = useRouter()

  // ── 分类 Dialog ──
  const [catDialogOpen, setCatDialogOpen] = useState(false)
  const [editingCat, setEditingCat] = useState<MallCategory | null>(null)
  const [catForm, setCatForm] = useState<CategoryFormData>(emptyForm)
  const [catSaving, setCatSaving] = useState(false)

  // ── 商品筛选 ──
  const [searchInput, setSearchInput] = useState("")
  const [catFilter, setCatFilter] = useState("")
  const [prodPage, setProdPage] = useState(1)
  const [prodPageSize, setProdPageSize] = useState(20)

  const openAddCat = () => {
    setEditingCat(null)
    setCatForm(emptyForm)
    setCatDialogOpen(true)
  }

  const openEditCat = (cat: MallCategory) => {
    setEditingCat(cat)
    setCatForm({
      categoryName: cat.categoryName,
      sortOrder: cat.sortOrder,
      isValid: cat.isValid,
    })
    setCatDialogOpen(true)
  }

  const handleCatSubmit = async () => {
    if (!catForm.categoryName.trim()) {
      toast.error("请输入分类名称")
      return
    }
    setCatSaving(true)
    try {
      if (editingCat) {
        const res = await updateMallCategory(editingCat.categoryId, {
          categoryName: catForm.categoryName.trim(),
          sortOrder: catForm.sortOrder,
          isValid: catForm.isValid,
        }, editingCat.updatedAt)
        if (!res.success) {
          toast.error(res.message)
          if (res.message.includes("已被其他人修改")) router.refresh()
          return
        }
        toast.success("分类已更新")
      } else {
        const categoryId = `mcat-${Date.now()}`
        const res = await createMallCategory({
          categoryId,
          categoryName: catForm.categoryName.trim(),
          sortOrder: catForm.sortOrder,
          isValid: catForm.isValid,
        })
        if (!res.success) {
          toast.error(res.message)
          return
        }
        toast.success("分类已创建")
      }
      setCatDialogOpen(false)
      router.refresh()
    } catch {
      toast.error(editingCat ? "更新失败" : "创建失败")
    } finally {
      setCatSaving(false)
    }
  }

  // ── 分类列 ──
  const catColumns: Column<MallCategory>[] = [
    {
      key: "categoryName",
      header: "分类名称",
      cell: (row) => <span className="font-medium">{row.categoryName}</span>,
    },
    { key: "sortOrder", header: "排序" },
    {
      key: "isValid",
      header: "状态",
      cell: (row) => (
        <Badge
          variant="outline"
          className={
            row.isValid
              ? "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]"
              : "border-[#888888] text-[#888888] bg-[#F5F5F5]"
          }
        >
          {row.isValid ? "启用" : "停用"}
        </Badge>
      ),
    },
    {
      key: "actions",
      header: "操作",
      cell: (row) => (
        <Button variant="link" size="sm" className="h-auto p-0" onClick={() => openEditCat(row)}>
          编辑
        </Button>
      ),
    },
  ]

  // ── 商品筛选 ──
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
    () => filteredProducts.slice((prodPage - 1) * prodPageSize, prodPage * prodPageSize),
    [filteredProducts, prodPage, prodPageSize],
  )

  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value)
    setProdPage(1)
  }, [])

  // ── 商品列 ──
  const prodColumns: Column<Product>[] = [
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
      </div>

      <Tabs defaultValue="categories">
        <TabsList>
          <TabsTrigger value="categories">商城分类</TabsTrigger>
          <TabsTrigger value="products">商城商品</TabsTrigger>
        </TabsList>

        {/* ── 商城分类 ── */}
        <TabsContent value="categories">
          <div className="flex justify-end mb-3">
            <Button onClick={openAddCat}>新增分类</Button>
          </div>
          <DataTable columns={catColumns} data={categories} emptyText="暂无分类" />
        </TabsContent>

        {/* ── 商城商品 ── */}
        <TabsContent value="products">
          <div className="flex items-center gap-3 mb-3">
            <select
              className="h-9 rounded-[var(--radius)] border border-[var(--input)] bg-transparent px-3 text-sm"
              value={catFilter}
              onChange={(e) => { setCatFilter(e.target.value); setProdPage(1) }}
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
            <div className="flex-1" />
            <Link href="/products/create">
              <Button>新增商品</Button>
            </Link>
          </div>

          <DataTable columns={prodColumns} data={pagedProducts} />

          <Pagination
            total={filteredProducts.length}
            pageSize={prodPageSize}
            page={prodPage}
            onPageChange={setProdPage}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            onPageSizeChange={(size) => { setProdPageSize(size); setProdPage(1) }}
          />
        </TabsContent>
      </Tabs>

      {/* ── 分类 Dialog ── */}
      <Dialog open={catDialogOpen} onOpenChange={setCatDialogOpen}>
        <DialogHeader>
          <DialogTitle>{editingCat ? "编辑分类" : "新增分类"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">分类名称 *</label>
            <Input
              value={catForm.categoryName}
              onChange={(e) => setCatForm({ ...catForm, categoryName: e.target.value })}
              placeholder="请输入分类名称"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">排序</label>
            <Input
              type="number"
              value={catForm.sortOrder}
              onChange={(e) => setCatForm({ ...catForm, sortOrder: parseInt(e.target.value) || 0 })}
            />
          </div>
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">启用状态</label>
            <Switch
              checked={catForm.isValid}
              onCheckedChange={(checked) => setCatForm({ ...catForm, isValid: checked })}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setCatDialogOpen(false)} disabled={catSaving}>
            取消
          </Button>
          <Button onClick={handleCatSubmit} disabled={catSaving}>
            {catSaving ? "保存中..." : "保存"}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  )
}
