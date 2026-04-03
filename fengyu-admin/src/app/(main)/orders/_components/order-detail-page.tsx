"use client"

import Link from "next/link"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { StatusBadge, Badge } from "@/components/ui/badge"
import type { SaleOrder, SaleAllocation, OperationLog } from "@/lib/types"

const paymentMethodMap: Record<string, string> = {
  微信: "微信支付",
  支付宝: "支付宝",
  线下: "线下支付",
}

const orderTypeColorMap: Record<string, string> = {
  "销售单": "bg-[#E8F0FE] text-[#3574C4]",
  "内部单": "bg-[#F0F9F2] text-[#3D8A5A]",
  "回款单": "bg-[#E8F5E9] text-[#2E7D32]",
  "转换单": "bg-[#E3F2FD] text-[#1565C0]",
  "退款单": "bg-[#FFEBEE] text-[#C62828]",
}

function formatDateTime(dt: string | null) {
  if (!dt) return "-"
  return new Date(dt).toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  })
}

export default function OrderDetailPageClient({
  order,
  allocations,
  logs,
}: {
  order: SaleOrder
  allocations: SaleAllocation[]
  logs: OperationLog[]
}) {
  const items = order.items || []

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/orders" className="text-[#999999] hover:text-[var(--foreground)]">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
          </Link>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">订单详情</h1>
        </div>
      </div>

      {/* 订单信息 */}
      <Card>
        <CardHeader>
          <CardTitle>订单信息</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-y-4 gap-x-8 text-sm">
            <div>
              <span className="text-[#999999]">订单号</span>
              <p className="font-medium mt-1">{order.saleOrderId}</p>
            </div>
            <div>
              <span className="text-[#999999]">状态</span>
              <p className="mt-1"><StatusBadge status={order.status} /></p>
            </div>
            <div>
              <span className="text-[#999999]">类型</span>
              <p className="mt-1">
                <Badge variant="secondary" className={orderTypeColorMap[order.saleOrderType] || ""}>
                  {order.saleOrderType}
                </Badge>
              </p>
            </div>
            <div>
              <span className="text-[#999999]">门店</span>
              <p className="font-medium mt-1">{order.storeName}</p>
            </div>
            <div>
              <span className="text-[#999999]">开单人</span>
              <p className="font-medium mt-1">{order.openedByName || "顾客自助"}</p>
            </div>
            <div>
              <span className="text-[#999999]">顾客</span>
              <p className="font-medium mt-1">{order.customerName || "-"}</p>
            </div>
            <div>
              <span className="text-[#999999]">下单时间</span>
              <p className="font-medium mt-1">{formatDateTime(order.saleOrderDatetime)}</p>
            </div>
            <div>
              <span className="text-[#999999]">支付时间</span>
              <p className="font-medium mt-1">{formatDateTime(order.paidAt)}</p>
            </div>
            <div>
              <span className="text-[#999999]">支付方式</span>
              <p className="font-medium mt-1">{paymentMethodMap[order.paymentMethod] || order.paymentMethod}</p>
            </div>
            <div>
              <span className="text-[#999999]">订单金额</span>
              <p className="font-bold text-lg mt-1 text-[var(--primary)]">¥{Number(order.totalAmount).toLocaleString()}</p>
            </div>
            {order.remark && (
              <div className="col-span-2 md:col-span-3">
                <span className="text-[#999999]">备注</span>
                <p className="font-medium mt-1">{order.remark}</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 商品明细 */}
      <Card>
        <CardHeader>
          <CardTitle>商品明细</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">SKU 名称</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">单价</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">数量</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">实收</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">状态/剩余次数</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {items.map((item) => (
                  <tr key={item.saleItemId} className="hover:bg-[#FFF0EE] transition-colors">
                    <td className="px-4 py-3 font-medium">{item.skuName || item.productName || "-"}</td>
                    <td className="px-4 py-3 text-right">¥{Number(item.unitPrice).toLocaleString()}</td>
                    <td className="px-4 py-3 text-right">{item.quantity}</td>
                    <td className="px-4 py-3 text-right font-medium">¥{Number(item.received).toLocaleString()}</td>
                    <td className="px-4 py-3">
                      {item.sessionCount !== null
                        ? `剩余 ${item.remainingSessions ?? 0}/${item.sessionCount} 次`
                        : "单品"}
                    </td>
                  </tr>
                ))}
                {items.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-[#999999]">暂无明细</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* 营业额分配 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>营业额分配</CardTitle>
          {order.status === '已支付' && (
            <Link href={`/allocations/${order.saleOrderId}`}>
              <Button size="sm" variant="outline">编辑分配</Button>
            </Link>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {allocations.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">员工</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">部门</th>
                    <th className="px-4 py-3 text-right font-medium text-gray-500">金额</th>
                    <th className="px-4 py-3 text-right font-medium text-gray-500">比例</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {allocations.map((a) => (
                    <tr key={a.id} className="hover:bg-[#FFF0EE] transition-colors">
                      <td className="px-4 py-3 font-medium">{a.employeeName}</td>
                      <td className="px-4 py-3">{a.departmentName || "-"}</td>
                      <td className="px-4 py-3 text-right">¥{Number(a.totalAmount).toLocaleString()}</td>
                      <td className="px-4 py-3 text-right">{(Number(a.allocationRatio) * 100).toFixed(0)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="px-4 py-8 text-center text-[#999999]">暂未分配</div>
          )}
        </CardContent>
      </Card>

      {/* 操作日志 */}
      <Card>
        <CardHeader>
          <CardTitle>操作日志</CardTitle>
        </CardHeader>
        <CardContent>
          {logs.length > 0 ? (
            <div className="space-y-4">
              {logs.map((log) => (
                <div key={log.id} className="flex gap-4">
                  <div className="flex flex-col items-center">
                    <div className="h-2.5 w-2.5 rounded-full bg-[var(--primary)] mt-1.5" />
                    <div className="flex-1 w-px bg-[var(--border)]" />
                  </div>
                  <div className="pb-4">
                    <p className="text-sm font-medium text-[var(--foreground)]">
                      {log.operatorName} - {log.action}
                    </p>
                    <p className="text-xs text-[#999999] mt-1">{formatDateTime(log.createdAt)}</p>
                    {log.detail && (
                      <p className="text-xs text-[#999999] mt-1 bg-gray-50 rounded px-2 py-1 font-mono">
                        {JSON.stringify(log.detail)}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-center text-[#999999] py-4">暂无日志</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
