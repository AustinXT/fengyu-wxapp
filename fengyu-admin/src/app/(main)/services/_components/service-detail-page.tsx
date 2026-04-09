"use client"

import Link from "next/link"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { StatusBadge, Badge } from "@/components/ui/badge"
import type { ServiceOrder } from "@/lib/types"
import type { ServiceItemDetail } from "@/actions/services"

function formatDateTime(dt: string | null) {
  if (!dt) return "-"
  return new Date(dt).toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  })
}

export default function ServiceDetailPageClient({
  serviceOrder,
  serviceItems,
}: {
  serviceOrder: ServiceOrder
  serviceItems: ServiceItemDetail[]
}) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/services" className="text-[#999999] hover:text-[var(--foreground)]">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
        </Link>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">服务单详情</h1>
      </div>

      {/* 服务单信息 */}
      <Card>
        <CardHeader>
          <CardTitle>服务单信息</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-y-4 gap-x-8 text-sm">
            <div>
              <span className="text-[#999999]">服务单号</span>
              <p className="font-medium mt-1">{serviceOrder.serviceOrderId}</p>
            </div>
            <div>
              <span className="text-[#999999]">状态</span>
              <p className="mt-1"><StatusBadge status={serviceOrder.status} /></p>
            </div>
            <div>
              <span className="text-[#999999]">类型</span>
              <p className="mt-1">
                <Badge variant="secondary" className={serviceOrder.serviceOrderType === "售前" ? "bg-[#FFF0EE] text-[#C45C48]" : "bg-[#E8F0FE] text-[#3574C4]"}>
                  {serviceOrder.serviceOrderType}
                </Badge>
              </p>
            </div>
            <div>
              <span className="text-[#999999]">顾客</span>
              <p className="font-medium mt-1">{serviceOrder.customerName || "-"}</p>
            </div>
            <div>
              <span className="text-[#999999]">门店</span>
              <p className="font-medium mt-1">{serviceOrder.storeName || "-"}</p>
            </div>
            <div>
              <span className="text-[#999999]">负责美容师</span>
              <p className="font-medium mt-1">{serviceOrder.employeeName || "-"}</p>
            </div>
            <div>
              <span className="text-[#999999]">服务日期</span>
              <p className="font-medium mt-1">{serviceOrder.serviceDate}</p>
            </div>
            <div>
              <span className="text-[#999999]">预约ID</span>
              <p className="font-medium mt-1">{serviceOrder.appointmentId || "-"}</p>
            </div>
            <div>
              <span className="text-[#999999]">创建时间</span>
              <p className="font-medium mt-1">{formatDateTime(serviceOrder.createdAt)}</p>
            </div>
            {serviceOrder.remark && (
              <div className="col-span-full">
                <span className="text-[#999999]">备注</span>
                <p className="font-medium mt-1">{serviceOrder.remark}</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 服务明细 */}
      <Card>
        <CardHeader>
          <CardTitle>关联服务明细</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">商品名称</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">规格</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">单价</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">划卡次数</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">剩余/总次数</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">操作人</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {serviceItems.length > 0 ? serviceItems.map((item) => (
                  <tr key={item.serviceItemId} className="hover:bg-[#FFF0EE] transition-colors">
                    <td className="px-4 py-3 font-medium">{item.productName || "-"}</td>
                    <td className="px-4 py-3">{item.skuName || "-"}</td>
                    <td className="px-4 py-3 text-right">
                      {item.unitRealPrice ? `¥${Number(item.unitRealPrice).toLocaleString()}` : "-"}
                    </td>
                    <td className="px-4 py-3 text-right">{item.sessionUsed}</td>
                    <td className="px-4 py-3 text-right">
                      {item.sessionCount !== null
                        ? `${item.remainingSessions ?? 0}/${item.sessionCount}`
                        : "-"}
                    </td>
                    <td className="px-4 py-3">{item.employeeName || "-"}</td>
                  </tr>
                )) : (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-[#999999]">暂无关联明细</td>
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
