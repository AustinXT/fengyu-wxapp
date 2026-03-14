"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import type { Store } from "@/lib/types"
import { updateStore } from "@/actions/stores"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { ImageUpload } from "@/components/ui/image-upload"

export default function StoreEditPage({ store }: { store: Store }) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [coverImage, setCoverImage] = useState(store.coverImage ?? "")
  const [storeImages, setStoreImages] = useState<string[]>(store.images ?? [])

  const handleSave = async (formData: FormData) => {
    setSaving(true)
    try {
      await updateStore(store.storeId, {
        storeName: formData.get("storeName") as string,
        phone: (formData.get("phone") as string) || null,
        openingDate: (formData.get("openingDate") as string) || null,
        bedCount: formData.get("bedCount") ? Number(formData.get("bedCount")) : null,
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
      toast.success("保存成功")
      router.push("/stores")
    } catch {
      toast.error("保存失败")
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
          编辑门店 - {store.storeName}
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
              <Input name="storeName" defaultValue={store.storeName} required />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">联系电话</label>
              <Input name="phone" defaultValue={store.phone ?? ""} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">开业日期</label>
              <Input name="openingDate" type="date" defaultValue={store.openingDate ?? ""} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">床位数</label>
              <Input
                name="bedCount"
                type="number"
                defaultValue={store.bedCount ?? ""}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">营业时间</label>
              <Input name="businessHours" defaultValue={store.businessHours ?? ""} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">所属市场</label>
              <Input defaultValue={store.marketName ?? ""} disabled />
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
              <Input name="district" defaultValue={store.district ?? ""} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">详细地址</label>
              <Input name="streetAddress" defaultValue={store.streetAddress ?? ""} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">纬度</label>
              <Input name="latitude" defaultValue={store.latitude ?? ""} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">经度</label>
              <Input name="longitude" defaultValue={store.longitude ?? ""} />
            </div>
            <div className="col-span-2 space-y-2">
              <label className="text-sm font-medium">停车信息</label>
              <Input name="parkingInfo" defaultValue={store.parkingInfo ?? ""} />
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
              <Textarea
                name="description"
                defaultValue={store.description ?? ""}
              />
            </div>
            <div className="col-span-2 space-y-2">
              <label className="text-sm font-medium">公告</label>
              <Textarea
                name="announcement"
                className="min-h-[60px]"
                defaultValue={store.announcement ?? ""}
              />
            </div>
            <div className="col-span-2 space-y-2">
              <label className="text-sm font-medium">封面图</label>
              <ImageUpload
                value={coverImage}
                onChange={(v) => setCoverImage(v as string)}
                path={`admin-uploads/stores/${store.storeId}`}
              />
            </div>
            <div className="col-span-2 space-y-2">
              <label className="text-sm font-medium">门店图片</label>
              <ImageUpload
                value={storeImages}
                onChange={(v) => setStoreImages(v as string[])}
                path={`admin-uploads/stores/${store.storeId}`}
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
          {saving ? "保存中..." : "保存"}
        </Button>
      </div>
    </form>
  )
}
