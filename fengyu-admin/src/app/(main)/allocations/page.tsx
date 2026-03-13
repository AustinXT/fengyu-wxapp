"use client"

import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { MOCK_ORDERS } from "@/lib/mock-data"

const allocationStatusMap: Record<string, { label: string; className: string }> = {
  pending: { label: "待分配", className: "border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]" },
  allocated: { label: "已分配", className: "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]" },
}

function formatTime(dt: string) {
  return new Date(dt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
}

export default function AllocationsPage() {
  const ordersNeedingAllocation = MOCK_ORDERS.filter(
    (o) => o.status === "已支付"
  )

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-[var(--foreground)]">营业额分配</h1>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">订单号</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">顾客</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">门店</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">订单金额</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">分配状态</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">支付时间</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {ordersNeedingAllocation.map((order) => {
                  const statusInfo = allocationStatusMap[order.allocationStatus || "pending"] || allocationStatusMap.pending
                  return (
                    <tr key={order.saleOrderId} className="hover:bg-[#FFF0EE] transition-colors">
                      <td className="px-4 py-3">
                        <Link href={`/orders/${order.saleOrderId}`} className="text-[var(--primary)] hover:underline">
                          {order.saleOrderId}
                        </Link>
                      </td>
                      <td className="px-4 py-3">{order.customerName || "-"}</td>
                      <td className="px-4 py-3">{order.storeName || "-"}</td>
                      <td className="px-4 py-3 text-right font-medium">¥{Number(order.totalAmount).toLocaleString()}</td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className={statusInfo.className}>
                          {statusInfo.label}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-[#999999]">{order.paidAt ? formatTime(order.paidAt) : "-"}</td>
                      <td className="px-4 py-3">
                        <Link href={`/allocations/${order.saleOrderId}`}>
                          <Button size="sm" variant="outline">
                            {order.allocationStatus === "allocated" ? "查看分配" : "分配"}
                          </Button>
                        </Link>
                      </td>
                    </tr>
                  )
                })}
                {ordersNeedingAllocation.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-[#999999]">暂无需要分配的订单</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
