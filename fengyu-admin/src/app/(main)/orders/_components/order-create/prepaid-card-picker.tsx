"use client"

/**
 * 充值卡 picker（与 client `card.rechargeConfig` / `matchTier` 对齐）
 *
 * 不再依赖真实 SKU 列表；档位与折扣逻辑完全复用 `@/lib/recharge`（与 client
 * `cloudfunctions/clientApi/routes/card.js` 同源）。
 *
 * 下单模型：
 * - skuId 强制为虚拟 SKU `sku-recharge-virtual`
 * - productName = `预付充值卡 ¥{faceValue}` → payNotify / applyRechargeOnOrderPaid
 *   从此字段解析面值
 * - price = specialPrice = unitPrice = payAmount（实付）
 * - 每单仅 1 笔（quantity 固定 1，混单校验在 order-create-page 侧）
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

export interface PrepaidCardPickerProps {
  onAdd: (product: Product, sku: ProductSku) => void
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
    isEnabled: true,
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

export function PrepaidCardPicker({ onAdd }: PrepaidCardPickerProps) {
  const [customAmount, setCustomAmount] = useState("")
  const [customError, setCustomError] = useState<string | null>(null)

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
        <div>
          <h3 className="text-sm font-semibold text-[#999999] mb-3">档位快选</h3>
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
