"use client"


import { useEffect, useMemo } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import type { HeldCardCandidate } from "@/actions/cards"

export interface ConversionPanelProps {
  
  loading: boolean
  
  heldCards: HeldCardCandidate[]
  
  selectedIds: string[]
  
  onChange: (ids: string[]) => void
  
  totalIn: number
  
  cardBalance?: number
  
  useCard?: boolean
  
  cardAmountInput?: string
  
  cardAmount?: number
  
  onToggleCard?: (checked: boolean) => void
  
  onCardAmountChange?: (v: string) => void
}

export function ConversionPanel({
  loading,
  heldCards,
  selectedIds,
  onChange,
  totalIn,
  cardBalance = 0,
  useCard = false,
  cardAmountInput = "",
  cardAmount = 0,
  onToggleCard,
  onCardAmountChange,
}: ConversionPanelProps) {
  
  useEffect(() => {
    const validIds = new Set(heldCards.map((c) => c.saleItemId))
    const filtered = selectedIds.filter((id) => validIds.has(id))
    if (filtered.length !== selectedIds.length) {
      onChange(filtered)
    }
  }, [heldCards, selectedIds, onChange])

  const totalOut = useMemo(() => {
    let sum = 0
    const set = new Set(selectedIds)
    for (const c of heldCards) {
      if (set.has(c.saleItemId)) sum += Number(c.deductibleAmount)
    }
    return Math.round(sum * 100) / 100
  }, [heldCards, selectedIds])

  const priceDiff = Math.round((totalIn - totalOut) * 100) / 100

  const toggle = (id: string) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((x) => x !== id))
    } else {
      onChange([...selectedIds, id])
    }
  }

  return (
    <Card className="bg-[#FAFAFA]">
      <CardContent className="p-4 space-y-4">
        <h3 className="text-sm font-semibold">转换单结算</h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {}
          <div className="space-y-2">
            <p className="text-xs text-[#666666]">勾选折抵卡（整张全转）</p>
            {loading && (
              <p className="text-xs text-[#999999] py-4 text-center">正在加载候选卡…</p>
            )}
            {!loading && heldCards.length === 0 && (
              <p className="text-xs text-[#999999] py-4 text-center">该顾客在当前门店无可折抵卡</p>
            )}
            <div className="space-y-1 max-h-72 overflow-y-auto">
              {heldCards.map((c) => {
                const checked = selectedIds.includes(c.saleItemId)
                const remainLabel =
                  c.productType === '疗程卡'
                    ? `剩 ${c.remainingSessions ?? 0} 次`
                    : `剩 ${c.remainingQty ?? 0} 件`
                return (
                  <label
                    key={c.saleItemId}
                    className={`flex items-start gap-2 p-2 rounded cursor-pointer text-xs border ${
                      checked
                        ? "border-[var(--primary)] bg-[#FFF0EE]"
                        : "border-transparent hover:bg-white"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={checked}
                      onChange={() => toggle(c.saleItemId)}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium truncate">
                          {c.productName ?? c.saleItemId}
                        </span>
                        <span className="text-[var(--primary)] font-semibold shrink-0">
                          ¥{c.deductibleAmount}
                        </span>
                      </div>
                      <div className="text-[#999999] mt-0.5 flex items-center gap-2">
                        <span>{c.productType}</span>
                        <span>{remainLabel}</span>
                        <span>单次价 ¥{c.unitRealPrice}</span>
                      </div>
                    </div>
                  </label>
                )
              })}
            </div>
          </div>

          {}
          <div className="space-y-3">
            <p className="text-xs text-[#666666]">差额预览</p>
            <div className="bg-white rounded border border-[var(--border)] p-3 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-[#666666]">应付（购物车合计）</span>
                <span className="font-medium">¥{totalIn.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-[#666666]">折抵（已选卡）</span>
                <span className="font-medium">¥{totalOut.toFixed(2)}</span>
              </div>
              <Separator />
              <div className="flex justify-between text-sm">
                <span className="text-[#666666]">差额</span>
                <span className="font-medium">¥{priceDiff.toFixed(2)}</span>
              </div>
            </div>

            {}
            {priceDiff > 0 && (
              <div className="bg-white rounded border border-[var(--border)] p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-[var(--foreground)]">充值卡抵扣</div>
                    <div className="text-xs text-[#999999] mt-0.5">余额 ¥{cardBalance.toFixed(2)}</div>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={useCard}
                      disabled={cardBalance <= 0}
                      onChange={(e) => onToggleCard?.(e.target.checked)}
                      className="h-4 w-4"
                    />
                    <span className={`text-xs ${cardBalance <= 0 ? 'text-[#cccccc]' : 'text-[#666666]'}`}>启用</span>
                  </label>
                </div>
                {useCard && cardBalance > 0 && (
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-xs text-[#999999]">抵扣金额</span>
                    <input
                      type="number"
                      min="0"
                      max={Math.min(cardBalance, priceDiff)}
                      step="0.01"
                      className="h-8 text-sm w-32 border border-[var(--border)] rounded px-2"
                      placeholder={`留空=¥${Math.min(cardBalance, priceDiff).toFixed(2)}`}
                      value={cardAmountInput}
                      onChange={(e) => onCardAmountChange?.(e.target.value)}
                    />
                    <span className="text-xs text-[#3D8A5A]">实际抵扣 ¥{cardAmount.toFixed(2)}</span>
                  </div>
                )}
              </div>
            )}

            <div className="text-sm text-center">
              {priceDiff > 0 && cardAmount > 0 && priceDiff - cardAmount <= 0.005 && (
                <p className="text-[#3D8A5A] font-semibold">储值卡全额抵扣 ¥{cardAmount.toFixed(2)}，无需补款</p>
              )}
              {priceDiff > 0 && priceDiff - cardAmount > 0.005 && (
                <p className="text-[#D94040] font-semibold">
                  {cardAmount > 0 ? `储值卡抵扣 ¥${cardAmount.toFixed(2)}，` : ''}还需支付 ¥{(priceDiff - cardAmount).toFixed(2)}
                </p>
              )}
              {priceDiff === 0 && (
                <p className="text-[#3D8A5A] font-semibold">折抵抵平，无需补款</p>
              )}
              {priceDiff < 0 && (
                <p className="text-[#5E8BB3] font-semibold">
                  将充入储值卡 ¥{Math.abs(priceDiff).toFixed(2)}
                </p>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
