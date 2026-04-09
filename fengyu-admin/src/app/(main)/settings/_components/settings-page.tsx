"use client"

import { useState } from "react"
import { toast } from "sonner"
import { useUnsavedChanges } from "@/lib/hooks/use-unsaved-changes"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { ImageUpload } from "@/components/ui/image-upload"
import { saveSettings, type MemberLevelBenefit, type MemberLevelBenefitsMap } from "@/actions/settings"

const CDN_BASE =
  "https://636c-cloud1-3gpht4b01ff88838-1406056527.tcb.qcloud.la"

const MEMBER_LEVELS = ['初钻', '星钻', '粉钻', '金钻', '黑钻'] as const

const LEVEL_THRESHOLDS: Record<(typeof MEMBER_LEVELS)[number], string> = {
  初钻: '滚动 12 个月消费 ¥1,990 ~ ¥9,999',
  星钻: '滚动 12 个月消费 ¥10,000 ~ ¥29,999',
  粉钻: '滚动 12 个月消费 ¥30,000 ~ ¥59,999',
  金钻: '滚动 12 个月消费 ¥60,000 ~ ¥99,999',
  黑钻: '滚动 12 个月消费 ¥100,000+',
}

interface SettingsPageProps {
  initialSettings: {
    newMemberThreshold: string
    orderTimeout: string
    bannerImages: string[]
    fengyuguanImage: string
    memberLevelBenefits: MemberLevelBenefitsMap
  }
  couponTemplates: Array<{ templateId: string; name: string }>
}

export default function SettingsPageClient({ initialSettings, couponTemplates }: SettingsPageProps) {
  const [newMemberThreshold, setNewMemberThreshold] = useState(initialSettings.newMemberThreshold)
  const [orderTimeout, setOrderTimeout] = useState(initialSettings.orderTimeout)
  const [saving, setSaving] = useState(false)
  const [formDirty, setFormDirty] = useState(false)
  useUnsavedChanges(formDirty)

  const [bannerImages, setBannerImages] = useState<string[]>(initialSettings.bannerImages)
  const [fengyuguanImage, setFengyuguanImage] = useState(
    initialSettings.fengyuguanImage || `${CDN_BASE}/images/fengyuguan.jpg`
  )
  const [benefits, setBenefits] = useState<MemberLevelBenefitsMap>(initialSettings.memberLevelBenefits)

  const updateBenefit = (level: (typeof MEMBER_LEVELS)[number], patch: Partial<MemberLevelBenefit>) => {
    setBenefits((prev) => ({ ...prev, [level]: { ...prev[level], ...patch } }))
    setFormDirty(true)
  }

  const toggleCouponTemplate = (level: (typeof MEMBER_LEVELS)[number], templateId: string) => {
    setBenefits((prev) => {
      const current = prev[level].couponTemplateIds
      const next = current.includes(templateId)
        ? current.filter((id) => id !== templateId)
        : [...current, templateId]
      return { ...prev, [level]: { ...prev[level], couponTemplateIds: next } }
    })
    setFormDirty(true)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await saveSettings({
        newMemberThreshold,
        orderTimeout,
        bannerImages,
        fengyuguanImage,
        memberLevelBenefits: benefits,
      })
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
    <div className="space-y-6" onInput={() => setFormDirty(true)}>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">系统配置</h1>
        <Button onClick={handleSave} loading={saving}>保存</Button>
      </div>

      <Tabs defaultValue="basic" className="w-full">
        <TabsList>
          <TabsTrigger value="basic">基础配置</TabsTrigger>
          <TabsTrigger value="member-benefits">会员等级权益</TabsTrigger>
        </TabsList>

        {/* ============ Tab 1: 基础配置 ============ */}
        <TabsContent value="basic" className="space-y-6">
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
        </TabsContent>

        {/* ============ Tab 2: 会员等级权益 ============ */}
        <TabsContent value="member-benefits" className="space-y-6">
          <Card className="max-w-3xl">
            <CardHeader>
              <CardTitle>会员等级权益规则</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-[#999999]">
              <p>会员等级根据顾客滚动 12 个月累计消费额自动跳档（每日凌晨 3:00 由 cronTask 重算）。</p>
              <p>当顾客等级<strong className="text-[var(--foreground)]">升级</strong>时，系统会自动发放对应等级的<strong className="text-[var(--foreground)]">消息 + 积分 + 优惠券</strong>三件套权益。降级仅记录日志，不发权益。</p>
              <p>所有字段均可留空：积分填 0 表示不发积分，优惠券不勾选表示不发券，消息标题留空表示不发消息。</p>
            </CardContent>
          </Card>

          {MEMBER_LEVELS.map((level) => {
            const b = benefits[level]
            return (
              <Card key={level} className="max-w-3xl">
                <CardHeader>
                  <CardTitle className="flex items-baseline gap-3">
                    <span>{level}</span>
                    <span className="text-xs font-normal text-[#999999]">{LEVEL_THRESHOLDS[level]}</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-[var(--foreground)]">升级奖励积分</label>
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      value={b.points}
                      onChange={(e) => updateBenefit(level, { points: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                      placeholder="0"
                      className="max-w-xs"
                    />
                    <p className="text-xs text-[#999999]">升级到此等级时一次性奖励的积分数</p>
                  </div>

                  <Separator />

                  <div className="space-y-2">
                    <label className="text-sm font-medium text-[var(--foreground)]">升级消息标题</label>
                    <Input
                      value={b.messageTitle}
                      onChange={(e) => updateBenefit(level, { messageTitle: e.target.value })}
                      placeholder={`🎉 恭喜升级为${level}会员`}
                      maxLength={200}
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium text-[var(--foreground)]">升级消息正文</label>
                    <Textarea
                      value={b.messageBody}
                      onChange={(e) => updateBenefit(level, { messageBody: e.target.value })}
                      placeholder="您已晋升至更高等级，专属权益已为您解锁。"
                      rows={3}
                    />
                  </div>

                  <Separator />

                  <div className="space-y-2">
                    <label className="text-sm font-medium text-[var(--foreground)]">
                      发放优惠券模板
                      {b.couponTemplateIds.length > 0 && (
                        <span className="ml-2 text-xs text-[var(--primary)]">已选 {b.couponTemplateIds.length} 张</span>
                      )}
                    </label>
                    {couponTemplates.length === 0 ? (
                      <p className="text-xs text-[#999999]">暂无可用优惠券模板，请先到 <a href="/coupons" className="text-[var(--primary)] underline">优惠券</a> 页面创建</p>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-48 overflow-y-auto border border-[var(--border)] rounded-md p-3">
                        {couponTemplates.map((tpl) => {
                          const checked = b.couponTemplateIds.includes(tpl.templateId)
                          return (
                            <label
                              key={tpl.templateId}
                              className="flex items-center gap-2 text-sm cursor-pointer hover:bg-[var(--accent)] px-2 py-1 rounded"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleCouponTemplate(level, tpl.templateId)}
                                className="h-4 w-4 accent-[var(--primary)]"
                              />
                              <span className="truncate" title={tpl.name}>{tpl.name}</span>
                            </label>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </TabsContent>
      </Tabs>
    </div>
  )
}
