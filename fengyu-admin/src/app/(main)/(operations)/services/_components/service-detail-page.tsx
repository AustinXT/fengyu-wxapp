"use client"

import Link from "next/link"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { StatusBadge, Badge } from "@/components/ui/badge"
import type { ServiceOrder } from "@/lib/types"
import type { ServiceItemDetail, ServiceReview } from "@/actions/services"
import { formatDateTime as fmtDateTime } from "@/lib/utils"
import { DangerZoneDelete } from "@/components/delete-action"
import { deleteServiceOrder } from "@/actions/services"

function formatDateTime(dt: string | null) {
  if (!dt) return "—"
  return fmtDateTime(dt)
}

/** 只读星级展示（admin 无现成组件，内联实现，品牌色 #C0322A） */
function StarDisplay({ rating }: { rating: number }) {
  const r = Math.max(0, Math.min(5, rating))
  return (
    <span className="text-lg leading-none tracking-wide text-[#C0322A]">
      {"★".repeat(r)}
      <span className="text-[#E8E8E8]">{"★".repeat(5 - r)}</span>
    </span>
  )
}

export default function ServiceDetailPageClient({
  serviceOrder,
  serviceItems,
  serviceReview,
  canDelete = false,
}: {
  serviceOrder: ServiceOrder
  serviceItems: ServiceItemDetail[]
  serviceReview: ServiceReview | null
  /** 是否展示「危险操作」删除入口（仅系统管理员 service:delete） */
  canDelete?: boolean
}) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/services" className="text-[#999999] hover:text-[var(--foreground)]">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
        </Link>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">服务单详情</h1>
        {serviceOrder.readOnly && (
          <Badge variant="secondary" className="bg-[#F3F3F3] text-[#888888]">跨门店只读</Badge>
        )}
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
              <p className="font-medium mt-1">{serviceOrder.customerName || "—"}</p>
            </div>
            <div>
              <span className="text-[#999999]">门店</span>
              <p className="font-medium mt-1">{serviceOrder.storeName || "—"}</p>
            </div>
            <div>
              <span className="text-[#999999]">负责美容师</span>
              <p className="font-medium mt-1">{serviceOrder.employeeName || "—"}</p>
            </div>
            <div>
              <span className="text-[#999999]">服务日期</span>
              <p className="font-medium mt-1">{serviceOrder.serviceDate}</p>
            </div>
            <div>
              <span className="text-[#999999]">预约ID</span>
              <p className="font-medium mt-1">{serviceOrder.appointmentId || "—"}</p>
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
                  <th className="px-4 py-3 text-right font-medium text-gray-500">划卡数量</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">已用/已付/共</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">操作人</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {serviceItems.length > 0 ? serviceItems.map((item) => {
                  // ticket 2026-05-19 D10=A：三段简写 已用/已付/共
                  const used = item.sessionCount !== null
                    ? item.sessionCount - (item.remainingSessions ?? 0)
                    : null
                  const sessionCell = item.sessionCount !== null
                    ? `${used ?? 0}/${item.paidSessions ?? 0}/${item.sessionCount} ${item.unit}`
                    : "-"
                  return (
                  <tr key={item.serviceItemId} className="hover:bg-[#FFF0EE] transition-colors">
                    <td className="px-4 py-3 font-medium">
                      {item.saleItemId ? (
                        <Link
                          href={`/cards/${item.saleItemId}`}
                          className="text-[var(--primary)] hover:underline"
                        >
                          {item.productName || "—"}
                        </Link>
                      ) : (
                        item.productName || "—"
                      )}
                    </td>
                    <td className="px-4 py-3">{item.skuName || "—"}</td>
                    <td className="px-4 py-3 text-right">
                      {item.unitRealPrice
                        ? `¥${Number(item.unitRealPrice).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : "-"}
                    </td>
                    <td className="px-4 py-3 text-right">{item.sessionUsed} {item.unit}</td>
                    <td className="px-4 py-3 text-right">{sessionCell}</td>
                    <td className="px-4 py-3">{item.employeeName || "—"}</td>
                  </tr>
                  )
                }) : (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-[#999999]">暂无关联明细</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* 客户评价（仅已完成单展示；service:list 权限已在 action 层限定，所有有权限用户可见） */}
      {serviceOrder.status === "已完成" && (
        <Card>
          <CardHeader>
            <CardTitle>客户评价</CardTitle>
          </CardHeader>
          <CardContent>
            {serviceReview ? (
              <div className="space-y-3 text-sm">
                <div className="flex items-center gap-2">
                  <StarDisplay rating={serviceReview.rating} />
                  <span className="font-medium text-[#C0322A]">{serviceReview.rating} 分</span>
                </div>
                {serviceReview.comment && (
                  <p className="whitespace-pre-wrap text-[var(--foreground)]">{serviceReview.comment}</p>
                )}
                <p className="text-[#999999]">{formatDateTime(serviceReview.createdAt)}</p>
              </div>
            ) : (
              <p className="text-sm text-[#999999]">顾客暂未评价</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* 危险操作：物理删除服务单（仅系统管理员；跨门店只读访问不展示） */}
      {canDelete && !serviceOrder.readOnly && (
        <DangerZoneDelete
          entityLabel="服务单"
          redirectTo="/services"
          onConfirm={() => deleteServiceOrder(serviceOrder.serviceOrderId)}
          description={
            <>
              确定要删除服务单 <span className="font-medium">{serviceOrder.serviceOrderId}</span> 吗？
              将一并删除其服务明细与评价，此操作不可恢复。仅「待服务 / 已取消」可删，进行中或已完成不可删除。
            </>
          }
        />
      )}
    </div>
  )
}
