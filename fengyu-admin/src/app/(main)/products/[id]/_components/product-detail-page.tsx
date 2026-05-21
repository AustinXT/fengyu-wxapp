"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useUnsavedChanges } from "@/lib/hooks/use-unsaved-changes"
import type { ProductSku, ProductCategory, ProjectSeries } from "@/lib/types"
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
  projectSeriesOptions,
}: {
  sku: ProductSku
  categories: ProductCategory[]
  markets: Market[]
  projectSeriesOptions: ProjectSeries[]
}) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [formDirty, setFormDirty] = useState(false)
  useUnsavedChanges(formDirty)
  const [categoryId, setCategoryId] = useState(sku.categoryId)
  const [projectSeriesId, setProjectSeriesId] = useState<number | null>(sku.projectSeriesId ?? null)

  const [isShengmei, setIsShengmei] = useState<boolean>(sku.isShengmei ?? false)
  const [isExperience, setIsExperience] = useState<boolean>(sku.isExperience ?? false)
  const [allMarkets, setAllMarkets] = useState(!sku.marketScope)
  const [selectedMarketIds, setSelectedMarketIds] = useState<string[]>(
    sku.marketScope ? sku.marketScope.split(',') : []
  )

  // Delete dialog state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const selectedCategory = categories.find(c => c.categoryId === categoryId)

  const handleCategoryChange = (id: string) => {
    setCategoryId(id)
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

    const specialPrice = (fd.get("specialPrice") as string).trim() || null
    const serviceFee = (fd.get("serviceFee") as string).trim() || "0"
    const sessionCountRaw = (fd.get("sessionCount") as string).trim()
    const sessionCount = sessionCountRaw ? parseInt(sessionCountRaw) : null
    const sortOrder = parseInt(fd.get("sortOrder") as string) || 0
    const isEnabled = fd.get("isEnabled") === "on"

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
        isShengmei,
        isExperience,
        projectSeriesId,
        marketScope: allMarkets ? null : (selectedMarketIds.length > 0 ? selectedMarketIds.join(',') : null),
        isEnabled,
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
      toast.success("商品已删除")
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
            商品详情 - {sku.specName}
          </h1>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="text-[var(--destructive)] border-[var(--destructive)]"
          onClick={() => setDeleteDialogOpen(true)}
        >
          删除商品
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
                <label className="text-sm font-medium">商品名称</label>
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
                  placeholder="疗程卡必填（单次填 1）"
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
                  defaultChecked={sku.isEnabled}
                  onChange={() => setFormDirty(true)}
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

              {/* 充值卡已退出 SKU/商品域（2026-05-20），无需勾选项；充值订单走独立入口 */}
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
          确定要删除商品「{sku.specName}」吗？此操作不可撤销。
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
