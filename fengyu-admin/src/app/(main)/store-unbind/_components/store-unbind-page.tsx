"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { StatusBadge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { approveUnbind, rejectUnbind, deleteUnbindRequest, type UnbindRequest } from "@/actions/store-unbind"
import { RowDeleteMenu } from "@/components/delete-action"
import { formatPhoneSafe } from "@/lib/format"
import { formatDateTime as fmtDateTime } from "@/lib/utils"

function formatDate(dt: string | null | undefined) {
  if (!dt) return "—"
  return fmtDateTime(dt)
}

interface Props {
  requests: UnbindRequest[]
  /** 是否展示行内删除入口（仅系统管理员 store_unbind:delete） */
  canDelete?: boolean
}

export default function StoreUnbindPage({ requests, canDelete = false }: Props) {
  const router = useRouter()
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [approveTarget, setApproveTarget] = useState<UnbindRequest | null>(null)
  const [rejectTarget, setRejectTarget] = useState<UnbindRequest | null>(null)
  const [rejectReason, setRejectReason] = useState("")

  const handleApprove = async () => {
    if (!approveTarget) return
    setPendingId(approveTarget.requestId)
    try {
      const res = await approveUnbind(approveTarget.requestId)
      if (res.success) {
        toast.success(res.message)
        router.refresh()
      } else {
        toast.error(res.message)
      }
    } catch {
      toast.error("操作失败")
    } finally {
      setPendingId(null)
      setApproveTarget(null)
    }
  }

  const handleReject = async () => {
    if (!rejectTarget) return
    if (!rejectReason.trim()) {
      toast.error("请填写拒绝原因")
      return
    }
    setPendingId(rejectTarget.requestId)
    try {
      const res = await rejectUnbind(rejectTarget.requestId, rejectReason.trim())
      if (res.success) {
        toast.success(res.message)
        router.refresh()
      } else {
        toast.error(res.message)
      }
    } catch {
      toast.error("操作失败")
    } finally {
      setPendingId(null)
      setRejectTarget(null)
      setRejectReason("")
    }
  }

  const pendingRequests = requests.filter((r) => r.status === "待处理")
  const processedRequests = requests.filter((r) => r.status !== "待处理")

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-[var(--foreground)]">门店解绑审批</h1>

      {/* 待处理 */}
      {pendingRequests.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">状态</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">顾客</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">手机号</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">原门店</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">目标门店</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">备注</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">申请时间</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {pendingRequests.map((req) => (
                    <tr key={req.requestId} className="hover:bg-[#FFF0EE] transition-colors">
                      <td className="px-4 py-3"><StatusBadge status="待确认" /></td>
                      <td className="px-4 py-3 font-medium">{req.customerName || "—"}</td>
                      <td className="px-4 py-3">{formatPhoneSafe(req.customerPhone)}</td>
                      <td className="px-4 py-3">{req.fromStoreName || "—"}</td>
                      <td className="px-4 py-3">{req.toStoreName || "—"}</td>
                      <td className="px-4 py-3 text-[#999999] max-w-32 truncate">{req.note || "—"}</td>
                      <td className="px-4 py-3 text-[#999999]">{formatDate(req.createdAt)}</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setApproveTarget(req)}
                            disabled={pendingId === req.requestId}
                          >
                            通过
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-[#D94040]"
                            onClick={() => setRejectTarget(req)}
                            disabled={pendingId === req.requestId}
                          >
                            拒绝
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {pendingRequests.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-[#999999]">
            暂无待处理的解绑申请
          </CardContent>
        </Card>
      )}

      {/* 已处理 */}
      {processedRequests.length > 0 && (
        <>
          <h2 className="text-lg font-semibold text-[var(--foreground)] mt-6">历史记录</h2>
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium text-gray-500">状态</th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500">顾客</th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500">手机号</th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500">原门店</th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500">目标门店</th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500">原因</th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500">申请时间</th>
                      {canDelete && <th className="px-4 py-3 text-left font-medium text-gray-500">操作</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {processedRequests.map((req) => (
                      <tr key={req.requestId}>
                        <td className="px-4 py-3">
                          <StatusBadge status={req.status === "已通过" ? "已完成" : "已取消"} />
                        </td>
                        <td className="px-4 py-3 font-medium">{req.customerName || "—"}</td>
                        <td className="px-4 py-3">{formatPhoneSafe(req.customerPhone)}</td>
                        <td className="px-4 py-3">{req.fromStoreName || "—"}</td>
                        <td className="px-4 py-3">{req.toStoreName || "—"}</td>
                        <td className="px-4 py-3 text-[#999999] max-w-40 truncate">{req.rejectReason || "—"}</td>
                        <td className="px-4 py-3 text-[#999999]">{formatDate(req.createdAt)}</td>
                        {canDelete && (
                          <td className="px-4 py-3">
                            <RowDeleteMenu
                              entityLabel="解绑申请"
                              onConfirm={() => deleteUnbindRequest(req.requestId)}
                              description={<>确定要删除该已处理的解绑申请吗？此操作不可恢复。</>}
                            />
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {/* 通过确认 */}
      <AlertDialog open={!!approveTarget} onOpenChange={(open) => !open && setApproveTarget(null)}>
        <AlertDialogTitle>确认通过转店？</AlertDialogTitle>
        <AlertDialogDescription>
          通过后将把该顾客的绑定门店转至目标门店，并清除原指定美容师，此操作不可撤销。
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setApproveTarget(null)}>返回</AlertDialogCancel>
          <AlertDialogAction onClick={handleApprove}>确认通过</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>

      {/* 拒绝弹窗 */}
      <Dialog open={!!rejectTarget} onOpenChange={(open) => !open && setRejectTarget(null)}>
        <DialogHeader>
          <DialogTitle>拒绝解绑申请</DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-2">
          <label className="text-sm font-medium">拒绝原因 *</label>
          <Input
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="请填写拒绝原因"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { setRejectTarget(null); setRejectReason("") }}>
            取消
          </Button>
          <Button onClick={handleReject} disabled={pendingId === rejectTarget?.requestId}>
            确认拒绝
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  )
}
