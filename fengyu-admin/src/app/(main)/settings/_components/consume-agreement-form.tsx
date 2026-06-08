"use client"

import { useState } from "react"
import { toast } from "sonner"
import { useUnsavedChanges } from "@/lib/hooks/use-unsaved-changes"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { saveConsumeAgreement, type ConsumeAgreementConfig } from "@/actions/settings"

interface ConsumeAgreementFormProps {
  initialConfig: ConsumeAgreementConfig
}

export default function ConsumeAgreementForm({ initialConfig }: ConsumeAgreementFormProps) {
  const [title, setTitle] = useState(initialConfig.title)
  const [content, setContent] = useState(initialConfig.content)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  useUnsavedChanges(dirty)

  const handleSave = async () => {
    if (!title.trim()) {
      toast.error("协议标题不能为空")
      return
    }
    setSaving(true)
    try {
      const res = await saveConsumeAgreement({ title: title.trim(), content })
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
          配置顾客端结算页《消费协议》的标题与正文；顾客下单前点击协议链接即可预览。正文按行分段，「一、二、…」开头的行会作为小标题加粗显示。
        </p>
        <Button onClick={handleSave} loading={saving}>保存</Button>
      </div>

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>消费协议</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <label className="text-sm font-medium text-[var(--foreground)]">协议标题</label>
            <Input
              value={title}
              onChange={(e) => {
                setTitle(e.target.value)
                setDirty(true)
              }}
              placeholder="服务消费协议"
              maxLength={50}
            />
            <p className="text-xs text-[#999999]">显示为结算页《标题》链接与预览弹层标题</p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-[var(--foreground)]">协议正文</label>
            <Textarea
              value={content}
              onChange={(e) => {
                setContent(e.target.value)
                setDirty(true)
              }}
              rows={18}
              maxLength={20000}
              placeholder={"一、服务内容与适用范围\n本协议适用于..."}
              className="font-mono leading-relaxed"
            />
            <p className="text-xs text-[#999999]">
              {content.length} / 20000 字 · 空行分隔段落；留空则顾客端展示内置默认协议
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
