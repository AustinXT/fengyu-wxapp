"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { approveRefund, rejectRefund } from "@/actions/refunds";

export function ApprovalActions({ refundPaymentId }: { refundPaymentId: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [approveOpen, setApproveOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const handleApprove = () => {
    startTransition(async () => {
      const res = await approveRefund(refundPaymentId);
      if (res.success) {
        toast.success(`退款已通过，线下退款金额 ¥${res.data.refundByOrigin.toFixed(2)}`);
        setApproveOpen(false);
        router.refresh();
      } else {
        toast.error(res.error.message);
      }
    });
  };

  const handleReject = () => {
    if (!rejectReason.trim()) {
      toast.error("请填写驳回原因");
      return;
    }
    startTransition(async () => {
      const res = await rejectRefund(refundPaymentId, rejectReason.trim());
      if (res.success) {
        toast.success("退款已驳回");
        setRejectOpen(false);
        setRejectReason("");
        router.refresh();
      } else {
        toast.error(res.error.message);
      }
    });
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={() => setRejectOpen(true)} disabled={pending}>
          驳回
        </Button>
        <Button onClick={() => setApproveOpen(true)} disabled={pending}>
          审批通过
        </Button>
      </div>

      {/* 审批通过二次确认 */}
      <AlertDialog open={approveOpen} onOpenChange={setApproveOpen}>
        <AlertDialogTitle>确认审批通过？</AlertDialogTitle>
        <AlertDialogDescription>
          审批通过后将执行以下操作：
          <ul className="mt-2 list-disc list-inside text-sm">
            <li>退款流水翻 待审批 → 已支付，回写审批人/时间</li>
            <li>重算原销售单已退金额；净收入 = 实收 − 已退金额</li>
            <li>重算疗程卡已支付次数：退款后该卡可消费次数相应减少</li>
            <li>按储值卡比例回冲顾客账户余额</li>
            <li>5 通道级联：营业额分配/ 服务提成软删；优惠券恢复未使用；积分反向流水；家居产品已提货数量反向恢复</li>
            <li>顾客累计消费档位重算</li>
          </ul>
          此操作不可撤销。
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setApproveOpen(false)} disabled={pending}>
            取消
          </AlertDialogCancel>
          <AlertDialogAction onClick={handleApprove} disabled={pending} className="bg-[#3D8A5A] hover:bg-[#3D8A5A]/90">
            {pending ? "处理中…" : "确认通过"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>

      {/* 驳回弹层（需输入原因） */}
      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogClose onOpenChange={setRejectOpen} />
        <DialogHeader>
          <DialogTitle>驳回退款申请</DialogTitle>
        </DialogHeader>
        <div className="mt-4">
          <label className="block text-sm font-medium mb-1">
            驳回原因 <span className="text-[#C0322A]">*</span>
          </label>
          <Textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={4}
            maxLength={300}
            placeholder="请说明驳回原因，发起人可查看此说明"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setRejectOpen(false)} disabled={pending}>
            取消
          </Button>
          <Button onClick={handleReject} disabled={pending} variant="destructive">
            {pending ? "处理中…" : "确认驳回"}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
