"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useUnsavedChanges } from "@/lib/hooks/use-unsaved-changes"
import type { ProductSku, ProductCategory } from "@/lib/types"
import { updateSku, deleteSku } from "@/actions/products"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { CategoryCascader } from "@/components/ui/category-cascader"
import { Separator } from "@/components/ui/separator"
import {
  AlertDialog,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog"

interface Market {
  id: string
  name: string
}

export default function SkuDetailPageClient({
  sku,
  categories,
  markets,
}: {
  sku: ProductSku
  categories: ProductCategory[]
  markets: Market[]
}) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [formDirty, setFormDirty] = useState(false)
  useUnsavedChanges(formDirty)
  const [categoryId, setCategoryId] = useState(sku.categoryId)

  const [isShengmei, setIsShengmei] = useState<boolean>(sku.isShengmei ?? false)
  const [allMarkets, setAllMarkets] = useState(!sku.marketScope)
  const [selectedMarketIds, setSelectedMarketIds] = useState<string[]>(
    sku.marketScope ? sku.marketScope.split(',') : []
  )

  // Delete dialog state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const selectedCategory = categories.find(c => c.categoryId === categoryId)
  const selectedProductKind = selectedCategory?.productKind

  const handleCategoryChange = (id: string) => {
    setCategoryId(id)
    const cat = categories.find(c => c.categoryId === id)
    if (cat && cat.productKind !== '护理项目') {
      setIsShengmei(false)
    }
    setFormDirty(true)
  }

  const handleSave = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const fd = new FormData(form)

    const specName = (fd.get("specName") as string).trim()
    const productType = fd.get("productType") as string
    const price = (fd.get("price") as string).trim()

    if (!specName) {
      toast.error("请输入品项名称")
      return
    }
    if (!categoryId) {
      toast.error("请选择品项分类")
      return
    }
    if (!productType) {
      toast.error("请选择产品类型")
      return
    }
    if (!price) {
      toast.error("请输入标价")
      return
    }

    const specialPrice = (fd.get("specialPrice") as string).trim() || null
    const serviceFee = (fd.get("serviceFee") as string).trim() || "0"
    const sessionCountRaw = (fd.get("sessionCount") as string).trim()
    const sessionCount = sessionCountRaw ? parseInt(sessionCountRaw) : null
    const sortOrder = parseInt(fd.get("sortOrder") as string) || 0
    const validStart = (fd.get("validStart") as string) || null
    const validEnd = (fd.get("validEnd") as string) || null

    setSaving(true)
    try {
      const result = await updateSku(sku.skuId, {
        categoryId,
        productType,
        specName,
        price,
        specialPrice,
        sessionCount,
        sortOrder,
        serviceFee,
        isShengmei: selectedProductKind === '护理项目' ? isShengmei : null,
        marketScope: allMarkets ? null : (selectedMarketIds.length > 0 ? selectedMarketIds.join(',') : null),
        validStart,
        validEnd,
      }, sku.updatedAt)
      if (!result.success) {
        toast.error(result.message)
        if (result.message.includes("已被其他人修改")) router.refresh()
        return
      }
      setFormDirty(false)
      toast.success("保存成功")
      router.refresh()
    } catch {
      toast.error("保存失败，请稍后重试")
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    setDeleting(true)
    try {
      const result = await deleteSku(sku.skuId)
      if (!result.success) {
        toast.error(result.message)
        return
      }
      toast.success("品项已删除")
      router.push("/products")
    } catch {
      toast.error("删除失败，请稍后重试")
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button type="button" variant="outline" size="sm" onClick={() => router.back()}>
            &larr; 返回
          </Button>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">
            品项详情 - {sku.specName}
          </h1>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="text-[var(--destructive)] border-[var(--destructive)]"
          onClick={() => setDeleteDialogOpen(true)}
        >
          删除品项
        </Button>
      </div>

      <form onSubmit={handleSave} onInput={() => setFormDirty(true)} className="space-y-4">
        {/* 基本信息 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">基本信息</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">品项名称</label>
                <Input name="specName" defaultValue={sku.specName} />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">品项分类</label>
                <CategoryCascader
                  name="categoryId"
                  categories={categories}
                  value={categoryId}
                  onChange={handleCategoryChange}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">产品类型</label>
                <Select name="productType" defaultValue={sku.productType}>
                  <option value="" disabled>请选择</option>
                  <option value="疗程卡">疗程卡</option>
                  <option value="单品">单品</option>
                  <option value="院装产品">院装产品</option>
                </Select>
              </div>
              {selectedProductKind === '护理项目' && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">是否生美</label>
                  <Select
                    value={isShengmei ? "true" : "false"}
                    onChange={(e) => { setIsShengmei(e.target.value === "true"); setFormDirty(true) }}
                  >
                    <option value="false">否（科美）</option>
                    <option value="true">是（生美）</option>
                  </Select>
                </div>
              )}
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
                <Input name="price" type="number" step="0.01" defaultValue={sku.price} />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">会员价</label>
                <Input
                  name="specialPrice"
                  type="number"
                  step="0.01"
                  defaultValue={sku.specialPrice ?? ""}
                  placeholder="不填则无会员价"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">手工费</label>
                <Input
                  name="serviceFee"
                  type="number"
                  step="0.01"
                  defaultValue={sku.serviceFee ?? "0"}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 次数与排序 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">次数与排序</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">次数</label>
                <Input
                  name="sessionCount"
                  type="number"
                  min={1}
                  defaultValue={sku.sessionCount ?? ""}
                  placeholder="疗程卡必填，单品默认1"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">排序</label>
                <Input name="sortOrder" type="number" defaultValue={sku.sortOrder} />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 可见范围 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">可见范围</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={allMarkets}
                  onChange={(e) => {
                    setAllMarkets(e.target.checked)
                    if (e.target.checked) setSelectedMarketIds([])
                    setFormDirty(true)
                  }}
                  className="h-4 w-4 rounded border-[var(--input)]"
                />
                <span className="text-sm font-medium">全部市场</span>
              </label>
              {!allMarkets && (
                <div className="grid grid-cols-3 gap-2 pl-6">
                  {markets.map((m) => (
                    <label key={m.id} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selectedMarketIds.includes(m.id)}
                        onChange={(e) => {
                          setSelectedMarketIds((prev) =>
                            e.target.checked
                              ? [...prev, m.id]
                              : prev.filter((id) => id !== m.id)
                          )
                          setFormDirty(true)
                        }}
                        className="h-4 w-4 rounded border-[var(--input)]"
                      />
                      <span className="text-sm">{m.name}</span>
                    </label>
                  ))}
                </div>
              )}
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
                <Input name="validStart" type="date" defaultValue={sku.validStart ?? ""} />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">截止日期</label>
                <Input
                  name="validEnd"
                  type="date"
                  defaultValue={sku.validEnd ?? ""}
                  placeholder="不填则长期有效"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <Separator />

        <div className="flex items-center justify-end gap-3">
          <Button type="button" variant="outline" onClick={() => router.back()}>
            取消
          </Button>
          <Button type="submit" loading={saving}>保存</Button>
        </div>
      </form>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogTitle>确认删除</AlertDialogTitle>
        <AlertDialogDescription>
          确定要删除品项「{sku.specName}」吗？此操作不可撤销。
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={() => setDeleteDialogOpen(false)}
            disabled={deleting}
          >
            取消
          </AlertDialogCancel>
          <AlertDialogAction onClick={handleDelete} disabled={deleting}>
            {deleting ? "删除中..." : "删除"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>
    </div>
  )
}
