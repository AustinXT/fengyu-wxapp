"use client"

import { useState, useMemo } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useUnsavedChanges } from "@/lib/hooks/use-unsaved-changes"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DatePicker } from "@/components/ui/date-picker"
import { Select } from "@/components/ui/select"
import { SkillSelect } from "@/components/ui/skill-select"
import { OrgTreeSelect } from "@/components/ui/org-tree-select"
import { ImageUpload } from "@/components/ui/image-upload"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { createEmployee } from "@/actions/employees"
import { actionErrorMessage } from "@/lib/action-error"
import { findAncestorMarketId } from "@/lib/utils"
import { shanghaiToday } from "@/lib/datetime"
import type { Store, OrgNode, SkillTag } from "@/lib/types"


interface Props {
  stores: Store[]
  orgNodes: OrgNode[]
  skillTags: SkillTag[]
}

export default function EmployeeCreatePage({ stores, orgNodes, skillTags }: Props) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [formDirty, setFormDirty] = useState(false)
  useUnsavedChanges(formDirty)
  const [form, setForm] = useState({
    name: "",
    gender: "",
    phone: "",
    idCard: "",
    storeId: "",
    orgNodeId: "",
    positionName: "",
    avatarUrl: "",
    birthday: "",
    // 默认今天作为入职日，可在表单内调整；DB 兜底为 created_at::date
    hiredAt: shanghaiToday(),
    skills: [] as string[],
    // 是否缴纳社保（默认否）
    socialInsurance: false,
  })

  // 根据所属组织的市场过滤门店
  const filteredStores = useMemo(() => {
    const marketId = findAncestorMarketId(form.orgNodeId || null, orgNodes)
    if (!marketId) return stores
    return stores.filter((s) => {
      const storeOrgNode = orgNodes.find((n) => n.id === s.orgNodeId)
      return storeOrgNode?.parentId === marketId
    })
  }, [form.orgNodeId, orgNodes, stores])

  function handleChange(field: string, value: string | string[]) {
    setFormDirty(true)
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  async function handleSubmit() {
    if (!form.name.trim()) {
      toast.error("请输入姓名")
      return
    }
    if (!form.phone.trim()) {
      toast.error("请输入手机号")
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

    setSaving(true)
    try {
      const result = await createEmployee({
        name: form.name.trim(),
        phone: form.phone.trim(),
        gender: form.gender || null,
        idCard: form.idCard.trim() || null,
        storeId: form.storeId || null,
        orgNodeId: form.orgNodeId || null,
        positionName: form.positionName.trim() || null,
        avatarUrl: form.avatarUrl || null,
        birthday: form.birthday || null,
        hiredAt: form.hiredAt || null,
        skills: form.skills.length > 0 ? form.skills : null,
        socialInsurance: form.socialInsurance,
      })

      if (!result.success) {
        toast.error(result.message)
        return
      }
      setFormDirty(false)
      toast.success(result.message)
      router.push("/employees")
      router.refresh()
    } catch (err) {
      toast.error(actionErrorMessage(err, "创建失败，请稍后重试"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => router.back()}>
          &larr; 返回
        </Button>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">新增员工</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">基本信息</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-6 flex items-start gap-4">
            <label className="text-sm font-medium pt-2 w-16 flex-shrink-0">头像</label>
            <ImageUpload
              value={form.avatarUrl}
              onChange={(v) => handleChange("avatarUrl", v as string)}
              path="avatars/staff/_new"
            />
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-4 max-w-3xl">
            <div className="space-y-2">
              <label className="text-sm font-medium">
                姓名 <span className="text-[#D94040]">*</span>
              </label>
              <Input
                value={form.name}
                onChange={(e) => handleChange("name", e.target.value)}
                placeholder="请输入姓名"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">性别</label>
              <Select
                value={form.gender}
                onChange={(e) => handleChange("gender", e.target.value)}
              >
                <option value="">请选择</option>
                <option value="男">男</option>
                <option value="女">女</option>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">
                手机号 <span className="text-[#D94040]">*</span>
              </label>
              <Input
                value={form.phone}
                onChange={(e) => handleChange("phone", e.target.value)}
                placeholder="请输入手机号"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">
                身份证号 <span className="text-[#D94040]">*</span>
              </label>
              <Input
                value={form.idCard}
                onChange={(e) => handleChange("idCard", e.target.value)}
                placeholder="请输入身份证号"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">是否缴纳社保</label>
              <Select
                value={form.socialInsurance ? "true" : "false"}
                onChange={(e) => {
                  setFormDirty(true)
                  setForm((prev) => ({ ...prev, socialInsurance: e.target.value === "true" }))
                }}
              >
                <option value="false">否</option>
                <option value="true">是</option>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">所属组织</label>
              <OrgTreeSelect
                orgNodes={orgNodes}
                value={form.orgNodeId}
                onChange={(id) => {
                  handleChange("orgNodeId", id)
                  const newMarketId = findAncestorMarketId(id, orgNodes)
                  const storeMarketId = findAncestorMarketId(
                    stores.find((s) => s.storeId === form.storeId)?.orgNodeId ?? null,
                    orgNodes,
                  )
                  if (newMarketId !== storeMarketId) {
                    handleChange("storeId", "")
                  }
                }}
                placeholder="请选择所属组织"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">所属门店</label>
              <Select
                value={form.storeId}
                onChange={(e) => handleChange("storeId", e.target.value)}
              >
                <option value="">请选择门店</option>
                {filteredStores.map((s) => (
                  <option key={s.storeId} value={s.storeId}>
                    {s.storeName}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">职位</label>
              <Input
                value={form.positionName}
                onChange={(e) => handleChange("positionName", e.target.value)}
                placeholder="请输入职位"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">生日</label>
              <DatePicker
                value={form.birthday}
                onValueChange={(value) => handleChange("birthday", value)}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">入职日期</label>
              <DatePicker
                value={form.hiredAt}
                onValueChange={(value) => handleChange("hiredAt", value)}
              />
            </div>
            <div className="space-y-2 col-span-2">
              <label className="text-sm font-medium">技能标签</label>
              <SkillSelect
                options={skillTags.map((t) => t.name)}
                value={form.skills}
                onChange={(skills) => handleChange("skills", skills)}
              />
            </div>
          </div>

          <div className="flex gap-3 mt-6">
            <Button loading={saving} onClick={handleSubmit}>
              创建员工
            </Button>
            <Button variant="outline" onClick={() => router.back()} disabled={saving}>
              取消
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
