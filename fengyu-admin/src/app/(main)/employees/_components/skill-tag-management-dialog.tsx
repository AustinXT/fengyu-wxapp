"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import type { SkillTag } from "@/lib/types"
import { actionErrorMessage } from "@/lib/action-error"
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
import { createSkillTag, updateSkillTag, deleteSkillTag } from "@/actions/skill-tags"

interface FormData {
  name: string
  sortOrder: number
}

const emptyForm: FormData = { name: "", sortOrder: 0 }

export default function SkillTagManagementDialog({
  open,
  onOpenChange,
  skillTags: allTags,
  canManage = false,
  canDelete,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  skillTags: SkillTag[]
  canManage?: boolean
  canDelete: boolean
}) {
  const router = useRouter()

  // Inner dialog state for add/edit
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<SkillTag | null>(null)
  const [form, setForm] = useState<FormData>(emptyForm)
  const [saving, setSaving] = useState(false)

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<SkillTag | null>(null)
  const [deleting, setDeleting] = useState(false)

  const sorted = [...allTags].sort((a, b) => a.sortOrder - b.sortOrder)

  function openAdd() {
    setEditing(null)
    setForm(emptyForm)
    setFormOpen(true)
  }

  function openEdit(row: SkillTag) {
    setEditing(row)
    setForm({ name: row.name, sortOrder: row.sortOrder })
    setFormOpen(true)
  }

  async function handleSubmit() {
    if (!canManage) return
    if (!form.name.trim()) {
      toast.error("请输入标签名称")
      return
    }
    setSaving(true)
    try {
      if (editing) {
        const res = await updateSkillTag(
          editing.id,
          { name: form.name.trim(), sortOrder: form.sortOrder },
          editing.updatedAt,
        )
        if (!res.success) {
          toast.error(res.message)
          if (res.message.includes("已被其他人修改")) router.refresh()
          return
        }
        toast.success("标签已更新")
      } else {
        const id = `stag-${Date.now()}`
        const res = await createSkillTag({
          id,
          name: form.name.trim(),
          sortOrder: form.sortOrder,
        })
        if (!res.success) {
          toast.error(res.message)
          return
        }
        toast.success("标签已创建")
      }
      setFormOpen(false)
      router.refresh()
    } catch (err) {
      toast.error(actionErrorMessage(err, editing ? "更新失败" : "创建失败"))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!canDelete || !deleteTarget) return
    setDeleting(true)
    try {
      const res = await deleteSkillTag(deleteTarget.id)
      if (!res.success) {
        toast.error(res.message)
        return
      }
      toast.success("标签已删除")
      setDeleteTarget(null)
      router.refresh()
    } catch (err) {
      toast.error(actionErrorMessage(err, "删除失败"))
    } finally {
      setDeleting(false)
    }
  }

  const columns: Column<SkillTag>[] = [
    {
      key: "name",
      header: "标签名称",
      cell: (row) => <span className="font-medium">{row.name}</span>,
    },
    { key: "sortOrder", header: "排序" },
    {
      key: "actions",
      header: "操作",
      cell: (row) => (
        <div className="flex gap-2">
          {canManage && <Button variant="link" size="sm" className="h-auto p-0" onClick={() => openEdit(row)}>
            编辑
          </Button>}
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
    <>
      <Dialog open={open} onOpenChange={onOpenChange} className="max-w-xl">
        <DialogHeader>
          <DialogTitle>技能标签管理</DialogTitle>
        </DialogHeader>
        <div className="mt-4">
          <div className="flex items-center justify-end mb-3">
            {canManage && <Button size="sm" onClick={openAdd}>
              新增标签
            </Button>}
          </div>
          <DataTable columns={columns} data={sorted} emptyText="暂无标签" />
        </div>
      </Dialog>

      {/* Add/Edit form dialog */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogHeader>
          <DialogTitle>{editing ? "编辑标签" : "新增标签"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">标签名称 *</label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="请输入标签名称"
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
          确定要删除标签「{deleteTarget?.name}」吗？删除后不可恢复，且将同时从所有已关联的员工身上移除该标签。
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
