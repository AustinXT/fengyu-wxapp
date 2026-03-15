"use client"

import { useState, useMemo } from "react"
import { useRouter } from "next/navigation"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Dialog, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog"
import { assignRole, revokeRole } from "@/actions/permissions"
import type { PermissionRole, Employee, RoleType, OrgNode } from "@/lib/types"

const roleLabels: Record<RoleType, string> = {
  admin: "系统管理员",
  manager: "门店店长",
  finance: "财务",
  hr: "人事",
  product: "商品管理",
  customer_mgr: "客户经理",
  staff: "普通员工",
}

const roleBgMap: Record<string, string> = {
  admin: "bg-[#FFF0F0] text-[#D94040] border-[#D94040]",
  manager: "bg-[#FFF8E6] text-[#D4820A] border-[#D4820A]",
  finance: "bg-[#E8F0FE] text-[#3574C4] border-[#3574C4]",
  hr: "bg-[#F0F9F2] text-[#3D8A5A] border-[#3D8A5A]",
  product: "bg-[#F5F0FF] text-[#7C5CBF] border-[#7C5CBF]",
  customer_mgr: "bg-[#FFF0EE] text-[#C45C48] border-[#C45C48]",
  staff: "bg-[#F5F5F5] text-[#888888] border-[#888888]",
}

const allRoles: RoleType[] = ["admin", "manager", "finance", "hr", "product", "customer_mgr", "staff"]

interface PermissionsPageProps {
  roles: PermissionRole[]
  employees: Employee[]
  orgNodes: OrgNode[]
}

export default function PermissionsPage({ roles, employees, orgNodes }: PermissionsPageProps) {
  const router = useRouter()
  const [selectedRole, setSelectedRole] = useState<RoleType>("admin")
  const [employeeSearch, setEmployeeSearch] = useState("")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [assignEmployeeId, setAssignEmployeeId] = useState("")
  const [assignRoleValue, setAssignRoleValue] = useState<RoleType>("staff")
  const [assignScopeId, setAssignScopeId] = useState("")
  const [assigning, setAssigning] = useState(false)

  const activeRoles = roles.filter((r) => !r.isVoid)

  // By role view
  const employeesForRole = useMemo(() => {
    return activeRoles.filter((r) => r.role === selectedRole)
  }, [selectedRole, activeRoles])

  // By employee view
  const filteredEmployees = useMemo(() => {
    const active = employees.filter((e) => !e.isResigned)
    if (!employeeSearch) return active
    const q = employeeSearch.toLowerCase()
    return active.filter(
      (e) =>
        (e.name || "").toLowerCase().includes(q) ||
        (e.phone || "").includes(q) ||
        e.employeeId.toLowerCase().includes(q)
    )
  }, [employees, employeeSearch])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">权限管理</h1>
        <Button onClick={() => setDialogOpen(true)}>分配角色</Button>
      </div>

      <Tabs defaultValue="byRole">
        <TabsList>
          <TabsTrigger value="byRole">按角色查看</TabsTrigger>
          <TabsTrigger value="byEmployee">按员工查看</TabsTrigger>
        </TabsList>

        {/* 按角色查看 */}
        <TabsContent value="byRole">
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
            {/* Role list */}
            <Card>
              <CardContent className="p-3">
                <h3 className="text-sm font-semibold text-[#999999] mb-2">角色列表</h3>
                <div className="space-y-1">
                  {allRoles.map((role) => {
                    const count = activeRoles.filter((r) => r.role === role).length
                    return (
                      <button
                        key={role}
                        onClick={() => setSelectedRole(role)}
                        className={`w-full text-left px-3 py-2.5 rounded text-sm transition-colors flex items-center justify-between ${
                          selectedRole === role
                            ? "bg-[var(--primary)] text-white"
                            : "hover:bg-[#FFF0EE]"
                        }`}
                      >
                        <span>{roleLabels[role]}</span>
                        <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                          selectedRole === role ? "bg-white/20" : "bg-gray-100"
                        }`}>
                          {count}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </CardContent>
            </Card>

            {/* Employee list for selected role */}
            <Card className="lg:col-span-3">
              <CardHeader>
                <CardTitle>{roleLabels[selectedRole]}({employeesForRole.length} 人)</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="px-4 py-3 text-left font-medium text-gray-500">员工</th>
                        <th className="px-4 py-3 text-left font-medium text-gray-500">工号</th>
                        <th className="px-4 py-3 text-left font-medium text-gray-500">权限范围</th>
                        <th className="px-4 py-3 text-left font-medium text-gray-500">授权来源</th>
                        <th className="px-4 py-3 text-left font-medium text-gray-500">授权时间</th>
                        <th className="px-4 py-3 text-left font-medium text-gray-500">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {employeesForRole.map((pr) => (
                        <tr key={pr.id} className="hover:bg-[#FFF0EE] transition-colors">
                          <td className="px-4 py-3 font-medium">{pr.employeeName}</td>
                          <td className="px-4 py-3 text-[#999999]">{pr.employeeId}</td>
                          <td className="px-4 py-3">{pr.scopeName}</td>
                          <td className="px-4 py-3 text-[#999999]">{pr.createdBy || "-"}</td>
                          <td className="px-4 py-3 text-[#999999]">
                            {new Date(pr.createdAt).toLocaleDateString("zh-CN")}
                          </td>
                          <td className="px-4 py-3">
                            <Button
                              variant="link"
                              size="sm"
                              className="h-auto p-0 text-[var(--destructive)]"
                              onClick={async () => {
                                if (!confirm(`确定要撤销 ${pr.employeeName} 的 ${roleLabels[pr.role as RoleType]} 角色吗？`)) return
                                try {
                                  const res = await revokeRole(pr.id, pr.updatedAt)
                                  if (res.success) {
                                    const { toast } = await import('sonner')
                                    toast.success(res.message)
                                    router.refresh()
                                  } else {
                                    const { toast } = await import('sonner')
                                    toast.error(res.message)
                                    if (res.message.includes('已被其他人修改')) router.refresh()
                                  }
                                } catch {
                                  const { toast } = await import('sonner')
                                  toast.error('撤销失败，请稍后重试')
                                }
                              }}
                            >
                              撤销
                            </Button>
                          </td>
                        </tr>
                      ))}
                      {employeesForRole.length === 0 && (
                        <tr>
                          <td colSpan={6} className="px-4 py-12 text-center text-[#999999]">该角色暂无成员</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* 按员工查看 */}
        <TabsContent value="byEmployee">
          <Card>
            <CardContent className="p-4">
              <Input
                className="w-64 mb-4"
                placeholder="搜索员工姓名/工号/手机号"
                value={employeeSearch}
                onChange={(e) => setEmployeeSearch(e.target.value)}
              />
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium text-gray-500">员工</th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500">工号</th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500">门店</th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500">职位</th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500">角色</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {filteredEmployees.map((emp) => {
                      const empRoles = activeRoles.filter((r) => r.employeeId === emp.employeeId)
                      return (
                        <tr key={emp.employeeId} className="hover:bg-[#FFF0EE] transition-colors">
                          <td className="px-4 py-3 font-medium">{emp.name}</td>
                          <td className="px-4 py-3 text-[#999999]">{emp.employeeId}</td>
                          <td className="px-4 py-3">{emp.storeName || "-"}</td>
                          <td className="px-4 py-3">{emp.positionName || "-"}</td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-1">
                              {empRoles.length > 0 ? empRoles.map((r) => (
                                <Badge
                                  key={r.id}
                                  variant="outline"
                                  className={roleBgMap[r.role] || ""}
                                >
                                  {roleLabels[r.role as RoleType] || r.role}
                                </Badge>
                              )) : (
                                <span className="text-[#999999]">未分配</span>
                              )}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* 分配角色 Dialog */}
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
              {employees.filter((e) => !e.isResigned).map((e) => (
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
                // admin 角色 scope 固定为 headquarters
                if (role === 'admin') {
                  const hq = orgNodes.find(n => n.type === 'headquarters')
                  if (hq) setAssignScopeId(hq.id)
                }
              }}
            >
              {allRoles.filter((r) => r !== 'staff').map((r) => (
                <option key={r} value={r}>{roleLabels[r]}</option>
              ))}
            </Select>
            {assignRoleValue === 'admin' && (
              <p className="text-xs text-[#D4820A] mt-1">系统管理员 scope 固定为总部级别，不受范围限制</p>
            )}
          </div>
          <div>
            <label className="text-sm text-[#999999]">权限范围</label>
            <Select
              className="mt-1"
              value={assignScopeId}
              onChange={(e) => setAssignScopeId(e.target.value)}
            >
              <option value="">选择组织节点</option>
              {orgNodes.filter((n) => n.isActive).map((n) => (
                <option key={n.id} value={n.id}>{n.name} ({n.type})</option>
              ))}
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
          <Button
            loading={assigning}
            disabled={!assignEmployeeId || !assignScopeId}
            onClick={async () => {
              if (!assignEmployeeId || !assignScopeId) return
              // admin 角色需要二次确认
              if (assignRoleValue === 'admin') {
                const confirmed = window.confirm(
                  '即将分配【系统管理员】角色，该角色拥有最高权限（不受 scope 限制），请确认此操作。'
                )
                if (!confirmed) return
              }
              setAssigning(true)
              try {
                const res = await assignRole({
                  employeeId: assignEmployeeId,
                  role: assignRoleValue,
                  scopeId: assignScopeId,
                })
                if (res.success) {
                  const { toast } = await import('sonner')
                  toast.success(res.message)
                  setDialogOpen(false)
                  setAssignEmployeeId("")
                  setAssignScopeId("")
                  router.refresh()
                } else {
                  const { toast } = await import('sonner')
                  toast.error(res.message)
                }
              } catch {
                const { toast } = await import('sonner')
                toast.error('分配失败，请稍后重试')
              } finally {
                setAssigning(false)
              }
            }}
          >
            确认分配
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  )
}
