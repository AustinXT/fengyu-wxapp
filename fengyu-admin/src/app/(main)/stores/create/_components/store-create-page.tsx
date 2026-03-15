"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useUnsavedChanges } from "@/lib/hooks/use-unsaved-changes"
import type { OrgNode } from "@/lib/types"
import { createStore } from "@/actions/stores"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectOption } from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { ImageUpload } from "@/components/ui/image-upload"

export default function StoreCreatePage({ markets }: { markets: OrgNode[] }) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [formDirty, setFormDirty] = useState(false)
  useUnsavedChanges(formDirty)
  const [coverImage, setCoverImage] = useState("")
  const [storeImages, setStoreImages] = useState<string[]>([])

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

      // createStore 内部会自动创建对应的 org_node (type=store)
      const result = await createStore({
        storeId,
        storeName,
        marketId,
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
        coverImage: coverImage || null,
        images: storeImages.length > 0 ? storeImages : null,
      })

      if (!result.success) {
        toast.error(result.message)
        return
      }
      setFormDirty(false)
      toast.success(result.message)
      router.push("/stores")
    } catch {
      toast.error("创建失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <form action={handleSave} onInput={() => setFormDirty(true)} className="space-y-4">
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
            <div className="col-span-2 space-y-2">
              <label className="text-sm font-medium">封面图</label>
              <ImageUpload
                value={coverImage}
                onChange={(v) => setCoverImage(v as string)}
                path="store-covers"
              />
            </div>
            <div className="col-span-2 space-y-2">
              <label className="text-sm font-medium">门店图片</label>
              <ImageUpload
                value={storeImages}
                onChange={(v) => setStoreImages(v as string[])}
                path="store-images"
                multiple
                max={9}
              />
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
