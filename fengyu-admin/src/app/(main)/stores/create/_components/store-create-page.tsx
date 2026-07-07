"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useUnsavedChanges } from "@/lib/hooks/use-unsaved-changes"
import { actionErrorMessage } from "@/lib/action-error"
import { createStore } from "@/actions/stores"
import type { MerchantOption } from "@/actions/merchants"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectOption } from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { ImageUpload } from "@/components/ui/image-upload"
import { RegionSelect } from "@/components/ui/region-select"

type StoreNode = { id: string; name: string; marketName: string }

export default function StoreCreatePage({ storeNodes, canEditPayment = false, merchantOptions = [] }: { storeNodes: StoreNode[]; canEditPayment?: boolean; merchantOptions?: MerchantOption[] }) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [formDirty, setFormDirty] = useState(false)
  useUnsavedChanges(formDirty)
  const [orgNodeId, setOrgNodeId] = useState("")
  const [coverImage, setCoverImage] = useState("")
  const [storeImages, setStoreImages] = useState<string[]>([])
  const [merchantId, setMerchantId] = useState("")

  const selectedNode = storeNodes.find((n) => n.id === orgNodeId)

  const handleSave = async (formData: FormData) => {
    if (!orgNodeId) {
      toast.error("请选择门店节点")
      return
    }

    setSaving(true)
    try {
      const storeId = `store-${Date.now()}`

      
      const result = await createStore({
        storeId,
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
        coverImage: coverImage || null,
        images: storeImages.length > 0 ? storeImages : null,
        
        ...(canEditPayment ? { lakalaMerchantId: merchantId || null } : {}),
      })

      if (!result.success) {
        toast.error(result.message)
        return
      }
      setFormDirty(false)
      toast.success(result.message)
      router.push("/stores")
    } catch (e) {
      console.error("createStore failed", e)
      toast.error(actionErrorMessage(e, "创建失败"))
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

      {}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">基本信息</CardTitle>
        </CardHeader>
        <CardContent>
          {storeNodes.length === 0 ? (
            <div className="rounded-[var(--radius)] border border-dashed border-[var(--input)] p-4 text-sm text-[var(--muted-foreground)]">
              当前没有可创建门店信息的门店节点。请先到【组织架构】新增「门店」类型的节点，再回此页为其补充门店信息。
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2 space-y-2">
                <label className="text-sm font-medium">门店节点</label>
                <Select
                  name="orgNodeId"
                  placeholder="请选择门店节点"
                  required
                  value={orgNodeId}
                  onChange={(e) => {
                    setOrgNodeId(e.target.value)
                    setFormDirty(true)
                  }}
                >
                  {storeNodes.map((n) => (
                    <SelectOption key={n.id} value={n.id}>
                      {n.marketName ? `${n.marketName} / ${n.name}` : n.name}
                    </SelectOption>
                  ))}
                </Select>
                {selectedNode && (
                  <p className="text-xs text-[var(--muted-foreground)]">
                    将创建门店：<span className="font-medium text-[var(--foreground)]">{selectedNode.name}</span>
                    （门店名以组织节点为准）
                  </p>
                )}
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
            </div>
          )}
        </CardContent>
      </Card>

      {}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">地理位置</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2 space-y-2">
              <label className="text-sm font-medium">区域</label>
              <RegionSelect name="district" />
            </div>
            <div className="col-span-2 space-y-2">
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

      {}
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

      {canEditPayment && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">收款商户（选填）</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xs text-muted-foreground mb-3">
              选择本店关联的拉卡拉收款商户（商户档案在「商户管理」维护）；也可建店后到门店编辑页再关联。未关联或商户未启用时支付走兜底。
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2 space-y-2">
                <label className="text-sm font-medium">关联收款商户</label>
                <Select
                  name="lakalaMerchantId"
                  value={merchantId}
                  onChange={(e) => {
                    setMerchantId(e.target.value)
                    setFormDirty(true)
                  }}
                >
                  <SelectOption value="">不关联（支付走兜底）</SelectOption>
                  {merchantOptions.map((m) => (
                    <SelectOption key={m.id} value={m.id}>
                      {m.merchantName}
                      {m.merchantNo ? `（${m.merchantNo}）` : ""}
                      {m.enabled ? "" : " · 未启用"}
                    </SelectOption>
                  ))}
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Separator />

      <div className="flex justify-end gap-3">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          取消
        </Button>
        <Button type="submit" disabled={saving || !orgNodeId}>
          {saving ? "创建中..." : "创建"}
        </Button>
      </div>
    </form>
  )
}
