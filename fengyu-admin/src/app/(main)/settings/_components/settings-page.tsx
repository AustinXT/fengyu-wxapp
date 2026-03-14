"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { ImageUpload } from "@/components/ui/image-upload"
import { saveSettings } from "@/actions/settings"

const CDN_BASE = "https://636c-cloud1-3gpht4b01ff88838-1406056527.tcb.qcloud.la"

interface SettingsPageProps {
  initialSettings: {
    orderPrefix: string
    newMemberThreshold: string
    orderTimeout: string
  }
}

export default function SettingsPageClient({ initialSettings }: SettingsPageProps) {
  const [orderPrefix, setOrderPrefix] = useState(initialSettings.orderPrefix)
  const [newMemberThreshold, setNewMemberThreshold] = useState(initialSettings.newMemberThreshold)
  const [orderTimeout, setOrderTimeout] = useState(initialSettings.orderTimeout)
  const [saving, setSaving] = useState(false)

  // Banner images: use CDN URL with cache-buster for preview
  const [bannerImages, setBannerImages] = useState<(string | null)[]>(
    Array.from({ length: 5 }, (_, i) =>
      `${CDN_BASE}/fengyu-client/banner/banner${i + 1}.jpg`
    )
  )
  const [fengyuguanImage, setFengyuguanImage] = useState(
    `${CDN_BASE}/images/fengyuguan.jpg`
  )

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await saveSettings({ orderPrefix, newMemberThreshold, orderTimeout })
      if (res.success) {
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
      <h1 className="text-2xl font-bold text-[var(--foreground)]">系统配置</h1>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>基础配置</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <label className="text-sm font-medium text-[var(--foreground)]">订单号前缀</label>
            <Input
              value={orderPrefix}
              onChange={(e) => setOrderPrefix(e.target.value)}
              placeholder="FY-XSD-WX-"
            />
            <p className="text-xs text-[#999999]">订单号格式：前缀 + YYMMDD + 4位序号</p>
          </div>

          <Separator />

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

          <div className="flex justify-end">
            <Button onClick={handleSave} loading={saving}>保存</Button>
          </div>
        </CardContent>
      </Card>
      {/* 首页轮播图 */}
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>首页轮播图</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-[#999999]">上传后将直接覆盖小程序首页对应轮播位的图片</p>
          {bannerImages.map((url, i) => (
            <div key={i} className="space-y-2">
              <label className="text-sm font-medium">轮播图 {i + 1}</label>
              <ImageUpload
                value={url ?? ""}
                onChange={(v) => {
                  const next = [...bannerImages]
                  next[i] = v as string
                  setBannerImages(next)
                }}
                exactKey={`fengyu-client/banner/banner${i + 1}.jpg`}
              />
            </div>
          ))}
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
            onChange={(v) => setFengyuguanImage(v as string)}
            exactKey="images/fengyuguan.jpg"
          />
        </CardContent>
      </Card>
    </div>
  )
}
