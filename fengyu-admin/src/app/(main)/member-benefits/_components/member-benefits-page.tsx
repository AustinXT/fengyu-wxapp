"use client"

import { useState } from "react"
import { toast } from "sonner"
import { useUnsavedChanges } from "@/lib/hooks/use-unsaved-changes"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  saveMemberBenefits,
  type MemberBenefitsBundle,
  type MemberLevelBenefitsMap,
} from "@/actions/settings"
import { MemberLevelBenefitsForm, type MemberLevel } from "./member-level-benefits-form"

interface MemberBenefitsPageProps {
  initialBundle: MemberBenefitsBundle
  couponTemplates: Array<{ templateId: string; name: string }>
}

export default function MemberBenefitsPageClient({
  initialBundle,
  couponTemplates,
}: MemberBenefitsPageProps) {
  const [bundle, setBundle] = useState<MemberBenefitsBundle>(initialBundle)
  const [saving, setSaving] = useState(false)
  const [formDirty, setFormDirty] = useState(false)
  useUnsavedChanges(formDirty)

  const updateScenario = (scenario: keyof MemberBenefitsBundle) =>
    (next: MemberLevelBenefitsMap) => {
      setBundle((prev) => ({ ...prev, [scenario]: next }))
      setFormDirty(true)
    }

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await saveMemberBenefits(bundle)
      if (res.success) {
        setFormDirty(false)
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
        <h1 className="text-2xl font-bold text-[var(--foreground)]">会员权益</h1>
        <Button onClick={handleSave} loading={saving}>保存</Button>
      </div>

      <Tabs defaultValue="upgrade" className="w-full">
        <TabsList>
          <TabsTrigger value="upgrade">升级权益</TabsTrigger>
          <TabsTrigger value="birthday">生日权益</TabsTrigger>
          <TabsTrigger value="thanksgiving">感恩日</TabsTrigger>
        </TabsList>

        <TabsContent value="upgrade" className="space-y-6">
          <Card className="max-w-3xl">
            <CardHeader>
              <CardTitle>升级权益规则</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-[#999999]">
              <p>会员等级根据顾客滚动 12 个月累计消费额自动跳档（每日凌晨 3:00 由 cronTask 重算）。</p>
              <p>当顾客等级<strong className="text-[var(--foreground)]">升级</strong>时，系统会自动发放对应等级的<strong className="text-[var(--foreground)]">消息 + 积分 + 优惠券</strong>三件套权益。降级仅记录日志，不发权益。</p>
              <p>所有字段均可留空：积分填 0 表示不发积分，优惠券不勾选表示不发券，消息标题留空表示不发消息。</p>
            </CardContent>
          </Card>
          <MemberLevelBenefitsForm
            value={bundle.upgrade}
            onChange={updateScenario('upgrade')}
            couponTemplates={couponTemplates}
            messageTitlePlaceholder={(level: MemberLevel) => `🎉 恭喜升级为${level}会员`}
            pointsHelperText="升级到此等级时一次性奖励的积分数"
          />
        </TabsContent>

        <TabsContent value="birthday" className="space-y-6">
          <Card className="max-w-3xl">
            <CardHeader>
              <CardTitle>生日权益规则</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-[#999999]">
              <p>生日当天<strong className="text-[var(--foreground)]">凌晨 3:00</strong> 由每日定时任务按顾客当前会员等级发放<strong className="text-[var(--foreground)]">消息 + 积分 + 优惠券</strong>。</p>
              <p>一年仅发送一次，cron 重跑不会重复发放。</p>
              <p>没有生日的顾客、没有会员等级的顾客（流量/体验/小美客）不发放。</p>
              <p>2/29 出生的顾客仅在闰年当日发放，非闰年跳过。</p>
            </CardContent>
          </Card>
          <MemberLevelBenefitsForm
            value={bundle.birthday}
            onChange={updateScenario('birthday')}
            couponTemplates={couponTemplates}
            messageTitlePlaceholder={(level: MemberLevel) => `🎂 ${level}会员生日快乐`}
            pointsHelperText="生日当天一次性赠送的积分数"
          />
        </TabsContent>

        <TabsContent value="thanksgiving" className="space-y-6">
          <Card className="max-w-3xl">
            <CardHeader>
              <CardTitle>感恩日权益规则</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-[#999999]">
              <p>每月 <strong className="text-[var(--foreground)]">20 号</strong> 下护理单的顾客（即当日存在已完成或进行中服务单），按当前会员等级自动发放<strong className="text-[var(--foreground)]">消息 + 积分 + 优惠券</strong>。</p>
              <p>本次发放的优惠券<strong className="text-[var(--foreground)]">有效期为 10 天</strong>。同一顾客同一月仅发放一次。</p>
            </CardContent>
          </Card>
          <MemberLevelBenefitsForm
            value={bundle.thanksgiving}
            onChange={updateScenario('thanksgiving')}
            couponTemplates={couponTemplates}
            messageTitlePlaceholder={(level: MemberLevel) => `💝 感恩回馈 · ${level}专享`}
            pointsHelperText="感恩日一次性赠送的积分数"
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
