"use client"

import { useState, useMemo } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useUnsavedChanges } from "@/lib/hooks/use-unsaved-changes"
import { useReturnContext } from "@/components/return-context"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DatePicker, DateTimePicker } from "@/components/ui/date-picker"
import { Textarea } from "@/components/ui/textarea"
import { Select } from "@/components/ui/select"
import { SkillSelect } from "@/components/ui/skill-select"
import { OrgTreeSelect } from "@/components/ui/org-tree-select"
import { ImageUpload, toHttpUrl } from "@/components/ui/image-upload"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { DataTable, type Column } from "@/components/ui/data-table"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter } from "@/components/ui/alert-dialog"
import { Separator } from "@/components/ui/separator"
import { formatDate, buildOrgPath, findAncestorMarketId, findAncestorStoreNodeId } from "@/lib/utils"
import { shanghaiToday } from "@/lib/datetime"
import { formatPhoneSafe } from "@/lib/format"
import { actionErrorMessage, actionErrorType } from "@/lib/action-error"
import { updateEmployee, deleteEmployee } from "@/actions/employees"
import { DangerZoneDelete } from "@/components/delete-action"
import { assignRole, revokeRole } from "@/actions/permissions"
import { resetToDefaultPassword } from "@/actions/auth"
import type { Employee, PermissionRole, Store, OrgNode, RoleType, SkillTag, RoleDefinition } from "@/lib/types"

/** 库内墙钟字符串（"YYYY-MM-DD HH:mm:ss" 或带 T）→ datetime-local 输入值 "YYYY-MM-DDTHH:mm" */
function toDatetimeLocal(v: string | null): string {
  if (!v) return ""
  return v.replace("T", " ").slice(0, 16).replace(" ", "T")
}

interface Props {
  employee: Employee
  roles: PermissionRole[]
  roleDefinitions: RoleDefinition[]
  stores: Store[]
  orgNodes: OrgNode[]
  skillTags: SkillTag[]
  canUpdate?: boolean
  canAssignRole?: boolean
  canRevokeRole?: boolean
  canAssignAdmin?: boolean
  canResetPassword?: boolean
  /** 是否展示「危险操作」删除入口（仅系统管理员 employee:delete） */
  canDelete?: boolean
}

export default function EmployeeDetailPage({
  employee,
  roles,
  roleDefinitions,
  stores,
  orgNodes,
  skillTags,
  canUpdate = false,
  canAssignRole = false,
  canRevokeRole = false,
  canAssignAdmin = false,
  canResetPassword = false,
  canDelete = false,
}: Props) {
  const router = useRouter()
  const { goToReturn } = useReturnContext('/employees')

  // Edit info state
  const [isEditing, setIsEditing] = useState(false)
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
    avatarUrl: employee.avatarUrl ?? "",
    birthday: employee.birthday ?? "",
    hiredAt: employee.hiredAt ?? "",
    leaveStart: toDatetimeLocal(employee.leaveStart),
    leaveEnd: toDatetimeLocal(employee.leaveEnd),
    isOnBusinessTrip: employee.isOnBusinessTrip,
    skills: employee.skills ?? ([] as string[]),
    socialInsurance: employee.socialInsurance,
  })

  // 离职弹窗表单（离职日期 + 离职原因）
  const [resignForm, setResignForm] = useState({
    resignedAt: shanghaiToday(),
    resignationReason: "",
  })

  // Inline role editing state
  const [isEditingRoles, setIsEditingRoles] = useState(false)
  useUnsavedChanges(isEditing || isEditingRoles)
  const [roleEntries, setRoleEntries] = useState<Array<{ role: RoleType; scopeId: string; persisted?: boolean }>>([])
  const [savingRoles, setSavingRoles] = useState(false)

  // Password reset state
  const [resetPwdDialogOpen, setResetPwdDialogOpen] = useState(false)
  const [resettingPwd, setResettingPwd] = useState(false)

  // 根据所属组织的市场过滤门店
  const filteredStores = useMemo(() => {
    const marketId = findAncestorMarketId(form.orgNodeId || null, orgNodes)
    if (!marketId) return stores
    return stores.filter((s) => {
      const storeOrgNode = orgNodes.find((n) => n.id === s.orgNodeId)
      return storeOrgNode?.parentId === marketId
    })
  }, [form.orgNodeId, orgNodes, stores])

  // 技能标签全量名字集合（详情页 skillTags 来自 getSkillTags）。
  // 保存前按此清洗 form.skills：只保留字典内名字，清掉字典外孤儿（已删除/改名残留）。
  const validSkillNames = useMemo(() => new Set(skillTags.map((t) => t.name)), [skillTags])

  function maskIdCard(value: string | null): string {
    if (!value || value.length < 8) return value ?? ""
    return value.slice(0, 4) + "****" + value.slice(-4)
  }

  function handleFormChange(field: string, value: string | string[]) {
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
      avatarUrl: employee.avatarUrl ?? "",
      birthday: employee.birthday ?? "",
      hiredAt: employee.hiredAt ?? "",
      leaveStart: toDatetimeLocal(employee.leaveStart),
      leaveEnd: toDatetimeLocal(employee.leaveEnd),
      isOnBusinessTrip: employee.isOnBusinessTrip,
      skills: employee.skills ?? ([] as string[]),
      socialInsurance: employee.socialInsurance,
    })
    setIsEditing(false)
  }

  async function handleSave() {
    if (!canUpdate) return
    // 姓名 / 身份证必填校验（与新建表单 + Server Action 一致）
    if (!form.name.trim()) {
      toast.error("姓名不能为空")
      return
    }
    if (!form.idCard.trim()) {
      toast.error("请输入身份证号")
      return
    }
    if (!/^\d{17}[\dXx]$/.test(form.idCard.trim())) {
      toast.error("身份证号格式不正确")
      return
    }
    // 请假区间成对 + 顺序校验（前端提前提示，Server Action + DB chk_swu_leave_range 兜底）
    if ((form.leaveStart && !form.leaveEnd) || (!form.leaveStart && form.leaveEnd)) {
      toast.error("请假开始和结束时间需同时填写")
      return
    }
    if (form.leaveStart && form.leaveEnd && form.leaveEnd <= form.leaveStart) {
      toast.error("请假结束时间须晚于开始时间")
      return
    }
    setSaving(true)
    try {
      // 保存前清洗技能标签：只保留当前有效名，丢弃已删除/已改名的残留旧名
      const sanitizedSkills = form.skills.filter((s) => validSkillNames.has(s))
      const result = await updateEmployee(employee.employeeId, {
        name: form.name || null,
        gender: form.gender || null,
        phone: form.phone || null,
        idCard: form.idCard || null,
        storeId: form.storeId || null,
        orgNodeId: form.orgNodeId || null,
        positionName: form.positionName.trim() || null,
        avatarUrl: form.avatarUrl || null,
        birthday: form.birthday || null,
        hiredAt: form.hiredAt || null,
        leaveStart: form.leaveStart || null,
        leaveEnd: form.leaveEnd || null,
        isOnBusinessTrip: form.isOnBusinessTrip,
        skills: sanitizedSkills.length > 0 ? sanitizedSkills : null,
        socialInsurance: form.socialInsurance,
      }, employee.updatedAt)
      if (!result.success) {
        toast.error(result.message)
        if (result.message.includes('已被其他人修改')) router.refresh()
        return
      }
      toast.success("保存成功")
      setIsEditing(false)
      router.refresh()
    } catch (err) {
      toast.error(actionErrorMessage(err, "保存失败，请稍后重试"))
    } finally {
      setSaving(false)
    }
  }

  async function handleSaveRoles() {
    if (!canAssignRole && !canRevokeRole) return
    setSavingRoles(true)
    try {
      const key = (role: string, scopeId: string) => `${role}:${scopeId}`
      const originalKeys = new Set(roles.map(r => key(r.role, r.scopeId)))
      const editedKeys = new Set(roleEntries.filter(e => e.scopeId).map(e => key(e.role, e.scopeId)))

      const toRevoke = canRevokeRole ? roles.filter(r => !editedKeys.has(key(r.role, r.scopeId))) : []
      const toAdd = canAssignRole
        ? roleEntries.filter(e => !e.persisted && e.scopeId && !originalKeys.has(key(e.role, e.scopeId)))
        : []

      const errors: string[] = []
      for (const r of toRevoke) {
        const res = await revokeRole(r.id)
        if (!res.success) errors.push(res.message)
      }
      for (const e of toAdd) {
        const res = await assignRole({ employeeId: employee.employeeId, role: e.role, scopeId: e.scopeId })
        if (!res.success) errors.push(res.message)
      }

      if (errors.length > 0) {
        toast.error(errors.join('；'))
      } else if (toRevoke.length === 0 && toAdd.length === 0) {
        toast.info('未检测到变更')
      } else {
        toast.success('权限角色已更新')
      }
      setIsEditingRoles(false)
      router.refresh()
    } catch (err) {
      toast.error(actionErrorMessage(err, '保存失败，请稍后重试'))
    } finally {
      setSavingRoles(false)
    }
  }

  async function handleResetToDefault() {
    if (!canResetPassword) return
    setResettingPwd(true)
    try {
      const res = await resetToDefaultPassword(employee.employeeId)
      if (res.success) {
        toast.success(res.message)
        setResetPwdDialogOpen(false)
      } else {
        toast.error(res.message)
      }
    } catch (err) {
      // withPermission HOF 在权限不足时 throw PERMISSION_DENIED:<action>，把它友好化为中文消息。
      // 判类型必须走 actionErrorType：生产构建下 err.message 已被脱敏，判 message 前缀恒不成立（issue #133）。
      if (actionErrorType(err) === 'PERMISSION_DENIED') {
        toast.error('仅系统管理员可重置密码')
      } else {
        toast.error(actionErrorMessage(err, '密码重置失败，请稍后重试'))
      }
    } finally {
      setResettingPwd(false)
    }
  }

  const roleColumns: Column<PermissionRole>[] = [
    {
      key: "role",
      header: "角色",
      cell: (row) => <span className="font-medium">{row.roleName ?? row.role}</span>,
    },
    {
      key: "scopeName",
      header: "作用域",
      cell: (row) => <span>{buildOrgPath(row.scopeId, orgNodes) || "—"}</span>,
    },
    {
      key: "createdAt",
      header: "分配时间",
      cell: (row) => <span>{formatDate(row.createdAt) || "—"}</span>,
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => goToReturn()}>
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
        {canUpdate && !employee.isResigned && (
          <Button variant="ghost" size="sm" className="text-[#D94040] ml-auto" onClick={() => {
            setResignForm({ resignedAt: shanghaiToday(), resignationReason: "" })
            setResignDialogOpen(true)
          }}>
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
              ) : canUpdate ? (
                <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
                  编辑
                </Button>
              ) : null}
            </CardHeader>
            <CardContent>
              <div className="mb-6 flex items-start gap-4">
                <label className="text-sm font-medium pt-2 w-16 flex-shrink-0">头像</label>
                {isEditing ? (
                  <ImageUpload
                    value={form.avatarUrl}
                    onChange={(v) => handleFormChange("avatarUrl", v as string)}
                    path={`avatars/staff/${employee.employeeId}`}
                  />
                ) : employee.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={toHttpUrl(employee.avatarUrl)}
                    alt={employee.name ?? ""}
                    className="h-24 w-24 rounded-[var(--radius)] border border-[var(--input)] object-cover"
                  />
                ) : (
                  <div className="flex h-24 w-24 items-center justify-center rounded-[var(--radius)] border border-[var(--input)] bg-[var(--muted)] text-2xl text-[var(--muted-foreground)]">
                    {(employee.name ?? employee.employeeId).slice(0, 1)}
                  </div>
                )}
              </div>
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
                  <label className="text-sm font-medium">是否缴纳社保</label>
                  {isEditing ? (
                    <Select
                      value={form.socialInsurance ? "true" : "false"}
                      onChange={(e) => setForm((prev) => ({ ...prev, socialInsurance: e.target.value === "true" }))}
                    >
                      <option value="false">否</option>
                      <option value="true">是</option>
                    </Select>
                  ) : (
                    <Input value={employee.socialInsurance ? "是" : "否"} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">生日</label>
                  {isEditing ? (
                    <DatePicker
                      value={form.birthday}
                      onValueChange={(value) => handleFormChange("birthday", value)}
                    />
                  ) : (
                    <Input value={employee.birthday ?? ""} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">入职日期</label>
                  {isEditing ? (
                    <DatePicker
                      value={form.hiredAt}
                      onValueChange={(value) => handleFormChange("hiredAt", value)}
                    />
                  ) : (
                    <Input value={employee.hiredAt ?? ""} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">请假开始</label>
                  {isEditing ? (
                    <DateTimePicker
                      value={form.leaveStart}
                      onValueChange={(value) => handleFormChange("leaveStart", value)}
                    />
                  ) : (
                    <Input value={employee.leaveStart ? employee.leaveStart.slice(0, 16) : "—"} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">请假结束</label>
                  {isEditing ? (
                    <DateTimePicker
                      value={form.leaveEnd}
                      onValueChange={(value) => handleFormChange("leaveEnd", value)}
                    />
                  ) : (
                    <Input value={employee.leaveEnd ? employee.leaveEnd.slice(0, 16) : "—"} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">出差支援（仅营业额/服务提成分配可选）</label>
                  {isEditing ? (
                    <Select
                      value={form.isOnBusinessTrip ? "true" : "false"}
                      onChange={(e) => setForm((prev) => ({ ...prev, isOnBusinessTrip: e.target.value === "true" }))}
                    >
                      <option value="false">否</option>
                      <option value="true">是</option>
                    </Select>
                  ) : (
                    <Input value={employee.isOnBusinessTrip ? "是" : "否"} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">离职日期</label>
                  <Input value={employee.resignedAt ?? "—"} disabled />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">离职原因</label>
                  <Input value={employee.resignationReason ?? "—"} disabled />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">所属组织</label>
                  {isEditing ? (
                    <OrgTreeSelect
                      orgNodes={orgNodes}
                      value={form.orgNodeId}
                      onChange={(id) => {
                        handleFormChange("orgNodeId", id)
                        // 组织变更时，若当前门店不在新市场下则清空
                        const newMarketId = findAncestorMarketId(id, orgNodes)
                        const storeMarketId = findAncestorMarketId(
                          stores.find((s) => s.storeId === form.storeId)?.orgNodeId ?? null,
                          orgNodes,
                        )
                        if (newMarketId !== storeMarketId) {
                          handleFormChange("storeId", "")
                        }
                      }}
                      placeholder="请选择所属组织"
                    />
                  ) : (
                    <Input value={buildOrgPath(employee.orgNodeId, orgNodes)} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">所属门店</label>
                  {isEditing ? (
                    <Select
                      value={form.storeId}
                      onChange={(e) => {
                        const nextStoreId = e.target.value
                        handleFormChange("storeId", nextStoreId)
                        /**
                         * #259：所属组织若归属于**旧**门店，跟着改成新门店的节点。
                         * 不联动的话「同市场内改门店、不动所属组织」会提交
                         * {新门店, 旧门店的节点} —— 被服务端归属自洽校验拒绝，
                         * 而这正是生产上两条脏数据的成因。
                         * 挂市场下的部门（养生部/财智部那类矩阵归属）没有门店祖先，不受影响。
                         */
                        const currentStoreAncestor = findAncestorStoreNodeId(form.orgNodeId || null, orgNodes)
                        if (currentStoreAncestor) {
                          const nextNode = stores.find((s) => s.storeId === nextStoreId)?.orgNodeId ?? ""
                          if (nextNode !== currentStoreAncestor) handleFormChange("orgNodeId", nextNode)
                        }
                      }}
                    >
                      <option value="">请选择门店</option>
                      {filteredStores.map((s) => (
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
                  <label className="text-sm font-medium">职位</label>
                  {isEditing ? (
                    <Input
                      value={form.positionName}
                      onChange={(e) => handleFormChange("positionName", e.target.value)}
                      placeholder="请输入职位"
                    />
                  ) : (
                    <Input value={employee.positionName ?? ""} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">技能标签</label>
                  <SkillSelect
                    options={skillTags.map((t) => t.name)}
                    value={isEditing ? form.skills : (employee.skills ?? [])}
                    onChange={(skills) => handleFormChange("skills", skills)}
                    disabled={!isEditing}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="roles">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">权限角色</CardTitle>
              {isEditingRoles ? (
                <div className="flex gap-2">
                  <Button size="sm" loading={savingRoles} onClick={handleSaveRoles}>
                    保存
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setIsEditingRoles(false)} disabled={savingRoles}>
                    取消
                  </Button>
                </div>
              ) : (canAssignRole || canRevokeRole) ? (
                <Button variant="outline" size="sm" onClick={() => {
                  setRoleEntries(roles.map(r => ({ role: r.role as RoleType, scopeId: r.scopeId, persisted: true })))
                  setIsEditingRoles(true)
                }}>
                  编辑
                </Button>
              ) : null}
            </CardHeader>
            <CardContent>
              {isEditingRoles ? (
                <div className="space-y-3">
                  {roleEntries.map((entry, index) => (
                    <div key={index} className="flex items-center gap-3">
                      <Select
                        className="flex-1"
                        value={entry.role}
                        disabled={entry.persisted && !(canAssignRole && canRevokeRole)}
                        onChange={(e) => {
                          const updated = [...roleEntries]
                          updated[index] = { ...entry, role: e.target.value as RoleType }
                          setRoleEntries(updated)
                        }}
                      >
                        {roleDefinitions.filter((role) => !role.isSuperAdmin || canAssignAdmin || entry.role === role.roleKey).map((role) => (
                          <option key={role.roleKey} value={role.roleKey}>{role.name}</option>
                        ))}
                      </Select>
                      <OrgTreeSelect
                        className="flex-1"
                        orgNodes={orgNodes}
                        excludeTypes={['部门']}
                        value={entry.scopeId}
                        disabled={entry.persisted && !(canAssignRole && canRevokeRole)}
                        onChange={(id) => {
                          const updated = [...roleEntries]
                          updated[index] = { ...entry, scopeId: id }
                          setRoleEntries(updated)
                        }}
                        placeholder="选择组织节点"
                      />
                      {(!entry.persisted && canAssignRole || entry.persisted && canRevokeRole) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-[var(--destructive)] shrink-0"
                          onClick={() => setRoleEntries(prev => prev.filter((_, i) => i !== index))}
                        >
                          删除
                        </Button>
                      )}
                    </div>
                  ))}
                  {canAssignRole && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setRoleEntries(prev => [...prev, { role: roleDefinitions.find((role) => !role.isSuperAdmin)?.roleKey ?? roleDefinitions[0]?.roleKey ?? '', scopeId: '' }])}
                    >
                      + 添加角色
                    </Button>
                  )}
                </div>
              ) : (
                <DataTable
                  columns={roleColumns}
                  data={roles}
                  emptyText="暂无权限角色"
                />
              )}
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
                    手机号登录：{employee.phone ? formatPhoneSafe(employee.phone) : "未绑定"}
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
                {canResetPassword && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setResetPwdDialogOpen(true)}
                    disabled={!employee.phone}
                  >
                    重置为初始密码
                  </Button>
                )}
                {!employee.phone && (
                  <p className="mt-2 text-xs text-[var(--destructive)]">该员工未绑定手机号，无法重置</p>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* 离职确认 — 填报离职日期 + 离职原因 */}
      {canUpdate && <AlertDialog open={resignDialogOpen} onOpenChange={setResignDialogOpen}>
        <AlertDialogTitle>标记离职</AlertDialogTitle>
        <AlertDialogDescription>
          将标记「{employee.name}」为已离职，并自动作废其所有有效权限角色。此操作不可撤销。
        </AlertDialogDescription>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <label className="text-sm font-medium">
              离职日期 <span className="text-[#D94040]">*</span>
            </label>
            <DatePicker
              value={resignForm.resignedAt}
              onValueChange={(value) => setResignForm((prev) => ({ ...prev, resignedAt: value }))}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">
              离职原因 <span className="text-[#D94040]">*</span>
            </label>
            <Textarea
              rows={3}
              value={resignForm.resignationReason}
              onChange={(e) => setResignForm((prev) => ({ ...prev, resignationReason: e.target.value }))}
              placeholder="请填写离职原因"
            />
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setResignDialogOpen(false)} disabled={saving}>取消</AlertDialogCancel>
          <AlertDialogAction onClick={async () => {
            if (!resignForm.resignedAt) {
              toast.error('请选择离职日期')
              return
            }
            if (!resignForm.resignationReason.trim()) {
              toast.error('请填写离职原因')
              return
            }
            setSaving(true)
            try {
              const result = await updateEmployee(employee.employeeId, {
                isResigned: true,
                resignedAt: resignForm.resignedAt,
                resignationReason: resignForm.resignationReason.trim(),
              }, employee.updatedAt)
              if (!result.success) {
                toast.error(result.message)
                if (result.message.includes('已被其他人修改')) router.refresh()
                return
              }
              toast.success('已标记离职')
              setResignDialogOpen(false)
              router.refresh()
            } catch (err) {
              toast.error(actionErrorMessage(err, '操作失败'))
            } finally {
              setSaving(false)
            }
          }} disabled={saving}>确认离职</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>}

      {/* 重置密码确认 */}
      {canResetPassword && <AlertDialog open={resetPwdDialogOpen} onOpenChange={setResetPwdDialogOpen}>
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
      </AlertDialog>}

      {/* 危险操作：物理删除员工（仅系统管理员，仅无业务关联的测试号可删） */}
      {canDelete && (
        <DangerZoneDelete
          entityLabel="员工"
          redirectTo="/employees"
          onConfirm={() => deleteEmployee(employee.employeeId)}
          description={
            <>
              确定要删除员工 <span className="font-medium">{employee.name || employee.employeeId}</span> 吗？
              将一并移除其登录密码与权限角色，此操作不可恢复。有订单 / 服务 / 分配 / 预约 / 库存等业务关联的员工不可删除（建议改为离职）。
            </>
          }
        />
      )}
    </div>
  )
}
