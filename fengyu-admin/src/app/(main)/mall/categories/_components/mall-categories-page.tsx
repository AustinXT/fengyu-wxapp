"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import type { MallCategory } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { DataTable, type Column } from "@/components/ui/data-table"
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog"
import { createMallCategory, updateMallCategory } from "@/actions/products"

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

export default function MallCategoriesPageClient({
  categories,
}: {
  categories: MallCategory[]
}) {
  const router = useRouter()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingCat, setEditingCat] = useState<MallCategory | null>(null)
  const [form, setForm] = useState<CategoryFormData>(emptyForm)
  const [saving, setSaving] = useState(false)

  // AlertDialog state for disable confirmation
  const [disableTarget, setDisableTarget] = useState<MallCategory | null>(null)
  const [disabling, setDisabling] = useState(false)

  const openAdd = () => {
    setEditingCat(null)
    setForm(emptyForm)
    setDialogOpen(true)
  }

  const openEdit = (cat: MallCategory) => {
    setEditingCat(cat)
    setForm({
      categoryName: cat.categoryName,
      sortOrder: cat.sortOrder,
      isValid: cat.isValid,
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
      if (editingCat) {
        const res = await updateMallCategory(editingCat.categoryId, {
          categoryName: form.categoryName.trim(),
          sortOrder: form.sortOrder,
          isValid: form.isValid,
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
          categoryName: form.categoryName.trim(),
          sortOrder: form.sortOrder,
          isValid: form.isValid,
        })
        if (!res.success) {
          toast.error(res.message)
          return
        }
        toast.success("分类已创建")
      }
      setDialogOpen(false)
      router.refresh()
    } catch {
      toast.error(editingCat ? "更新失败" : "创建失败")
    } finally {
      setSaving(false)
    }
  }

  const handleDisable = async () => {
    if (!disableTarget) return
    setDisabling(true)
    try {
      const res = await updateMallCategory(disableTarget.categoryId, { isValid: false }, disableTarget.updatedAt)
      if (!res.success) {
        toast.error(res.message)
        if (res.message.includes("已被其他人修改")) router.refresh()
        return
      }
      toast.success("分类已停用")
      setDisableTarget(null)
      router.refresh()
    } catch {
      toast.error("停用失败")
    } finally {
      setDisabling(false)
    }
  }

  const columns: Column<MallCategory>[] = [
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
        <div className="flex gap-2">
          <Button variant="link" size="sm" className="h-auto p-0" onClick={() => openEdit(row)}>
            编辑
          </Button>
          {row.isValid && (
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-[var(--destructive)]"
              onClick={() => setDisableTarget(row)}
            >
              停用
            </Button>
          )}
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
          <h1 className="text-2xl font-bold text-[var(--foreground)]">商城分类</h1>
        </div>
        <Button onClick={openAdd}>新增分类</Button>
      </div>

      <DataTable columns={columns} data={categories} emptyText="暂无分类" />

      {/* Add/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogHeader>
          <DialogTitle>{editingCat ? "编辑分类" : "新增分类"}</DialogTitle>
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
          确定要停用分类「{disableTarget?.categoryName}」吗？停用后该分类下的商城商品将不再展示。
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
