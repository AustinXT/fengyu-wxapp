"use client"

import { useState, useEffect, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { updateDepositReceived } from "@/actions/orders"

/**
 * 寄存单历史实收编辑弹层。
 *
 * 逐行录入「这张卡当时实际收了多少钱」，提交 items[] 给 updateDepositReceived（全量重设）。
 * 仅记账：不收款、不计营业额、不影响可消费次数（total_amount 保持 0）。
 */
type DepositItem = {
  saleItemId: string
  productName: string
  /** 当前已录实收（元，字符串） */
  received: string
}

export function DepositReceiptDialog({
  open,
  onOpenChange,
  saleOrderId,
  items,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  saleOrderId: string
  items: DepositItem[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  // 各行实收输入（saleItemId → 金额字符串）
  const [lineReceived, setLineReceived] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!open) return
    const init: Record<string, string> = {}
    for (const it of items) init[it.saleItemId] = Number(it.received) > 0 ? Number(it.received).toFixed(2) : ""
    setLineReceived(init)
  }, [open, items])

  const round2 = (n: number) => Math.round(n * 100) / 100
  const total = round2(items.reduce((s, it) => s + (Number(lineReceived[it.saleItemId] || 0) || 0), 0))

  const handleSubmit = () => {
    for (const it of items) {
      const v = Number(lineReceived[it.saleItemId] || 0) || 0
      if (v < 0) {
        toast.error("实收金额不能为负")
        return
      }
    }
    const payloadItems = items.map((it) => ({
      saleItemId: it.saleItemId,
      received: round2(Number(lineReceived[it.saleItemId] || 0) || 0),
    }))
    startTransition(async () => {
      const res = await updateDepositReceived({ saleOrderId, items: payloadItems })
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
        <DialogTitle>修改历史实收</DialogTitle>
        <DialogDescription>
          录入寄存单 {saleOrderId} 各明细「当时实际收了多少钱」。仅作账目记录，不收款、不计营业额、不影响可核销次数。
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 mt-4">
        <div className="border border-[#E8E8E8] rounded-[var(--radius)] overflow-hidden">
          <div className="grid grid-cols-[1fr_auto] gap-2 px-3 py-2 bg-[#F5F5F5] text-xs text-[#666] font-medium">
            <span>明细</span>
            <span className="w-28 text-right">实收(¥)</span>
          </div>
          {items.length === 0 ? (
            <div className="px-3 py-4 text-sm text-[#999]">无明细</div>
          ) : (
            items.map((it) => (
              <div key={it.saleItemId} className="grid grid-cols-[1fr_auto] gap-2 px-3 py-2 border-t border-[#F0F0F0] items-center">
                <div className="min-w-0 text-sm truncate">{it.productName}</div>
                <Input
                  className="w-28 text-right"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="0"
                  value={lineReceived[it.saleItemId] ?? ""}
                  onChange={(e) => setLineReceived((m) => ({ ...m, [it.saleItemId]: e.target.value }))}
                />
              </div>
            ))
          )}
          <div className="grid grid-cols-[1fr_auto] gap-2 px-3 py-2 border-t border-[#E8E8E8] bg-[#FAFAFA] text-sm font-medium items-center">
            <span className="text-[#666]">合计实收</span>
            <span className="w-28 text-right text-[#C0322A]">¥{total.toFixed(2)}</span>
          </div>
        </div>
        <p className="text-xs text-[#999]">留空或填 0 表示该行无实收记录。</p>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
          取消
        </Button>
        <Button onClick={handleSubmit} disabled={pending}>
          {pending ? "提交中…" : "保存"}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
