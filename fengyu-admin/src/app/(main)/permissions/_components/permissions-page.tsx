"use client"

import { useState, useMemo, useCallback, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/select"
import { OrgTreeSelect } from "@/components/ui/org-tree-select"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog"
import { AlertDialog, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog"
import { toast } from "sonner"
import { assignRole, revokeRole, getRolesByScope } from "@/actions/permissions"
import { ROLE_LABELS } from "@/lib/types"
import { ROLE_SCOPE_TYPES } from "@/lib/role-scope-rules"
import { actionErrorMessage } from "@/lib/action-error"
import { cn, formatDate } from "@/lib/utils"
import type { PermissionRole, Employee, RoleType, OrgNode } from "@/lib/types"

const roleBgMap: Record<string, string> = {
  admin: "bg-[#FFF0F0] text-[#D94040] border-[#D94040]",
  manager: "bg-[#FFF8E6] text-[#D4820A] border-[#D4820A]",
  finance: "bg-[#E8F0FE] text-[#3574C4] border-[#3574C4]",
  hr: "bg-[#F0F9F2] text-[#3D8A5A] border-[#3D8A5A]",
  product: "bg-[#F5F0FF] text-[#7C5CBF] border-[#7C5CBF]",
  customer_mgr: "bg-[#FFF0EE] text-[#C45C48] border-[#C45C48]",
  staff: "bg-[#F5F5F5] text-[#888888] border-[#888888]",
}

const scopeTypeBadge: Record<string, { label: string; className: string }> = {
  总部: { label: "总部", className: "bg-[#FFF0F0] text-[#D94040] border-[#D94040]" },
  市场: { label: "市场", className: "bg-[#FFF8E6] text-[#D4820A] border-[#D4820A]" },
  门店: { label: "门店", className: "bg-[#F5F5F5] text-[#888888] border-[#888888]" },
}

const allRoles: RoleType[] = ["admin", "manager", "finance", "hr", "product", "customer_mgr", "staff"]

interface PermissionsPageProps {
  initialRoles: PermissionRole[]
  initialScopeId: string
  roleCounts: Record<string, number>
  allEmployees: Employee[]
  orgNodes: OrgNode[]
  
  accessibleScopeIds: string[] | null
}



interface TreeNodeProps {
  node: OrgNode
  allNodes: OrgNode[]
  depth: number
  selectedId: string | null
  expandedIds: Set<string>
  roleCounts: Record<string, number>
  
  accessibleIds: Set<string> | null
  onSelect: (id: string) => void
  onToggle: (id: string) => void
}

function TreeNode({ node, allNodes, depth, selectedId, expandedIds, roleCounts, accessibleIds, onSelect, onToggle }: TreeNodeProps) {
  const children = allNodes
    .filter(n => n.parentId === node.id)
    .sort((a, b) => a.sortOrder - b.sortOrder)
  const hasChildren = children.length > 0
  const isExpanded = expandedIds.has(node.id)
  const isSelected = selectedId === node.id
  const count = roleCounts[node.id] || 0
  
  const isDisabled = accessibleIds != null && !accessibleIds.has(node.id)

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-1 rounded-[var(--radius)] px-2 py-1.5 text-sm transition-colors",
          isDisabled
            ? "cursor-not-allowed text-[var(--muted-foreground)] opacity-50"
            : cn("cursor-pointer", isSelected ? "bg-[#FFF0EE] text-[#C0322A] font-medium" : "hover:bg-[var(--muted)]"),
        )}
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
        onClick={isDisabled ? undefined : () => onSelect(node.id)}
      >
        {hasChildren ? (
          <span
            className="inline-flex w-4 shrink-0 cursor-pointer select-none"
            onClick={(e) => { e.stopPropagation(); onToggle(node.id) }}
          >
            {isExpanded ? "▾" : "▸"}
          </span>
        ) : (
          <span className="inline-flex w-4 shrink-0" />
        )}
        <span className="truncate flex-1">{node.name}</span>
        {count > 0 && (
          <span className={cn(
            "text-xs px-1.5 py-0.5 rounded-full shrink-0",
            isSelected && !isDisabled ? "bg-white/20" : "bg-gray-100 text-gray-500",
          )}>
            {count}
          </span>
        )}
      </div>
      {hasChildren && isExpanded && children.map(child => (
        <TreeNode
          key={child.id}
          node={child}
          allNodes={allNodes}
          depth={depth + 1}
          selectedId={selectedId}
          expandedIds={expandedIds}
          roleCounts={roleCounts}
          accessibleIds={accessibleIds}
          onSelect={onSelect}
          onToggle={onToggle}
        />
      ))}
    </div>
  )
}



export default function PermissionsPage({ initialRoles, initialScopeId, roleCounts, allEmployees, orgNodes, accessibleScopeIds }: PermissionsPageProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  
  const permissionNodes = useMemo(
    () => orgNodes.filter(n => n.isActive && n.type !== "部门"),
    [orgNodes],
  )

  
  const accessibleIdSet = useMemo(
    () => (accessibleScopeIds ? new Set(accessibleScopeIds) : null),
    [accessibleScopeIds],
  )

  
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(initialScopeId || null)
  const [scopeRoles, setScopeRoles] = useState<PermissionRole[]>(initialRoles)

  
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    const roots = permissionNodes.filter(n => !n.parentId)
    const initial = new Set(roots.map(n => n.id))
    for (const root of roots) {
      for (const child of permissionNodes.filter(n => n.parentId === root.id)) {
        initial.add(child.id)
      }
    }
    
    if (accessibleScopeIds) {
      const byId = new Map(permissionNodes.map(n => [n.id, n]))
      for (const id of accessibleScopeIds) {
        let cur = byId.get(id)
        for (let i = 0; i < 5 && cur?.parentId; i++) {
          initial.add(cur.parentId)
          cur = byId.get(cur.parentId)
        }
      }
    }
    return initial
  })

  const toggleExpand = useCallback((nodeId: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }, [])

  
  const handleSelectNode = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId)
    startTransition(async () => {
      try {
        const roles = await getRolesByScope(nodeId)
        setScopeRoles(roles)
      } catch (err) {
        toast.error(actionErrorMessage(err, "加载角色数据失败"))
      }
    })
  }, [])

  
  const refreshCurrentScope = useCallback(() => {
    if (!selectedNodeId) return
    startTransition(async () => {
      try {
        const roles = await getRolesByScope(selectedNodeId)
        setScopeRoles(roles)
      } catch {
        
      }
    })
    router.refresh() 
  }, [selectedNodeId, router])

  
  const selectedNode = useMemo(
    () => orgNodes.find(n => n.id === selectedNodeId) ?? null,
    [orgNodes, selectedNodeId],
  )

  const groupedByRole = useMemo(() => {
    const groups: { role: RoleType; label: string; items: PermissionRole[] }[] = []
    for (const role of allRoles) {
      const items = scopeRoles.filter(r => r.role === role)
      if (items.length > 0) {
        groups.push({ role, label: ROLE_LABELS[role], items })
      }
    }
    return groups
  }, [scopeRoles])

  
  const [dialogOpen, setDialogOpen] = useState(false)
  const [assignEmployeeId, setAssignEmployeeId] = useState("")
  
  
  const [assignRoleValue, setAssignRoleValue] = useState<RoleType>("manager")
  const [assignScopeId, setAssignScopeId] = useState("")
  const [assigning, setAssigning] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<PermissionRole | null>(null)
  const [adminConfirmOpen, setAdminConfirmOpen] = useState(false)

  function openAssignDialog(prefilledScopeId?: string) {
    setAssignEmployeeId("")
    setAssignRoleValue("manager")
    setAssignScopeId(prefilledScopeId ?? "")
    setDialogOpen(true)
  }

  async function doAssign() {
    setAssigning(true)
    try {
      const res = await assignRole({
        employeeId: assignEmployeeId,
        role: assignRoleValue,
        scopeId: assignScopeId,
      })
      if (res.success) {
        toast.success(res.message)
        setDialogOpen(false)
        refreshCurrentScope()
      } else {
        toast.error(res.message)
      }
    } catch (err) {
      toast.error(actionErrorMessage(err, "分配失败，请稍后重试"))
    } finally {
      setAssigning(false)
    }
  }

  async function doRevoke() {
    if (!revokeTarget) return
    try {
      const res = await revokeRole(revokeTarget.id)
      if (res.success) {
        toast.success(res.message)
        refreshCurrentScope()
      } else {
        toast.error(res.message)
      }
    } catch (err) {
      toast.error(actionErrorMessage(err, "撤销失败，请稍后重试"))
    } finally {
      setRevokeTarget(null)
    }
  }

  const rootNodes = permissionNodes
    .filter(n => !n.parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">权限管理</h1>
        <Button onClick={() => openAssignDialog()}>分配角色</Button>
      </div>

      <div className="flex gap-4" style={{ minHeight: "calc(100vh - 220px)" }}>
        {}
        <Card className="w-72 shrink-0 flex flex-col">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">权限范围</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 overflow-auto p-3 pt-0">
            {rootNodes.map(node => (
              <TreeNode
                key={node.id}
                node={node}
                allNodes={permissionNodes}
                depth={0}
                selectedId={selectedNodeId}
                expandedIds={expandedIds}
                roleCounts={roleCounts}
                accessibleIds={accessibleIdSet}
                onSelect={handleSelectNode}
                onToggle={toggleExpand}
              />
            ))}
          </CardContent>
        </Card>

        {}
        <Card className="flex-1">
          {selectedNode ? (
            <>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CardTitle>{selectedNode.name}</CardTitle>
                    {scopeTypeBadge[selectedNode.type] && (
                      <Badge variant="outline" className={scopeTypeBadge[selectedNode.type].className}>
                        {scopeTypeBadge[selectedNode.type].label}
                      </Badge>
                    )}
                  </div>
                  <Button variant="outline" size="sm" onClick={() => openAssignDialog(selectedNodeId!)}>
                    在此范围分配角色
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {isPending ? (
                  <div className="flex items-center justify-center py-20 text-[#999999]">
                    加载中...
                  </div>
                ) : groupedByRole.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-20 text-[#999999]">
                    <p className="mb-4">该范围暂无角色分配</p>
                    <Button variant="outline" size="sm" onClick={() => openAssignDialog(selectedNodeId!)}>
                      分配角色
                    </Button>
                  </div>
                ) : (
                  <div className="divide-y divide-gray-200">
                    {groupedByRole.map(group => (
                      <div key={group.role} className="px-4 py-4">
                        <div className="flex items-center gap-2 mb-3">
                          <Badge variant="outline" className={roleBgMap[group.role]}>
                            {group.label}
                          </Badge>
                          <span className="text-xs text-[#999999]">{group.items.length} 人</span>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead className="bg-gray-50">
                              <tr>
                                <th className="px-3 py-2 text-left font-medium text-gray-500">员工</th>
                                <th className="px-3 py-2 text-left font-medium text-gray-500">工号</th>
                                <th className="px-3 py-2 text-left font-medium text-gray-500">授权来源</th>
                                <th className="px-3 py-2 text-left font-medium text-gray-500">授权时间</th>
                                <th className="px-3 py-2 text-left font-medium text-gray-500">操作</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                              {group.items.map(pr => (
                                <tr key={pr.id} className="hover:bg-[#FFF0EE] transition-colors">
                                  <td className="px-3 py-2 font-medium">{pr.employeeName}</td>
                                  <td className="px-3 py-2 text-[#999999]">{pr.employeeId}</td>
                                  <td className="px-3 py-2 text-[#999999]">{pr.createdBy || "—"}</td>
                                  <td className="px-3 py-2 text-[#999999]">
                                    {formatDate(pr.createdAt) || "—"}
                                  </td>
                                  <td className="px-3 py-2">
                                    <Button
                                      variant="link"
                                      size="sm"
                                      className="h-auto p-0 text-[var(--destructive)]"
                                      onClick={() => setRevokeTarget(pr)}
                                    >
                                      撤销
                                    </Button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </>
          ) : (
            <CardContent className="flex items-center justify-center h-full text-[#999999]">
              请在左侧选择一个组织节点
            </CardContent>
          )}
        </Card>
      </div>

      {}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogClose onOpenChange={setDialogOpen} />
        <DialogHeader>
          <DialogTitle>分配角色</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-4">
          <div>
            <label className="text-sm text-[#999999]">员工</label>
            <Select
              className="mt-1"
              value={assignEmployeeId}
              onChange={(e) => setAssignEmployeeId(e.target.value)}
            >
              <option value="">选择员工</option>
              {allEmployees.filter((e) => !e.isResigned).map((e) => (
                <option key={e.employeeId} value={e.employeeId}>
                  {e.name} ({e.positionName} - {e.storeName})
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="text-sm text-[#999999]">角色</label>
            <Select
              className="mt-1"
              value={assignRoleValue}
              onChange={(e) => {
                const role = e.target.value as RoleType
                setAssignRoleValue(role)
                if (role === "admin") {
                  const hq = orgNodes.find(n => n.type === "总部")
                  setAssignScopeId(hq ? hq.id : "")
                  return
                }
                
                if (assignScopeId) {
                  const node = orgNodes.find(n => n.id === assignScopeId)
                  if (!node || !ROLE_SCOPE_TYPES[role].includes(node.type)) {
                    setAssignScopeId("")
                  }
                }
              }}
            >
              {allRoles.filter((r) => r !== "staff").map((r) => (
                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
              ))}
            </Select>
            {assignRoleValue === "admin" && (
              <p className="text-xs text-[#D4820A] mt-1">系统管理员 scope 固定为总部级别，不受范围限制</p>
            )}
          </div>
          <div>
            <label className="text-sm text-[#999999]">权限范围</label>
            <OrgTreeSelect
              className="mt-1"
              orgNodes={orgNodes}
              excludeTypes={["部门"]}
              allowedTypes={ROLE_SCOPE_TYPES[assignRoleValue]}
              value={assignScopeId}
              onChange={(id) => setAssignScopeId(id)}
              placeholder="选择组织节点"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
          <Button
            loading={assigning}
            disabled={!assignEmployeeId || !assignScopeId}
            onClick={async () => {
              if (!assignEmployeeId || !assignScopeId) return
              if (assignRoleValue === "admin") {
                setAdminConfirmOpen(true)
                return
              }
              await doAssign()
            }}
          >
            确认分配
          </Button>
        </DialogFooter>
      </Dialog>

      {}
      <AlertDialog open={!!revokeTarget} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <AlertDialogTitle>确认撤销角色？</AlertDialogTitle>
        <AlertDialogDescription>
          将撤销 {revokeTarget?.employeeName} 的{" "}
          {ROLE_LABELS[(revokeTarget?.role ?? "staff") as RoleType]} 角色，撤销后该员工将立即失去对应权限。
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setRevokeTarget(null)}>取消</AlertDialogCancel>
          <AlertDialogAction onClick={doRevoke}>确认撤销</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>

      {}
      <AlertDialog open={adminConfirmOpen} onOpenChange={setAdminConfirmOpen}>
        <AlertDialogTitle>确认分配系统管理员？</AlertDialogTitle>
        <AlertDialogDescription>
          系统管理员拥有最高权限，不受 scope 限制，可访问全部数据和功能。请确认此操作。
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setAdminConfirmOpen(false)}>取消</AlertDialogCancel>
          <AlertDialogAction
            className="bg-[var(--primary)] text-white hover:bg-[var(--primary)]/90"
            onClick={async () => {
              setAdminConfirmOpen(false)
              await doAssign()
            }}
          >
            确认分配
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>
    </div>
  )
}
