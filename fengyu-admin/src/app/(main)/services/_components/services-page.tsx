"use client"

import { useState, useMemo } from "react"
import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { StatusBadge, Badge } from "@/components/ui/badge"
import type { ServiceOrder, Store, ServiceOrderStatus } from "@/lib/types"

function formatDate(dt: string) {
  return new Date(dt).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })
}

function ServiceActions({ so }: { so: ServiceOrder }) {
  const handleAction = (action: string) => {
    alert(`执行操作: ${action} - 服务单 ${so.serviceOrderId}`)
  }

  return (
    <div className="flex gap-1">
      {so.status === "待服务" && (
        <>
          <Button size="sm" variant="outline" onClick={() => handleAction("开始服务")}>开始服务</Button>
          <Button size="sm" variant="ghost" className="text-[#D94040]" onClick={() => handleAction("取消")}>取消</Button>
        </>
      )}
      {so.status === "服务中" && (
        <Button size="sm" variant="outline" onClick={() => handleAction("完成服务")}>完成服务</Button>
      )}
    </div>
  )
}

export default function ServicesPageClient({
  serviceOrders,
  stores,
}: {
  serviceOrders: ServiceOrder[]
  stores: Store[]
}) {
  const [statusFilter, setStatusFilter] = useState<string>("")
  const [storeFilter, setStoreFilter] = useState<string>("")
  const [search, setSearch] = useState("")

  const filtered = useMemo(() => {
    return serviceOrders.filter((s) => {
      if (statusFilter && s.status !== statusFilter) return false
      if (storeFilter && s.storeId !== storeFilter) return false
      if (search) {
        const q = search.toLowerCase()
        if (
          !s.serviceOrderId.toLowerCase().includes(q) &&
          !(s.customerName || "").toLowerCase().includes(q) &&
          !(s.employeeName || "").toLowerCase().includes(q)
        )
          return false
      }
      return true
    })
  }, [serviceOrders, statusFilter, storeFilter, search])

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-[var(--foreground)]">服务单管理</h1>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap gap-3">
            <Select className="w-40" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">全部状态</option>
              {(["待服务", "服务中", "已完成", "已取消"] as ServiceOrderStatus[]).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </Select>
            <Select className="w-40" value={storeFilter} onChange={(e) => setStoreFilter(e.target.value)}>
              <option value="">全部门店</option>
              {stores.map((s) => (
                <option key={s.storeId} value={s.storeId}>{s.storeName}</option>
              ))}
            </Select>
            <Input
              className="w-56"
              placeholder="搜索服务单号/顾客/美容师"
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
                  <th className="px-4 py-3 text-left font-medium text-gray-500">服务单号</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">状态</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">类型</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">顾客</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">门店</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">负责美容师</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">服务日期</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {filtered.map((so) => (
                  <tr key={so.serviceOrderId} className="hover:bg-[#FFF0EE] transition-colors">
                    <td className="px-4 py-3">
                      <Link href={`/services/${so.serviceOrderId}`} className="text-[var(--primary)] hover:underline">
                        {so.serviceOrderId}
                      </Link>
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={so.status} /></td>
                    <td className="px-4 py-3">
                      <Badge variant="secondary" className={so.serviceOrderType === "体验" ? "bg-[#FFF0EE] text-[#C45C48]" : "bg-[#E8F0FE] text-[#3574C4]"}>
                        {so.serviceOrderType}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">{so.customerName || "-"}</td>
                    <td className="px-4 py-3">{so.storeName || "-"}</td>
                    <td className="px-4 py-3">{so.employeeName || "-"}</td>
                    <td className="px-4 py-3 text-[#999999]">{formatDate(so.serviceDate)}</td>
                    <td className="px-4 py-3">
                      <ServiceActions so={so} />
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-12 text-center text-[#999999]">暂无服务单数据</td>
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
