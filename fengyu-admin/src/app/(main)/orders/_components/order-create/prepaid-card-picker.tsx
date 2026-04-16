"use client"

/**
 * 充值卡 picker（PR-C C1）
 *
 * 充值卡是面值型 SKU，UI 平铺成"金额按钮组"。每个 SKU 卡片把价格作为主视觉，
 * 点击直接加入购物车。无分类导航。
 */
import type { Product } from "@/lib/types"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { pickerSkuToProductSku, type NormalKindPickerProps } from "./types"

export function PrepaidCardPicker({ categories, onAdd }: NormalKindPickerProps) {
  const allSkus = categories.flatMap((c) => c.skus)

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <h3 className="text-sm font-semibold text-[#999999]">充值卡面值</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
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
              isEnabled: true,
              isVisible: true,
              createdAt: '',
              updatedAt: '',
            }
            const displayPrice = sku.specialPrice || sku.price
            return (
              <button
                key={sku.skuId}
                type="button"
                onClick={() => onAdd(fakeProduct, pickerSkuToProductSku(sku))}
                className="bg-[#FAFAFA] rounded-lg border border-[var(--border)] hover:border-[var(--primary)] hover:bg-[#FFF0EE] transition-colors p-4 flex flex-col items-center gap-1"
              >
                <span className="text-2xl font-bold text-[var(--primary)]">¥{displayPrice}</span>
                <span className="text-xs text-[#666666]">{sku.specName}</span>
                <Button size="sm" variant="outline" className="h-6 text-xs px-2 mt-1 pointer-events-none">
                  加入
                </Button>
              </button>
            )
          })}
          {allSkus.length === 0 && (
            <p className="text-sm text-[#999999] py-8 text-center col-span-4">暂无可选充值卡</p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
