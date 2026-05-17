"use client"

import { useState, useMemo } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import type { ProductCategory } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { DataTable, type Column } from "@/components/ui/data-table"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog"
import { createCategory, updateCategory } from "@/actions/products"
import ProductKindManagementDialog from "./product-kind-management-dialog"

type SalesCategory = '自销自耗' | '他销自耗' | '他销他耗' | '生态合作'

const SALES_CATEGORY_OPTIONS: SalesCategory[] = ['自销自耗', '他销自耗', '他销他耗', '生态合作']

interface CategoryFormData {
  categoryName: string
  productKind: string
  salesCategory: SalesCategory | ''
  sortOrder: number
  isValid: boolean
}

export default function CategoriesPageClient({
  categories,
  productKinds,
}: {
  categories: ProductCategory[]
  productKinds: ProductCategory[]
}) {
  const router = useRouter()

  // 动态一级分类列表（启用 + 按排序）
  const activeKinds = useMemo(
    () => [...productKinds].filter(k => k.isValid).sort((a, b) => a.sortOrder - b.sortOrder),
    [productKinds],
  )

  const defaultKind = activeKinds[0]?.categoryName ?? ""
  const [activeTab, setActiveTab] = useState(defaultKind)

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingCategory, setEditingCategory] = useState<ProductCategory | null>(null)
  const [form, setForm] = useState<CategoryFormData>({
    categoryName: "",
    productKind: defaultKind,
    salesCategory: "",
    sortOrder: 0,
    isValid: true,
  })
  const [saving, setSaving] = useState(false)

  // AlertDialog state for disable confirmation
  const [disableTarget, setDisableTarget] = useState<ProductCategory | null>(null)
  const [disabling, setDisabling] = useState(false)

  // 品项一级分类管理 dialog
  const [kindDialogOpen, setKindDialogOpen] = useState(false)

  const categoriesByKind = useMemo(() => {
    const map: Record<string, ProductCategory[]> = {}
    for (const kind of activeKinds) {
      map[kind.categoryName] = categories
        .filter((c) => c.productKind === kind.categoryName)
        .sort((a, b) => a.sortOrder - b.sortOrder)
    }
    return map
  }, [categories, activeKinds])

  const openAddDialog = () => {
    setEditingCategory(null)
    setForm({
      categoryName: "",
      productKind: activeTab,
      salesCategory: "",
      sortOrder: 0,
      isValid: true,
    })
    setDialogOpen(true)
  }

  const openEditDialog = (row: ProductCategory) => {
    setEditingCategory(row)
    setForm({
      categoryName: row.categoryName,
      productKind: row.productKind ?? activeTab,
      salesCategory: (row.salesCategory as SalesCategory | null) ?? "",
      sortOrder: row.sortOrder,
      isValid: row.isValid,
    })
    setDialogOpen(true)
  }

  const handleSubmit = async () => {
    if (!form.categoryName.trim()) {
      toast.error("请输入二级分类名称")
      return
    }
    setSaving(true)
    try {
      if (editingCategory) {
        const catResult = await updateCategory(editingCategory.categoryId, {
          categoryName: form.categoryName.trim(),
          productKind: form.productKind,
          salesCategory: form.salesCategory || null,
          sortOrder: form.sortOrder,
          isValid: form.isValid,
        }, editingCategory.updatedAt)
        if (!catResult.success) {
          toast.error(catResult.message)
          if (catResult.message.includes("已被其他人修改")) router.refresh()
          return
        }
        toast.success("二级分类已更新")
      } else {
        const createResult = await createCategory({
          categoryName: form.categoryName.trim(),
          productKind: form.productKind,
          salesCategory: form.salesCategory || null,
          sortOrder: form.sortOrder,
          isValid: form.isValid,
        })
        if (!createResult.success) {
          toast.error(createResult.message)
          return
        }
        toast.success("二级分类已创建")
      }
      setDialogOpen(false)
      router.refresh()
    } catch (err) {
      toast.error(editingCategory ? "更新失败" : "创建失败")
      console.error(err)
    } finally {
      setSaving(false)
    }
  }

  const handleDisable = async () => {
    if (!disableTarget) return
    setDisabling(true)
    try {
      const disableResult = await updateCategory(disableTarget.categoryId, { isValid: false }, disableTarget.updatedAt)
      if (!disableResult.success) {
        toast.error(disableResult.message)
        if (disableResult.message.includes("已被其他人修改")) router.refresh()
        return
      }
      toast.success("二级分类已停用")
      setDisableTarget(null)
      router.refresh()
    } catch (err) {
      toast.error("停用失败")
      console.error(err)
    } finally {
      setDisabling(false)
    }
  }

  const columns: Column<ProductCategory>[] = [
    {
      key: "categoryName",
      header: "二级分类名称",
      cell: (row) => <span className="font-medium">{row.categoryName}</span>,
    },
    {
      key: "salesCategory",
      header: "经营类型",
      cell: (row) => row.salesCategory ?? <span className="text-[var(--muted-foreground)]">—</span>,
    },
    {
      key: "sortOrder",
      header: "排序",
    },
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
        <div className="flex gap-2">
          <Button variant="link" size="sm" className="h-auto p-0" onClick={() => openEditDialog(row)}>
            编辑
          </Button>
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-[var(--destructive)]"
            onClick={() => setDisableTarget(row)}
          >
            停用
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button type="button" variant="outline" size="sm" onClick={() => router.back()}>
            &larr; 返回
          </Button>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">品项分类</h1>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setKindDialogOpen(true)}>品项一级分类管理</Button>
          <Button onClick={openAddDialog}>新增二级分类</Button>
        </div>
      </div>

      {activeKinds.length > 0 ? (
        <Tabs defaultValue={defaultKind} onValueChange={setActiveTab}>
          <TabsList>
            {activeKinds.map((kind) => (
              <TabsTrigger key={kind.categoryId} value={kind.categoryName}>
                {kind.categoryName}（{categoriesByKind[kind.categoryName]?.length ?? 0}）
              </TabsTrigger>
            ))}
          </TabsList>

          {activeKinds.map((kind) => (
            <TabsContent key={kind.categoryId} value={kind.categoryName}>
              <DataTable
                columns={columns}
                data={(categoriesByKind[kind.categoryName] ?? [])}
                emptyText="暂无二级分类"
              />
            </TabsContent>
          ))}
        </Tabs>
      ) : (
        <div className="text-center py-8 text-[var(--muted-foreground)]">
          暂无品项一级分类，请先通过「品项一级分类管理」添加
        </div>
      )}

      {/* Add/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogHeader>
          <DialogTitle>{editingCategory ? "编辑分类" : "新增分类"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">分类名称 *</label>
            <Input
              value={form.categoryName}
              onChange={(e) => setForm({ ...form, categoryName: e.target.value })}
              placeholder="请输入分类名称"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">品项一级分类 *</label>
            <Select
              value={form.productKind}
              onChange={(e) => setForm({ ...form, productKind: e.target.value })}
            >
              {activeKinds.map((kind) => (
                <option key={kind.categoryId} value={kind.categoryName}>
                  {kind.categoryName}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">经营类型</label>
            <Select
              value={form.salesCategory}
              onChange={(e) =>
                setForm({ ...form, salesCategory: e.target.value as SalesCategory | "" })
              }
            >
              <option value="">未设置</option>
              {SALES_CATEGORY_OPTIONS.map((sc) => (
                <option key={sc} value={sc}>{sc}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">排序</label>
            <Input
              type="number"
              value={form.sortOrder}
              onChange={(e) => setForm({ ...form, sortOrder: parseInt(e.target.value) || 0 })}
            />
          </div>
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">启用状态</label>
            <Switch
              checked={form.isValid}
              onCheckedChange={(checked) => setForm({ ...form, isValid: checked })}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving ? "保存中..." : "保存"}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Disable Confirmation */}
      <AlertDialog open={!!disableTarget} onOpenChange={(open) => !open && setDisableTarget(null)}>
        <AlertDialogTitle>确认停用</AlertDialogTitle>
        <AlertDialogDescription>
          确定要停用分类「{disableTarget?.categoryName}」吗？停用后该分类下的商品将不再展示。
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setDisableTarget(null)} disabled={disabling}>
            取消
          </AlertDialogCancel>
          <AlertDialogAction onClick={handleDisable} disabled={disabling}>
            {disabling ? "停用中..." : "确认停用"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>

      {/* 品项一级分类管理 Dialog */}
      <ProductKindManagementDialog
        open={kindDialogOpen}
        onOpenChange={setKindDialogOpen}
        productKinds={productKinds}
      />
    </div>
  )
}
