"use client"

/**
 * 普通商品 picker（PR-C C1）
 *
 * 数据源：getProductsByKind('护理项目' | '家居产品' | '体验卡' | '充值卡') 返回的
 * categories[]。本组件是 4 类 picker 中的"主力"，配套左侧二级分类导航 + 右侧 SKU
 * 卡片网格。普通商品包含 护理项目 + 家居产品（前端层合并）；体验卡 / 充值卡 复用
 * 这套布局，仅传入对应的 categories。
 */
import { useEffect, useState } from "react"
import type { Product } from "@/lib/types"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { pickerSkuToProductSku, type NormalKindPickerProps } from "./types"

export function NormalSkuPicker({ categories, kindLabel, onAdd }: NormalKindPickerProps) {
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>(
    () => categories[0]?.categoryId ?? ""
  )

  // categories 变化（如 kind 切换）时复位选中分类
  useEffect(() => {
    if (categories.length === 0) {
      setSelectedCategoryId("")
      return
    }
    if (!categories.some((c) => c.categoryId === selectedCategoryId)) {
      setSelectedCategoryId(categories[0].categoryId)
    }
  }, [categories, selectedCategoryId])

  const currentCategory = categories.find((c) => c.categoryId === selectedCategoryId)

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
      {/* 左侧二级分类 */}
      <Card className="lg:col-span-1">
        <CardContent className="p-3">
          <h3 className="text-sm font-semibold text-[#999999] mb-2">商品分类</h3>
          <div className="space-y-0.5">
            {categories.map((cat) => (
              <button
                key={cat.categoryId}
                onClick={() => setSelectedCategoryId(cat.categoryId)}
                className={`w-full text-left px-3 py-1.5 rounded text-sm transition-colors ${
                  selectedCategoryId === cat.categoryId
                    ? "bg-[var(--primary)] text-white"
                    : "hover:bg-[#FFF0EE] text-[var(--foreground)]"
                }`}
              >
                {cat.categoryName}
              </button>
            ))}
            {categories.length === 0 && (
              <p className="text-xs text-[#999999] py-3 text-center">
                {kindLabel} 暂无可选品类
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 右侧 SKU 网格 */}
      <Card className="lg:col-span-3">
        <CardContent className="p-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {currentCategory?.skus.map((sku) => {
              // 构造一个最小 Product 让 cart 小计沿用现有 getItemAmounts 逻辑
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
                <Card key={sku.skuId} className="bg-[#FAFAFA]">
                  <CardContent className="p-4 space-y-2">
                    <div className="flex justify-between items-start">
                      <h4 className="font-medium text-sm">{sku.specName}</h4>
                      <span className="text-xs text-[#999999]">¥{displayPrice}</span>
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
