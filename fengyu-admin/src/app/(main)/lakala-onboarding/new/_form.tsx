"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { createDraft } from "@/actions/lakala-onboarding"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export default function NewLakalaMerchantForm() {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [merchantName, setMerchantName] = useState("")

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!merchantName.trim()) {
      toast.error("请输入商户名")
      return
    }
    setSaving(true)
    try {
      const result = await createDraft({ merchantName: merchantName.trim() })
      if (!result?.success) {
        toast.error("创建失败")
        return
      }
      toast.success("已创建草稿")
      router.push(`/lakala-onboarding/${result.id}/edit`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "创建失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 max-w-xl">
      <div className="flex items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={() => router.back()}>
          &larr; 返回
        </Button>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">新建商户入网</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">基本信息</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <label className="text-sm font-medium">
              商户名 <span className="text-[#D94040]">*</span>
            </label>
            <Input
              value={merchantName}
              onChange={(e) => setMerchantName(e.target.value)}
              placeholder="如：凤御美容院·张家界蓝茉店"
              maxLength={80}
              autoFocus
              required
            />
            <p className="text-xs text-[var(--muted-foreground)]">
              创建后会自动分配进件流水号（out_org_code）；其它信息可在草稿态完整编辑后再申请合同。
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-3">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          取消
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? "创建中..." : "创建草稿"}
        </Button>
      </div>
    </form>
  )
}
