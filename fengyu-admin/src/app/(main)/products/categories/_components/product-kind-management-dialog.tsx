"use client"

import { useState, useMemo } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import type { ProductCategory } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
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
import { createProductKind, updateProductKind } from "@/actions/products"

interface FormData {
  categoryName: string
  sortOrder: number
  isValid: boolean
  isCardKind: boolean
  displayColor: string
  displayIcon: string
  requiresShengmeiFlag: boolean
}

const emptyForm: FormData = {
  categoryName: "",
  sortOrder: 0,
  isValid: true,
  isCardKind: false,
  displayColor: "",
  displayIcon: "",
  requiresShengmeiFlag: false,
}

export default function ProductKindManagementDialog({
  open,
  onOpenChange,
  productKinds,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  productKinds: ProductCategory[]
}) {
  const router = useRouter()

  // Inner dialog state for add/edit
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<ProductCategory | null>(null)
  const [form, setForm] = useState<FormData>(emptyForm)
  const [saving, setSaving] = useState(false)

  // Disable confirmation
  const [disableTarget, setDisableTarget] = useState<ProductCategory | null>(null)
  const [disabling, setDisabling] = useState(false)

  const sorted = useMemo(
    () => [...productKinds].sort((a, b) => a.sortOrder - b.sortOrder),
    [productKinds],
  )

  function openAdd() {
    setEditing(null)
    setForm({ ...emptyForm, sortOrder: sorted.length + 1 })
    setFormOpen(true)
  }

  function openEdit(row: ProductCategory) {
    setEditing(row)
    setForm({
      categoryName: row.categoryName,
      sortOrder: row.sortOrder,
      isValid: row.isValid,
      isCardKind: row.isCardKind,
      displayColor: row.displayColor ?? "",
      displayIcon: row.displayIcon ?? "",
      requiresShengmeiFlag: row.requiresShengmeiFlag,
    })
    setFormOpen(true)
  }

  async function handleSubmit() {
    if (!form.categoryName.trim()) {
      toast.error("请输入品项类型名称")
      return
    }
    setSaving(true)
    try {
      const capabilityFields = {
        isCardKind: form.isCardKind,
        displayColor: form.displayColor.trim() || null,
        displayIcon: form.displayIcon.trim() || null,
        requiresShengmeiFlag: form.requiresShengmeiFlag,
      }
      if (editing) {
        const res = await updateProductKind(
          editing.categoryId,
          {
            categoryName: form.categoryName.trim(),
            sortOrder: form.sortOrder,
            isValid: form.isValid,
            ...capabilityFields,
          },
          editing.updatedAt,
        )
        if (!res.success) {
          toast.error(res.message)
          if (res.message.includes("已被其他人修改")) router.refresh()
          return
        }
        toast.success("品项类型已更新")
      } else {
        const res = await createProductKind({
          categoryName: form.categoryName.trim(),
          sortOrder: form.sortOrder,
          isValid: form.isValid,
          ...capabilityFields,
        })
        if (!res.success) {
          toast.error(res.message)
          return
        }
        toast.success("品项类型已创建")
      }
      setFormOpen(false)
      router.refresh()
    } catch {
      toast.error(editing ? "更新失败" : "创建失败")
    } finally {
      setSaving(false)
    }
  }

  async function handleDisable() {
    if (!disableTarget) return
    setDisabling(true)
    try {
      const res = await updateProductKind(
        disableTarget.categoryId,
        { isValid: false },
        disableTarget.updatedAt,
      )
      if (!res.success) {
        toast.error(res.message)
        if (res.message.includes("已被其他人修改")) router.refresh()
        return
      }
      toast.success("品项类型已停用")
      setDisableTarget(null)
      router.refresh()
    } catch {
      toast.error("停用失败")
    } finally {
      setDisabling(false)
    }
  }

  const columns: Column<ProductCategory>[] = [
    {
      key: "categoryName",
      header: "类型名称",
      cell: (row) => <span className="font-medium">{row.categoryName}</span>,
    },
    { key: "sortOrder", header: "排序" },
    {
      key: "isCardKind",
      header: "卡类",
      cell: (row) => (row.isCardKind ? <Badge variant="outline">卡</Badge> : <span className="text-[var(--muted-foreground)]">—</span>),
    },
    {
      key: "displayColor",
      header: "颜色",
      cell: (row) => row.displayColor ? (
        <span className="inline-flex items-center gap-2">
          <span
            className="inline-block w-4 h-4 rounded border"
            style={{ backgroundColor: row.displayColor }}
          />
          <span className="font-mono text-xs">{row.displayColor}</span>
        </span>
      ) : (
        <span className="text-[var(--destructive)] text-xs">未配置</span>
      ),
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
    <>
      <Dialog open={open} onOpenChange={onOpenChange} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>品项类型管理</DialogTitle>
        </DialogHeader>
        <div className="mt-4">
          <div className="flex items-center justify-end mb-3">
            <Button size="sm" onClick={openAdd}>
              新增类型
            </Button>
          </div>
          <DataTable columns={columns} data={sorted} emptyText="暂无品项类型" />
        </div>
      </Dialog>

      {/* Add/Edit form dialog */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogHeader>
          <DialogTitle>{editing ? "编辑品项类型" : "新增品项类型"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">类型名称 *</label>
            <Input
              value={form.categoryName}
              onChange={(e) => setForm({ ...form, categoryName: e.target.value })}
              placeholder="请输入品项类型名称"
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
          <div className="space-y-2">
            <label className="text-sm font-medium">展示颜色（HEX，如 #C0322A）</label>
            <div className="flex items-center gap-2">
              <Input
                type="color"
                value={form.displayColor || "#1989FA"}
                onChange={(e) => setForm({ ...form, displayColor: e.target.value })}
                className="w-16 p-1 h-9"
              />
              <Input
                value={form.displayColor}
                onChange={(e) => setForm({ ...form, displayColor: e.target.value })}
                placeholder="#1989FA"
                className="flex-1 font-mono"
              />
            </div>
            <p className="text-xs text-[var(--muted-foreground)]">
              用于商品 tag、购物车标签的视觉色；为空将不渲染 tag 颜色。
            </p>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">展示图标（可选，emoji 或 icon name）</label>
            <Input
              value={form.displayIcon}
              onChange={(e) => setForm({ ...form, displayIcon: e.target.value })}
              placeholder="留空即不展示"
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium">是否为卡类</label>
              <p className="text-xs text-[var(--muted-foreground)]">勾选后此一级品项会从员工端 / 管理后台开单"普通商品"分支中排除</p>
            </div>
            <Switch
              checked={form.isCardKind}
              onCheckedChange={(checked) => setForm({ ...form, isCardKind: checked })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium">是否需要"是否生美"开关</label>
              <p className="text-xs text-[var(--muted-foreground)]">仅护理类项目通常勾选；勾选后该一级品项下商品表单显示"是否生美"选项</p>
            </div>
            <Switch
              checked={form.requiresShengmeiFlag}
              onCheckedChange={(checked) => setForm({ ...form, requiresShengmeiFlag: checked })}
            />
          </div>
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">启用状态</label>
            <Switch checked={form.isValid} onCheckedChange={(checked) => setForm({ ...form, isValid: checked })} />
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

      {/* Disable confirmation */}
      <AlertDialog open={!!disableTarget} onOpenChange={(o) => !o && setDisableTarget(null)}>
        <AlertDialogTitle>确认停用</AlertDialogTitle>
        <AlertDialogDescription>
          确定要停用品项类型「{disableTarget?.categoryName}」吗？停用后该类型下的二级分类仍保留，但不再显示为可选分组。
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
    </>
  )
}
