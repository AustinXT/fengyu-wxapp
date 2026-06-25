"use client"

/**
 * 体验卡 picker（PR-C C1）
 *
 * 体验卡品类少，无需左侧分类导航，直接平铺成单页 grid。复用 NormalSkuPicker 的
 * SKU 卡片视觉，但去掉分类切换。数据源：getProductsByKind('体验卡').categories
 * 扁平展开成 SKU 数组。
 */
import type { Product } from "@/lib/types"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { pickerSkuToProductSku, type NormalKindPickerProps } from "./types"

export function TrialCardPicker({ categories, onAdd, buyerIsMember }: NormalKindPickerProps) {
  const allSkus = categories.flatMap((c) => c.skus)

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <h3 className="text-sm font-semibold text-[#999999]">体验卡</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {allSkus.map((sku) => {
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
            // 会员价分流（#6=B：体验卡同口径，会员→会员价、非会员→标价）：会员且会员价 < 标价 → 会员价为主 + 划线标价
            const hasMemberPrice =
              sku.specialPrice != null && sku.specialPrice !== '' && Number(sku.specialPrice) < Number(sku.price)
            const showMemberPrice = buyerIsMember === true && hasMemberPrice
            const displayPrice = showMemberPrice ? sku.specialPrice : sku.price
            return (
              <Card key={sku.skuId} className="bg-[#FAFAFA]">
                <CardContent className="p-3 space-y-2">
                  <div className="flex justify-between items-start gap-2">
                    <h4 className="font-medium text-sm flex-1">{sku.specName}</h4>
                    <span className="text-sm text-[var(--primary)] font-semibold">
                      ¥{displayPrice}
                      {showMemberPrice && (
                        <span className="line-through text-[#999999] font-normal ml-1">¥{sku.price}</span>
                      )}
                    </span>
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between text-xs text-[#999999]">
                    <span>{sku.productType}{sku.sessionCount ? ` · ${sku.sessionCount}次` : ''}</span>
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
          {allSkus.length === 0 && (
            <p className="text-sm text-[#999999] py-8 text-center col-span-3">暂无可选体验卡</p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
