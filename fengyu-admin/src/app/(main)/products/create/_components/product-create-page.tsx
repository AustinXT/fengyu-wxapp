"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import type { ProductCategory, ProjectSeries } from "@/lib/types"
import { createSku } from "@/actions/products"
import { actionErrorMessage } from "@/lib/action-error"
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
  projectSeriesOptions,
}: {
  categories: ProductCategory[]
  markets: Market[]
  projectSeriesOptions: ProjectSeries[]
}) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [categoryId, setCategoryId] = useState("")
  const [productType, setProductType] = useState<"" | "疗程卡" | "家居产品">("")
  const [unit, setUnit] = useState("")
  const [formDirty, setFormDirty] = useState(false)
  useUnsavedChanges(formDirty)

  const [isShengmei, setIsShengmei] = useState<boolean>(false)
  const [isExperience, setIsExperience] = useState<boolean>(false)
  const [isManagerSpecial, setIsManagerSpecial] = useState<boolean>(false)
  const [projectSeriesId, setProjectSeriesId] = useState<number | null>(null)
  const [allMarkets, setAllMarkets] = useState(true)
  const [selectedMarketIds, setSelectedMarketIds] = useState<string[]>([])

  const selectedCategory = categories.find(c => c.categoryId === categoryId)

  const handleCategoryChange = (id: string) => {
    setCategoryId(id)
    setFormDirty(true)
  }

  const handleProductTypeChange = (value: "疗程卡" | "家居产品") => {
    setProductType(value)
    setUnit(value === "家居产品" ? "盒" : "次")
    setFormDirty(true)
  }

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const fd = new FormData(form)

    const specName = (fd.get("specName") as string).trim()
    const productType = fd.get("productType") as string
    const price = (fd.get("price") as string).trim()
    const unit = (fd.get("unit") as string).trim()

    if (!specName) {
      toast.error("请输入商品名称")
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
    if (!unit) {
      toast.error("请输入单位")
      return
    }

    const specialPrice = (fd.get("specialPrice") as string).trim() || null
    const serviceFee = (fd.get("serviceFee") as string).trim() || "0"
    const sessionCountRaw = (fd.get("sessionCount") as string).trim()
    // 疗程卡默认 1 次（避免漏填导致 session_count=null）；家居产品保持 null
    const sessionCount = sessionCountRaw
      ? parseInt(sessionCountRaw)
      : productType === '疗程卡' ? 1 : null
    const purchaseLimitRaw = (fd.get("purchaseLimit") as string).trim()
    const purchaseLimit = purchaseLimitRaw ? Number(purchaseLimitRaw) : null
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
        unit,
        purchaseLimit,
        sortOrder,
        serviceFee,
        isShengmei,
        isExperience,
        isManagerSpecial,
        projectSeriesId,
        marketScope: allMarkets ? null : (selectedMarketIds.length > 0 ? selectedMarketIds.join(',') : ""),
        isEnabled,
      })
      if (!result.success) {
        toast.error(result.message)
        return
      }
      setFormDirty(false)
      toast.success("商品创建成功")
      router.push("/products")
    } catch (err) {
      toast.error(actionErrorMessage(err, "创建失败，请稍后重试"))
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
              <Input name="specName" placeholder="请输入商品名称" />
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
              <Select
                name="productType"
                value={productType}
                onChange={(e) => handleProductTypeChange(e.target.value as "疗程卡" | "家居产品")}
              >
                <option value="" disabled>请选择</option>
                <option value="疗程卡">疗程卡</option>
                <option value="家居产品">家居产品</option>
              </Select>
            </div>
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
            <div className="space-y-2">
              <label className="text-sm font-medium">经营类型</label>
              <Input value={selectedCategory?.salesCategory ?? "—"} disabled readOnly />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">项目系列</label>
              <Select
                value={projectSeriesId === null ? "" : String(projectSeriesId)}
                onChange={(e) => {
                  const v = e.target.value
                  setProjectSeriesId(v === "" ? null : Number(v))
                  setFormDirty(true)
                }}
              >
                <option value="">未设置</option>
                {projectSeriesOptions.map((s) => (
                  <option key={s.id} value={String(s.id)}>{s.name}</option>
                ))}
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

      {/* 疗程数量、单位与排序 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">疗程数量、单位与排序</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">疗程数量</label>
              <Input name="sessionCount" type="number" min={1} placeholder={`疗程卡不填默认 1${unit || "次"}`} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">单位</label>
              <Input
                name="unit"
                value={unit}
                maxLength={10}
                placeholder="选择产品类型后自动填写"
                onChange={(e) => setUnit(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">限购次数</label>
              <Input name="purchaseLimit" type="number" min={1} step={1} placeholder="不填则不限购" />
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
          <div className="space-y-3">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="isEnabled"
                defaultChecked
                className="h-4 w-4 rounded border-[var(--input)]"
              />
              <span className="text-sm">启用</span>
            </label>

            <div className="space-y-1">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={isExperience}
                  onChange={(e) => { setIsExperience(e.target.checked); setFormDirty(true) }}
                  className="h-4 w-4 rounded border-[var(--input)]"
                />
                <span className="text-sm font-medium">体验卡商品</span>
              </label>
              <p className="pl-6 text-xs text-[var(--muted-foreground)]">
                勾选后该商品仅在小程序体验卡入口展示，不出现在商城；现有订单的快照不受改动影响
              </p>
            </div>

            <div className="space-y-1">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={isManagerSpecial}
                  onChange={(e) => { setIsManagerSpecial(e.target.checked); setFormDirty(true) }}
                  className="h-4 w-4 rounded border-[var(--input)]"
                />
                <span className="text-sm font-medium">店长特别优惠</span>
              </label>
              <p className="pl-6 text-xs text-[var(--muted-foreground)]">
                勾选后店长在开单（销售单·普通商品）时可手动修改该商品的应付金额（最低 0，不超过标价）；组合套餐不适用
              </p>
            </div>

            {/* 充值卡已退出 SKU/商品域（2026-05-20），无需勾选项；充值订单走独立入口 */}
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
