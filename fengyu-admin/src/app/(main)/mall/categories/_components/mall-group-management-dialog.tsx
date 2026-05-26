"use client"

import { useState, useMemo } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import type { MallCategory } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
import { createMallCategoryGroup, updateMallCategoryGroup, deleteMallCategoryGroup } from "@/actions/products"

interface FormData {
  categoryName: string
  sortOrder: number
}

const emptyForm: FormData = {
  categoryName: "",
  sortOrder: 0,
}

export default function MallGroupManagementDialog({
  open,
  onOpenChange,
  groups,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  groups: MallCategory[]
}) {
  const router = useRouter()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<MallCategory | null>(null)
  const [form, setForm] = useState<FormData>(emptyForm)
  const [saving, setSaving] = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<MallCategory | null>(null)
  const [deleting, setDeleting] = useState(false)

  const sorted = useMemo(
    () => [...groups].sort((a, b) => a.sortOrder - b.sortOrder),
    [groups],
  )

  function openAdd() {
    setEditing(null)
    setForm({ ...emptyForm, sortOrder: sorted.length + 1 })
    setFormOpen(true)
  }

  function openEdit(row: MallCategory) {
    setEditing(row)
    setForm({
      categoryName: row.categoryName,
      sortOrder: row.sortOrder,
    })
    setFormOpen(true)
  }

  async function handleSubmit() {
    if (!form.categoryName.trim()) {
      toast.error("请输入分组名称")
      return
    }
    setSaving(true)
    try {
      if (editing) {
        const res = await updateMallCategoryGroup(
          editing.categoryId,
          {
            categoryName: form.categoryName.trim(),
            sortOrder: form.sortOrder,
          },
          editing.updatedAt,
        )
        if (!res.success) {
          toast.error(res.message)
          if (res.message.includes("已被其他人修改")) router.refresh()
          return
        }
        toast.success("分组已更新")
      } else {
        const res = await createMallCategoryGroup({
          categoryName: form.categoryName.trim(),
          sortOrder: form.sortOrder,
        })
        if (!res.success) {
          toast.error(res.message)
          return
        }
        toast.success("分组已创建")
      }
      setFormOpen(false)
      router.refresh()
    } catch {
      toast.error(editing ? "更新失败" : "创建失败")
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const res = await deleteMallCategoryGroup(deleteTarget.categoryId)
      if (!res.success) {
        toast.error(res.message)
        return
      }
      toast.success("分组已删除")
      setDeleteTarget(null)
      router.refresh()
    } catch {
      toast.error("删除失败")
    } finally {
      setDeleting(false)
    }
  }

  const columns: Column<MallCategory>[] = [
    {
      key: "categoryName",
      header: "分组名称",
      cell: (row) => <span className="font-medium">{row.categoryName}</span>,
    },
    { key: "sortOrder", header: "排序" },
    {
      key: "actions",
      header: "操作",
      cell: (row) => (
        <div className="flex gap-2">
          <Button variant="link" size="sm" className="h-auto p-0" onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-[var(--destructive)]"
            onClick={() => setDeleteTarget(row)}
          >
            删除
          </Button>
        </div>
      ),
    },
  ]

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>分组管理</DialogTitle>
        </DialogHeader>
        <div className="mt-4">
          <div className="flex items-center justify-end mb-3">
            <Button size="sm" onClick={openAdd}>
              新增分组
            </Button>
          </div>
          <DataTable columns={columns} data={sorted} emptyText="暂无分组" />
        </div>
      </Dialog>

      {/* Add/Edit form dialog */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogHeader>
          <DialogTitle>{editing ? "编辑分组" : "新增分组"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">分组名称 *</label>
            <Input
              value={form.categoryName}
              onChange={(e) => setForm({ ...form, categoryName: e.target.value })}
              placeholder="请输入分组名称"
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
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setFormOpen(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving ? "保存中..." : "保存"}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogTitle>确认删除</AlertDialogTitle>
        <AlertDialogDescription>
          确定要删除分组「{deleteTarget?.categoryName}」吗？该分组下的所有分类将一并删除，此操作不可撤销。
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
    </>
  )
}
