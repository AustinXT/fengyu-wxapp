"use client"

import { useState } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"

export default function SettingsPage() {
  const [orderPrefix, setOrderPrefix] = useState("FY-XSD-WX-")
  const [newMemberThreshold, setNewMemberThreshold] = useState("1980")
  const [orderTimeout, setOrderTimeout] = useState("10")
  const [saving, setSaving] = useState(false)

  const handleSave = () => {
    setSaving(true)
    setTimeout(() => {
      setSaving(false)
      alert("保存成功（Mock）")
    }, 1000)
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
    </div>
  )
}
