"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectOption } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { recordPayment } from "@/actions/orders"

/**
 * 录入回款弹层（ticket 2026-04-24 多次回款 PR-B）
 *
 * admin 端仅支持"线下"/"储值卡"两种回款方式（后台不收线上钱）。
 * 调用 recordPayment Server Action 后 router.refresh() 触发详情页重新查询款项流水 + 订单状态。
 */
export function RecordPaymentDialog({
  open,
  onOpenChange,
  saleOrderId,
  /** 订单剩余欠款（payable_amount - paid_amount），单位元 */
  remainingPayable,
  /** 顾客当前储值卡余额，单位元（null 表示未查询或无账户） */
  cardBalance,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  saleOrderId: string
  remainingPayable: number
  cardBalance: number | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  // 默认回款金额 = 剩余欠款（两位小数字符串便于受控 input）
  const [repayAmount, setRepayAmount] = useState<string>(remainingPayable.toFixed(2))
  const [paymentMethod, setPaymentMethod] = useState<"线下" | "储值卡">("线下")
  const [externalTxnId, setExternalTxnId] = useState<string>("")
  const [prepaidCardAmount, setPrepaidCardAmount] = useState<string>("0.00")
  const [note, setNote] = useState<string>("")

  const handleSubmit = () => {
    const repayNum = Number(repayAmount || "0")
    const cardNum = Number(prepaidCardAmount || "0")

    if (!Number.isFinite(repayNum) || repayNum < 0) {
      toast.error("回款金额无效")
      return
    }
    if (!Number.isFinite(cardNum) || cardNum < 0) {
      toast.error("储值卡抵扣金额无效")
      return
    }
    if (repayNum + cardNum <= 0) {
      toast.error("回款金额与储值卡抵扣不能都为 0")
      return
    }
    if (repayNum + cardNum > remainingPayable + 0.001) {
      toast.error(`本次回款不能超过剩余欠款 ¥${remainingPayable.toFixed(2)}`)
      return
    }
    if (paymentMethod === "线下" && repayNum > 0 && !externalTxnId.trim()) {
      toast.error("线下回款必须填写外部交易号（银行回执号/流水号）")
      return
    }
    if (paymentMethod === "储值卡" && repayNum > 0) {
      toast.error("储值卡付款方式下不应传回款金额，请将金额填入储值卡抵扣字段")
      return
    }
    if (cardNum > 0 && cardBalance != null && cardNum > cardBalance + 0.001) {
      toast.error(`储值卡余额不足（当前 ¥${cardBalance.toFixed(2)}）`)
      return
    }

    startTransition(async () => {
      const res = await recordPayment({
        saleOrderId,
        repayAmount: repayNum,
        paymentMethod,
        externalTxnId: externalTxnId.trim() || undefined,
        prepaidCardAmount: cardNum,
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
        <DialogTitle>录入回款</DialogTitle>
        <DialogDescription>
          向订单 {saleOrderId} 追加一笔款项流水。admin 端仅支持线下 / 储值卡方式。
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 mt-4">
        {/* 欠款额（只读） */}
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

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium mb-1">回款金额（¥）</label>
            <Input
              type="number"
              step="0.01"
              min="0"
              max={remainingPayable}
              value={repayAmount}
              onChange={(e) => setRepayAmount(e.target.value)}
              placeholder="0.00"
              disabled={paymentMethod === "储值卡"}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">支付方式</label>
            <Select
              value={paymentMethod}
              onChange={(e) => {
                const v = e.target.value as "线下" | "储值卡"
                setPaymentMethod(v)
                if (v === "储值卡") {
                  setRepayAmount("0.00")
                  setExternalTxnId("")
                }
              }}
            >
              <SelectOption value="线下">线下</SelectOption>
              <SelectOption value="储值卡">储值卡</SelectOption>
            </Select>
          </div>
        </div>

        {paymentMethod === "线下" && (
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
          <label className="block text-sm font-medium mb-1">
            储值卡抵扣金额（可选）
            {cardBalance != null && (
              <span className="text-xs text-[#666] ml-2">余额 ¥{cardBalance.toFixed(2)}</span>
            )}
          </label>
          <Input
            type="number"
            step="0.01"
            min="0"
            max={cardBalance ?? remainingPayable}
            value={prepaidCardAmount}
            onChange={(e) => setPrepaidCardAmount(e.target.value)}
            placeholder="0.00"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">备注（可选）</label>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="例如：顾客 4-25 到店补齐尾款"
            rows={2}
            maxLength={200}
          />
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
          取消
        </Button>
        <Button onClick={handleSubmit} disabled={pending}>
          {pending ? "提交中…" : "确认录入"}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
