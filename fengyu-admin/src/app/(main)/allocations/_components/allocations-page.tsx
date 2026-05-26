"use client"

import { useCallback, useRef, useState, useTransition } from "react"
import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Pagination } from "@/components/ui/pagination"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import type { SaleOrder, ServiceOrder, Store } from "@/lib/types"
import { formatDate as fmtDate, formatDateTime as fmtDateTime } from "@/lib/utils"

const PAGE_SIZE_OPTIONS = [10, 20, 50]

const allocationStatusMap: Record<string, { label: string; className: string }> = {
  待分配: { label: "待分配", className: "border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]" },
  已分配: { label: "已分配", className: "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]" },
}

function formatTime(dt: string) {
  return fmtDateTime(dt)
}

function formatDate(dt: string) {
  return fmtDate(dt)
}

/**
 * 营业额分配列表 — 服务端分页 + Tab 切换（销售提成 / 服务提成）
 */
export default function AllocationsPageClient({
  tab,
  stores = [],
  orders = [],
  saleTotal = 0,
  serviceOrders = [],
  serviceTotal = 0,
}: {
  tab: 'sale' | 'service'
  stores?: Store[]
  orders?: SaleOrder[]
  saleTotal?: number
  serviceOrders?: ServiceOrder[]
  serviceTotal?: number
}) {
  const { get, set, setMany } = useUrlFilters()
  const currentPage = Math.max(1, Number(get("page", "1")) || 1)
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(get("size"))) ? Number(get("size")) : 20

  // Why: 切换 Tab / 分页走 router.replace 触发 Server Component 重渲染，
  // 同路由 searchParam 变更不会触发 loading.tsx，~500ms 内 UI 完全冻结无反馈。
  // useTransition 提供 isPending 让我们在数据流转期间 dim 当前内容并禁用交互。
  const [isPending, startTransition] = useTransition()

  const setFilter = useCallback(
    (key: string, value: string) => {
      startTransition(() => setMany({ [key]: value, page: '' }))
    },
    [setMany],
  )

  const allocStatus = get("allocStatus")
  const storeFilter = get("store")
  const dateFrom = get("from")
  const dateTo = get("to")

  // 搜索框防抖：本地 state 即时响应，URL 延迟更新
  const [searchInput, setSearchInput] = useState(get("q"))
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchInput(value)
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => setFilter("q", value), 300)
    },
    [setFilter],
  )

  const handleTabChange = (value: string) => {
    startTransition(() => {
      setMany({ tab: value === 'sale' ? '' : value, page: '', size: '' })
    })
  }
  const handlePageChange = (p: number) => {
    startTransition(() => set("page", p === 1 ? "" : String(p)))
  }
  const handlePageSizeChange = (size: number) => {
    startTransition(() => setMany({ size: String(size), page: '' }))
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-[var(--foreground)]">营业额分配</h1>

      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap gap-3">
            <Select
              className="w-36"
              value={allocStatus}
              onChange={(e) => setFilter("allocStatus", e.target.value)}
            >
              <option value="">全部状态</option>
              <option value="待分配">待分配</option>
              <option value="已分配">已分配</option>
            </Select>
            <Select
              className="w-40"
              value={storeFilter}
              onChange={(e) => setFilter("store", e.target.value)}
            >
              <option value="">全部门店</option>
              {stores.map((s) => (
                <option key={s.storeId} value={s.storeId}>
                  {s.storeName}
                </option>
              ))}
            </Select>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground whitespace-nowrap">
                {tab === 'service' ? '服务日期' : '下单日期'}
              </span>
              <Input
                type="date"
                className="w-36"
                value={dateFrom}
                onChange={(e) => setFilter("from", e.target.value)}
              />
              <span className="text-[#999999]">-</span>
              <Input
                type="date"
                className="w-36"
                value={dateTo}
                onChange={(e) => setFilter("to", e.target.value)}
              />
            </div>
            <Input
              className="w-64"
              placeholder={tab === 'service' ? '搜索服务单号/顾客/美容师' : '搜索订单号/顾客/手机号'}
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={handleTabChange}>
        <TabsList aria-busy={isPending}>
          <TabsTrigger value="sale" disabled={isPending}>销售提成</TabsTrigger>
          <TabsTrigger value="service" disabled={isPending}>服务提成</TabsTrigger>
        </TabsList>

        <div
          className={isPending ? "opacity-60 pointer-events-none transition-opacity" : "transition-opacity"}
          aria-busy={isPending}
        >
          <TabsContent value="sale">
            <SaleAllocationTable orders={orders} />
            <div className="mt-4">
              <Pagination
                total={saleTotal}
                pageSize={pageSize}
                page={currentPage}
                onPageChange={handlePageChange}
                pageSizeOptions={PAGE_SIZE_OPTIONS}
                onPageSizeChange={handlePageSizeChange}
              />
            </div>
          </TabsContent>

          <TabsContent value="service">
            <ServiceCommissionTable serviceOrders={serviceOrders} />
            <div className="mt-4">
              <Pagination
                total={serviceTotal}
                pageSize={pageSize}
                page={currentPage}
                onPageChange={handlePageChange}
                pageSizeOptions={PAGE_SIZE_OPTIONS}
                onPageSizeChange={handlePageSizeChange}
              />
            </div>
          </TabsContent>
        </div>
      </Tabs>
    </div>
  )
}

function SaleAllocationTable({ orders }: { orders: SaleOrder[] }) {
  return (
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
              {orders.map((order) => {
                const statusInfo = allocationStatusMap[order.allocationStatus || "待分配"] || allocationStatusMap.待分配
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
                          {order.allocationStatus === "已分配" ? "查看分配" : "分配"}
                        </Button>
                      </Link>
                    </td>
                  </tr>
                )
              })}
              {orders.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-[#999999]">
                    暂无匹配的订单，可调整筛选条件
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}

function ServiceCommissionTable({ serviceOrders }: { serviceOrders: ServiceOrder[] }) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 sticky top-0">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">服务单号</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">顾客</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">门店</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">美容师</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">服务日期</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">提成状态</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {serviceOrders.map((so) => {
                const statusInfo = allocationStatusMap[so.commissionStatus || "待分配"] || allocationStatusMap.待分配
                return (
                  <tr key={so.serviceOrderId} className="hover:bg-[#FFF0EE] transition-colors">
                    <td className="px-4 py-3">
                      <Link href={`/services/${so.serviceOrderId}`} className="text-[var(--primary)] hover:underline">
                        {so.serviceOrderId}
                      </Link>
                    </td>
                    <td className="px-4 py-3">{so.customerName || "-"}</td>
                    <td className="px-4 py-3">{so.storeName || "-"}</td>
                    <td className="px-4 py-3">{so.employeeName || "-"}</td>
                    <td className="px-4 py-3 text-[#999999]">{formatDate(so.serviceDate)}</td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className={statusInfo.className}>
                        {statusInfo.label}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Link href={`/allocations/service/${so.serviceOrderId}`}>
                        <Button size="sm" variant="outline">
                          {so.commissionStatus === "已分配" ? "查看分配" : "分配"}
                        </Button>
                      </Link>
                    </td>
                  </tr>
                )
              })}
              {serviceOrders.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-[#999999]">
                    暂无匹配的服务单，可调整筛选条件
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}
