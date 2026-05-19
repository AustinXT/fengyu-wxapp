"use client"

/**
 * 充值卡 picker
 *
 * 两类档位来源：
 *  A) 真实 SKU 档位 — 来自 `getRechargeCardSkus()`（is_recharge_card=true）：
 *     - skuId = product_skus.sku_id（真实 SKU）
 *     - productName / skuSpecName / productType / price 全部走 SKU 实际值
 *     - 后端 createOrder 真实 SKU 分支查 DB 验 unitRealPrice 防篡改
 *  B) 档位快选（虚拟 SKU） — 沿用 `@/lib/recharge` 静态 RECHARGE_TIERS：
 *     - skuId 强制为 RECHARGE_VIRTUAL_SKU_ID
 *     - productName = `预付充值卡 ¥{faceValue}` → payNotify / staff order.js /
 *       admin applyRechargeOnOrderPaid 从该字段正则解析面值
 *     - 后端 createOrder 虚拟 SKU 分支保留 matchTier 校验 + 字段强制覆盖
 *
 * 每单仅 1 笔（quantity 固定 1，混单校验在 order-create-page 侧）。
 *
 * onAdd 沿用通用 (product, sku) 签名：父级 addToCart 将其作为 CartItem。
 */
import { useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import {
  RECHARGE_TIERS,
  RECHARGE_MIN_AMOUNT,
  RECHARGE_MAX_AMOUNT,
  RECHARGE_VIRTUAL_SKU_ID,
  matchTier,
} from "@/lib/recharge"
import type { Product, ProductSku } from "@/lib/types"
import type { RechargeCardSku } from "@/actions/cards"

export interface PrepaidCardPickerProps {
  onAdd: (product: Product, sku: ProductSku) => void
  /** 真实 is_recharge_card=true SKU 档位（来自 SSR fetch；失败时父组件传空数组） */
  realSkus?: RechargeCardSku[]
}

function buildRechargeAddPayload(faceValue: number): { product: Product; sku: ProductSku } {
  const { payAmount } = matchTier(faceValue)
  const priceStr = payAmount.toFixed(2)
  const product: Product = {
    productId: RECHARGE_VIRTUAL_SKU_ID,
    categoryId: '',
    name: `预付充值卡 ¥${faceValue}`,
    coverImage: null,
    detailImages: null,
    description: null,
    isBundle: false,
    price: priceStr,
    specialPrice: null,
    manageScope: null,
    marketScope: null,
    sortOrder: 0,
    isVisible: true,
    createdAt: '',
    updatedAt: '',
  }
  const sku: ProductSku = {
    skuId: RECHARGE_VIRTUAL_SKU_ID,
    categoryId: '',
    productType: '家居产品',
    specName: '预付充值卡（虚拟）',
    price: priceStr,
    specialPrice: null,
    sessionCount: null,
    sortOrder: 0,
    serviceFee: '0',
    isShengmei: null,
    // 2026-04-26 ticket：充值卡 capability 列 — 后端创建订单时按本字段判定，
    // 取代旧的 sku.skuId === RECHARGE_VIRTUAL_SKU_ID 字面量
    isRechargeCard: true,
    marketScope: null,
    isEnabled: true,
    createdAt: '',
    updatedAt: '',
  }
  return { product, sku }
}

/**
 * 真实 SKU 路径 → (product, sku) payload
 *
 * 关键区别于虚拟 SKU 路径：
 *  - skuId / productName / skuSpecName / productType 全部使用真实 SKU 字段
 *  - 后端 createOrder 真实 SKU 分支查 DB 比对，不强制覆盖
 *  - applyRechargeOnOrderPaid 从 product_skus.price 取面值（无需 product_name 兜底）
 */
function buildRealRechargePayload(realSku: RechargeCardSku): { product: Product; sku: ProductSku } {
  const priceStr = realSku.payAmount.toFixed(2)
  const faceValueStr = realSku.faceValue.toFixed(2)
  const product: Product = {
    productId: realSku.skuId,
    categoryId: realSku.categoryId,
    name: realSku.specName,
    coverImage: null,
    detailImages: null,
    description: null,
    isBundle: false,
    price: faceValueStr,
    specialPrice: realSku.bonus > 0 ? priceStr : null,
    manageScope: null,
    marketScope: null,
    sortOrder: 0,
    isVisible: true,
    createdAt: '',
    updatedAt: '',
  }
  const sku: ProductSku = {
    skuId: realSku.skuId,
    categoryId: realSku.categoryId,
    productType: realSku.productType as ProductSku['productType'],
    specName: realSku.specName,
    price: faceValueStr,
    specialPrice: realSku.bonus > 0 ? priceStr : null,
    sessionCount: null,
    sortOrder: 0,
    serviceFee: '0',
    isShengmei: null,
    isRechargeCard: true,
    marketScope: null,
    isEnabled: true,
    createdAt: '',
    updatedAt: '',
  }
  return { product, sku }
}

export function PrepaidCardPicker({ onAdd, realSkus = [] }: PrepaidCardPickerProps) {
  const [customAmount, setCustomAmount] = useState("")
  const [customError, setCustomError] = useState<string | null>(null)

  const handleRealSkuClick = (realSku: RechargeCardSku) => {
    const { product, sku } = buildRealRechargePayload(realSku)
    onAdd(product, sku)
  }

  const handleTierClick = (faceValue: number) => {
    const { product, sku } = buildRechargeAddPayload(faceValue)
    onAdd(product, sku)
  }

  const handleCustomAdd = () => {
    setCustomError(null)
    const amount = Number(customAmount)
    if (!customAmount || !Number.isFinite(amount)) {
      setCustomError("请输入有效金额")
      return
    }
    try {
      // matchTier 会校验小数位 / 区间；错误消息带 INVALID_PARAMS: 前缀
      matchTier(amount)
    } catch (err: any) {
      const msg = err?.message?.startsWith('INVALID_PARAMS:')
        ? err.message.replace(/^INVALID_PARAMS:\s*/, '')
        : '金额不合法'
      setCustomError(msg)
      return
    }
    const { product, sku } = buildRechargeAddPayload(amount)
    onAdd(product, sku)
    setCustomAmount("")
  }

  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        {realSkus.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-[#999999] mb-3">真实 SKU 档位</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {realSkus.map((realSku) => (
                <button
                  key={realSku.skuId}
                  type="button"
                  onClick={() => handleRealSkuClick(realSku)}
                  className="bg-[#FAFAFA] rounded-lg border border-[var(--border)] hover:border-[var(--primary)] hover:bg-[#FFF0EE] transition-colors p-4 flex flex-col items-center gap-1 relative"
                >
                  {realSku.bonus > 0 && (
                    <span className="absolute top-1 right-1 text-[10px] font-medium text-white bg-[var(--primary)] rounded px-1.5 py-0.5">
                      送 ¥{realSku.bonus}
                    </span>
                  )}
                  <span className="text-xs text-[#999999] line-clamp-1 max-w-full">
                    {realSku.specName}
                  </span>
                  <span className="text-2xl font-bold text-[var(--primary)]">
                    ¥{realSku.faceValue}
                  </span>
                  <span className="text-xs text-[#666666]">
                    实付 ¥{realSku.payAmount}
                  </span>
                  <span
                    className={cn(
                      buttonVariants({ size: "sm", variant: "outline" }),
                      "h-6 text-xs px-2 mt-1 pointer-events-none"
                    )}
                  >
                    加入
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className={realSkus.length > 0 ? 'border-t border-[var(--border)] pt-4' : undefined}>
          <h3 className="text-sm font-semibold text-[#999999] mb-3">
            {realSkus.length > 0 ? '档位快选（默认）' : '档位快选'}
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {RECHARGE_TIERS.map((tier) => {
              const { payAmount } = matchTier(tier.faceValue)
              const discountLabel = (tier.discount * 10).toFixed(1).replace(/\.0$/, '')
              return (
                <button
                  key={tier.faceValue}
                  type="button"
                  onClick={() => handleTierClick(tier.faceValue)}
                  className="bg-[#FAFAFA] rounded-lg border border-[var(--border)] hover:border-[var(--primary)] hover:bg-[#FFF0EE] transition-colors p-4 flex flex-col items-center gap-1"
                >
                  <span className="text-2xl font-bold text-[var(--primary)]">
                    ¥{tier.faceValue}
                  </span>
                  <span className="text-xs text-[#666666]">
                    {discountLabel} 折 · 实付 ¥{payAmount}
                  </span>
                  <span
                    className={cn(
                      buttonVariants({ size: "sm", variant: "outline" }),
                      "h-6 text-xs px-2 mt-1 pointer-events-none"
                    )}
                  >
                    加入
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        <div className="border-t border-[var(--border)] pt-4">
          <h3 className="text-sm font-semibold text-[#999999] mb-2">自定义金额</h3>
          <div className="flex items-start gap-2">
            <div className="flex-1">
              <Input
                type="number"
                inputMode="decimal"
                placeholder={`¥${RECHARGE_MIN_AMOUNT} - ¥${RECHARGE_MAX_AMOUNT}`}
                value={customAmount}
                onChange={(e) => {
                  setCustomAmount(e.target.value)
                  setCustomError(null)
                }}
              />
              {customError ? (
                <p className="text-xs text-[#D94040] mt-1">{customError}</p>
              ) : customAmount && Number.isFinite(Number(customAmount)) ? (
                (() => {
                  try {
                    const { discount, payAmount } = matchTier(Number(customAmount))
                    const label = (discount * 10).toFixed(1).replace(/\.0$/, '')
                    return (
                      <p className="text-xs text-[#666666] mt-1">
                        匹配档位 {label} 折 · 实付 ¥{payAmount}
                      </p>
                    )
                  } catch {
                    return null
                  }
                })()
              ) : (
                <p className="text-xs text-[#999999] mt-1">
                  500-999 → 9.9 折 · 1000-4999 → 9.8 折 · ≥5000 → 9.5 折
                </p>
              )}
            </div>
            <Button type="button" onClick={handleCustomAdd}>
              加入
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
