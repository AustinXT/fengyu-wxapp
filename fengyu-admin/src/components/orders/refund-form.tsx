"use client"

import * as React from "react"
import { useEffect, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  createRefund,
  estimateRefundOverdraft,
  getRefundable,
  type EstimateOverdraftResult,
  type RefundableItem,
} from "@/actions/refunds"
import { formatDate } from "@/lib/utils"

interface LineState {
  checked: boolean
  refundQuantity: string
}

export function RefundForm({
  open,
  onOpenChange,
  saleOrderId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  saleOrderId: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [items, setItems] = useState<RefundableItem[]>([])
  const [lineStates, setLineStates] = useState<Record<string, LineState>>({})
  const [handlingFee, setHandlingFee] = useState<string>("0.00")
  const [refundReason, setRefundReason] = useState<string>("")
  const [clientUserId, setClientUserId] = useState<string | null>(null)
  const [overdraft, setOverdraft] = useState<EstimateOverdraftResult | null>(null)
  const [overdraftLoading, setOverdraftLoading] = useState(false)
  const [applyOverdraft, setApplyOverdraft] = useState(true)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setLoadError(null)
    getRefundable(saleOrderId)
      .then((res) => {
        setItems(res.items)
        setClientUserId(res.clientUserId)
        const defaults: Record<string, LineState> = {}
        for (const it of res.items) {
          defaults[it.saleItemId] = {
            checked: it.unusedQuantity > 0,
            refundQuantity: String(it.unusedQuantity),
          }
        }
        setLineStates(defaults)
      })
      .catch((err: Error) => {
        const msg = err?.message || "加载失败"
        const cleaned = msg.replace(/^(INVALID_PARAMS|INVALID_STATE|PERMISSION_DENIED):\s*/, "")
        setLoadError(cleaned)
      })
      .finally(() => setLoading(false))
  }, [open, saleOrderId])

  const previewTotals = useMemo(() => {
    let subtotal = 0
    for (const it of items) {
      const ls = lineStates[it.saleItemId]
      if (!ls?.checked) continue
      const qty = Number(ls.refundQuantity) || 0
      if (qty <= 0) continue
      subtotal += Math.round(it.unitRealPrice * qty * 100) / 100
    }
    const fee = Math.max(0, Number(handlingFee) || 0)
    const final = Math.max(0, Math.round((subtotal - fee) * 100) / 100)
    return { subtotal: Math.round(subtotal * 100) / 100, fee, final }
  }, [items, lineStates, handlingFee])

  // 预判等级跌档 + 超额权益扣除（500ms 防抖）
  useEffect(() => {
    if (!open || !clientUserId || previewTotals.final <= 0) {
      setOverdraft(null)
      return
    }
    const refundAmount = previewTotals.final
    setOverdraftLoading(true)
    const h = setTimeout(() => {
      estimateRefundOverdraft({
        userId: clientUserId,
        refundAmount,
        originalSaleOrderId: saleOrderId,
      })
        .then(setOverdraft)
        .catch(() => setOverdraft(null))
        .finally(() => setOverdraftLoading(false))
    }, 500)
    return () => clearTimeout(h)
  }, [open, clientUserId, previewTotals.final, saleOrderId])

  const effectiveDeduction =
    overdraft && overdraft.willDowngrade && applyOverdraft
      ? overdraft.suggestedOverdraftDeduction
      : 0
  const customerRefund = Math.max(
    0,
    Math.round((previewTotals.final - effectiveDeduction) * 100) / 100,
  )

  const handleSubmit = () => {
    if (!refundReason.trim()) {
      toast.error("请填写退款原因")
      return
    }
    const payload: Array<{ saleItemId: string; refundQuantity: number }> = []
    for (const it of items) {
      const ls = lineStates[it.saleItemId]
      if (!ls?.checked) continue
      const qty = Number(ls.refundQuantity) || 0
      if (qty <= 0) continue
      if (qty > it.unusedQuantity) {
        toast.error(`${it.productName} 退款数量超过可退数量 ${it.unusedQuantity}`)
        return
      }
      payload.push({ saleItemId: it.saleItemId, refundQuantity: qty })
    }
    if (payload.length === 0) {
      toast.error("请至少勾选一项退款明细")
      return
    }
    if (previewTotals.final <= 0) {
      toast.error("退款金额为 0，无法提交")
      return
    }

    startTransition(async () => {
      const res = await createRefund({
        refSaleOrderId: saleOrderId,
        items: payload,
        refundReason: refundReason.trim(),
        handlingFee: previewTotals.fee,
        applyOverdraftDeduction: applyOverdraft,
      })
      if (res.success) {
        toast.success(`退款单已创建（流水 #${res.data.refundPaymentId}），等待审批`)
        onOpenChange(false)
        router.refresh()
      } else {
        toast.error(res.error.message)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} className="max-w-3xl">
      <DialogClose onOpenChange={onOpenChange} />
      <DialogHeader>
        <DialogTitle>创建退款单</DialogTitle>
        <DialogDescription>
          为订单 {saleOrderId} 发起退款申请，退款单需经审批通过后才会实际退款。
        </DialogDescription>
      </DialogHeader>

      {loading ? (
        <div className="py-10 text-center text-[#999999]">加载可退明细…</div>
      ) : loadError ? (
        <div className="py-6 text-center text-[#C62828]">{loadError}</div>
      ) : items.length === 0 ? (
        <div className="py-6 text-center text-[#999999]">该订单没有可退明细</div>
      ) : (
        <div className="space-y-4 mt-4">
          {/* 明细表 */}
          <div className="overflow-x-auto border border-[var(--border)] rounded-[var(--radius)]">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-gray-500 w-10">选</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-500">名称</th>
                  <th className="px-3 py-2 text-right font-medium text-gray-500">单次价</th>
                  <th className="px-3 py-2 text-right font-medium text-gray-500">可退</th>
                  <th className="px-3 py-2 text-right font-medium text-gray-500 w-28">退款数量</th>
                  <th className="px-3 py-2 text-right font-medium text-gray-500">小计</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {items.map((it) => {
                  const ls = lineStates[it.saleItemId] ?? { checked: false, refundQuantity: "0" }
                  const qty = Number(ls.refundQuantity) || 0
                  const rowSubtotal = ls.checked
                    ? Math.round(it.unitRealPrice * qty * 100) / 100
                    : 0
                  const disabled = it.unusedQuantity <= 0
                  return (
                    <tr key={it.saleItemId} className={disabled ? "opacity-50" : ""}>
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={ls.checked}
                          disabled={disabled}
                          onChange={(e) => {
                            setLineStates((prev) => ({
                              ...prev,
                              [it.saleItemId]: { ...ls, checked: e.target.checked },
                            }))
                          }}
                        />
                      </td>
                      <td className="px-3 py-2">{it.productName}</td>
                      <td className="px-3 py-2 text-right">¥{it.unitRealPrice.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right">{it.unusedQuantity}</td>
                      <td className="px-3 py-2">
                        <Input
                          type="number"
                          min="0"
                          max={it.unusedQuantity}
                          step="1"
                          value={ls.refundQuantity}
                          disabled={disabled || !ls.checked}
                          onChange={(e) =>
                            setLineStates((prev) => ({
                              ...prev,
                              [it.saleItemId]: { ...ls, refundQuantity: e.target.value },
                            }))
                          }
                          className="h-8 text-right"
                        />
                      </td>
                      <td className="px-3 py-2 text-right font-medium">
                        ¥{rowSubtotal.toFixed(2)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* 手续费 + 原因 */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">手续费（¥，可选）</label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={handlingFee}
                onChange={(e) => setHandlingFee(e.target.value)}
                placeholder="0.00"
              />
              <p className="text-xs text-[#999] mt-1">从退款总额中扣除，不退给顾客</p>
            </div>
            <div className="rounded-[var(--radius)] bg-[#FFF7E6] border border-[#F3C77E] px-3 py-2 text-sm">
              <div className="flex justify-between">
                <span className="text-[#666]">小计</span>
                <span>¥{previewTotals.subtotal.toFixed(2)}</span>
              </div>
              <div className="flex justify-between mt-1">
                <span className="text-[#666]">手续费</span>
                <span>-¥{previewTotals.fee.toFixed(2)}</span>
              </div>
              {effectiveDeduction > 0 && (
                <div className="flex justify-between mt-1">
                  <span className="text-[#666]">权益扣除</span>
                  <span>-¥{effectiveDeduction.toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between mt-1 pt-1 border-t border-[#F3C77E]">
                <span className="font-medium">顾客应退</span>
                <span className="font-bold text-[#C0322A]">¥{customerRefund.toFixed(2)}</span>
              </div>
            </div>
          </div>

          {/* 会员权益调整区块 */}
          {clientUserId && (overdraftLoading || overdraft) && (
            <div className="rounded-[var(--radius)] border border-[var(--border)] bg-white px-3 py-3 text-sm space-y-2">
              <div className="font-medium">会员权益调整</div>
              {overdraftLoading ? (
                <div className="text-[#999]">计算中…</div>
              ) : overdraft ? (
                overdraft.willDowngrade ? (
                  <>
                    <div className="text-[#666]">
                      当前等级 <span className="font-medium text-[var(--foreground)]">{overdraft.currentLevel ?? "—"}</span>
                      {" → 退款后应降级至 "}
                      <span className="font-medium text-[var(--foreground)]">{overdraft.recomputedLevel ?? "无等级"}</span>
                    </div>
                    {overdraft.upgradedAt && (
                      <div className="text-[#666]">
                        升级时间：{formatDate(overdraft.upgradedAt)}
                      </div>
                    )}
                    <ul className="text-[#666] list-disc pl-5 space-y-0.5">
                      {overdraft.usedCouponValue > 0 && (
                        <li>
                          已核销升级奖励优惠券 {overdraft.detail.usedCoupons.length} 张，面值 ¥{overdraft.usedCouponValue.toFixed(2)}
                        </li>
                      )}
                      {overdraft.usedPointsValue > 0 && (
                        <li>
                          已用升级奖励积分 {overdraft.detail.usedPoints} 分（折 ¥{overdraft.usedPointsValue.toFixed(2)}）
                        </li>
                      )}
                    </ul>
                    <div className="text-[#666]">
                      {overdraft.currentLevel} vs {overdraft.recomputedLevel ?? "无等级"} 权益差：
                      ¥{overdraft.benefitValueDiff.toFixed(2)}
                    </div>
                    <div className="pt-1 border-t border-[var(--border)]">
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={applyOverdraft}
                          onChange={(e) => setApplyOverdraft(e.target.checked)}
                        />
                        <span>
                          应用扣除：<span className="font-medium">¥{overdraft.suggestedOverdraftDeduction.toFixed(2)}</span>
                        </span>
                      </label>
                    </div>
                  </>
                ) : overdraft.lockedUntilStatus === "in_lock" ? (
                  <div className="text-[#666]">
                    顾客处于保级期至当前保级截止日，本次退款不影响等级，不扣权益。
                  </div>
                ) : overdraft.currentLevel ? (
                  <div className="text-[#666]">
                    本次退款后等级仍为 {overdraft.currentLevel}，不扣权益。
                  </div>
                ) : (
                  <div className="text-[#666]">顾客无会员等级，不扣权益。</div>
                )
              ) : null}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium mb-1">
              退款原因 <span className="text-[#C0322A]">*</span>
            </label>
            <Textarea
              value={refundReason}
              onChange={(e) => setRefundReason(e.target.value)}
              rows={3}
              maxLength={300}
              placeholder="请描述退款原因，审批人将基于此判断是否通过"
            />
          </div>
        </div>
      )}

      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
          取消
        </Button>
        <Button onClick={handleSubmit} disabled={pending || loading || items.length === 0}>
          {pending ? "提交中…" : "提交退款申请"}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
