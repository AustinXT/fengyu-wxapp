"use client"

import { useState, useMemo } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import type { Position, PositionScope } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
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
import { createPosition, updatePosition } from "@/actions/positions"

const SCOPE_TABS: { value: PositionScope; label: string }[] = [
  { value: "headquarters", label: "总部" },
  { value: "market", label: "市场" },
  { value: "store", label: "门店" },
]

interface FormData {
  name: string
  scope: PositionScope
  sortOrder: number
  isValid: boolean
}

const emptyForm = (scope: PositionScope): FormData => ({
  name: "",
  scope,
  sortOrder: 0,
  isValid: true,
})

export default function PositionManagementDialog({
  open,
  onOpenChange,
  positions: allPositions,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  positions: Position[]
}) {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<PositionScope>("store")

  // Inner dialog state for add/edit
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Position | null>(null)
  const [form, setForm] = useState<FormData>(emptyForm("store"))
  const [saving, setSaving] = useState(false)

  // Disable confirmation
  const [disableTarget, setDisableTarget] = useState<Position | null>(null)
  const [disabling, setDisabling] = useState(false)

  const positionsByScope = useMemo(() => {
    const map: Record<string, Position[]> = {}
    for (const tab of SCOPE_TABS) {
      map[tab.value] = allPositions
        .filter((p) => p.scope === tab.value)
        .sort((a, b) => a.sortOrder - b.sortOrder)
    }
    return map
  }, [allPositions])

  function openAdd() {
    setEditing(null)
    setForm(emptyForm(activeTab))
    setFormOpen(true)
  }

  function openEdit(row: Position) {
    setEditing(row)
    setForm({
      name: row.name,
      scope: row.scope,
      sortOrder: row.sortOrder,
      isValid: row.isValid,
    })
    setFormOpen(true)
  }

  async function handleSubmit() {
    if (!form.name.trim()) {
      toast.error("请输入职位名称")
      return
    }
    setSaving(true)
    try {
      if (editing) {
        const res = await updatePosition(
          editing.id,
          {
            name: form.name.trim(),
            scope: form.scope,
            sortOrder: form.sortOrder,
            isValid: form.isValid,
          },
          editing.updatedAt,
        )
        if (!res.success) {
          toast.error(res.message)
          if (res.message.includes("已被其他人修改")) router.refresh()
          return
        }
        toast.success("职位已更新")
      } else {
        const id = `pos-${Date.now()}`
        const res = await createPosition({
          id,
          name: form.name.trim(),
          scope: form.scope,
          sortOrder: form.sortOrder,
          isValid: form.isValid,
        })
        if (!res.success) {
          toast.error(res.message)
          return
        }
        toast.success("职位已创建")
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
      const res = await updatePosition(disableTarget.id, { isValid: false }, disableTarget.updatedAt)
      if (!res.success) {
        toast.error(res.message)
        if (res.message.includes("已被其他人修改")) router.refresh()
        return
      }
      toast.success("职位已停用")
      setDisableTarget(null)
      router.refresh()
    } catch {
      toast.error("停用失败")
    } finally {
      setDisabling(false)
    }
  }

  const columns: Column<Position>[] = [
    {
      key: "name",
      header: "职位名称",
      cell: (row) => <span className="font-medium">{row.name}</span>,
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
    <>
      <Dialog open={open} onOpenChange={onOpenChange} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>职位管理</DialogTitle>
        </DialogHeader>
        <div className="mt-4">
          <Tabs defaultValue="store" onValueChange={(v) => setActiveTab(v as PositionScope)}>
            <div className="flex items-center justify-between mb-3">
              <TabsList>
                {SCOPE_TABS.map((tab) => (
                  <TabsTrigger key={tab.value} value={tab.value}>
                    {tab.label}（{positionsByScope[tab.value]?.length ?? 0}）
                  </TabsTrigger>
                ))}
              </TabsList>
              <Button size="sm" onClick={openAdd}>
                新增职位
              </Button>
            </div>

            {SCOPE_TABS.map((tab) => (
              <TabsContent key={tab.value} value={tab.value}>
                <DataTable columns={columns} data={positionsByScope[tab.value] ?? []} emptyText="暂无职位" />
              </TabsContent>
            ))}
          </Tabs>
        </div>
      </Dialog>

      {/* Add/Edit form dialog */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogHeader>
          <DialogTitle>{editing ? "编辑职位" : "新增职位"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">职位名称 *</label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="请输入职位名称"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">所属层级 *</label>
            <div className="flex gap-2">
              {SCOPE_TABS.map((tab) => (
                <Button
                  key={tab.value}
                  type="button"
                  variant={form.scope === tab.value ? "default" : "outline"}
                  size="sm"
                  onClick={() => setForm({ ...form, scope: tab.value })}
                >
                  {tab.label}
                </Button>
              ))}
            </div>
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
          确定要停用职位「{disableTarget?.name}」吗？停用后该职位将不再出现在下拉选项中。
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
