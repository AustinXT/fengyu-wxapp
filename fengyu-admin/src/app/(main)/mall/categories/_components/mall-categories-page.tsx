"use client"

import { useState, useMemo } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import type { MallCategory } from "@/lib/types"
import { actionErrorMessage } from "@/lib/action-error"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { DataTable, type Column } from "@/components/ui/data-table"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog"
import { createMallCategory, updateMallCategory, deleteMallCategory } from "@/actions/products"
import MallGroupManagementDialog from "./mall-group-management-dialog"

interface CategoryFormData {
  categoryName: string
  categoryGroup: string
  sortOrder: number
}

export default function MallCategoriesPageClient({
  categories,
  groups,
  canDelete,
}: {
  categories: MallCategory[]
  groups: MallCategory[]
  canDelete: boolean
}) {
  const router = useRouter()

  const activeGroups = useMemo(
    () => [...groups].sort((a, b) => a.sortOrder - b.sortOrder),
    [groups],
  )

  const defaultGroup = activeGroups[0]?.categoryName ?? ""
  const [activeTab, setActiveTab] = useState(defaultGroup)

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingCategory, setEditingCategory] = useState<MallCategory | null>(null)
  const [form, setForm] = useState<CategoryFormData>({
    categoryName: "",
    categoryGroup: defaultGroup,
    sortOrder: 0,
  })
  const [saving, setSaving] = useState(false)

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<MallCategory | null>(null)
  const [deleting, setDeleting] = useState(false)

  // 分组管理 dialog
  const [groupDialogOpen, setGroupDialogOpen] = useState(false)

  const categoriesByGroup = useMemo(() => {
    const map: Record<string, MallCategory[]> = {}
    for (const group of activeGroups) {
      map[group.categoryName] = categories
        .filter((c) => c.categoryGroup === group.categoryName)
        .sort((a, b) => a.sortOrder - b.sortOrder)
    }
    return map
  }, [categories, activeGroups])

  const openAddDialog = () => {
    setEditingCategory(null)
    setForm({
      categoryName: "",
      categoryGroup: activeTab,
      sortOrder: 0,
    })
    setDialogOpen(true)
  }

  const openEditDialog = (row: MallCategory) => {
    setEditingCategory(row)
    setForm({
      categoryName: row.categoryName,
      categoryGroup: row.categoryGroup ?? activeTab,
      sortOrder: row.sortOrder,
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
        const res = await updateMallCategory(editingCategory.categoryId, {
          categoryName: form.categoryName.trim(),
          sortOrder: form.sortOrder,
        }, editingCategory.updatedAt)
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
          categoryGroup: form.categoryGroup,
          sortOrder: form.sortOrder,
        })
        if (!res.success) {
          toast.error(res.message)
          return
        }
        toast.success("分类已创建")
      }
      setDialogOpen(false)
      router.refresh()
    } catch (err) {
      toast.error(actionErrorMessage(err, editingCategory ? "更新失败" : "创建失败"))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const res = await deleteMallCategory(deleteTarget.categoryId)
      if (!res.success) {
        toast.error(res.message)
        return
      }
      toast.success("分类已删除")
      setDeleteTarget(null)
      router.refresh()
    } catch (err) {
      toast.error(actionErrorMessage(err, "删除失败"))
    } finally {
      setDeleting(false)
    }
  }

  const columns: Column<MallCategory>[] = [
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
      key: "actions",
      header: "操作",
      cell: (row) => (
        <div className="flex gap-2">
          <Button variant="link" size="sm" className="h-auto p-0" onClick={() => openEditDialog(row)}>
            编辑
          </Button>
          {canDelete && (
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-[var(--destructive)]"
              onClick={() => setDeleteTarget(row)}
            >
              删除
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
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setGroupDialogOpen(true)}>分组管理</Button>
          <Button onClick={openAddDialog}>新增分类</Button>
        </div>
      </div>

      {activeGroups.length > 0 ? (
        <Tabs defaultValue={defaultGroup} onValueChange={setActiveTab}>
          <TabsList>
            {activeGroups.map((group) => (
              <TabsTrigger key={group.categoryId} value={group.categoryName}>
                {group.categoryName}（{categoriesByGroup[group.categoryName]?.length ?? 0}）
              </TabsTrigger>
            ))}
          </TabsList>

          {activeGroups.map((group) => (
            <TabsContent key={group.categoryId} value={group.categoryName}>
              <DataTable
                columns={columns}
                data={(categoriesByGroup[group.categoryName] ?? [])}
                emptyText="暂无分类"
              />
            </TabsContent>
          ))}
        </Tabs>
      ) : (
        <div className="text-center py-8 text-[var(--muted-foreground)]">
          暂无分组，请先通过「分组管理」添加
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
            <label className="text-sm font-medium">所属分组 *</label>
            <Select
              value={form.categoryGroup}
              onChange={(e) => setForm({ ...form, categoryGroup: e.target.value })}
            >
              {activeGroups.map((group) => (
                <option key={group.categoryId} value={group.categoryName}>
                  {group.categoryName}
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

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogTitle>确认删除</AlertDialogTitle>
        <AlertDialogDescription>
          确定要删除分类「{deleteTarget?.categoryName}」吗？此操作不可撤销。
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setDeleteTarget(null)} disabled={deleting}>
            取消
          </AlertDialogCancel>
          <AlertDialogAction onClick={handleDelete} disabled={deleting}>
            {deleting ? "删除中..." : "确认删除"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>

      {/* 分组管理 Dialog */}
      <MallGroupManagementDialog
        open={groupDialogOpen}
        onOpenChange={setGroupDialogOpen}
        groups={groups}
        canDelete={canDelete}
      />
    </div>
  )
}
