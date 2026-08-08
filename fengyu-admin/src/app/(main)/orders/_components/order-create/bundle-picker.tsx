"use client"

/**
 * 组合套餐 picker（PR-C C1）
 *
 * 数据源：getProductsByKind('__bundle__').bundles[]
 *
 * 阶段一基础形态（参考 ticket §5 第一行风险妥协）：
 * - 套餐右侧"加入套餐"按钮 → 把套餐内"未分组 + 各分组下 pickCount=null 的全部 SKU"
 *   一次性加入购物车，使用 bundlePrice（套餐价）作为 specialPrice。
 * - 当套餐定义了 pickCount=N（选N项）的分组时，分组内每个 SKU 提供数量步进器，
 *   允许同一 SKU 选多次；N 按"组内各 SKU 数量之和"统计（非种类数），合计满 N 才可加入。
 * - 落库：前端只按 SKU 传 quantity=N，后端既有 B2 拆行规则处理
 *   （疗程卡 quantity>1 拆 N 行 / 家居产品合 1 行），无需后端改动。
 */
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
  /** 一次性回调（组合套餐分支走替换 cart + 跳转确认页） */
  onBundleAdded?: (payload: BundleAddPayload) => void
}

function purchaseLimitMessage(ref: Pick<OrderPickerBundleSkuRef, 'specName' | 'purchaseLimit'>): string {
  return `${ref.specName} 每单最多可购买 ${ref.purchaseLimit} 件`
}

function findBundlePurchaseLimitViolation(
  items: Array<{ ref: OrderPickerBundleSkuRef; quantity: number }>,
): OrderPickerBundleSkuRef | null {
  const totals = new Map<string, { ref: OrderPickerBundleSkuRef; quantity: number }>()
  for (const item of items) {
    const current = totals.get(item.ref.skuId)
    totals.set(item.ref.skuId, {
      ref: item.ref,
      quantity: (current?.quantity ?? 0) + item.quantity,
    })
  }
  for (const row of totals.values()) {
    if (row.ref.purchaseLimit != null && row.quantity > row.ref.purchaseLimit) return row.ref
  }
  return null
}

function BundleRow({ bundle, onAdd, onBundleAdded }: BundleRowProps) {
  // 各「选N项」分组的当前选择状态：groupId → { skuId → 数量 }
  const pickGroups = useMemo(
    () => bundle.groups.filter((g) => g.pickCount != null && g.pickCount > 0),
    [bundle.groups],
  )
  const allSelectGroups = useMemo(
    () => bundle.groups.filter((g) => g.pickCount == null),
    [bundle.groups],
  )

  const [selections, setSelections] = useState<Record<number, Record<string, number>>>({})

  // 组内已选数量合计（N 按数量统计，非种类数）
  const groupTotal = (groupId: number): number =>
    Object.values(selections[groupId] ?? {}).reduce((s, q) => s + q, 0)

  const incSku = (groupId: number, sku: OrderPickerBundleSkuRef, pickCount: number) => {
    if (groupTotal(groupId) >= pickCount) {
      toast.error(`该分组共选 ${pickCount} 项`)
      return
    }
    const currentQty = selections[groupId]?.[sku.skuId] ?? 0
    if (sku.purchaseLimit != null && currentQty + 1 > sku.purchaseLimit) {
      toast.error(purchaseLimitMessage(sku))
      return
    }
    setSelections((prev) => {
      const cur = { ...(prev[groupId] ?? {}) }
      cur[sku.skuId] = (cur[sku.skuId] ?? 0) + 1
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
    // 校验：每个「选N项」分组的数量合计必须 === pickCount
    for (const g of pickGroups) {
      if (groupTotal(g.id) !== (g.pickCount ?? 0)) {
        toast.error(`「${g.groupName}」需选 ${g.pickCount} 项`)
        return
      }
    }

    // 收集要加入的 SKU + 数量：未分组 + 全选分组各 1 份；选N项分组按已选数量
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
    const violation = findBundlePurchaseLimitViolation(toAdd)
    if (violation) {
      toast.error(purchaseLimitMessage(violation))
      return
    }

    // 套餐封面占位 product：cart 显示套餐名 + 子规格
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
      // 一次性替换分支：父级负责清空旧 cart + 填入新套餐 + 跳 Step 3
      const items = toAdd.map(({ ref, quantity }) => ({ sku: bundleSkuToProductSku(ref), quantity }))
      onBundleAdded({ bundleProductId: bundle.productId, product: fakeProduct, items })
    } else {
      // 兼容分支：未提供一次性回调时走 addToCart 循环（保留既有单测路径）。
      // page 的 addToCart 按 skuId 累加，故同一 SKU 调 quantity 次等价 quantity=N。
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

        {/* 未分组 SKU 展示（信息性） */}
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

        {/* 全选分组（信息性） */}
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

        {/* 选N项分组（交互式数量步进器，同一 SKU 可选多次，N 按数量合计） */}
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
                  const limitReached = s.purchaseLimit != null && qty >= s.purchaseLimit
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
                          disabled={full || limitReached}
                          onClick={() => incSku(g.id, s, pickCount)}
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
