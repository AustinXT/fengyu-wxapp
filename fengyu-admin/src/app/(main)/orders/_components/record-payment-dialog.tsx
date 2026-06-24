"use client"

import { useState, useEffect, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectOption } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { recordPayment, getRepayable, generateOrderWxacode } from "@/actions/orders"

/**
 * 录入回款弹层（ticket 2026-05-21 按子项定向回款；2026-06-24 重构：储值卡改独立抵扣勾选）
 *
 * 交互：支付方式三选一（线下 / 微信 / 支付宝）；各子项填「实付金额」；
 *   储值卡作为独立勾选项，勾选后自动抵满 min(余额, 实付合计)，按子项实付比例摊分入账。
 * 线下：即时记账（recordPayment paymentMethod='线下'，含储值卡抵扣）。
 * 微信 / 支付宝：储值卡部分先即时扣（paymentMethod='储值卡'），剩余生成 client 小程序码让顾客扫码在线付，
 *   payNotify 回调写 change_type='回款'（admin 不直接收线上钱）。
 */
type RepayableItem = {
  saleItemId: string
  productName: string
  saleAmount: string
  received: string
  remaining: string
}

type PayMethod = "线下" | "微信" | "支付宝"

export function RecordPaymentDialog({
  open,
  onOpenChange,
  saleOrderId,
  /** 订单剩余欠款（fallback，打开后由 getRepayable 刷新），单位元 */
  remainingPayable: remainingPayableProp,
  /** 顾客当前储值卡余额（fallback），单位元（null 表示未查询或无账户） */
  cardBalance: cardBalanceProp,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  saleOrderId: string
  remainingPayable: number
  cardBalance: number | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [loading, setLoading] = useState(false)

  const [items, setItems] = useState<RepayableItem[]>([])
  const [remainingPayable, setRemainingPayable] = useState<number>(remainingPayableProp)
  const [cardBalance, setCardBalance] = useState<number | null>(cardBalanceProp)
  // 各子项实付金额（saleItemId → 金额字符串）
  const [lineReal, setLineReal] = useState<Record<string, string>>({})
  // 是否用储值卡抵扣（勾选后自动抵满 min(余额, 实付合计)）
  const [useCard, setUseCard] = useState(false)
  const [paymentMethod, setPaymentMethod] = useState<PayMethod>("线下")
  const [note, setNote] = useState<string>("")
  // 在线收款码（微信/支付宝）：储值卡先扣后，生成 client 小程序码让顾客扫码付剩余
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [qrAmount, setQrAmount] = useState<number>(0)

  // 打开时拉取可回款子项；默认每行实付 = 该行可回款额（操作员可改小或清零）
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setQrDataUrl(null)
    getRepayable(saleOrderId)
      .then((res) => {
        if (cancelled) return
        setItems(res.items)
        setRemainingPayable(res.remainingPayable)
        setCardBalance(res.cardBalance)
        const real: Record<string, string> = {}
        for (const it of res.items) real[it.saleItemId] = it.remaining
        setLineReal(real)
        setUseCard(false)
        setPaymentMethod("线下")
        setNote("")
      })
      .catch((e) => toast.error(e?.message || "加载可回款明细失败"))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [open, saleOrderId])

  const round2 = (n: number) => Math.round(n * 100) / 100
  const isOnline = paymentMethod === "微信" || paymentMethod === "支付宝"
  const sumReal = round2(items.reduce((s, it) => s + (Number(lineReal[it.saleItemId] || 0) || 0), 0))
  // 储值卡抵扣额：勾选后自动抵满 min(余额, 实付合计)，随实付响应式重算
  const cardDeduct = useCard && cardBalance != null ? round2(Math.min(cardBalance, sumReal)) : 0
  // 剩余需用所选方式支付的金额（线下=现金 / 微信支付宝=顾客扫码）
  const needPay = round2(Math.max(0, sumReal - cardDeduct))

  // 储值卡按各子项实付比例摊分（末项补差，保证 Σ = cardDeduct，且每项 ≤ 该行实付）
  const allocateCard = (totalCard: number): Record<string, number> => {
    const map: Record<string, number> = {}
    for (const it of items) map[it.saleItemId] = 0
    if (totalCard <= 0 || sumReal <= 0) return map
    const filled = items.filter((it) => round2(Number(lineReal[it.saleItemId] || 0) || 0) > 0)
    let acc = 0
    filled.forEach((it, idx) => {
      const real = round2(Number(lineReal[it.saleItemId] || 0) || 0)
      let card = idx === filled.length - 1 ? round2(totalCard - acc) : round2((totalCard * real) / sumReal)
      card = Math.max(0, Math.min(card, real)) // 兜底：不超过该行实付，不为负
      map[it.saleItemId] = card
      acc = round2(acc + card)
    })
    return map
  }

  // 构造 recordPayment 的 items：实付拆为 repayAmount（非储值卡部分）+ prepaidCardAmount
  const buildItems = (cardMap: Record<string, number>) =>
    items
      .map((it) => {
        const real = round2(Number(lineReal[it.saleItemId] || 0) || 0)
        const card = round2(cardMap[it.saleItemId] || 0)
        return { saleItemId: it.saleItemId, repayAmount: round2(real - card), prepaidCardAmount: card }
      })
      .filter((it) => it.repayAmount > 0 || it.prepaidCardAmount > 0)

  // 通用校验：实付合计 > 0、≤ 剩余欠款、逐项 ≤ 该行可回款额
  const validateReal = (): boolean => {
    if (sumReal <= 0) {
      toast.error("请至少为一个子项填写实付金额")
      return false
    }
    if (sumReal > remainingPayable + 0.001) {
      toast.error(`本次回款不能超过剩余欠款 ¥${remainingPayable.toFixed(2)}`)
      return false
    }
    for (const it of items) {
      const real = Number(lineReal[it.saleItemId] || 0) || 0
      if (real < 0) {
        toast.error("金额不能为负")
        return false
      }
      if (round2(real) > Number(it.remaining) + 0.001) {
        toast.error(`「${it.productName}」实付超过该行可回款额 ¥${it.remaining}`)
        return false
      }
    }
    return true
  }

  // 微信 / 支付宝：储值卡部分先即时扣（若勾选），剩余生成收款码顾客扫码在线付
  const handleOnlineSubmit = () => {
    if (!validateReal()) return
    const cardItems = buildItems(allocateCard(cardDeduct))
      .map((it) => ({ saleItemId: it.saleItemId, repayAmount: 0, prepaidCardAmount: it.prepaidCardAmount }))
      .filter((it) => it.prepaidCardAmount > 0)

    startTransition(async () => {
      // 1) 储值卡先扣（即时入账）
      if (cardItems.length > 0) {
        const cardRes = await recordPayment({
          saleOrderId,
          paymentMethod: "储值卡",
          items: cardItems,
          note: note.trim() || undefined,
        })
        if (!cardRes.success) {
          toast.error(cardRes.error.message)
          return
        }
      }
      // 2) 储值卡已全额抵扣 → 结清，无需出码
      if (needPay <= 0.001) {
        toast.success("储值卡已抵扣结清")
        onOpenChange(false)
        router.refresh()
        return
      }
      // 3) 生成 client 小程序码，顾客扫码进收银台用微信/支付宝付剩余
      const qrRes = await generateOrderWxacode(saleOrderId)
      if (!qrRes.success || !qrRes.dataUrl) {
        toast.error(qrRes.message || "生成收款码失败")
        router.refresh()
        return
      }
      setQrAmount(needPay)
      setQrDataUrl(qrRes.dataUrl)
      router.refresh()
    })
  }

  const handleSubmit = () => {
    if (isOnline) {
      handleOnlineSubmit()
      return
    }
    // ===== 线下：即时记账（实付 = 现金 + 储值卡抵扣） =====
    if (!validateReal()) return
    const payloadItems = buildItems(allocateCard(cardDeduct))

    startTransition(async () => {
      const res = await recordPayment({
        saleOrderId,
        paymentMethod: "线下",
        items: payloadItems,
        note: note.trim() || undefined,
      })
      if (res.success) {
        toast.success(`回款成功：凭证单 ${res.data.repaymentOrderId}`)
        onOpenChange(false)
        router.refresh()
      } else {
        toast.error(res.error.message)
      }
    })
  }

  const submitLabel = isOnline ? (needPay > 0.001 ? "生成收款码" : "确认抵扣") : "确认录入"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogClose onOpenChange={onOpenChange} />
      <DialogHeader>
        <DialogTitle>录入回款（按子项）</DialogTitle>
        <DialogDescription>
          向订单 {saleOrderId} 追加款项。各子项填本次实付金额，可勾选储值卡抵扣；线下即时记账，微信 / 支付宝由顾客扫码在线支付。可只对部分子项回款，不要求一次性付清。
        </DialogDescription>
      </DialogHeader>

      {qrDataUrl ? (
        // ===== 在线收款码视图 =====
        <div className="flex flex-col items-center gap-3 mt-4">
          <div className="text-sm text-[#666]">请让顾客用微信扫描下方小程序码，进入收银台完成支付</div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qrDataUrl} alt="收款小程序码" className="w-56 h-56 rounded-[var(--radius)] border border-[#E8E8E8]" />
          <div className="text-sm">
            顾客需支付：<span className="font-bold text-[#C0322A]">¥{qrAmount.toFixed(2)}</span>
          </div>
          <div className="text-xs text-[#999] text-center px-4">
            支付成功后订单将自动入账（change_type=回款）。可关闭本窗口，稍后在订单详情查看到账状态。
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                setQrDataUrl(null)
                onOpenChange(false)
                router.refresh()
              }}
            >
              完成
            </Button>
          </DialogFooter>
        </div>
      ) : (
        <>
          <div className="space-y-4 mt-4">
            <div className="rounded-[var(--radius)] bg-[#FFF7E6] border border-[#F3C77E] px-4 py-3 text-sm">
              <div className="flex justify-between">
                <span className="text-[#666]">订单剩余欠款</span>
                <span className="font-bold text-[#C0322A]">¥{remainingPayable.toFixed(2)}</span>
              </div>
              {cardBalance != null && (
                <div className="flex justify-between mt-1">
                  <span className="text-[#666]">顾客储值卡余额</span>
                  <span className="font-medium text-[#3D8A5A]">¥{cardBalance.toFixed(2)}</span>
                </div>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">支付方式</label>
              <Select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as PayMethod)}>
                <SelectOption value="线下">线下</SelectOption>
                <SelectOption value="微信">微信（顾客扫码）</SelectOption>
                <SelectOption value="支付宝">支付宝（顾客扫码）</SelectOption>
              </Select>
            </div>

            {/* 按子项实付金额表 */}
            <div className="border border-[#E8E8E8] rounded-[var(--radius)] overflow-hidden">
              <div className="grid grid-cols-[1fr_auto] gap-2 px-3 py-2 bg-[#F5F5F5] text-xs text-[#666] font-medium">
                <span>子项 / 应付·已收·可回款</span>
                <span className="w-28 text-right">实付金额(¥)</span>
              </div>
              {loading ? (
                <div className="px-3 py-4 text-sm text-[#999]">加载中…</div>
              ) : items.length === 0 ? (
                <div className="px-3 py-4 text-sm text-[#999]">无可回款子项</div>
              ) : (
                items.map((it) => (
                  <div key={it.saleItemId} className="grid grid-cols-[1fr_auto] gap-2 px-3 py-2 border-t border-[#F0F0F0] items-center">
                    <div className="min-w-0">
                      <div className="text-sm truncate">{it.productName}</div>
                      <div className="text-xs text-[#999]">
                        应付 ¥{Number(it.saleAmount).toFixed(2)} · 已收 ¥{Number(it.received).toFixed(2)} · 可回款 ¥{it.remaining}
                      </div>
                    </div>
                    <Input
                      className="w-28 text-right"
                      type="number"
                      step="0.01"
                      min="0"
                      max={it.remaining}
                      value={lineReal[it.saleItemId] ?? "0.00"}
                      onChange={(e) => setLineReal((m) => ({ ...m, [it.saleItemId]: e.target.value }))}
                    />
                  </div>
                ))
              )}
              <div className="grid grid-cols-[1fr_auto] gap-2 px-3 py-2 border-t border-[#E8E8E8] bg-[#FAFAFA] text-sm font-medium items-center">
                <span className="text-[#666]">
                  {isOnline
                    ? `储值卡抵 ¥${cardDeduct.toFixed(2)} · 顾客扫码 ¥${needPay.toFixed(2)}`
                    : `储值卡抵 ¥${cardDeduct.toFixed(2)} · 现金需付 ¥${needPay.toFixed(2)}`}
                </span>
                <span className="w-28 text-right text-[#C0322A]">¥{sumReal.toFixed(2)}</span>
              </div>
            </div>

            {/* 储值卡抵扣勾选（仅顾客有余额时可用） */}
            {cardBalance != null && cardBalance > 0 && (
              <label className="flex items-center gap-2 px-3 py-2.5 rounded-[var(--radius)] bg-[#F0FAF4] border border-[#BEE3CD] cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="w-4 h-4 accent-[#C0322A]"
                  checked={useCard}
                  onChange={(e) => setUseCard(e.target.checked)}
                />
                <span className="text-sm">使用储值卡抵扣</span>
                <span className="ml-auto text-xs text-[#3D8A5A]">
                  余额 ¥{cardBalance.toFixed(2)}
                  {useCard ? ` · 本次抵扣 ¥${cardDeduct.toFixed(2)}` : ""}
                </span>
              </label>
            )}

            {isOnline && (
              <div className="rounded-[var(--radius)] bg-[#F0F7FF] border border-[#BBD6F5] px-4 py-2.5 text-xs text-[#456]">
                储值卡抵扣即时入账，剩余 <span className="font-bold">¥{needPay.toFixed(2)}</span> 生成小程序码，顾客扫码用{paymentMethod}支付；到账由支付回调自动入账。
              </div>
            )}

            <div>
              <label className="block text-sm font-medium mb-1">备注（可选）</label>
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="例如：顾客 5-21 到店补齐 A 疗程卡尾款"
                rows={2}
                maxLength={200}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              取消
            </Button>
            <Button onClick={handleSubmit} disabled={pending || loading}>
              {pending ? "提交中…" : submitLabel}
            </Button>
          </DialogFooter>
        </>
      )}
    </Dialog>
  )
}
