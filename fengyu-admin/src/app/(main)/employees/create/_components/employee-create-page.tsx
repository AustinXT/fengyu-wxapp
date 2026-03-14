"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { createEmployee } from "@/actions/employees"
import type { Store, OrgNode } from "@/lib/types"

function generateEmployeeId(): string {
  const now = new Date()
  const yy = String(now.getFullYear()).slice(2)
  const mm = String(now.getMonth() + 1).padStart(2, "0")
  const dd = String(now.getDate()).padStart(2, "0")
  const seq = String(Math.floor(Math.random() * 10000)).padStart(4, "0")
  return `FY-${yy}${mm}${dd}-${seq}`
}

interface Props {
  stores: Store[]
  orgNodes: OrgNode[]
}

export default function EmployeeCreatePage({ stores, orgNodes }: Props) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    name: "",
    gender: "",
    phone: "",
    idCard: "",
    storeId: "",
    orgNodeId: "",
    positionName: "",
    birthday: "",
    skills: "",
  })

  function handleChange(field: string, value: string) {
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

    setSaving(true)
    try {
      const employeeId = generateEmployeeId()
      const skillsArr = form.skills
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean)

      await createEmployee({
        employeeId,
        name: form.name.trim() || null,
        gender: form.gender || null,
        phone: form.phone.trim() || null,
        idCard: form.idCard.trim() || null,
        storeId: form.storeId || null,
        orgNodeId: form.orgNodeId || null,
        positionName: form.positionName.trim() || null,
        birthday: form.birthday || null,
        skills: skillsArr.length > 0 ? skillsArr : null,
        isResigned: false,
      })

      toast.success("员工创建成功")
      router.push("/employees")
      router.refresh()
    } catch {
      toast.error("创建失败，请稍后重试")
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
              <label className="text-sm font-medium">身份证号</label>
              <Input
                value={form.idCard}
                onChange={(e) => handleChange("idCard", e.target.value)}
                placeholder="请输入身份证号"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">所属门店</label>
              <Select
                value={form.storeId}
                onChange={(e) => handleChange("storeId", e.target.value)}
              >
                <option value="">请选择门店</option>
                {stores.map((s) => (
                  <option key={s.storeId} value={s.storeId}>
                    {s.storeName}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">部门</label>
              <Select
                value={form.orgNodeId}
                onChange={(e) => handleChange("orgNodeId", e.target.value)}
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
              <Input
                type="date"
                value={form.birthday}
                onChange={(e) => handleChange("birthday", e.target.value)}
              />
            </div>
            <div className="space-y-2 col-span-2">
              <label className="text-sm font-medium">技能标签</label>
              <Input
                value={form.skills}
                onChange={(e) => handleChange("skills", e.target.value)}
                placeholder="多个技能用逗号分隔"
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
