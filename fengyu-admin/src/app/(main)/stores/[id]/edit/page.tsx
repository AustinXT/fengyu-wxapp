"use client"

import { useMemo } from "react"
import { useRouter } from "next/navigation"
import { use } from "react"
import { MOCK_STORES } from "@/lib/mock-data"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"

export default function StoreEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()

  const store = useMemo(
    () => MOCK_STORES.find((s) => s.storeId === id) ?? null,
    [id]
  )

  if (!store) {
    return (
      <div className="space-y-4">
        <Button variant="outline" onClick={() => router.back()}>
          &larr; 返回
        </Button>
        <p className="text-[var(--muted-foreground)]">门店不存在</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => router.back()}>
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
              <Input defaultValue={store.storeName} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">联系电话</label>
              <Input defaultValue={store.phone ?? ""} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">开业日期</label>
              <Input type="date" defaultValue={store.openingDate ?? ""} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">床位数</label>
              <Input
                type="number"
                defaultValue={store.bedCount ?? ""}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">营业时间</label>
              <Input defaultValue={store.businessHours ?? ""} />
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
              <Input defaultValue={store.district ?? ""} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">详细地址</label>
              <Input defaultValue={store.streetAddress ?? ""} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">纬度</label>
              <Input defaultValue={store.latitude ?? ""} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">经度</label>
              <Input defaultValue={store.longitude ?? ""} />
            </div>
            <div className="col-span-2 space-y-2">
              <label className="text-sm font-medium">停车信息</label>
              <Input defaultValue={store.parkingInfo ?? ""} />
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
              <textarea
                className="flex w-full rounded-[var(--radius)] border border-[var(--input)] bg-transparent px-3 py-2 text-sm placeholder:text-[var(--muted-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 min-h-[80px]"
                defaultValue={store.description ?? ""}
              />
            </div>
            <div className="col-span-2 space-y-2">
              <label className="text-sm font-medium">公告</label>
              <textarea
                className="flex w-full rounded-[var(--radius)] border border-[var(--input)] bg-transparent px-3 py-2 text-sm placeholder:text-[var(--muted-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 min-h-[60px]"
                defaultValue={store.announcement ?? ""}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">封面图</label>
              <Input defaultValue={store.coverImage ?? ""} placeholder="图片 URL" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">门店图片</label>
              <Input
                defaultValue={store.images?.join(", ") ?? ""}
                placeholder="多张图片 URL，逗号分隔"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Separator />

      <div className="flex justify-end gap-3">
        <Button variant="outline" onClick={() => router.back()}>
          取消
        </Button>
        <Button>保存</Button>
      </div>
    </div>
  )
}
