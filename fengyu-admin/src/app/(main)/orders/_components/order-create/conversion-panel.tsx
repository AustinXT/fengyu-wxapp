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
import { useEffect, useMemo, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
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
  /** 顾客充值卡余额（> 0 时在补差额场景渲染抵扣控件） */
  cardBalance?: number
  /** 是否启用充值卡抵扣 */
  useCard?: boolean
  /** 抵扣金额输入框值（受控；默认 0.00） */
  cardAmountInput?: string
  /** 实际生效抵扣额（父组件 clamp 后传入，用于"还需支付"展示） */
  cardAmount?: number
  /** 启用/停用抵扣 */
  onToggleCard?: (checked: boolean) => void
  /** 抵扣金额输入变化 */
  onCardAmountChange?: (v: string) => void
  /** 抵扣金额失焦，由父组件按统一口径钳制并格式化 */
  onCardAmountBlur?: () => void
}

export function ConversionPanel({
  loading,
  heldCards,
  selectedIds,
  onChange,
  totalIn,
  cardBalance = 0,
  useCard = false,
  cardAmountInput = "0.00",
  cardAmount = 0,
  onToggleCard,
  onCardAmountChange,
  onCardAmountBlur,
}: ConversionPanelProps) {
  const [productKindFilter, setProductKindFilter] = useState("")
  const [categoryFilter, setCategoryFilter] = useState("")
  const [nameQuery, setNameQuery] = useState("")

  // heldCards 变化时清掉不在新列表里的旧选择（如换顾客 / 换门店）
  useEffect(() => {
    const validIds = new Set(heldCards.map((c) => c.saleItemId))
    const filtered = selectedIds.filter((id) => validIds.has(id))
    if (filtered.length !== selectedIds.length) {
      onChange(filtered)
    }
  }, [heldCards, selectedIds, onChange])

  // 顾客或门店变更后候选卡重新加载，避免上一位顾客遗留的筛选条件造成空列表。
  useEffect(() => {
    setProductKindFilter("")
    setCategoryFilter("")
    setNameQuery("")
  }, [heldCards])

  const totalOut = useMemo(() => {
    let sum = 0
    const set = new Set(selectedIds)
    for (const c of heldCards) {
      if (set.has(c.saleItemId)) sum += Number(c.deductibleAmount)
    }
    return Math.round(sum * 100) / 100
  }, [heldCards, selectedIds])

  const productKinds = useMemo(
    () => Array.from(new Set(heldCards.map((card) => card.productKind).filter((value): value is string => Boolean(value)))),
    [heldCards],
  )
  const categories = useMemo(
    () => Array.from(
      new Map(
        heldCards
          .filter((card) => card.categoryId && card.categoryName && (!productKindFilter || card.productKind === productKindFilter))
          .map((card) => [card.categoryId!, { id: card.categoryId!, name: card.categoryName! }]),
      ).values(),
    ),
    [heldCards, productKindFilter],
  )
  const filteredHeldCards = useMemo(() => {
    const query = nameQuery.trim().toLocaleLowerCase()
    return heldCards.filter((card) => {
      if (productKindFilter && card.productKind !== productKindFilter) return false
      if (categoryFilter && card.categoryId !== categoryFilter) return false
      return !query || (card.productName ?? "").toLocaleLowerCase().includes(query)
    })
  }, [categoryFilter, heldCards, nameQuery, productKindFilter])
  const hasCardFilters = Boolean(productKindFilter || categoryFilter || nameQuery.trim())

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
            {!loading && heldCards.length > 0 && (
              <div className="grid gap-2 sm:grid-cols-[1fr_1fr]">
                <Select
                  value={productKindFilter}
                  onChange={(e) => {
                    setProductKindFilter(e.target.value)
                    setCategoryFilter("")
                  }}
                  className="h-8 text-xs"
                >
                  <option value="">全部一级品项</option>
                  {productKinds.map((productKind) => (
                    <option key={productKind} value={productKind}>{productKind}</option>
                  ))}
                </Select>
                <Select
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  disabled={!productKindFilter}
                  className="h-8 text-xs"
                >
                  <option value="">{productKindFilter ? "全部二级品项" : "请先选择一级品项"}</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>{category.name}</option>
                  ))}
                </Select>
                <Input
                  value={nameQuery}
                  onChange={(e) => setNameQuery(e.target.value)}
                  placeholder="搜索疗程卡名称"
                  className="h-8 text-xs sm:col-span-2"
                />
              </div>
            )}
            {loading && (
              <p className="text-xs text-[#999999] py-4 text-center">正在加载候选卡…</p>
            )}
            {!loading && heldCards.length === 0 && (
              <p className="text-xs text-[#999999] py-4 text-center">该顾客在当前门店无可折抵卡</p>
            )}
            {!loading && heldCards.length > 0 && filteredHeldCards.length === 0 && (
              <p className="text-xs text-[#999999] py-4 text-center">
                {hasCardFilters ? "未找到匹配的疗程卡" : "该顾客在当前门店无可折抵卡"}
              </p>
            )}
            <div className="space-y-1 max-h-72 overflow-y-auto">
              {filteredHeldCards.map((c) => {
                const checked = selectedIds.includes(c.saleItemId)
                const remainLabel =
                  c.productType === '疗程卡'
                    ? `剩 ${c.remainingSessions ?? 0} ${c.unit}`
                    : `剩 ${c.remainingQty ?? 0} ${c.unit}`
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
                        <span>单{c.unit}价 ¥{c.unitRealPrice}</span>
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

            {/* 充值卡抵扣（仅补差额 > 0 时显示） */}
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
                      placeholder="0.00"
                      value={cardAmountInput}
                      onChange={(e) => onCardAmountChange?.(e.target.value)}
                      onBlur={onCardAmountBlur}
                    />
                    <span className="text-xs text-[#999999]">最多可抵扣 ¥{Math.min(cardBalance, priceDiff).toFixed(2)}</span>
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
