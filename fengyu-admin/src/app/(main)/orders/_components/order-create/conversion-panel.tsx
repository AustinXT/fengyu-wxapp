"use client"

/**
 * 转换单结算面板（PR-C C3）
 *
 * 左列：渲染 getCustomerHeldCards(clientUserId, storeId) 返回的折抵候选卡，
 *      每张一行 checkbox + 折抵金额预览。整张卡不可拆，勾选 = 全部转出。
 * 右列：当前购物车合计（应付转入金额） + 实时差额提示。
 * 底部：按差额正负分别显示
 *      - 差额 > 0：红字 "还需支付 ¥X"
 *      - 差额 = 0：绿字 "折抵抵平，无需补款"
 *      - 差额 < 0：蓝字 "将充入储值卡 ¥X"
 *
 * 本组件只负责选卡 + 计算差额并把 selectedIds 通过 onChange 回写父组件，
 * 实际提交（createConversionOrder）在父组件 Step 3 提交按钮触发。
 */
import { useEffect, useMemo } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import type { HeldCardCandidate } from "@/actions/cards"

export interface ConversionPanelProps {
  /** 加载中（父组件正在调用 getCustomerHeldCards） */
  loading: boolean
  /** 候选折抵卡 */
  heldCards: HeldCardCandidate[]
  /** 当前已勾选的 saleItemId 集合 */
  selectedIds: string[]
  /** 勾选变化 */
  onChange: (ids: string[]) => void
  /** 当前购物车应付合计（人民币元） */
  totalIn: number
}

export function ConversionPanel({
  loading,
  heldCards,
  selectedIds,
  onChange,
  totalIn,
}: ConversionPanelProps) {
  // heldCards 变化时清掉不在新列表里的旧选择（如换顾客 / 换门店）
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
          {/* 左列：折抵卡列表 */}
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
                          {c.productName ?? c.skuSpecName ?? c.saleItemId}
                        </span>
                        <span className="text-[var(--primary)] font-semibold shrink-0">
                          ¥{c.deductibleAmount}
                        </span>
                      </div>
                      <div className="text-[#999999] mt-0.5 flex items-center gap-2">
                        <span>{c.productType}</span>
                        <span>{remainLabel}</span>
                        <span>单价 ¥{c.unitRealPrice}</span>
                      </div>
                    </div>
                  </label>
                )
              })}
            </div>
          </div>

          {/* 右列：差额计算 */}
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

            <div className="text-sm text-center">
              {priceDiff > 0 && (
                <p className="text-[#D94040] font-semibold">
                  还需支付 ¥{priceDiff.toFixed(2)}
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
