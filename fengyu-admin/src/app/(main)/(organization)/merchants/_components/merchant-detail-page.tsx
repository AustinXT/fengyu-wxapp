"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import type { MerchantDetail } from "@/actions/merchants"
import { deleteMerchant } from "@/actions/merchants"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@/components/ui/alert-dialog"
import { formatDateTime } from "@/lib/utils"
import { actionErrorMessage } from "@/lib/action-error"
import { useReturnContext } from "@/components/return-context"

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <span className="text-[#999999]">{label}</span>
      <p className={`mt-1 font-medium ${mono ? "font-mono text-xs" : ""}`}>{value}</p>
    </div>
  )
}

export default function MerchantDetailPage({
  merchant,
  canEdit,
  canDelete,
}: {
  merchant: MerchantDetail
  canEdit: boolean
  canDelete: boolean
}) {
  const router = useRouter()
  const { forwardHref, goToReturn } = useReturnContext('/merchants')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const hasLinkedStores = merchant.linkedStores.length > 0

  const handleDelete = async () => {
    setDeleting(true)
    try {
      const result = await deleteMerchant(merchant.id)
      if (!result.success) {
        toast.error(result.message)
        setDeleteOpen(false)
        return
      }
      toast.success(result.message)
      goToReturn(true)
      router.refresh()
    } catch (err) {
      toast.error(actionErrorMessage(err, "删除失败"))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={() => goToReturn()}>
          &larr; 返回
        </Button>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">商户详情</h1>
        {canEdit && (
          <Button className="ml-auto" onClick={() => router.push(forwardHref(`/merchants/${merchant.id}/edit`))}>
            编辑
          </Button>
        )}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">收款商户信息</CardTitle>
          {merchant.enabled ? (
            <Badge variant="outline" className="border-[#3D8A5A] text-[#3D8A5A]">
              已启用
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[#888888]">
              未启用
            </Badge>
          )}
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-x-8 gap-y-4 text-sm md:grid-cols-3">
            <Field label="商户名称" value={merchant.merchantName} />
            <Field label="商户号" value={merchant.merchantNo ?? "—"} mono />
            <Field label="终端号" value={merchant.termNo ?? "—"} mono />
            <Field label="商户 ID" value={merchant.id} mono />
            <Field label="创建时间" value={formatDateTime(merchant.createdAt)} />
            <Field label="更新时间" value={formatDateTime(merchant.updatedAt)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">关联门店（{merchant.linkedStores.length}）</CardTitle>
        </CardHeader>
        <CardContent>
          {hasLinkedStores ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] text-[#999999]">
                    <th className="px-3 py-2 text-left font-medium">门店</th>
                    <th className="px-3 py-2 text-left font-medium">市场</th>
                  </tr>
                </thead>
                <tbody>
                  {merchant.linkedStores.map((s) => (
                    <tr key={s.storeId} className="border-b border-[var(--border)]">
                      <td className="px-3 py-2">
                        <Link
                          href={`/stores/${s.storeId}/edit`}
                          className="text-[var(--primary)] hover:underline"
                        >
                          {s.storeName}
                        </Link>
                      </td>
                      <td className="px-3 py-2">{s.marketName ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-[#999999]">暂无门店关联本商户。</p>
          )}
        </CardContent>
      </Card>

      {/* 危险操作：删除入口放详情页底部不显眼处（有门店关联时禁用） */}
      {canDelete && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base text-[#888888]">危险操作</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between gap-4">
              <p className="text-xs text-[#999999]">
                {hasLinkedStores
                  ? "该商户仍被门店关联，需先在门店编辑页解除关联后才能删除。"
                  : "删除后不可恢复。仅当无门店关联时可删。"}
              </p>
              <Button
                variant="ghost"
                className="shrink-0 text-[#D94040]"
                disabled={hasLinkedStores}
                onClick={() => setDeleteOpen(true)}
              >
                删除商户
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogTitle>确认删除商户？</AlertDialogTitle>
        <AlertDialogDescription>
          删除「{merchant.merchantName}」后不可恢复。删除前请确认无门店关联本商户。
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setDeleteOpen(false)}>取消</AlertDialogCancel>
          <AlertDialogAction onClick={handleDelete} disabled={deleting}>
            {deleting ? "删除中..." : "确认删除"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>
    </div>
  )
}
