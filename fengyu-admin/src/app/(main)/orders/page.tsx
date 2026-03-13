"use client"

import { useState, useMemo } from "react"
import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { StatusBadge, Badge } from "@/components/ui/badge"
import { MOCK_ORDERS, MOCK_STORES } from "@/lib/mock-data"
import type { SaleOrder, OrderStatus, SaleOrderType } from "@/lib/types"

const paymentMethodMap: Record<string, string> = {
  wechat: "微信支付",
  alipay: "支付宝",
  offline: "线下支付",
}

const orderTypeColorMap: Record<string, string> = {
  "普通": "bg-[#E8F0FE] text-[#3574C4]",
  "体验": "bg-[#FFF0EE] text-[#C45C48]",
  "内部": "bg-[#F0F9F2] text-[#3D8A5A]",
  "福利活动": "bg-[#FFF8E6] text-[#D4820A]",
}

function formatTime(dt: string) {
  return new Date(dt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
}

export default function OrdersPage() {
  const [statusFilter, setStatusFilter] = useState<string>("")
  const [typeFilter, setTypeFilter] = useState<string>("")
  const [storeFilter, setStoreFilter] = useState<string>("")
  const [search, setSearch] = useState("")

  const filtered = useMemo(() => {
    return MOCK_ORDERS.filter((o) => {
      if (statusFilter && o.status !== statusFilter) return false
      if (typeFilter && o.saleOrderType !== typeFilter) return false
      if (storeFilter && o.storeId !== storeFilter) return false
      if (search) {
        const q = search.toLowerCase()
        if (
          !o.saleOrderId.toLowerCase().includes(q) &&
          !(o.customerName || "").toLowerCase().includes(q) &&
          !(o.clientPhone || "").includes(q)
        )
          return false
      }
      return true
    })
  }, [statusFilter, typeFilter, storeFilter, search])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">订单管理</h1>
        <Link href="/orders/create">
          <Button>新建订单</Button>
        </Link>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap gap-3">
            <Select className="w-40" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">全部状态</option>
              {(["待支付", "待确认收款", "已支付", "已完成", "支付失败", "已关闭"] as OrderStatus[]).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </Select>
            <Select className="w-40" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="">全部类型</option>
              {(["普通", "体验", "内部", "福利活动", "回款", "转换", "退款"] as SaleOrderType[]).map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </Select>
            <Select className="w-40" value={storeFilter} onChange={(e) => setStoreFilter(e.target.value)}>
              <option value="">全部门店</option>
              {MOCK_STORES.map((s) => (
                <option key={s.storeId} value={s.storeId}>{s.storeName}</option>
              ))}
            </Select>
            <Input
              className="w-56"
              placeholder="搜索订单号/顾客/手机号"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">订单号</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">类型</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">状态</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">顾客</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">门店</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">订单金额</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">支付方式</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">开单人</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">下单时间</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {filtered.map((order) => (
                  <tr key={order.saleOrderId} className="hover:bg-[#FFF0EE] transition-colors">
                    <td className="px-4 py-3">
                      <Link href={`/orders/${order.saleOrderId}`} className="text-[var(--primary)] hover:underline">
                        {order.saleOrderId}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="secondary" className={orderTypeColorMap[order.saleOrderType] || ""}>
                        {order.saleOrderType}
                      </Badge>
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={order.status} /></td>
                    <td className="px-4 py-3">{order.customerName || "-"}</td>
                    <td className="px-4 py-3">{order.storeName || "-"}</td>
                    <td className="px-4 py-3 text-right font-medium">¥{Number(order.totalAmount).toLocaleString()}</td>
                    <td className="px-4 py-3">{paymentMethodMap[order.paymentMethod] || order.paymentMethod}</td>
                    <td className="px-4 py-3">{order.openedByName || "顾客自助"}</td>
                    <td className="px-4 py-3 text-[#999999]">{formatTime(order.saleOrderDatetime)}</td>
                    <td className="px-4 py-3">
                      <OrderActions order={order} />
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={10} className="px-4 py-12 text-center text-[#999999]">暂无订单数据</td>
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

function OrderActions({ order }: { order: SaleOrder }) {
  const handleAction = (action: string) => {
    alert(`执行操作: ${action} - 订单 ${order.saleOrderId}`)
  }

  return (
    <div className="flex gap-1">
      {order.status === "待确认收款" && (
        <Button size="sm" variant="outline" onClick={() => handleAction("确认收款")}>确认收款</Button>
      )}
      {order.status === "待支付" && (
        <Button size="sm" variant="outline" onClick={() => handleAction("关闭订单")}>关闭订单</Button>
      )}
      {order.status === "支付失败" && (
        <>
          <Button size="sm" variant="outline" onClick={() => handleAction("重置")}>重置</Button>
          <Button size="sm" variant="outline" onClick={() => handleAction("关闭")}>关闭</Button>
        </>
      )}
    </div>
  )
}
