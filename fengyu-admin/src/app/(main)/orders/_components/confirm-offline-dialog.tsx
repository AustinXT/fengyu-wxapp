"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { confirmOfflinePayment } from "@/actions/orders"


export function ConfirmOfflineDialog({
  open,
  onOpenChange,
  saleOrderId,
  
  remainingPayable,
  
  suggestedAmount,
  
  cardBalance,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  saleOrderId: string
  remainingPayable: number
  suggestedAmount?: number
  cardBalance: number | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  
  const [amount, setAmount] = useState<string>((suggestedAmount != null ? suggestedAmount : remainingPayable).toFixed(2))

  const handleSubmit = () => {
    const amt = Math.round(Number(amount || "0") * 100) / 100
    if (!Number.isFinite(amt) || amt < 0) {
      toast.error("确认金额无效")
      return
    }
    if (amt > remainingPayable + 0.005) {
      toast.error(`本次确认不能超过剩余应付 ¥${remainingPayable.toFixed(2)}`)
      return
    }

    startTransition(async () => {
      const res = await confirmOfflinePayment(saleOrderId, amt)
      if (res.success) {
        toast.success(res.message)
        onOpenChange(false)
        router.refresh()
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogClose onOpenChange={onOpenChange} />
      <DialogHeader>
        <DialogTitle>确认收款</DialogTitle>
        <DialogDescription>
          为线下订单 {saleOrderId} 登记实收款项。默认全额；可下调做部分确认，剩余在「录入回款」补齐。
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 mt-4">
        <div className="rounded-[var(--radius)] bg-[#FFF7E6] border border-[#F3C77E] px-4 py-3 text-sm">
          <div className="flex justify-between">
            <span className="text-[#666]">剩余应付现金</span>
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
          <label className="block text-sm font-medium mb-1">本次确认收款金额（¥）</label>
          <Input
            type="number"
            step="0.01"
            min="0"
            max={remainingPayable}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
          />
          <p className="text-xs text-[#999] mt-1">订单若预选了储值卡抵扣，确认时会一并扣卡入账。</p>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
          取消
        </Button>
        <Button onClick={handleSubmit} disabled={pending}>
          {pending ? "确认中…" : "确认收款"}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
