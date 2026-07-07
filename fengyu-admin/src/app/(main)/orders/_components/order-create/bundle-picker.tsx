"use client"


import { useMemo, useState } from "react"
import { toast } from "sonner"
import type { Product, ProductSku } from "@/lib/types"
import type { OrderPickerBundle, OrderPickerBundleSkuRef } from "@/actions/products"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { bundleSkuToProductSku, type BundleAddPayload, type BundlePickerProps } from "./types"

interface BundleRowProps {
  bundle: OrderPickerBundle
  onAdd: (product: Product, sku: ProductSku) => void
  
  onBundleAdded?: (payload: BundleAddPayload) => void
}

function BundleRow({ bundle, onAdd, onBundleAdded }: BundleRowProps) {
  
  const pickGroups = useMemo(
    () => bundle.groups.filter((g) => g.pickCount != null && g.pickCount > 0),
    [bundle.groups],
  )
  const allSelectGroups = useMemo(
    () => bundle.groups.filter((g) => g.pickCount == null),
    [bundle.groups],
  )

  const [selections, setSelections] = useState<Record<number, Record<string, number>>>({})

  
  const groupTotal = (groupId: number): number =>
    Object.values(selections[groupId] ?? {}).reduce((s, q) => s + q, 0)

  const incSku = (groupId: number, skuId: string, pickCount: number) => {
    if (groupTotal(groupId) >= pickCount) {
      toast.error(`该分组共选 ${pickCount} 项`)
      return
    }
    setSelections((prev) => {
      const cur = { ...(prev[groupId] ?? {}) }
      cur[skuId] = (cur[skuId] ?? 0) + 1
      return { ...prev, [groupId]: cur }
    })
  }

  const decSku = (groupId: number, skuId: string) => {
    setSelections((prev) => {
      const cur = { ...(prev[groupId] ?? {}) }
      const next = (cur[skuId] ?? 0) - 1
      if (next > 0) cur[skuId] = next
      else delete cur[skuId]
      return { ...prev, [groupId]: cur }
    })
  }

  const handleAddBundle = () => {
    
    for (const g of pickGroups) {
      if (groupTotal(g.id) !== (g.pickCount ?? 0)) {
        toast.error(`「${g.groupName}」需选 ${g.pickCount} 项`)
        return
      }
    }

    
    const toAdd: { ref: OrderPickerBundleSkuRef; quantity: number }[] = []
    for (const ref of bundle.ungroupedSkus) toAdd.push({ ref, quantity: 1 })
    for (const g of allSelectGroups) for (const ref of g.skus) toAdd.push({ ref, quantity: 1 })
    for (const g of pickGroups) {
      const sel = selections[g.id] ?? {}
      for (const ref of g.skus) {
        const qty = sel[ref.skuId] ?? 0
        if (qty > 0) toAdd.push({ ref, quantity: qty })
      }
    }

    if (toAdd.length === 0) {
      toast.error("该套餐暂无可加购规格")
      return
    }

    
    const fakeProduct: Product = {
      productId: bundle.productId,
      categoryId: '',
      name: bundle.name,
      coverImage: bundle.coverImage,
      detailImages: null,
      description: null,
      isBundle: true,
      price: bundle.price,
      specialPrice: bundle.specialPrice,
      manageScope: null,
      marketScope: null,
      sortOrder: bundle.sortOrder,
      isVisible: true,
      createdAt: '',
      updatedAt: '',
    }

    if (onBundleAdded) {
      
      const items = toAdd.map(({ ref, quantity }) => ({ sku: bundleSkuToProductSku(ref), quantity }))
      onBundleAdded({ product: fakeProduct, items })
    } else {
      
      
      for (const { ref, quantity } of toAdd) {
        const sku = bundleSkuToProductSku(ref)
        for (let i = 0; i < quantity; i++) onAdd(fakeProduct, sku)
      }
    }

    setSelections({})
    toast.success(`已加入套餐「${bundle.name}」`)
  }

  return (
    <Card className="bg-[#FAFAFA]">
      <CardContent className="p-4 space-y-3">
        <div className="flex justify-between items-start gap-3">
          <div className="flex-1">
            <h4 className="font-medium text-sm">{bundle.name}</h4>
            <p className="text-xs text-[#999999] mt-1">套餐价 ¥{bundle.specialPrice || bundle.price}</p>
          </div>
          <Button size="sm" onClick={handleAddBundle}>加入套餐</Button>
        </div>

        {}
        {bundle.ungroupedSkus.length > 0 && (
          <>
            <Separator />
            <div className="space-y-1">
              <p className="text-xs text-[#999999]">套餐固定包含：</p>
              {bundle.ungroupedSkus.map((s) => (
                <div key={s.skuId} className="text-xs flex justify-between">
                  <span>{s.specName}</span>
                  <span className="text-[#999999]">套餐价 ¥{s.bundlePrice ?? s.price}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {}
        {allSelectGroups.map((g) => (
          <div key={g.id}>
            <Separator />
            <p className="text-xs text-[#999999] my-2">「{g.groupName}」全部包含：</p>
            <div className="space-y-1">
              {g.skus.map((s) => (
                <div key={s.skuId} className="text-xs flex justify-between">
                  <span>{s.specName}</span>
                  <span className="text-[#999999]">套餐价 ¥{s.bundlePrice ?? s.price}</span>
                </div>
              ))}
            </div>
          </div>
        ))}

        {}
        {pickGroups.map((g) => {
          const pickCount = g.pickCount ?? 0
          const total = groupTotal(g.id)
          const full = total >= pickCount
          return (
            <div key={g.id}>
              <Separator />
              <p className="text-xs font-medium text-[#666666] my-2">
                「{g.groupName}」请选 {pickCount} 项（已选 {total}/{pickCount}）
              </p>
              <div className="space-y-1">
                {g.skus.map((s) => {
                  const qty = selections[g.id]?.[s.skuId] ?? 0
                  return (
                    <div
                      key={s.skuId}
                      className={`flex items-center justify-between text-xs px-2 py-1 rounded ${
                        qty > 0 ? "bg-[#FFF0EE]" : ""
                      }`}
                    >
                      <span className="flex-1 truncate">{s.specName}</span>
                      <span className="text-[#999999] mr-3">套餐价 ¥{s.bundlePrice ?? s.price}</span>
                      <div className="flex items-center border border-[var(--border)] rounded shrink-0">
                        <button
                          type="button"
                          disabled={qty <= 0}
                          onClick={() => decSku(g.id, s.skuId)}
                          className="w-6 h-6 flex items-center justify-center text-[#666666] hover:bg-gray-100 rounded-l transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                        >
                          −
                        </button>
                        <span className="w-7 text-center font-medium">{qty}</span>
                        <button
                          type="button"
                          disabled={full}
                          onClick={() => incSku(g.id, s.skuId, pickCount)}
                          className="w-6 h-6 flex items-center justify-center text-[#666666] hover:bg-gray-100 rounded-r transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                        >
                          +
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

export function BundlePicker({ bundles, onAdd, onBundleAdded }: BundlePickerProps) {
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <h3 className="text-sm font-semibold text-[#999999]">组合套餐</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {bundles.map((b) => (
            <BundleRow key={b.productId} bundle={b} onAdd={onAdd} onBundleAdded={onBundleAdded} />
          ))}
          {bundles.length === 0 && (
            <p className="text-sm text-[#999999] py-8 text-center col-span-2">暂无可选套餐</p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
