"use client"

import { useState } from "react"
import { toast } from "sonner"
import { useUnsavedChanges } from "@/lib/hooks/use-unsaved-changes"
import { actionErrorMessage } from "@/lib/action-error"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { ImageUpload } from "@/components/ui/image-upload"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { saveSettings, type RechargeCardConfigInput, type ConsumeAgreementConfig } from "@/actions/settings"
import RechargeConfigForm from "./recharge-config-form"
import ConsumeAgreementForm from "./consume-agreement-form"

const CDN_BASE =
  "https://636c-cloud1-3gpht4b01ff88838-1406056527.tcb.qcloud.la"

interface SettingsPageProps {
  initialSettings: {
    newMemberThreshold: string
    orderTimeout: string
    bannerImages: string[]
    fengyuguanImage: string
    serviceHotline: string
    pointsDeductionMaxRate: string
  }
  rechargeCardConfig: RechargeCardConfigInput
  consumeAgreement: ConsumeAgreementConfig
}

export default function SettingsPageClient({ initialSettings, rechargeCardConfig, consumeAgreement }: SettingsPageProps) {
  const [newMemberThreshold, setNewMemberThreshold] = useState(initialSettings.newMemberThreshold)
  const [orderTimeout, setOrderTimeout] = useState(initialSettings.orderTimeout)
  const [saving, setSaving] = useState(false)
  const [formDirty, setFormDirty] = useState(false)
  useUnsavedChanges(formDirty)

  const [bannerImages, setBannerImages] = useState<string[]>(initialSettings.bannerImages)
  const [fengyuguanImage, setFengyuguanImage] = useState(
    initialSettings.fengyuguanImage || `${CDN_BASE}/images/fengyuguan.jpg`
  )
  const [serviceHotline, setServiceHotline] = useState(initialSettings.serviceHotline)
  const [pointsDeductionMaxRate, setPointsDeductionMaxRate] = useState(initialSettings.pointsDeductionMaxRate)

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await saveSettings({
        newMemberThreshold,
        orderTimeout,
        bannerImages,
        fengyuguanImage,
        serviceHotline,
        pointsDeductionMaxRate,
      })
      if (res.success) {
        setFormDirty(false)
        toast.success(res.message)
      } else {
        toast.error(res.message)
      }
    } catch (err) {
      toast.error(actionErrorMessage(err, "保存失败，请稍后重试"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-[var(--foreground)]">系统配置</h1>

      <Tabs defaultValue="basic">
        <TabsList>
          <TabsTrigger value="basic">基础配置</TabsTrigger>
          <TabsTrigger value="recharge">充值卡配置</TabsTrigger>
          <TabsTrigger value="agreement">消费协议</TabsTrigger>
        </TabsList>

        <TabsContent value="basic">
          <div className="space-y-6" onInput={() => setFormDirty(true)}>
            <div className="flex justify-end">
              <Button onClick={handleSave} loading={saving}>保存</Button>
            </div>

            <Card className="max-w-2xl">
              <CardHeader>
                <CardTitle>基础配置</CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-[var(--foreground)]">新会员消费门槛（元）</label>
                  <Input
                    type="number"
                    value={newMemberThreshold}
                    onChange={(e) => setNewMemberThreshold(e.target.value)}
                    placeholder="1980"
                  />
                  <p className="text-xs text-[#999999]">新客户首次消费达到此金额自动升级为会员</p>
                </div>

                <Separator />

                <div className="space-y-2">
                  <label className="text-sm font-medium text-[var(--foreground)]">订单超时时间（分钟）</label>
                  <Input
                    type="number"
                    value={orderTimeout}
                    onChange={(e) => setOrderTimeout(e.target.value)}
                    placeholder="10"
                  />
                  <p className="text-xs text-[#999999]">待支付订单超过此时间自动关闭</p>
                </div>

                <Separator />

                <div className="space-y-2">
                  <label className="text-sm font-medium text-[var(--foreground)]">客服热线</label>
                  <Input
                    value={serviceHotline}
                    onChange={(e) => setServiceHotline(e.target.value)}
                    placeholder="例如 400-000-0000 或 0791-XXXXXXXX"
                  />
                  <p className="text-xs text-[#999999]">展示在顾客端「我的」页，点击可直接拨号</p>
                </div>

                <Separator />

                <div className="space-y-2">
                  <label className="text-sm font-medium text-[var(--foreground)]">积分抵扣比例</label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    max="1"
                    value={pointsDeductionMaxRate}
                    onChange={(e) => setPointsDeductionMaxRate(e.target.value)}
                    placeholder="0.03"
                  />
                  <p className="text-xs text-[#999999]">订单金额最高可用积分抵扣的比例（0.03 = 3%）。日常 3%，活动期可调至 5%，活动结束后改回</p>
                </div>
              </CardContent>
            </Card>

            {/* 首页轮播图 */}
            <Card className="max-w-2xl">
              <CardHeader>
                <CardTitle>首页轮播图</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-xs text-[#999999]">上传轮播图，拖拽调整显示顺序</p>
                <ImageUpload
                  value={bannerImages}
                  onChange={(v) => { setBannerImages(v as string[]); setFormDirty(true); }}
                  path="fengyu-client/banner"
                  multiple
                  max={0}
                />
              </CardContent>
            </Card>

            {/* 凤御馆宣传图 */}
            <Card className="max-w-2xl">
              <CardHeader>
                <CardTitle>凤御馆宣传图</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-xs text-[#999999]">上传后将直接覆盖小程序凤御馆页面的宣传图</p>
                <ImageUpload
                  value={fengyuguanImage}
                  onChange={(v) => { setFengyuguanImage(v as string); setFormDirty(true); }}
                  exactKey="images/fengyuguan.jpg"
                />
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="recharge">
          <RechargeConfigForm initialConfig={rechargeCardConfig} />
        </TabsContent>

        <TabsContent value="agreement">
          <ConsumeAgreementForm initialConfig={consumeAgreement} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
