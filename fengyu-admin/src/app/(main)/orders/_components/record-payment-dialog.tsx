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
 * 录入回款弹层（ticket 2026-05-21 按子项定向回款；2026-06-24 加微信/支付宝在线回款）
 *
 * 线下 / 储值卡：admin 后台即时记账（recordPayment），可按子项定向回款。
 * 微信 / 支付宝：店员先（可选）扣储值卡即时入账，剩余生成 client 小程序码让顾客扫码进收银台在线付，
 *   payNotify 回调写 change_type='回款'（与首付同一管道，admin 不直接收线上钱）。
 */
type RepayableItem = {
  saleItemId: string
  productName: string
  saleAmount: string
  received: string
  remaining: string
}

type PayMethod = "线下" | "储值卡" | "微信" | "支付宝"

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
  // 各子项现金 / 储值卡输入（saleItemId → 金额字符串）
  const [lineCash, setLineCash] = useState<Record<string, string>>({})
  const [lineCard, setLineCard] = useState<Record<string, string>>({})
  const [paymentMethod, setPaymentMethod] = useState<PayMethod>("线下")
  const [externalTxnId, setExternalTxnId] = useState<string>("")
  const [note, setNote] = useState<string>("")
  // 在线收款码（微信/支付宝）：店员先扣储值卡后，生成 client 小程序码让顾客扫码付剩余
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [qrAmount, setQrAmount] = useState<number>(0)

  // 打开时拉取可回款子项；默认线下、每行现金 = 该行可回款额（操作员可改小或清零）
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
        const cash: Record<string, string> = {}
        const card: Record<string, string> = {}
        for (const it of res.items) {
          cash[it.saleItemId] = it.remaining
          card[it.saleItemId] = "0.00"
        }
        setLineCash(cash)
        setLineCard(card)
        setPaymentMethod("线下")
        setExternalTxnId("")
        setNote("")
      })
      .catch((e) => toast.error(e?.message || "加载可回款明细失败"))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [open, saleOrderId])

  const round2 = (n: number) => Math.round(n * 100) / 100
  const isCard = paymentMethod === "储值卡"
  const isOnline = paymentMethod === "微信" || paymentMethod === "支付宝"
  // 仅线下展示现金列；储值卡 / 微信 / 支付宝只用储值卡列
  const showCash = paymentMethod === "线下"
  const sumCash = round2(items.reduce((s, it) => s + (Number(lineCash[it.saleItemId] || 0) || 0), 0))
  const sumCard = round2(items.reduce((s, it) => s + (Number(lineCard[it.saleItemId] || 0) || 0), 0))
  // 在线方式：储值卡先扣后顾客扫码支付剩余欠款
  const onlineRemain = round2(Math.max(0, remainingPayable - sumCard))
  const grandTotal = isOnline ? round2(sumCard + onlineRemain) : round2(sumCash + sumCard)

  // 切换支付方式：按新方式重置两列默认值（避免线下默认现金残留误判到储值卡/在线）
  const switchMethod = (v: PayMethod) => {
    setPaymentMethod(v)
    if (v !== "线下") setExternalTxnId("")
    const cash: Record<string, string> = {}
    const card: Record<string, string> = {}
    for (const it of items) {
      if (v === "线下") {
        cash[it.saleItemId] = it.remaining
        card[it.saleItemId] = "0.00"
      } else if (v === "储值卡") {
        cash[it.saleItemId] = "0.00"
        card[it.saleItemId] = it.remaining
      } else {
        // 微信 / 支付宝：储值卡先扣默认 0，剩余由顾客扫码在线付
        cash[it.saleItemId] = "0.00"
        card[it.saleItemId] = "0.00"
      }
    }
    setLineCash(cash)
    setLineCard(card)
  }

  // 微信 / 支付宝：店员先扣储值卡（若填），剩余生成收款码顾客扫码在线付
  const handleOnlineSubmit = () => {
    for (const it of items) {
      const card = Number(lineCard[it.saleItemId] || 0) || 0
      if (card < 0) {
        toast.error("金额不能为负")
        return
      }
      if (round2(card) > Number(it.remaining) + 0.001) {
        toast.error(`「${it.productName}」储值卡抵扣超过该行可回款额 ¥${it.remaining}`)
        return
      }
    }
    if (sumCard > remainingPayable + 0.001) {
      toast.error(`储值卡抵扣不能超过剩余欠款 ¥${remainingPayable.toFixed(2)}`)
      return
    }
    if (sumCard > 0 && cardBalance != null && sumCard > cardBalance + 0.001) {
      toast.error(`储值卡余额不足（当前 ¥${cardBalance.toFixed(2)}）`)
      return
    }
    const cardItems = items
      .map((it) => ({
        saleItemId: it.saleItemId,
        repayAmount: 0,
        prepaidCardAmount: round2(Number(lineCard[it.saleItemId] || 0) || 0),
      }))
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
      if (onlineRemain <= 0.001) {
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
      setQrAmount(onlineRemain)
      setQrDataUrl(qrRes.dataUrl)
      router.refresh()
    })
  }

  const handleSubmit = () => {
    if (isOnline) {
      handleOnlineSubmit()
      return
    }
    // ===== 线下 / 储值卡：即时记账 =====
    if (grandTotal <= 0) {
      toast.error("请至少为一个子项填写回款金额")
      return
    }
    if (grandTotal > remainingPayable + 0.001) {
      toast.error(`本次回款不能超过剩余欠款 ¥${remainingPayable.toFixed(2)}`)
      return
    }
    // 逐项校验：现金+储值卡 ≤ 该行可回款额
    for (const it of items) {
      const cash = Number(lineCash[it.saleItemId] || 0) || 0
      const card = Number(lineCard[it.saleItemId] || 0) || 0
      if (cash < 0 || card < 0) {
        toast.error("金额不能为负")
        return
      }
      if (round2(cash + card) > Number(it.remaining) + 0.001) {
        toast.error(`「${it.productName}」回款额超过该行可回款额 ¥${it.remaining}`)
        return
      }
    }
    if (isCard && sumCash > 0) {
      toast.error("储值卡方式下不应填现金回款金额")
      return
    }
    if (showCash && sumCash > 0 && !externalTxnId.trim()) {
      toast.error("线下回款必须填写外部交易号（银行回执号/流水号）")
      return
    }
    if (sumCard > 0 && cardBalance != null && sumCard > cardBalance + 0.001) {
      toast.error(`储值卡余额不足（当前 ¥${cardBalance.toFixed(2)}）`)
      return
    }

    const payloadItems = items
      .map((it) => ({
        saleItemId: it.saleItemId,
        repayAmount: round2(Number(lineCash[it.saleItemId] || 0) || 0),
        prepaidCardAmount: round2(Number(lineCard[it.saleItemId] || 0) || 0),
      }))
      .filter((it) => it.repayAmount > 0 || it.prepaidCardAmount > 0)

    startTransition(async () => {
      const res = await recordPayment({
        saleOrderId,
        paymentMethod: paymentMethod as "线下" | "储值卡",
        externalTxnId: externalTxnId.trim() || undefined,
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogClose onOpenChange={onOpenChange} />
      <DialogHeader>
        <DialogTitle>录入回款（按子项）</DialogTitle>
        <DialogDescription>
          向订单 {saleOrderId} 追加款项。线下 / 储值卡即时记账；微信 / 支付宝由顾客扫码在线支付。可只对部分子项回款，不要求一次性付清。
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
              <Select value={paymentMethod} onChange={(e) => switchMethod(e.target.value as PayMethod)}>
                <SelectOption value="线下">线下</SelectOption>
                <SelectOption value="储值卡">储值卡</SelectOption>
                <SelectOption value="微信">微信（顾客扫码）</SelectOption>
                <SelectOption value="支付宝">支付宝（顾客扫码）</SelectOption>
              </Select>
            </div>

            {isOnline && (
              <div className="rounded-[var(--radius)] bg-[#F0F7FF] border border-[#BBD6F5] px-4 py-2.5 text-xs text-[#456]">
                储值卡先扣（可选），剩余 <span className="font-bold">¥{onlineRemain.toFixed(2)}</span> 生成小程序码，顾客扫码用{paymentMethod}支付；到账由支付回调自动入账。
              </div>
            )}

            {/* 按子项金额表 */}
            <div className="border border-[#E8E8E8] rounded-[var(--radius)] overflow-hidden">
              <div className="grid grid-cols-[1fr_auto_auto] gap-2 px-3 py-2 bg-[#F5F5F5] text-xs text-[#666] font-medium">
                <span>子项 / 应付·已收·可回款</span>
                <span className="w-24 text-right">{showCash ? "现金(¥)" : "储值卡(¥)"}</span>
                <span className="w-24 text-right">{showCash ? "储值卡(¥)" : ""}</span>
              </div>
              {loading ? (
                <div className="px-3 py-4 text-sm text-[#999]">加载中…</div>
              ) : items.length === 0 ? (
                <div className="px-3 py-4 text-sm text-[#999]">无可回款子项</div>
              ) : (
                items.map((it) => (
                  <div key={it.saleItemId} className="grid grid-cols-[1fr_auto_auto] gap-2 px-3 py-2 border-t border-[#F0F0F0] items-center">
                    <div className="min-w-0">
                      <div className="text-sm truncate">{it.productName}</div>
                      <div className="text-xs text-[#999]">
                        应付 ¥{Number(it.saleAmount).toFixed(2)} · 已收 ¥{Number(it.received).toFixed(2)} · 可回款 ¥{it.remaining}
                      </div>
                    </div>
                    <Input
                      className="w-24 text-right"
                      type="number"
                      step="0.01"
                      min="0"
                      max={it.remaining}
                      value={showCash ? (lineCash[it.saleItemId] ?? "0.00") : (lineCard[it.saleItemId] ?? "0.00")}
                      onChange={(e) =>
                        showCash
                          ? setLineCash((m) => ({ ...m, [it.saleItemId]: e.target.value }))
                          : setLineCard((m) => ({ ...m, [it.saleItemId]: e.target.value }))
                      }
                    />
                    {showCash ? (
                      <Input
                        className="w-24 text-right"
                        type="number"
                        step="0.01"
                        min="0"
                        max={it.remaining}
                        value={lineCard[it.saleItemId] ?? "0.00"}
                        onChange={(e) => setLineCard((m) => ({ ...m, [it.saleItemId]: e.target.value }))}
                      />
                    ) : (
                      <span className="w-24" />
                    )}
                  </div>
                ))
              )}
              <div className="grid grid-cols-[1fr_auto_auto] gap-2 px-3 py-2 border-t border-[#E8E8E8] bg-[#FAFAFA] text-sm font-medium items-center">
                <span className="text-[#666]">
                  {isOnline
                    ? `储值卡先扣 ¥${sumCard.toFixed(2)} · 顾客扫码 ¥${onlineRemain.toFixed(2)}`
                    : `本次合计 ¥${grandTotal.toFixed(2)}`}
                </span>
                <span className="w-24 text-right text-[#C0322A]">¥{(showCash ? sumCash : sumCard).toFixed(2)}</span>
                <span className="w-24 text-right text-[#3D8A5A]">{showCash ? `¥${sumCard.toFixed(2)}` : ""}</span>
              </div>
            </div>

            {showCash && sumCash > 0 && (
              <div>
                <label className="block text-sm font-medium mb-1">
                  银行回执号 / 交易流水号 <span className="text-[#C0322A]">*</span>
                </label>
                <Input
                  value={externalTxnId}
                  onChange={(e) => setExternalTxnId(e.target.value)}
                  placeholder="例如：BANK-20260425-001"
                  maxLength={64}
                />
                <p className="text-xs text-[#999] mt-1">审计凭证，建议填写银行流水 / 扫码平台流水号</p>
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
              {pending ? "提交中…" : isOnline ? "生成收款码" : "确认录入"}
            </Button>
          </DialogFooter>
        </>
      )}
    </Dialog>
  )
}
