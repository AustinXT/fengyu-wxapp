"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useSearchParams } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ExportButton } from "@/components/ui/export-button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { StatusBadge } from "@/components/ui/badge"
import type { RefundListItem } from "@/actions/refunds"
import { formatDateTime as fmtDateTime } from "@/lib/utils"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import { PreserveListContextLink } from "@/components/return-context"

type RefundStatus = '待审批' | '已支付' | '已关闭'

function formatDateTime(dt: string | null) {
  if (!dt) return '—'
  return fmtDateTime(dt)
}

export default function RefundsPageClient({
  refunds,
  total,
  page,
  pageSize,
}: {
  refunds: RefundListItem[]
  total: number
  page: number
  pageSize: number
}) {
  const { get, setMany } = useUrlFilters()
  const searchParams = useSearchParams()
  const rawStatus = get('status')
  const status: RefundStatus | '' = ['待审批', '已支付', '已关闭'].includes(rawStatus)
    ? rawStatus as RefundStatus
    : ''
  const [searchInput, setSearchInput] = useState(get('q'))
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => setSearchInput(get('q')), [get])
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
  }, [])

  const setFilter = useCallback((key: string, value: string) => {
    setMany({ [key]: value, page: '' })
  }, [setMany])

  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setFilter('q', value.trim()), 300)
  }, [setFilter])

  const setPage = (nextPage: number) => {
    setMany({ page: nextPage === 1 ? '' : String(nextPage) })
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
          <div className="flex flex-wrap items-center gap-3">
            <Select
              aria-label="退款状态"
              className="w-36"
              value={status}
              onChange={(event) => setFilter('status', event.target.value)}
            >
              <option value="">全部状态</option>
              <option value="待审批">待审批</option>
              <option value="已支付">已通过</option>
              <option value="已关闭">已驳回</option>
            </Select>
            <Input
              className="w-72"
              placeholder="搜索退款单号/原单号/顾客/手机号/发起人"
              value={searchInput}
              onChange={(event) => handleSearchChange(event.target.value)}
            />
            <ExportButton
              exportRequest={{
                exportType: 'refunds',
                payload: Object.fromEntries(searchParams.entries()),
              }}
            />
          </div>
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
