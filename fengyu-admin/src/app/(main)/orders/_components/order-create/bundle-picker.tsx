"use client"

/**
 * 组合套餐 picker（PR-C C1）
 *
 * 数据源：getProductsByKind('__bundle__').bundles[]
 *
 * 阶段一基础形态（参考 ticket §5 第一行风险妥协）：
 * - 套餐右侧"加入套餐"按钮 → 把套餐内"未分组 + 各分组下 pickCount=null 的全部 SKU"
 *   一次性加入购物车，使用 bundlePrice（套餐价）作为 specialPrice。
 * - 当套餐定义了 pickCount=N（N 选 M）的分组时，弹出"分组选择"区域让用户在该
 *   分组内勾选 N 个 SKU 后再加入。基础阶段：分组列表用 checkbox 选 N 个，超过
 *   不让选；满 N 后点"加入套餐"按钮才生效。
 * - N 选 M 复杂校验（如跨多组、依赖其他组完成度）留待后续 ticket。
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

function BundleRow({ bundle, onAdd, onBundleAdded }: BundleRowProps) {
  // 各 N 选 M 分组的当前选择状态：groupId → Set<skuId>
  const pickGroups = useMemo(
    () => bundle.groups.filter((g) => g.pickCount != null && g.pickCount > 0),
    [bundle.groups],
  )
  const allSelectGroups = useMemo(
    () => bundle.groups.filter((g) => g.pickCount == null),
    [bundle.groups],
  )

  const [selections, setSelections] = useState<Record<number, Set<string>>>({})

  const toggleSelect = (groupId: number, skuId: string, max: number) => {
    setSelections((prev) => {
      const cur = new Set(prev[groupId] ?? [])
      if (cur.has(skuId)) {
        cur.delete(skuId)
      } else {
        if (cur.size >= max) {
          toast.error(`该分组最多选 ${max} 个`)
          return prev
        }
        cur.add(skuId)
      }
      return { ...prev, [groupId]: cur }
    })
  }

  const handleAddBundle = () => {
    // 校验：每个 N 选 M 分组必须满 pickCount
    for (const g of pickGroups) {
      const sel = selections[g.id]
      if ((sel?.size ?? 0) !== (g.pickCount ?? 0)) {
        toast.error(`「${g.groupName}」需选 ${g.pickCount} 项`)
        return
      }
    }

    // 收集要加入的 SKU：未分组 + 全选分组 + N 选 M 已选
    const toAdd: OrderPickerBundleSkuRef[] = []
    toAdd.push(...bundle.ungroupedSkus)
    for (const g of allSelectGroups) toAdd.push(...g.skus)
    for (const g of pickGroups) {
      const sel = selections[g.id] ?? new Set<string>()
      toAdd.push(...g.skus.filter((s) => sel.has(s.skuId)))
    }

    if (toAdd.length === 0) {
      toast.error("该套餐暂无可加购规格")
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
      const skus = toAdd.map((ref) => bundleSkuToProductSku(ref))
      onBundleAdded({ product: fakeProduct, skus })
    } else {
      // 兼容分支：未提供一次性回调时走 addToCart 循环（保留既有单测路径）
      for (const ref of toAdd) {
        onAdd(fakeProduct, bundleSkuToProductSku(ref))
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

        {/* N 选 M 分组（交互式） */}
        {pickGroups.map((g) => {
          const sel = selections[g.id] ?? new Set<string>()
          return (
            <div key={g.id}>
              <Separator />
              <p className="text-xs font-medium text-[#666666] my-2">
                「{g.groupName}」请选 {g.pickCount} 项（已选 {sel.size}/{g.pickCount}）
              </p>
              <div className="space-y-1">
                {g.skus.map((s) => {
                  const checked = sel.has(s.skuId)
                  return (
                    <label
                      key={s.skuId}
                      className={`flex items-center justify-between text-xs px-2 py-1 rounded cursor-pointer ${
                        checked ? "bg-[#FFF0EE]" : "hover:bg-gray-100"
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleSelect(g.id, s.skuId, g.pickCount ?? 1)}
                        />
                        {s.specName}
                      </span>
                      <span className="text-[#999999]">套餐价 ¥{s.bundlePrice ?? s.price}</span>
                    </label>
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
