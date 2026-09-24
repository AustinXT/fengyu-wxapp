"use client"

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { updatePaymentPerformanceAttributionDate } from "@/actions/orders"
import { actionErrorMessage } from "@/lib/action-error"
import { Button } from "@/components/ui/button"
import { DatePicker } from "@/components/ui/date-picker"
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

function addCalendarDays(value: string, amount: number): string {
  const [year, month, day] = value.split("-").map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + amount))
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-")
}

export function PaymentPerformanceAttributionDialog({
  open,
  onOpenChange,
  paymentId,
  originalPaidDate,
  currentAttributionDate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  paymentId: number
  originalPaidDate: string
  currentAttributionDate: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [value, setValue] = useState(currentAttributionDate)
  const min = addCalendarDays(originalPaidDate, -7)
  const max = addCalendarDays(originalPaidDate, 7)

  useEffect(() => {
    if (open) setValue(currentAttributionDate)
  }, [currentAttributionDate, open])

  const submit = () => {
    if (!value || value === currentAttributionDate) {
      toast.error("请选择一个不同于当前值的归属日期")
      return
    }
    startTransition(async () => {
      try {
        const result = await updatePaymentPerformanceAttributionDate({
          paymentId,
          performanceAttributionDate: value,
          expectedAttributionDate: currentAttributionDate,
        })
        toast.success(result.message)
        onOpenChange(false)
        router.refresh()
      } catch (error) {
        toast.error(actionErrorMessage(error, "款项业绩归属日期修改失败"))
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogClose onOpenChange={onOpenChange} disabled={pending} />
      <DialogHeader>
        <DialogTitle>修改款项业绩归属日期</DialogTitle>
        <DialogDescription>
          原始款项发生时间不会改变。归属日期只能在款项发生日前后 7 天内选择。
        </DialogDescription>
      </DialogHeader>

      <div className="mt-5 space-y-4">
        <div className="grid grid-cols-2 gap-3 rounded-md bg-gray-50 px-4 py-3 text-sm">
          <div>
            <p className="text-[#999999]">款项发生日期</p>
            <p className="mt-1 font-medium">{originalPaidDate}</p>
          </div>
          <div>
            <p className="text-[#999999]">当前归属日期</p>
            <p className="mt-1 font-medium">{currentAttributionDate}</p>
          </div>
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium">新归属日期</label>
          <DatePicker
            value={value}
            onValueChange={setValue}
            min={min}
            max={max}
            disabled={pending}
            aria-label="新款项业绩归属日期"
            className="w-full"
          />
          <p className="mt-1.5 text-xs text-[#999999]">可选范围：{min} 至 {max}</p>
        </div>
        <div className="rounded-md border border-[#F3C77E] bg-[#FFF7E6] px-4 py-3 text-sm text-[#9A6700]">
          修改成功后，该笔款项及其销售提成会立即按新日期重述，且不能再次修改。
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
          取消
        </Button>
        <Button onClick={submit} disabled={pending || !value || value === currentAttributionDate}>
          {pending ? "提交中..." : "确认修改（仅此一次）"}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
