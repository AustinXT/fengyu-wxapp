"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import type { OrgNode } from "@/lib/types"
import { createStore } from "@/actions/stores"
import { createOrgNode } from "@/actions/org"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectOption } from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"

export default function StoreCreatePage({ markets }: { markets: OrgNode[] }) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)

  const handleSave = async (formData: FormData) => {
    const storeName = (formData.get("storeName") as string).trim()
    if (!storeName) {
      toast.error("请输入门店名称")
      return
    }

    const marketId = formData.get("marketId") as string
    if (!marketId) {
      toast.error("请选择所属市场")
      return
    }

    setSaving(true)
    try {
      const storeId = `store-${Date.now()}`
      const orgNodeId = `org-store-${Date.now()}`

      // Create an org node of type 'store' under the selected market
      await createOrgNode({
        id: orgNodeId,
        name: storeName,
        type: "store",
        parentId: marketId,
        sortOrder: 0,
        isActive: true,
      })

      const imagesRaw = (formData.get("images") as string).trim()
      await createStore({
        storeId,
        storeName,
        orgNodeId,
        openingDate: (formData.get("openingDate") as string) || null,
        bedCount: formData.get("bedCount") ? Number(formData.get("bedCount")) : null,
        phone: (formData.get("phone") as string) || null,
        businessHours: (formData.get("businessHours") as string) || null,
        district: (formData.get("district") as string) || null,
        streetAddress: (formData.get("streetAddress") as string) || null,
        latitude: (formData.get("latitude") as string) || null,
        longitude: (formData.get("longitude") as string) || null,
        parkingInfo: (formData.get("parkingInfo") as string) || null,
        description: (formData.get("description") as string) || null,
        announcement: (formData.get("announcement") as string) || null,
        coverImage: (formData.get("coverImage") as string) || null,
        images: imagesRaw ? imagesRaw.split(",").map((s) => s.trim()).filter(Boolean) : null,
      })

      toast.success("创建成功")
      router.push("/stores")
    } catch {
      toast.error("创建失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <form action={handleSave} className="space-y-4">
      <div className="flex items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={() => router.back()}>
          &larr; 返回
        </Button>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">
          新增门店
        </h1>
      </div>

      {/* 基本信息 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">基本信息</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">门店名称</label>
              <Input name="storeName" required />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">联系电话</label>
              <Input name="phone" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">开业日期</label>
              <Input name="openingDate" type="date" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">床位数</label>
              <Input name="bedCount" type="number" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">营业时间</label>
              <Input name="businessHours" placeholder="如: 09:00-21:00" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">所属市场</label>
              <Select name="marketId" placeholder="请选择市场" required>
                {markets.map((m) => (
                  <SelectOption key={m.id} value={m.id}>
                    {m.name}
                  </SelectOption>
                ))}
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 地理位置 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">地理位置</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">区域</label>
              <Input name="district" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">详细地址</label>
              <Input name="streetAddress" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">纬度</label>
              <Input name="latitude" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">经度</label>
              <Input name="longitude" />
            </div>
            <div className="col-span-2 space-y-2">
              <label className="text-sm font-medium">停车信息</label>
              <Input name="parkingInfo" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 展示内容 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">展示内容</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2 space-y-2">
              <label className="text-sm font-medium">门店简介</label>
              <Textarea name="description" />
            </div>
            <div className="col-span-2 space-y-2">
              <label className="text-sm font-medium">公告</label>
              <Textarea name="announcement" className="min-h-[60px]" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">封面图</label>
              <Input name="coverImage" placeholder="图片 URL" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">门店图片</label>
              <Input name="images" placeholder="多张图片 URL，逗号分隔" />
            </div>
          </div>
        </CardContent>
      </Card>

      <Separator />

      <div className="flex justify-end gap-3">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          取消
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? "创建中..." : "创建"}
        </Button>
      </div>
    </form>
  )
}
