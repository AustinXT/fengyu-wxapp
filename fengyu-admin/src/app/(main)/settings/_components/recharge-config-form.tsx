"use client"

import { useState } from "react"
import { toast } from "sonner"
import { useUnsavedChanges } from "@/lib/hooks/use-unsaved-changes"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { saveRechargeCardConfig, type RechargeCardConfigInput } from "@/actions/settings"

interface TierRow {
  faceValue: string
  payAmount: string
}

interface RechargeConfigFormProps {
  initialConfig: RechargeCardConfigInput
}

export default function RechargeConfigForm({ initialConfig }: RechargeConfigFormProps) {
  const [tiers, setTiers] = useState<TierRow[]>(
    initialConfig.tiers.map((t) => ({ faceValue: String(t.faceValue), payAmount: String(t.payAmount) })),
  )
  const [minAmount, setMinAmount] = useState(String(initialConfig.minAmount))
  const [maxAmount, setMaxAmount] = useState(String(initialConfig.maxAmount))
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  useUnsavedChanges(dirty)

  const markDirty = () => setDirty(true)

  const updateTier = (idx: number, field: keyof TierRow, value: string) => {
    setTiers((prev) => prev.map((t, i) => (i === idx ? { ...t, [field]: value } : t)))
    markDirty()
  }

  const addTier = () => {
    setTiers((prev) => [...prev, { faceValue: "", payAmount: "" }])
    markDirty()
  }

  const removeTier = (idx: number) => {
    setTiers((prev) => prev.filter((_, i) => i !== idx))
    markDirty()
  }

  const handleSave = async () => {
    // 解析 + 前端预校验
    const parsedTiers = tiers.map((t) => ({ faceValue: Number(t.faceValue), payAmount: Number(t.payAmount) }))
    for (const t of parsedTiers) {
      if (!Number.isFinite(t.faceValue) || t.faceValue <= 0) { toast.error("档位面额必须为大于 0 的数字"); return }
      if (!Number.isFinite(t.payAmount) || t.payAmount < 0) { toast.error("档位实付金额不能为负"); return }
      if (t.payAmount > t.faceValue) { toast.error(`面额 ¥${t.faceValue} 的实付金额不能高于面额`); return }
    }
    if (parsedTiers.length === 0) { toast.error("至少配置一个充值档位"); return }
    const min = Number(minAmount)
    const max = Number(maxAmount)
    if (!Number.isFinite(min) || min <= 0) { toast.error("最低充值金额必须 > 0"); return }
    if (!Number.isFinite(max) || max < min) { toast.error("单次上限不能低于最低充值金额"); return }

    setSaving(true)
    try {
      const res = await saveRechargeCardConfig({ tiers: parsedTiers, minAmount: min, maxAmount: max })
      if (res.success) {
        setDirty(false)
        toast.success(res.message)
      } else {
        toast.error(res.message)
      }
    } catch {
      toast.error("保存失败，请稍后重试")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-[#999999]">
          配置充值档位（面额 + 实付金额）与最低 / 单次上限金额；员工端、客户端、管理后台共用此配置。
        </p>
        <Button onClick={handleSave} loading={saving}>保存</Button>
      </div>

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>充值档位</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-12 gap-2 text-xs text-[#999999] px-1">
            <span className="col-span-3">面额（元）</span>
            <span className="col-span-3">实付金额（元）</span>
            <span className="col-span-3">折扣 / 赠送</span>
            <span className="col-span-3 text-right">操作</span>
          </div>
          {tiers.length === 0 && (
            <p className="text-sm text-[#999999] py-2">暂无档位，点击下方「添加档位」新增。</p>
          )}
          {tiers.map((t, idx) => {
            const face = Number(t.faceValue)
            const pay = Number(t.payAmount)
            const valid = Number.isFinite(face) && face > 0 && Number.isFinite(pay) && pay >= 0
            const discount = valid && face > 0 ? Math.round((pay / face) * 100) / 100 : null
            const bonus = valid ? Math.round((face - pay) * 100) / 100 : null
            return (
              <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                <div className="col-span-3">
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={t.faceValue}
                    onChange={(e) => updateTier(idx, "faceValue", e.target.value)}
                    placeholder="如 1000"
                  />
                </div>
                <div className="col-span-3">
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={t.payAmount}
                    onChange={(e) => updateTier(idx, "payAmount", e.target.value)}
                    placeholder="如 900"
                  />
                </div>
                <div className="col-span-3 text-sm">
                  {discount != null ? (
                    <>
                      <span className="text-[var(--primary)]">{(discount * 10).toFixed(1).replace(/\.0$/, "")} 折</span>
                      {bonus != null && bonus > 0 && (
                        <span className="text-[#3D8A5A] ml-2">送 ¥{bonus}</span>
                      )}
                    </>
                  ) : (
                    <span className="text-[#cccccc]">—</span>
                  )}
                </div>
                <div className="col-span-3 text-right">
                  <button
                    type="button"
                    className="text-xs text-[#D94040] hover:underline"
                    onClick={() => removeTier(idx)}
                  >
                    删除
                  </button>
                </div>
              </div>
            )
          })}
          <Button variant="outline" size="sm" onClick={addTier}>+ 添加档位</Button>
        </CardContent>
      </Card>

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>金额边界</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <label className="text-sm font-medium text-[var(--foreground)]">最低充值金额（元）</label>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={minAmount}
              onChange={(e) => { setMinAmount(e.target.value); markDirty() }}
              placeholder="100"
            />
            <p className="text-xs text-[#999999]">自定义充值金额不得低于此值</p>
          </div>

          <Separator />

          <div className="space-y-2">
            <label className="text-sm font-medium text-[var(--foreground)]">单次充值上限（元）</label>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={maxAmount}
              onChange={(e) => { setMaxAmount(e.target.value); markDirty() }}
              placeholder="50000"
            />
            <p className="text-xs text-[#999999]">单笔充值金额不得超过此值</p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
