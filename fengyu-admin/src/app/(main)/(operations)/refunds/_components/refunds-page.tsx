"use client"

import { useRouter, useSearchParams } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { StatusBadge } from "@/components/ui/badge"
import type { RefundListItem } from "@/actions/refunds"
import { formatDateTime as fmtDateTime } from "@/lib/utils"
import { PreserveListContextLink } from "@/components/return-context"

type RefundStatus = '待审批' | '已支付' | '已关闭'

function formatDateTime(dt: string | null) {
  if (!dt) return '—'
  return fmtDateTime(dt)
}

export default function RefundsPageClient({
  initialStatus,
  refunds,
  total,
  page,
  pageSize,
}: {
  initialStatus: RefundStatus
  refunds: RefundListItem[]
  total: number
  page: number
  pageSize: number
}) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const setStatus = (status: RefundStatus) => {
    const params = new URLSearchParams(searchParams?.toString() ?? '')
    params.set('status', status)
    params.delete('page')
    router.push(`/refunds?${params.toString()}`)
  }

  const setPage = (nextPage: number) => {
    const params = new URLSearchParams(searchParams?.toString() ?? '')
    params.set('page', String(nextPage))
    router.push(`/refunds?${params.toString()}`)
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">退款管理</h1>
        <div className="text-sm text-[#999]">共 {total} 条</div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>退款申请</CardTitle>
          <Tabs value={initialStatus} onValueChange={(v) => setStatus(v as RefundStatus)}>
            <TabsList>
              <TabsTrigger value="待审批">待审批</TabsTrigger>
              <TabsTrigger value="已支付">已通过</TabsTrigger>
              <TabsTrigger value="已关闭">已驳回</TabsTrigger>
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">退款单号</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">关联原单</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">顾客</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">退款金额</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">状态</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">原因</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">发起人</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">创建时间</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {refunds.map((r) => {
                  const amount = Math.abs(Number(r.amount))
                  return (
                    <tr key={r.refundPaymentId} className="hover:bg-[#FFF0EE] transition-colors">
                      <td className="px-4 py-3 font-medium">
                        <PreserveListContextLink href={`/refunds/${r.refundPaymentId}`} className="text-[var(--primary)] hover:underline">
                          #{r.refundPaymentId}
                        </PreserveListContextLink>
                      </td>
                      <td className="px-4 py-3">
                        {r.refSaleOrderId ? (
                          <PreserveListContextLink href={`/orders/${r.refSaleOrderId}`} className="hover:underline">
                            {r.refSaleOrderId}
                          </PreserveListContextLink>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-3">{r.customerName || '—'}</td>
                      <td className={`px-4 py-3 text-right font-medium ${amount > 0 ? "text-[#C62828]" : "text-[#666]"}`}>
                        {amount > 0 ? `-¥${amount.toFixed(2)}` : "退项不退款"}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="px-4 py-3 text-[#666] max-w-xs truncate" title={r.refundReason ?? ''}>
                        {r.refundReason || '—'}
                      </td>
                      <td className="px-4 py-3">{r.operatorName || '—'}</td>
                      <td className="px-4 py-3 whitespace-nowrap">{formatDateTime(r.createdAt)}</td>
                      <td className="px-4 py-3 text-right">
                        <PreserveListContextLink href={`/refunds/${r.refundPaymentId}`}>
                          <Button size="sm" variant="outline">
                            {r.status === '待审批' ? '审批' : '查看'}
                          </Button>
                        </PreserveListContextLink>
                      </td>
                    </tr>
                  )
                })}
                {refunds.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-4 py-12 text-center text-[#999]">
                      暂无退款申请
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* 简单分页 */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-[var(--border)]">
              <span className="text-sm text-[#999]">第 {page} / {totalPages} 页</span>
              <div className="space-x-2">
                <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  上一页
                </Button>
                <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
                  下一页
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
