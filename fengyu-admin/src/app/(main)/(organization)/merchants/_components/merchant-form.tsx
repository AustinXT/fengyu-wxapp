"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useUnsavedChanges } from "@/lib/hooks/use-unsaved-changes"
import {
  createMerchant,
  updateMerchant,
  type MerchantDetail,
  type MerchantMarketOption,
} from "@/actions/merchants"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectOption } from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

/**
 * 商户新建 / 编辑共用表单。
 * - 不传 merchant → 新建模式（createMerchant）
 * - 传 merchant → 编辑模式（updateMerchant，携带 updatedAt 乐观锁）
 */
export default function MerchantForm({
  merchant,
  markets,
}: {
  merchant?: MerchantDetail
  markets: MerchantMarketOption[]
}) {
  const router = useRouter()
  const isEdit = !!merchant
  const [saving, setSaving] = useState(false)
  const [formDirty, setFormDirty] = useState(false)
  useUnsavedChanges(formDirty)

  const [merchantName, setMerchantName] = useState(merchant?.merchantName ?? "")
  const [merchantNo, setMerchantNo] = useState(merchant?.merchantNo ?? "")
  const [termNo, setTermNo] = useState(merchant?.termNo ?? "")
  const [enabled, setEnabled] = useState(merchant?.enabled ?? false)
  const [marketOrgNodeId, setMarketOrgNodeId] = useState(merchant?.marketOrgNodeId ?? "")

  const markDirty = () => setFormDirty(true)

  const handleSubmit = async () => {
    // 前端校验（后端 validateMerchantInput 亦校验）
    if (!merchantName.trim()) {
      toast.error("商户名称必填")
      return
    }
    if (enabled && !merchantNo.trim()) {
      toast.error("启用真实支付通道时，拉卡拉商户号必填")
      return
    }
    if (enabled && !termNo.trim()) {
      toast.error("启用真实支付通道时，终端号必填")
      return
    }

    setSaving(true)
    try {
      const payload = {
        merchantName: merchantName.trim(),
        merchantNo: merchantNo.trim() || null,
        termNo: termNo.trim() || null,
        enabled,
        marketOrgNodeId: marketOrgNodeId || null,
      }
      const result = isEdit
        ? await updateMerchant(merchant!.id, payload, merchant!.updatedAt)
        : await createMerchant(payload)
      if (!result.success) {
        toast.error(result.message)
        if (result.message.includes("已被其他人修改")) router.refresh()
        return
      }
      setFormDirty(false)
      toast.success(result.message)
      router.push(isEdit ? `/merchants/${merchant!.id}` : "/merchants")
      router.refresh()
    } catch {
      toast.error(isEdit ? "保存失败" : "创建失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={() => router.back()}>
          &larr; 返回
        </Button>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">
          {isEdit ? `编辑商户 - ${merchant!.merchantName}` : "新建商户"}
        </h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">拉卡拉收款商户</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-3 text-xs text-muted-foreground">
            商户名称用于区分各店商户；商户号 / 终端号为拉卡拉线下开通后分配。未启用的商户不能受理拉卡拉支付，
            请完成入网并核对配置后再人工启用。
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">
                商户名称 <span className="text-[#D94040]">*</span>
              </label>
              <Input
                value={merchantName}
                onChange={(e) => {
                  setMerchantName(e.target.value)
                  markDirty()
                }}
                placeholder="便于区分各店商户，如：凤仪韵·南昌莲塘店"
                maxLength={80}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">所属市场</label>
              <Select
                value={marketOrgNodeId}
                onChange={(e) => {
                  setMarketOrgNodeId(e.target.value)
                  markDirty()
                }}
              >
                <SelectOption value="">未分配</SelectOption>
                {markets.map((m) => (
                  <SelectOption key={m.id} value={m.id}>
                    {m.name}
                  </SelectOption>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">拉卡拉商户号</label>
              <Input
                value={merchantNo}
                onChange={(e) => {
                  setMerchantNo(e.target.value)
                  markDirty()
                }}
                placeholder="拉卡拉分配的商户号"
                maxLength={32}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">终端号</label>
              <Input
                value={termNo}
                onChange={(e) => {
                  setTermNo(e.target.value)
                  markDirty()
                }}
                placeholder="如：D9261078"
                maxLength={32}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">启用真实支付通道</label>
              <div className="flex items-center gap-2 pt-2">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => {
                    setEnabled(e.target.checked)
                    markDirty()
                  }}
                  className="h-4 w-4"
                />
                <span className="text-sm">
                  {enabled ? "已启用（可受理拉卡拉支付）" : "未启用（不受理拉卡拉支付）"}
                </span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-3">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          取消
        </Button>
        <Button type="button" onClick={handleSubmit} disabled={saving}>
          {saving ? (isEdit ? "保存中..." : "创建中...") : isEdit ? "保存" : "创建"}
        </Button>
      </div>
    </div>
  )
}
