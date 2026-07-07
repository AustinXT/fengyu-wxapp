"use client"


import { useEffect, useMemo, useState } from "react"
import type { Product } from "@/lib/types"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { pickerSkuToProductSku, type NormalGroupPickerProps } from "./types"

export function NormalSkuPicker({ groups, kindLabel, onAdd, buyerIsMember }: NormalGroupPickerProps) {
  
  const renderGroups = useMemo(
    () => groups.filter((g) => g.categories.length > 0),
    [groups],
  )

  
  const allCategoryIds = useMemo(
    () => renderGroups.flatMap((g) => g.categories.map((c) => c.categoryId)),
    [renderGroups],
  )

  const [selectedCategoryId, setSelectedCategoryId] = useState<string>(
    () => renderGroups[0]?.categories[0]?.categoryId ?? "",
  )

  
  useEffect(() => {
    if (allCategoryIds.length === 0) {
      setSelectedCategoryId("")
      return
    }
    if (!allCategoryIds.includes(selectedCategoryId)) {
      setSelectedCategoryId(renderGroups[0].categories[0].categoryId)
    }
  }, [allCategoryIds, renderGroups, selectedCategoryId])

  const currentCategory = useMemo(() => {
    for (const g of renderGroups) {
      const cat = g.categories.find((c) => c.categoryId === selectedCategoryId)
      if (cat) return cat
    }
    return null
  }, [renderGroups, selectedCategoryId])

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
      {}
      <Card className="lg:col-span-1">
        <CardContent className="p-3">
          <h3 className="text-sm font-semibold text-[#999999] mb-2">商品分类</h3>
          <div className="space-y-0.5">
            {renderGroups.map((group) => (
              <div key={group.productKind} className="mb-1">
                {}
                <div
                  className="px-3 py-1 rounded text-xs text-[#888888] bg-[#F7F7F7] select-none"
                  style={{ pointerEvents: 'none' }}
                  aria-disabled="true"
                >
                  {group.productKind}
                </div>
                {}
                {group.categories.map((cat) => (
                  <button
                    key={cat.categoryId}
                    onClick={() => setSelectedCategoryId(cat.categoryId)}
                    className={`w-full text-left px-3 py-1.5 rounded text-sm transition-colors ${
                      selectedCategoryId === cat.categoryId
                        ? "bg-[var(--primary)] text-white font-medium"
                        : "hover:bg-[#FFF0EE] text-[var(--foreground)]"
                    }`}
                  >
                    {cat.categoryName}
                  </button>
                ))}
              </div>
            ))}
            {renderGroups.length === 0 && (
              <p className="text-xs text-[#999999] py-3 text-center">
                {kindLabel} 暂无可选品类
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {}
      <Card className="lg:col-span-3">
        <CardContent className="p-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {currentCategory?.skus.map((sku) => {
              
              const fakeProduct: Product = {
                productId: sku.skuId,
                categoryId: sku.categoryId,
                name: sku.specName.split(" ")[0] || sku.specName,
                coverImage: null,
                detailImages: null,
                description: null,
                isBundle: false,
                price: sku.price,
                specialPrice: sku.specialPrice,
                manageScope: null,
                marketScope: null,
                sortOrder: sku.sortOrder,
                isVisible: true,
                createdAt: '',
                updatedAt: '',
              }
              
              const hasMemberPrice =
                sku.specialPrice != null && sku.specialPrice !== '' && Number(sku.specialPrice) < Number(sku.price)
              const showMemberPrice = buyerIsMember === true && hasMemberPrice
              const displayPrice = showMemberPrice ? sku.specialPrice : sku.price
              return (
                <Card key={sku.skuId} className="bg-[#FAFAFA]">
                  <CardContent className="p-4 space-y-2">
                    <div className="flex justify-between items-start">
                      <h4 className="font-medium text-sm">{sku.specName}</h4>
                      <span className="text-xs text-[#999999]">
                        ¥{displayPrice}
                        {showMemberPrice && (
                          <span className="line-through text-[#999999] ml-1">¥{sku.price}</span>
                        )}
                      </span>
                    </div>
                    <Separator />
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-[#999999]">{sku.productType}{sku.sessionCount ? ` · ${sku.sessionCount}次` : ''}</span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onAdd(fakeProduct, pickerSkuToProductSku(sku))}
                        className="h-6 text-xs px-2"
                      >
                        加入
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
            {(!currentCategory || currentCategory.skus.length === 0) && (
              <p className="text-sm text-[#999999] py-8 text-center col-span-2">
                {currentCategory ? "该分类暂无商品" : `请选择${kindLabel}分类`}
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
