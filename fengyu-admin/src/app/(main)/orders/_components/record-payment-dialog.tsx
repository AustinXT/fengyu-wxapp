"use client"

import { useState, useEffect, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectOption } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { recordPayment, getRepayable } from "@/actions/orders"

/**
 * 录入回款弹层（ticket 2026-05-21 按子项定向回款）
 *
 * admin 端仅支持"线下"/"储值卡"两种回款方式（后台不收线上钱）。
 * 打开时拉取 getRepayable 获取各购买子项的应付/已收/可回款额，操作员逐子项填现金/储值卡金额，
 * 提交 items[] 给 recordPayment（带 ref_sale_item_id 定向回款）→ paid_sessions 按子项独立解锁。
 * 不要求一次性全部回款；可只对部分子项回款。
 */
type RepayableItem = {
  saleItemId: string
  productName: string
  skuSpecName: string
  saleAmount: string
  received: string
  remaining: string
}

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
  const [paymentMethod, setPaymentMethod] = useState<"线下" | "储值卡">("线下")
  const [externalTxnId, setExternalTxnId] = useState<string>("")
  const [note, setNote] = useState<string>("")

  // 打开时拉取可回款子项；默认每行现金 = 该行可回款额（线下，操作员可改小或清零）
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
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
  const sumCash = round2(items.reduce((s, it) => s + (Number(lineCash[it.saleItemId] || 0) || 0), 0))
  const sumCard = round2(items.reduce((s, it) => s + (Number(lineCard[it.saleItemId] || 0) || 0), 0))
  const grandTotal = round2(sumCash + sumCard)

  const handleSubmit = () => {
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
    if (!isCard && sumCash > 0 && !externalTxnId.trim()) {
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
        paymentMethod,
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
          向订单 {saleOrderId} 按子项追加款项。可只对部分子项回款，不要求一次性付清。admin 端仅支持线下 / 储值卡方式。
        </DialogDescription>
      </DialogHeader>

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
          <Select
            value={paymentMethod}
            onChange={(e) => {
              const v = e.target.value as "线下" | "储值卡"
              setPaymentMethod(v)
              if (v === "储值卡") setExternalTxnId("")
            }}
          >
            <SelectOption value="线下">线下</SelectOption>
            <SelectOption value="储值卡">储值卡</SelectOption>
          </Select>
        </div>

        {/* 按子项金额表 */}
        <div className="border border-[#E8E8E8] rounded-[var(--radius)] overflow-hidden">
          <div className="grid grid-cols-[1fr_auto_auto] gap-2 px-3 py-2 bg-[#F5F5F5] text-xs text-[#666] font-medium">
            <span>子项 / 应付·已收·可回款</span>
            <span className="w-24 text-right">{isCard ? "储值卡(¥)" : "现金(¥)"}</span>
            <span className="w-24 text-right">{isCard ? "" : "储值卡(¥)"}</span>
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
                  value={isCard ? (lineCard[it.saleItemId] ?? "0.00") : (lineCash[it.saleItemId] ?? "0.00")}
                  onChange={(e) =>
                    isCard
                      ? setLineCard((m) => ({ ...m, [it.saleItemId]: e.target.value }))
                      : setLineCash((m) => ({ ...m, [it.saleItemId]: e.target.value }))
                  }
                />
                {isCard ? (
                  <span className="w-24" />
                ) : (
                  <Input
                    className="w-24 text-right"
                    type="number"
                    step="0.01"
                    min="0"
                    max={it.remaining}
                    value={lineCard[it.saleItemId] ?? "0.00"}
                    onChange={(e) => setLineCard((m) => ({ ...m, [it.saleItemId]: e.target.value }))}
                  />
                )}
              </div>
            ))
          )}
          <div className="grid grid-cols-[1fr_auto_auto] gap-2 px-3 py-2 border-t border-[#E8E8E8] bg-[#FAFAFA] text-sm font-medium items-center">
            <span className="text-[#666]">本次合计 ¥{grandTotal.toFixed(2)}</span>
            <span className="w-24 text-right text-[#C0322A]">¥{(isCard ? sumCard : sumCash).toFixed(2)}</span>
            <span className="w-24 text-right text-[#3D8A5A]">{isCard ? "" : `¥${sumCard.toFixed(2)}`}</span>
          </div>
        </div>

        {!isCard && sumCash > 0 && (
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
          {pending ? "提交中…" : "确认录入"}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
