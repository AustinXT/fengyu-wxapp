"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import type { ProductCategory } from "@/lib/types"
import { createProduct } from "@/actions/products"
import { useUnsavedChanges } from "@/lib/hooks/use-unsaved-changes"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { ImageUpload } from "@/components/ui/image-upload"

export default function ProductCreatePageClient({
  categories,
}: {
  categories: ProductCategory[]
}) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [coverImage, setCoverImage] = useState("")
  const [detailImages, setDetailImages] = useState<string[]>([])
  const [formDirty, setFormDirty] = useState(false)
  useUnsavedChanges(formDirty)

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const fd = new FormData(form)

    const name = (fd.get("name") as string).trim()
    const categoryId = fd.get("categoryId") as string
    const price = (fd.get("price") as string).trim()

    if (!name) {
      toast.error("请输入商品名称")
      return
    }
    if (!categoryId) {
      toast.error("请选择品项分类")
      return
    }
    if (!price) {
      toast.error("请输入标价")
      return
    }

    const specialPrice = (fd.get("specialPrice") as string).trim() || null
    const salesCategory = (fd.get("salesCategory") as string) || null
    const isBundle = fd.get("isBundle") === "true"
    const description = (fd.get("description") as string).trim() || null
    const sortOrder = parseInt(fd.get("sortOrder") as string) || 0
    const validStart = (fd.get("validStart") as string) || null
    const validEnd = (fd.get("validEnd") as string) || null

    const productId = `prod-${Date.now()}`

    setSaving(true)
    try {
      const result = await createProduct({
        productId,
        categoryId,
        name,
        coverImage: coverImage || null,
        detailImages: detailImages.length > 0 ? detailImages : null,
        description,
        isBundle,
        price,
        specialPrice,
        salesCategory,
        sortOrder,
        validStart,
        validEnd,
      })
      if (!result.success) {
        toast.error(result.message)
        return
      }
      setFormDirty(false)
      toast.success("商品创建成功")
      router.push("/products")
    } catch {
      toast.error("创建失败，请稍后重试")
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} onInput={() => setFormDirty(true)} className="space-y-4">
      <div className="flex items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={() => router.back()}>
          &larr; 返回
        </Button>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">新增商品</h1>
      </div>

      {/* 基本信息 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">基本信息</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">商品名称</label>
              <Input name="name" placeholder="请输入商品名称" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">品项分类</label>
              <Select name="categoryId" defaultValue="">
                <option value="" disabled>
                  请选择分类
                </option>
                {categories.map((c) => (
                  <option key={c.categoryId} value={c.categoryId}>
                    {c.categoryName}（{c.productKind}）
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">销售分类</label>
              <Select name="salesCategory" defaultValue="">
                <option value="" disabled>
                  请选择
                </option>
                <option value="自采自销">自采自销</option>
                <option value="他销自耗">他销自耗</option>
                <option value="他销他耗">他销他耗</option>
                <option value="生态合作">生态合作</option>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">是否套餐</label>
              <Select name="isBundle" defaultValue="false">
                <option value="false">否</option>
                <option value="true">是</option>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 价格 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">价格</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">标价</label>
              <Input name="price" type="number" placeholder="0.00" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">特价</label>
              <Input name="specialPrice" type="number" placeholder="不填则无特价" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 展示 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">展示</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2 space-y-2">
              <label className="text-sm font-medium">商品描述</label>
              <textarea
                name="description"
                className="flex w-full rounded-[var(--radius)] border border-[var(--input)] bg-transparent px-3 py-2 text-sm placeholder:text-[var(--muted-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 min-h-[80px]"
                placeholder="请输入商品描述"
              />
            </div>
            <div className="col-span-2 space-y-2">
              <label className="text-sm font-medium">封面图</label>
              <ImageUpload
                value={coverImage}
                onChange={(v) => setCoverImage(v as string)}
                path="product-covers"
              />
            </div>
            <div className="col-span-2 space-y-2">
              <label className="text-sm font-medium">详情图</label>
              <ImageUpload
                value={detailImages}
                onChange={(v) => setDetailImages(v as string[])}
                path="product-details"
                multiple
                max={9}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">排序</label>
              <Input name="sortOrder" type="number" defaultValue={0} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 有效期 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">有效期</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">生效日期</label>
              <Input name="validStart" type="date" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">截止日期</label>
              <Input name="validEnd" type="date" />
            </div>
          </div>
        </CardContent>
      </Card>

      <Separator />

      <div className="flex justify-end gap-3">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          取消
        </Button>
        <Button type="submit" loading={saving}>创建商品</Button>
      </div>
    </form>
  )
}
