"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import type { ProductCategory } from "@/lib/types"
import { createSku } from "@/actions/products"
import { useUnsavedChanges } from "@/lib/hooks/use-unsaved-changes"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { CategoryCascader } from "@/components/ui/category-cascader"

interface Market {
  id: string
  name: string
}

export default function SkuCreatePageClient({
  categories,
  markets,
}: {
  categories: ProductCategory[]
  markets: Market[]
}) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [categoryId, setCategoryId] = useState("")
  const [formDirty, setFormDirty] = useState(false)
  useUnsavedChanges(formDirty)

  const [isShengmei, setIsShengmei] = useState<boolean>(false)
  const [allMarkets, setAllMarkets] = useState(true)
  const [selectedMarketIds, setSelectedMarketIds] = useState<string[]>([])

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

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
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
    const isEnabled = fd.get("isEnabled") === "on"

    const skuId = `sku-${Date.now()}`

    setSaving(true)
    try {
      const result = await createSku({
        skuId,
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
        isEnabled,
      })
      if (!result.success) {
        toast.error(result.message)
        return
      }
      setFormDirty(false)
      toast.success("品项创建成功")
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
        <h1 className="text-2xl font-bold text-[var(--foreground)]">新增品项</h1>
      </div>

      {/* 基本信息 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">基本信息</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">品项名称</label>
              <Input name="specName" placeholder="请输入品项名称" />
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
              <Select name="productType" defaultValue="">
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
              <Input name="price" type="number" step="0.01" placeholder="0.00" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">会员价</label>
              <Input name="specialPrice" type="number" step="0.01" placeholder="不填则无会员价" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">手工费</label>
              <Input name="serviceFee" type="number" step="0.01" defaultValue="0" placeholder="0.00" />
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
              <Input name="sessionCount" type="number" min={1} placeholder="疗程卡必填，单品默认1" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">排序</label>
              <Input name="sortOrder" type="number" defaultValue={0} />
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

      {/* 启用状态 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">启用状态</CardTitle>
        </CardHeader>
        <CardContent>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name="isEnabled"
              defaultChecked
              className="h-4 w-4 rounded border-[var(--input)]"
            />
            <span className="text-sm">启用</span>
          </label>
        </CardContent>
      </Card>

      <Separator />

      <div className="flex justify-end gap-3">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          取消
        </Button>
        <Button type="submit" loading={saving}>创建品项</Button>
      </div>
    </form>
  )
}
