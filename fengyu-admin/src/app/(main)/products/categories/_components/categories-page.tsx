"use client"

import { useState, useMemo } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import type { ProductKind, ProductCategory } from "@/lib/types"
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

const PRODUCT_KINDS: ProductKind[] = ["福利活动", "护理项目", "家居产品", "充值卡"]

interface CategoryFormData {
  categoryName: string
  productKind: ProductKind
  sortOrder: number
  isValid: boolean
}

const emptyForm = (defaultKind: ProductKind): CategoryFormData => ({
  categoryName: "",
  productKind: defaultKind,
  sortOrder: 0,
  isValid: true,
})

export default function CategoriesPageClient({
  categories,
}: {
  categories: ProductCategory[]
}) {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<ProductKind>("福利活动")

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingCategory, setEditingCategory] = useState<ProductCategory | null>(null)
  const [form, setForm] = useState<CategoryFormData>(emptyForm("福利活动"))
  const [saving, setSaving] = useState(false)

  // AlertDialog state for disable confirmation
  const [disableTarget, setDisableTarget] = useState<ProductCategory | null>(null)
  const [disabling, setDisabling] = useState(false)

  const categoriesByKind = useMemo(() => {
    const map: Record<string, ProductCategory[]> = {}
    for (const kind of PRODUCT_KINDS) {
      map[kind] = categories
        .filter((c) => c.productKind === kind)
        .sort((a, b) => a.sortOrder - b.sortOrder)
    }
    return map
  }, [categories])

  const openAddDialog = () => {
    setEditingCategory(null)
    setForm(emptyForm(activeTab))
    setDialogOpen(true)
  }

  const openEditDialog = (row: ProductCategory) => {
    setEditingCategory(row)
    setForm({
      categoryName: row.categoryName,
      productKind: row.productKind,
      sortOrder: row.sortOrder,
      isValid: row.isValid,
    })
    setDialogOpen(true)
  }

  const handleSubmit = async () => {
    if (!form.categoryName.trim()) {
      toast.error("请输入分类名称")
      return
    }
    setSaving(true)
    try {
      if (editingCategory) {
        const catResult = await updateCategory(editingCategory.categoryId, {
          categoryName: form.categoryName.trim(),
          productKind: form.productKind,
          sortOrder: form.sortOrder,
          isValid: form.isValid,
        }, editingCategory.updatedAt)
        if (!catResult.success) {
          toast.error(catResult.message)
          if (catResult.message.includes("已被其他人修改")) router.refresh()
          return
        }
        toast.success("分类已更新")
      } else {
        const categoryId = `cat-${Date.now()}`
        const createResult = await createCategory({
          categoryId,
          categoryName: form.categoryName.trim(),
          productKind: form.productKind,
          sortOrder: form.sortOrder,
          isValid: form.isValid,
        })
        if (!createResult.success) {
          toast.error(createResult.message)
          return
        }
        toast.success("分类已创建")
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
      toast.success("分类已停用")
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
      header: "分类名称",
      cell: (row) => <span className="font-medium">{row.categoryName}</span>,
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
        <h1 className="text-2xl font-bold text-[var(--foreground)]">品项分类</h1>
        <Button onClick={openAddDialog}>新增分类</Button>
      </div>

      <Tabs defaultValue="福利活动" onValueChange={(v) => setActiveTab(v as ProductKind)}>
        <TabsList>
          {PRODUCT_KINDS.map((kind) => (
            <TabsTrigger key={kind} value={kind}>
              {kind}（{categoriesByKind[kind]?.length ?? 0}）
            </TabsTrigger>
          ))}
        </TabsList>

        {PRODUCT_KINDS.map((kind) => (
          <TabsContent key={kind} value={kind}>
            <DataTable
              columns={columns}
              data={(categoriesByKind[kind] ?? [])}
              emptyText="暂无分类"
            />
          </TabsContent>
        ))}
      </Tabs>

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
            <label className="text-sm font-medium">品项类型 *</label>
            <Select
              value={form.productKind}
              onChange={(e) => setForm({ ...form, productKind: e.target.value as ProductKind })}
            >
              {PRODUCT_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
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
    </div>
  )
}
