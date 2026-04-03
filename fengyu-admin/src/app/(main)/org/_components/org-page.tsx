"use client"

import { useState, useMemo } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import type { OrgNode } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Dialog, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog"
import { formatDateTime } from "@/lib/utils"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter } from "@/components/ui/alert-dialog"
import { createOrgNode, updateOrgNode, deleteOrgNode } from "@/actions/org"

const TYPE_ICON: Record<OrgNode["type"], string> = {
  总部: "\u{1F3E2}",
  市场: "\u{1F4CA}",
  门店: "\u{1F3EA}",
  部门: "\u{1F3F7}\uFE0F",
}

const TYPE_LABEL: Record<OrgNode["type"], string> = {
  总部: "总部",
  市场: "市场",
  门店: "门店",
  部门: "部门",
}

const TYPE_OPTIONS: { value: OrgNode["type"]; label: string }[] = [
  { value: "总部", label: "总部" },
  { value: "市场", label: "市场" },
  { value: "门店", label: "门店" },
  { value: "部门", label: "部门" },
]

function validateType(
  type: OrgNode["type"],
  parentNode: OrgNode | null,
  orgNodes: OrgNode[],
  editingNodeId: string | null
): string | null {
  if (type === "总部" && orgNodes.some((n) => n.type === "总部" && n.id !== editingNodeId))
    return "只能有一个总部"
  if (type === "市场" && parentNode?.type !== "总部")
    return "市场只能在总部下"
  if (type === "门店" && parentNode?.type !== "市场")
    return "门店只能在市场下"
  if (type === "部门" && parentNode?.type === "部门")
    return "部门不能嵌套"
  return null
}

interface TreeNodeProps {
  node: OrgNode
  children: OrgNode[]
  allNodes: OrgNode[]
  depth: number
  selectedId: string | null
  expandedIds: Set<string>
  onSelect: (id: string) => void
  onToggle: (id: string) => void
}

function TreeNode({ node, children, allNodes, depth, selectedId, expandedIds, onSelect, onToggle }: TreeNodeProps) {
  const hasChildren = children.length > 0
  const isExpanded = expandedIds.has(node.id)
  const isSelected = selectedId === node.id

  return (
    <div>
      <div
        className={`flex items-center gap-1 rounded-[var(--radius)] px-2 py-1.5 text-sm cursor-pointer transition-colors ${
          isSelected ? "bg-[#FFF0EE] text-[#C0322A]" : "hover:bg-[var(--muted)]"
        }`}
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
        onClick={() => onSelect(node.id)}
      >
        <button
          className="w-4 h-4 flex items-center justify-center text-xs text-[var(--muted-foreground)] shrink-0"
          onClick={(e) => {
            e.stopPropagation()
            if (hasChildren) onToggle(node.id)
          }}
        >
          {hasChildren ? (isExpanded ? "\u25BE" : "\u25B8") : ""}
        </button>
        <span className="shrink-0">{TYPE_ICON[node.type]}</span>
        <span className="truncate font-medium">{node.name}</span>
        {!node.isActive && (
          <Badge variant="secondary" className="ml-auto text-[10px] px-1.5 py-0">
            停用
          </Badge>
        )}
      </div>
      {isExpanded &&
        children
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              children={allNodes.filter((n) => n.parentId === child.id)}
              allNodes={allNodes}
              depth={depth + 1}
              selectedId={selectedId}
              expandedIds={expandedIds}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
    </div>
  )
}

export default function OrgPage({ orgNodes: allOrgNodes }: { orgNodes: OrgNode[] }) {
  const router = useRouter()
  const [showInactive, setShowInactive] = useState(false)

  // 过滤停用节点（默认隐藏）
  const orgNodes = useMemo(
    () => (showInactive ? allOrgNodes : allOrgNodes.filter((n) => n.isActive)),
    [allOrgNodes, showInactive]
  )

  const [selectedId, setSelectedId] = useState<string | null>(allOrgNodes[0]?.id ?? null)

  // 默认展开两层：根节点 + 根节点的直接子节点
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    const roots = allOrgNodes.filter((n) => n.parentId === null)
    const level1Children = allOrgNodes.filter((n) => roots.some((r) => r.id === n.parentId))
    return new Set([...roots, ...level1Children].map((n) => n.id))
  })

  // Delete state
  const [deleteTarget, setDeleteTarget] = useState<OrgNode | null>(null)

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogMode, setDialogMode] = useState<"create" | "edit">("create")
  const [dialogParentId, setDialogParentId] = useState<string | null>(null)
  const [editingNode, setEditingNode] = useState<OrgNode | null>(null)
  const [formName, setFormName] = useState("")
  const [formType, setFormType] = useState<OrgNode["type"]>("部门")
  const [formSortOrder, setFormSortOrder] = useState(0)
  const [formIsActive, setFormIsActive] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  const rootNodes = useMemo(
    () =>
      orgNodes.filter((n) => n.parentId === null).sort(
        (a, b) => a.sortOrder - b.sortOrder
      ),
    [orgNodes]
  )

  const selectedNode = useMemo(
    () => orgNodes.find((n) => n.id === selectedId) ?? null,
    [selectedId, orgNodes]
  )

  const parentNode = useMemo(
    () =>
      selectedNode?.parentId
        ? orgNodes.find((n) => n.id === selectedNode.parentId) ?? null
        : null,
    [selectedNode, orgNodes]
  )

  const dialogParentNode = useMemo(
    () => (dialogParentId ? orgNodes.find((n) => n.id === dialogParentId) ?? null : null),
    [dialogParentId, orgNodes]
  )

  const openCreateDialog = (parentId: string | null) => {
    setDialogMode("create")
    setDialogParentId(parentId)
    setEditingNode(null)
    setFormName("")
    setFormType("部门")
    setFormSortOrder(0)
    setFormIsActive(true)
    setDialogOpen(true)
  }

  const openEditDialog = (node: OrgNode) => {
    setDialogMode("edit")
    setDialogParentId(node.parentId)
    setEditingNode(node)
    setFormName(node.name)
    setFormType(node.type)
    setFormSortOrder(node.sortOrder)
    setFormIsActive(node.isActive)
    setDialogOpen(true)
  }

  const handleSubmit = async () => {
    if (!formName.trim()) {
      toast.error("请输入节点名称")
      return
    }

    const error = validateType(formType, dialogParentNode, orgNodes, editingNode?.id ?? null)
    if (error) {
      toast.error(error)
      return
    }

    setSubmitting(true)
    try {
      if (dialogMode === "create") {
        const newId = `org-${formType}-${Date.now()}`
        const createResult = await createOrgNode({
          id: newId,
          name: formName.trim(),
          type: formType,
          parentId: dialogParentId,
          sortOrder: formSortOrder,
          isActive: formIsActive,
        })
        if (!createResult.success) {
          toast.error(createResult.message)
          return
        }
        toast.success("节点创建成功")
        setDialogOpen(false)
        router.refresh()
        // Expand parent so new node is visible, then select the new node
        if (dialogParentId) {
          setExpandedIds((prev) => new Set([...prev, dialogParentId]))
        }
        setSelectedId(newId)
      } else if (editingNode) {
        const orgResult = await updateOrgNode(editingNode.id, {
          name: formName.trim(),
          type: formType,
          sortOrder: formSortOrder,
          isActive: formIsActive,
        }, editingNode.updatedAt)
        if (!orgResult.success) {
          toast.error(orgResult.message)
          if (orgResult.message.includes("已被其他人修改")) router.refresh()
          return
        }
        toast.success("节点更新成功")
        setDialogOpen(false)
        router.refresh()
      }
    } catch {
      toast.error(dialogMode === "create" ? "创建失败，请稍后重试" : "更新失败，请稍后重试")
    } finally {
      setSubmitting(false)
    }
  }

  const handleToggle = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">组织架构</h1>
      </div>

      <div className="flex gap-4" style={{ minHeight: "calc(100vh - 220px)" }}>
        {/* Left: Tree */}
        <Card className="w-80 shrink-0 flex flex-col">
          <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">组织树</CardTitle>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 rounded border-[var(--input)] accent-[var(--primary)]"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
              />
              <span className="text-xs text-[var(--muted-foreground)]">显示停用</span>
            </label>
          </CardHeader>
          <CardContent className="flex-1 overflow-auto pb-3">
            {rootNodes.map((node) => (
              <TreeNode
                key={node.id}
                node={node}
                children={orgNodes.filter((n) => n.parentId === node.id)}
                allNodes={orgNodes}
                depth={0}
                selectedId={selectedId}
                expandedIds={expandedIds}
                onSelect={setSelectedId}
                onToggle={handleToggle}
              />
            ))}
          </CardContent>
        </Card>

        {/* Right: Detail */}
        <Card className="flex-1">
          {selectedNode ? (
            <>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                <CardTitle className="text-base">节点详情</CardTitle>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => openEditDialog(selectedNode)}>
                    编辑
                  </Button>
                  <Button size="sm" onClick={() => openCreateDialog(selectedNode.id)}>新增子节点</Button>
                  {selectedNode.type !== '总部' && (
                    <Button size="sm" variant="ghost" className="text-[#D94040]" onClick={() => setDeleteTarget(selectedNode)}>
                      删除
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-x-8 gap-y-4">
                  <div>
                    <div className="text-sm text-[var(--muted-foreground)]">节点名称</div>
                    <div className="mt-1 font-medium">{selectedNode.name}</div>
                  </div>
                  <div>
                    <div className="text-sm text-[var(--muted-foreground)]">节点类型</div>
                    <div className="mt-1 font-medium">
                      {TYPE_ICON[selectedNode.type]} {TYPE_LABEL[selectedNode.type]}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-[var(--muted-foreground)]">上级节点</div>
                    <div className="mt-1 font-medium">
                      {parentNode ? parentNode.name : "（无）"}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-[var(--muted-foreground)]">排序</div>
                    <div className="mt-1 font-medium">{selectedNode.sortOrder}</div>
                  </div>
                  <div>
                    <div className="text-sm text-[var(--muted-foreground)]">状态</div>
                    <div className="mt-1">
                      <Badge
                        variant="outline"
                        className={
                          selectedNode.isActive
                            ? "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]"
                            : "border-[#888888] text-[#888888] bg-[#F5F5F5]"
                        }
                      >
                        {selectedNode.isActive ? "启用" : "停用"}
                      </Badge>
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-[var(--muted-foreground)]">节点 ID</div>
                    <div className="mt-1 font-mono text-xs text-[var(--muted-foreground)]">
                      {selectedNode.id}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-[var(--muted-foreground)]">创建时间</div>
                    <div className="mt-1 text-sm">{formatDateTime(selectedNode.createdAt)}</div>
                  </div>
                  <div>
                    <div className="text-sm text-[var(--muted-foreground)]">更新时间</div>
                    <div className="mt-1 text-sm">{formatDateTime(selectedNode.updatedAt)}</div>
                  </div>
                </div>

                <Separator className="my-6" />

                <div>
                  <h3 className="text-sm font-medium text-[var(--muted-foreground)] mb-3">
                    下级节点
                  </h3>
                  {orgNodes.filter((n) => n.parentId === selectedNode.id).length === 0 ? (
                    <p className="text-sm text-[var(--muted-foreground)]">暂无下级节点</p>
                  ) : (
                    <div className="space-y-1">
                      {orgNodes.filter((n) => n.parentId === selectedNode.id)
                        .sort((a, b) => a.sortOrder - b.sortOrder)
                        .map((child) => (
                          <div
                            key={child.id}
                            className="flex items-center gap-2 rounded-[var(--radius)] px-3 py-2 text-sm hover:bg-[var(--muted)] cursor-pointer"
                            onClick={() => setSelectedId(child.id)}
                          >
                            <span>{TYPE_ICON[child.type]}</span>
                            <span>{child.name}</span>
                            {!child.isActive && (
                              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                                停用
                              </Badge>
                            )}
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              </CardContent>
            </>
          ) : (
            <CardContent className="flex items-center justify-center h-full">
              <p className="text-[var(--muted-foreground)]">请在左侧选择一个节点</p>
            </CardContent>
          )}
        </Card>
      </div>

      {/* 新增/编辑 Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogClose onOpenChange={setDialogOpen} />
        <DialogHeader>
          <DialogTitle>{dialogMode === "create" ? "新增节点" : "编辑节点"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-4">
          <div>
            <label className="text-sm text-[var(--muted-foreground)]">上级节点</label>
            <div className="mt-1 text-sm font-medium px-3 py-2 rounded-[var(--radius)] border border-[var(--input)] bg-[var(--muted)] text-[var(--muted-foreground)]">
              {dialogParentNode ? dialogParentNode.name : "（无）"}
            </div>
          </div>
          <div>
            <label className="text-sm text-[var(--muted-foreground)]">
              节点名称 <span className="text-[#D94040]">*</span>
            </label>
            <Input
              className="mt-1"
              placeholder="请输入节点名称"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
            />
          </div>
          <div>
            <label className="text-sm text-[var(--muted-foreground)]">
              节点类型 <span className="text-[#D94040]">*</span>
            </label>
            <Select
              className="mt-1"
              value={formType}
              onChange={(e) => setFormType(e.target.value as OrgNode["type"])}
            >
              {TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="text-sm text-[var(--muted-foreground)]">排序</label>
            <Input
              className="mt-1"
              type="number"
              value={formSortOrder}
              onChange={(e) => setFormSortOrder(Number(e.target.value) || 0)}
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              id="org-is-active"
              type="checkbox"
              className="h-4 w-4 rounded border-[var(--input)] accent-[var(--primary)]"
              checked={formIsActive}
              onChange={(e) => setFormIsActive(e.target.checked)}
            />
            <label htmlFor="org-is-active" className="text-sm text-[var(--foreground)] cursor-pointer">
              启用
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
          <Button loading={submitting} onClick={handleSubmit}>
            {dialogMode === "create" ? "创建" : "保存"}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* 删除确认 */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogTitle>确认删除节点？</AlertDialogTitle>
        <AlertDialogDescription>
          将永久删除「{deleteTarget?.name}」节点，此操作不可撤销。如果该节点下存在子节点或关联数据，删除会被拒绝。
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setDeleteTarget(null)}>取消</AlertDialogCancel>
          <AlertDialogAction onClick={async () => {
            if (!deleteTarget) return
            try {
              const res = await deleteOrgNode(deleteTarget.id)
              if (res.success) {
                toast.success(res.message)
                setDeleteTarget(null)
                setSelectedId(null)
                router.refresh()
              } else {
                toast.error(res.message)
              }
            } catch (err: any) {
              const msg = err?.message ?? ''
              if (msg.includes('PERMISSION_DENIED')) {
                toast.error('无权执行删除操作')
              } else if (msg.includes('UNAUTHORIZED')) {
                toast.error('登录已过期，请重新登录')
              } else {
                toast.error('操作失败，请稍后重试')
              }
            }
          }}>确认删除</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>
    </div>
  )
}
