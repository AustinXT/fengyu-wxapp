"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useUnsavedChanges } from "@/lib/hooks/use-unsaved-changes"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { DataTable, type Column } from "@/components/ui/data-table"
import { Dialog, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter } from "@/components/ui/alert-dialog"
import { Separator } from "@/components/ui/separator"
import { getRoleLabel } from "@/lib/auth"
import { formatDate } from "@/lib/utils"
import { updateEmployee } from "@/actions/employees"
import { assignRole } from "@/actions/permissions"
import { resetToDefaultPassword } from "@/actions/auth"
import type { Employee, PermissionRole, Store, OrgNode, RoleType } from "@/lib/types"

const allRoleTypes: RoleType[] = ["admin", "manager", "finance", "hr", "product", "customer_mgr"]

const roleLabels: Record<RoleType, string> = {
  admin: "系统管理员",
  manager: "门店店长",
  finance: "财务",
  hr: "人事",
  product: "商品管理",
  customer_mgr: "客户经理",
  staff: "普通员工",
}

interface Props {
  employee: Employee
  roles: PermissionRole[]
  stores: Store[]
  orgNodes: OrgNode[]
}

export default function EmployeeDetailPage({ employee, roles, stores, orgNodes }: Props) {
  const router = useRouter()

  // Edit info state
  const [isEditing, setIsEditing] = useState(false)
  useUnsavedChanges(isEditing)
  const [resignDialogOpen, setResignDialogOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    name: employee.name ?? "",
    gender: employee.gender ?? "",
    phone: employee.phone ?? "",
    idCard: employee.idCard ?? "",
    storeId: employee.storeId ?? "",
    orgNodeId: employee.orgNodeId ?? "",
    positionName: employee.positionName ?? "",
    birthday: employee.birthday ?? "",
    skills: employee.skills?.join(", ") ?? "",
  })

  // Assign role dialog state
  const [roleDialogOpen, setRoleDialogOpen] = useState(false)
  const [assignRoleValue, setAssignRoleValue] = useState<RoleType>("manager")
  const [assignScopeId, setAssignScopeId] = useState("")
  const [assigning, setAssigning] = useState(false)

  // Password reset state
  const [resetPwdDialogOpen, setResetPwdDialogOpen] = useState(false)
  const [resettingPwd, setResettingPwd] = useState(false)

  function maskIdCard(value: string | null): string {
    if (!value || value.length < 8) return value ?? ""
    return value.slice(0, 4) + "****" + value.slice(-4)
  }

  function handleFormChange(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  function handleCancelEdit() {
    setForm({
      name: employee.name ?? "",
      gender: employee.gender ?? "",
      phone: employee.phone ?? "",
      idCard: employee.idCard ?? "",
      storeId: employee.storeId ?? "",
      orgNodeId: employee.orgNodeId ?? "",
      positionName: employee.positionName ?? "",
      birthday: employee.birthday ?? "",
      skills: employee.skills?.join(", ") ?? "",
    })
    setIsEditing(false)
  }

  async function handleSave() {
    setSaving(true)
    try {
      const skillsArr = form.skills
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean)
      const result = await updateEmployee(employee.employeeId, {
        name: form.name || null,
        gender: form.gender || null,
        phone: form.phone || null,
        idCard: form.idCard || null,
        storeId: form.storeId || null,
        orgNodeId: form.orgNodeId || null,
        positionName: form.positionName || null,
        birthday: form.birthday || null,
        skills: skillsArr.length > 0 ? skillsArr : null,
      }, employee.updatedAt)
      if (!result.success) {
        toast.error(result.message)
        if (result.message.includes('已被其他人修改')) router.refresh()
        return
      }
      toast.success("保存成功")
      setIsEditing(false)
      router.refresh()
    } catch {
      toast.error("保存失败，请稍后重试")
    } finally {
      setSaving(false)
    }
  }

  async function handleAssignRole() {
    if (!assignScopeId) return
    setAssigning(true)
    try {
      const res = await assignRole({
        employeeId: employee.employeeId,
        role: assignRoleValue,
        scopeId: assignScopeId,
      })
      if (res.success) {
        toast.success(res.message)
        setRoleDialogOpen(false)
        setAssignScopeId("")
        router.refresh()
      }
    } catch {
      toast.error("分配失败，请稍后重试")
    } finally {
      setAssigning(false)
    }
  }

  async function handleResetToDefault() {
    setResettingPwd(true)
    try {
      const res = await resetToDefaultPassword(employee.employeeId)
      if (res.success) {
        toast.success(res.message)
        setResetPwdDialogOpen(false)
      } else {
        toast.error(res.message)
      }
    } catch {
      toast.error("密码重置失败，请稍后重试")
    } finally {
      setResettingPwd(false)
    }
  }

  const roleColumns: Column<PermissionRole>[] = [
    {
      key: "role",
      header: "角色",
      cell: (row) => <span className="font-medium">{getRoleLabel(row.role)}</span>,
    },
    {
      key: "scopeName",
      header: "作用域",
      cell: (row) => <span>{row.scopeName ?? "—"}</span>,
    },
    {
      key: "isVoid",
      header: "状态",
      cell: (row) => (
        <Badge
          variant="outline"
          className={
            row.isVoid
              ? "border-[#888888] text-[#888888] bg-[#F5F5F5]"
              : "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]"
          }
        >
          {row.isVoid ? "已撤销" : "生效中"}
        </Badge>
      ),
    },
    {
      key: "createdAt",
      header: "分配时间",
      cell: (row) => <span>{formatDate(row.createdAt)}</span>,
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => router.back()}>
          &larr; 返回
        </Button>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">
          员工详情 - {employee.name}
        </h1>
        <Badge
          variant="outline"
          className={
            employee.isResigned
              ? "border-[#888888] text-[#888888] bg-[#F5F5F5]"
              : "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]"
          }
        >
          {employee.isResigned ? "已离职" : "在职"}
        </Badge>
        {!employee.isResigned && (
          <Button variant="ghost" size="sm" className="text-[#D94040] ml-auto" onClick={() => setResignDialogOpen(true)}>
            标记离职
          </Button>
        )}
      </div>

      <Tabs defaultValue="info">
        <TabsList>
          <TabsTrigger value="info">基本信息</TabsTrigger>
          <TabsTrigger value="roles">权限角色</TabsTrigger>
          <TabsTrigger value="admin">管理后台</TabsTrigger>
        </TabsList>

        <TabsContent value="info">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">基本信息</CardTitle>
              {isEditing ? (
                <div className="flex gap-2">
                  <Button size="sm" loading={saving} onClick={handleSave}>
                    保存
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleCancelEdit} disabled={saving}>
                    取消
                  </Button>
                </div>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
                  编辑
                </Button>
              )}
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-x-8 gap-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">员工编号</label>
                  <Input value={employee.employeeId} disabled />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">姓名</label>
                  {isEditing ? (
                    <Input
                      value={form.name}
                      onChange={(e) => handleFormChange("name", e.target.value)}
                    />
                  ) : (
                    <Input value={employee.name ?? ""} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">性别</label>
                  {isEditing ? (
                    <Select
                      value={form.gender}
                      onChange={(e) => handleFormChange("gender", e.target.value)}
                    >
                      <option value="">请选择</option>
                      <option value="男">男</option>
                      <option value="女">女</option>
                    </Select>
                  ) : (
                    <Input value={employee.gender ?? ""} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">手机号</label>
                  {isEditing ? (
                    <Input
                      value={form.phone}
                      onChange={(e) => handleFormChange("phone", e.target.value)}
                    />
                  ) : (
                    <Input value={employee.phone ?? ""} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">身份证号</label>
                  {isEditing ? (
                    <Input
                      value={form.idCard}
                      onChange={(e) => handleFormChange("idCard", e.target.value)}
                    />
                  ) : (
                    <Input value={maskIdCard(employee.idCard)} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">生日</label>
                  {isEditing ? (
                    <Input
                      type="date"
                      value={form.birthday}
                      onChange={(e) => handleFormChange("birthday", e.target.value)}
                    />
                  ) : (
                    <Input value={employee.birthday ?? ""} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">所属门店</label>
                  {isEditing ? (
                    <Select
                      value={form.storeId}
                      onChange={(e) => handleFormChange("storeId", e.target.value)}
                    >
                      <option value="">请选择门店</option>
                      {stores.map((s) => (
                        <option key={s.storeId} value={s.storeId}>
                          {s.storeName}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input value={employee.storeName ?? ""} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">部门</label>
                  {isEditing ? (
                    <Select
                      value={form.orgNodeId}
                      onChange={(e) => handleFormChange("orgNodeId", e.target.value)}
                    >
                      <option value="">请选择部门</option>
                      {orgNodes
                        .filter((n) => n.isActive)
                        .map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.name} ({n.type})
                          </option>
                        ))}
                    </Select>
                  ) : (
                    <Input value={employee.departmentName ?? ""} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">职位</label>
                  {isEditing ? (
                    <Input
                      value={form.positionName}
                      onChange={(e) => handleFormChange("positionName", e.target.value)}
                    />
                  ) : (
                    <Input value={employee.positionName ?? ""} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">技能标签</label>
                  {isEditing ? (
                    <Input
                      value={form.skills}
                      onChange={(e) => handleFormChange("skills", e.target.value)}
                      placeholder="多个技能用逗号分隔"
                    />
                  ) : (
                    <Input value={employee.skills?.join(", ") ?? ""} disabled />
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="roles">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">权限角色</CardTitle>
              <Button size="sm" onClick={() => setRoleDialogOpen(true)}>分配角色</Button>
            </CardHeader>
            <CardContent>
              <DataTable
                columns={roleColumns}
                data={roles}
                emptyText="暂无权限角色"
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="admin">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">管理后台账号</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between rounded-[var(--radius)] border border-[var(--border)] p-4">
                <div>
                  <div className="font-medium">登录账号</div>
                  <div className="text-sm text-[var(--muted-foreground)]">
                    手机号登录：{employee.phone ?? "未绑定"}
                  </div>
                </div>
                <Badge
                  variant="outline"
                  className={
                    employee.openid
                      ? "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]"
                      : "border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]"
                  }
                >
                  {employee.openid ? "已绑定微信" : "未绑定微信"}
                </Badge>
              </div>

              <Separator />

              <div>
                <h3 className="text-sm font-medium mb-3">密码管理</h3>
                <p className="text-sm text-[var(--muted-foreground)] mb-3">
                  初始密码为手机号后 6 位，首次登录需修改密码
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setResetPwdDialogOpen(true)}
                  disabled={!employee.phone}
                >
                  重置为初始密码
                </Button>
                {!employee.phone && (
                  <p className="mt-2 text-xs text-[var(--destructive)]">该员工未绑定手机号，无法重置</p>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* 分配角色 Dialog */}
      <Dialog open={roleDialogOpen} onOpenChange={setRoleDialogOpen}>
        <DialogClose onOpenChange={setRoleDialogOpen} />
        <DialogHeader>
          <DialogTitle>分配角色</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-4">
          <div>
            <label className="text-sm text-[#999999]">员工</label>
            <Input className="mt-1" value={`${employee.name ?? ""} (${employee.employeeId})`} disabled />
          </div>
          <div>
            <label className="text-sm text-[#999999]">角色</label>
            <Select
              className="mt-1"
              value={assignRoleValue}
              onChange={(e) => setAssignRoleValue(e.target.value as RoleType)}
            >
              {allRoleTypes.map((r) => (
                <option key={r} value={r}>
                  {roleLabels[r]}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="text-sm text-[#999999]">权限范围</label>
            <Select
              className="mt-1"
              value={assignScopeId}
              onChange={(e) => setAssignScopeId(e.target.value)}
            >
              <option value="">选择组织节点</option>
              {orgNodes
                .filter((n) => n.isActive)
                .map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name} ({n.type})
                  </option>
                ))}
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setRoleDialogOpen(false)}>
            取消
          </Button>
          <Button
            loading={assigning}
            disabled={!assignScopeId}
            onClick={handleAssignRole}
          >
            确认分配
          </Button>
        </DialogFooter>
      </Dialog>

      {/* 离职确认 */}
      <AlertDialog open={resignDialogOpen} onOpenChange={setResignDialogOpen}>
        <AlertDialogTitle>确认标记离职？</AlertDialogTitle>
        <AlertDialogDescription>
          将标记「{employee.name}」为已离职，并自动作废其所有有效权限角色。此操作不可撤销。
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setResignDialogOpen(false)}>取消</AlertDialogCancel>
          <AlertDialogAction onClick={async () => {
            try {
              const result = await updateEmployee(employee.employeeId, { isResigned: true }, employee.updatedAt)
              if (!result.success) {
                toast.error(result.message)
                if (result.message.includes('已被其他人修改')) router.refresh()
                return
              }
              toast.success('已标记离职')
              setResignDialogOpen(false)
              router.refresh()
            } catch {
              toast.error('操作失败')
            }
          }}>确认离职</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>

      {/* 重置密码确认 */}
      <AlertDialog open={resetPwdDialogOpen} onOpenChange={setResetPwdDialogOpen}>
        <AlertDialogTitle>确认重置密码？</AlertDialogTitle>
        <AlertDialogDescription>
          将「{employee.name}」的密码重置为手机号后 6 位（{employee.phone?.slice(-6) ?? "—"}），首次登录需修改密码。
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setResetPwdDialogOpen(false)} disabled={resettingPwd}>取消</AlertDialogCancel>
          <AlertDialogAction onClick={handleResetToDefault} disabled={resettingPwd}>
            {resettingPwd ? "重置中..." : "确认重置"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>
    </div>
  )
}
