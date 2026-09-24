import Link from 'next/link'
import { ReturnContextLink } from '@/components/return-context'
import { notFound } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBadge } from '@/components/ui/badge'
import { getRefundById } from '@/actions/refunds'
import { ApprovalActions } from '../_components/approval-actions'
import { getSession } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { requireUiPageCapability } from '@/lib/page-capability'
import { formatPhoneSafe } from '@/lib/format'
import { formatDateTime as fmtDateTime } from '@/lib/utils'

export const dynamic = 'force-dynamic'

function formatDateTime(dt: string | null) {
  if (!dt) return '—'
  return fmtDateTime(dt)
}

const paymentFlowStatusColorMap: Record<string, string> = {
  待支付: 'bg-[#FFF7E6] text-[#D4820A]',
  已支付: 'bg-[#F0F9F2] text-[#3D8A5A]',
  已作废: 'bg-gray-100 text-[#888888]',
  已退款: 'bg-[#FFEBEE] text-[#C62828]',
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await getSession()
  requireUiPageCapability(session, ['sale_order:refund_create', 'sale_order:refund_approve'])
  const data = await getRefundById(id)
  if (!data) notFound()

  const canApprove = !!(session && hasPermission(session, 'sale_order:refund_approve'))

  const { refund, origOrder, payments } = data
  const refundAmount = Math.abs(Number(refund.amount))

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ReturnContextLink href="/refunds" className="text-[#999999] hover:text-[var(--foreground)]">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </ReturnContextLink>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">退款单详情</h1>
        </div>
        {refund.status === '待审批' && canApprove && <ApprovalActions refundPaymentId={refund.refundPaymentId} />}
      </div>

      {/* 退款单信息 */}
      <Card>
        <CardHeader>
          <CardTitle>退款单信息</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-y-4 gap-x-8 text-sm">
            <div>
              <span className="text-[#999]">退款流水号</span>
              <p className="font-medium mt-1">#{refund.refundPaymentId}</p>
            </div>
            <div>
              <span className="text-[#999]">状态</span>
              <p className="mt-1"><StatusBadge status={refund.status} /></p>
            </div>
            <div>
              <span className="text-[#999]">关联原单</span>
              <p className="mt-1">
                {refund.refSaleOrderId ? (
                  <Link href={`/orders/${refund.refSaleOrderId}`} className="text-[var(--primary)] hover:underline">
                    {refund.refSaleOrderId}
                  </Link>
                ) : '—'}
              </p>
            </div>
            <div>
              <span className="text-[#999]">门店</span>
              <p className="font-medium mt-1">{refund.storeName || '—'}</p>
            </div>
            <div>
              <span className="text-[#999]">顾客</span>
              <p className="font-medium mt-1">{refund.customerName || '—'}</p>
            </div>
            <div>
              <span className="text-[#999]">手机号</span>
              <p className="font-medium mt-1">{formatPhoneSafe(refund.clientPhone)}</p>
            </div>
            <div>
              <span className="text-[#999]">退款金额</span>
              <p className={`font-bold text-lg mt-1 ${refundAmount > 0 ? 'text-[#C62828]' : 'text-[#666]'}`}>
                {refundAmount > 0 ? `-¥${refundAmount.toFixed(2)}` : '退项不退款'}
              </p>
            </div>
            <div>
              <span className="text-[#999]">支付通道</span>
              <p className="font-medium mt-1">{refund.paymentMethod}</p>
            </div>
            <div>
              <span className="text-[#999]">发起人</span>
              <p className="font-medium mt-1">{refund.operatorName || '—'}</p>
            </div>
            <div>
              <span className="text-[#999]">创建时间</span>
              <p className="font-medium mt-1">{formatDateTime(refund.createdAt)}</p>
            </div>
            <div>
              <span className="text-[#999]">审批人</span>
              <p className="font-medium mt-1">{refund.auditorName || '—'}</p>
            </div>
            <div>
              <span className="text-[#999]">审批时间</span>
              <p className="font-medium mt-1">{formatDateTime(refund.auditAt)}</p>
            </div>
            <div className="col-span-2 md:col-span-3">
              <span className="text-[#999]">退款原因</span>
              <p className="font-medium mt-1">{refund.refundReason || '—'}</p>
            </div>
            {refund.auditRemark && (
              <div className="col-span-2 md:col-span-3">
                <span className="text-[#999]">驳回原因</span>
                <p className="font-medium mt-1 text-[#C62828]">{refund.auditRemark}</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 原订单概要 */}
      {origOrder && (
        <Card>
          <CardHeader>
            <CardTitle>原订单概要</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-y-3 gap-x-8 text-sm">
              <div>
                <span className="text-[#999]">订单号</span>
                <p className="font-medium mt-1">
                  <Link href={`/orders/${origOrder.saleOrderId}`} className="text-[var(--primary)] hover:underline">
                    {origOrder.saleOrderId}
                  </Link>
                </p>
              </div>
              <div>
                <span className="text-[#999]">订单状态</span>
                <p className="mt-1"><StatusBadge status={origOrder.status} /></p>
              </div>
              <div>
                <span className="text-[#999]">订单总额</span>
                <p className="font-medium mt-1">¥{Number(origOrder.totalAmount).toFixed(2)}</p>
              </div>
              <div>
                <span className="text-[#999]">支付方式</span>
                <p className="font-medium mt-1">{origOrder.paymentMethod}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 退款明细（关联商品明细） */}
      {(refund.refSaleItemId || refund.sessionCount !== null) && (
        <Card>
          <CardHeader>
            <CardTitle>退款明细</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-y-3 gap-x-8 text-sm">
              {refund.refSaleItemId && (
                <div>
                  <span className="text-[#999]">关联销售明细</span>
                  <p className="font-medium mt-1">{refund.refSaleItemId}</p>
                </div>
              )}
              {refund.sessionCount !== null && (
                <div>
                  <span className="text-[#999]">退回数量</span>
                  <p className="font-medium mt-1">{refund.sessionCount} {refund.unit}</p>
                </div>
              )}
              <div>
                <span className="text-[#999]">退款通道</span>
                <p className="font-medium mt-1">{refund.paymentMethod}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 本次退款涉及的款项流水 */}
      <Card>
        <CardHeader>
          <CardTitle>款项流水</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">时间</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">金额</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">通道</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">状态</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">操作人</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {payments.map((p) => {
                  const amt = Number(p.amount)
                  const cashAmount = Math.abs(amt)
                  return (
                    <tr key={p.id} className="hover:bg-[#FFF0EE] transition-colors">
                      <td className="px-4 py-3 whitespace-nowrap">
                        {formatDateTime(p.paidAt || p.createdAt)}
                      </td>
                      <td className={`px-4 py-3 text-right font-medium ${cashAmount > 0 ? 'text-[#C62828]' : 'text-[#666]'}`}>
                        {cashAmount > 0 ? `-¥${cashAmount.toLocaleString()}` : '退项不退款'}
                      </td>
                      <td className="px-4 py-3">{p.paymentMethod}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-block px-2 py-0.5 rounded text-xs ${paymentFlowStatusColorMap[p.status] ?? 'bg-gray-100 text-[#888]'}`}>
                          {p.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">{p.operatorName || '—'}</td>
                    </tr>
                  )
                })}
                {payments.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-[#999]">暂无款项流水</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
