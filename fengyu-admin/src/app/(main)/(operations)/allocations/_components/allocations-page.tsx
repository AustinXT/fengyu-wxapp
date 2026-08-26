"use client"

import { useCallback, useRef, useState, useTransition } from "react"
import { useSearchParams } from "next/navigation"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { DatePicker } from "@/components/ui/date-picker"
import { Select } from "@/components/ui/select"
import { Pagination } from "@/components/ui/pagination"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { ExportButton } from "@/components/ui/export-button"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import { PreserveListContextLink } from "@/components/return-context"
import type { ServiceOrder } from "@/lib/types"
import type { MarketStoreFilterOptions } from "@/lib/market-store-filter-types"
import MarketStoreFilter from "@/components/market-store-filter"
import { formatDate as fmtDate, formatDateTime as fmtDateTime } from "@/lib/utils"

const PAGE_SIZE_OPTIONS = [10, 20, 50]

/** 销售提成「回款维度」列表行（getPendingPayments 返回项；销售 Tab 用） */
export interface PaymentAllocationRow {
  salePaymentId: number
  saleOrderId: string
  changeType: string
  amount: string
  paymentMethod: string
  paidAt: string | null
  allocationStatus: string | null
  saleOrderType: string
  customerName: string | null
  clientPhone: string | null
  storeName: string | null
  preferredEmployeeId: string | null
}

const allocationStatusMap: Record<string, { label: string; className: string }> = {
  待分配: { label: "待分配", className: "border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]" },
  已分配: { label: "已分配", className: "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]" },
}

function formatTime(dt: string) {
  return fmtDateTime(dt)
}

function formatDate(dt: string | null | undefined) {
  if (!dt) return "—"
  return fmtDate(dt)
}

/**
 * 营业额分配列表 — 服务端分页 + Tab 切换（销售提成 / 服务提成）
 */
export default function AllocationsPageClient({
  tab,
  filterOptions,
  payments = [],
  saleTotal = 0,
  serviceOrders = [],
  serviceTotal = 0,
  canSave,
  canViewOrders,
  canViewServices,
}: {
  tab: 'sale' | 'service'
  filterOptions: MarketStoreFilterOptions
  payments?: PaymentAllocationRow[]
  saleTotal?: number
  serviceOrders?: ServiceOrder[]
  serviceTotal?: number
  canSave: boolean
  canViewOrders: boolean
  canViewServices: boolean
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
  const marketFilter = get("market")
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

  // 导出走当前 URL 全部筛选（跨分页），与列表口径一致
  const searchParams = useSearchParams()

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
            <MarketStoreFilter
              options={filterOptions}
              marketValue={marketFilter}
              storeValue={storeFilter}
              onMarketChange={(value) => startTransition(() => setMany({ market: value, store: '', page: '' }))}
              onStoreChange={(value) => setFilter("store", value)}
            />
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground whitespace-nowrap">
                {tab === 'service' ? '服务日期' : '下单日期'}
              </span>
              <DatePicker
                className="w-36"
                value={dateFrom}
                onValueChange={(value) => setFilter("from", value)}
              />
              <span className="text-[#999999]">-</span>
              <DatePicker
                className="w-36"
                value={dateTo}
                onValueChange={(value) => setFilter("to", value)}
              />
            </div>
            <Input
              className="w-64"
              placeholder={tab === 'service' ? '搜索服务单号/顾客/美容师' : '搜索订单号/顾客/手机号'}
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
            />
            <div className="ml-auto">
              <ExportButton
                exportRequest={{
                  exportType: tab === 'service' ? 'allocation-services' : 'allocation-sales',
                  payload: Object.fromEntries(searchParams.entries()),
                }}
              />
            </div>
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
            <SaleAllocationTable payments={payments} canSave={canSave} canViewOrders={canViewOrders} />
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
            <ServiceCommissionTable serviceOrders={serviceOrders} canSave={canSave} canViewServices={canViewServices} />
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

// 销售提成「回款维度」：分配单元从订单下沉到每笔回款（sale_payment_id）。
// 列：回款(类型+金额) / 顾客 / 门店 / 订单号 / 分配状态 / 到账时间 / 操作。
function SaleAllocationTable({
  payments,
  canSave,
  canViewOrders,
}: {
  payments: PaymentAllocationRow[]
  canSave: boolean
  canViewOrders: boolean
}) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 sticky top-0">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">回款</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">顾客</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">门店</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">订单号</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">分配状态</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">到账时间</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {payments.map((p) => {
                const statusInfo = allocationStatusMap[p.allocationStatus || "待分配"] || allocationStatusMap.待分配
                return (
                  <tr key={p.salePaymentId} className="hover:bg-[#FFF0EE] transition-colors">
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-2">
                        <Badge variant="outline" className="border-gray-300 text-gray-600 bg-gray-50">
                          {p.changeType}
                        </Badge>
                        <span className="font-medium">¥{Number(p.amount).toLocaleString()}</span>
                      </span>
                    </td>
                    <td className="px-4 py-3">{p.customerName || "—"}</td>
                    <td className="px-4 py-3">{p.storeName || "—"}</td>
                    <td className="px-4 py-3">
                      {canViewOrders ? (
                        <PreserveListContextLink href={`/orders/${p.saleOrderId}`} className="text-[var(--primary)] hover:underline">
                          {p.saleOrderId}
                        </PreserveListContextLink>
                      ) : p.saleOrderId}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className={statusInfo.className}>
                        {statusInfo.label}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-[#999999]">{p.paidAt ? formatTime(p.paidAt) : "-"}</td>
                    <td className="px-4 py-3">
                      {/* 转换单现已按回款逐笔产 receipt，与销售单统一走按回款分配页 */}
                      {canSave && (
                        <PreserveListContextLink href={`/allocations/payments/${p.salePaymentId}`}>
                          <Button size="sm" variant="outline">
                            {p.allocationStatus === "已分配" ? "查看分配" : "分配"}
                          </Button>
                        </PreserveListContextLink>
                      )}
                    </td>
                  </tr>
                )
              })}
              {payments.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-[#999999]">
                    暂无匹配的回款，可调整筛选条件
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

function ServiceCommissionTable({
  serviceOrders,
  canSave,
  canViewServices,
}: {
  serviceOrders: ServiceOrder[]
  canSave: boolean
  canViewServices: boolean
}) {
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
                      {canViewServices ? (
                        <PreserveListContextLink href={`/services/${so.serviceOrderId}`} className="text-[var(--primary)] hover:underline">
                          {so.serviceOrderId}
                        </PreserveListContextLink>
                      ) : so.serviceOrderId}
                    </td>
                    <td className="px-4 py-3">{so.customerName || "—"}</td>
                    <td className="px-4 py-3">{so.storeName || "—"}</td>
                    <td className="px-4 py-3">{so.employeeName || "—"}</td>
                    <td className="px-4 py-3 text-[#999999]">{formatDate(so.serviceDate)}</td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className={statusInfo.className}>
                        {statusInfo.label}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      {canSave && (
                        <PreserveListContextLink href={`/allocations/service/${so.serviceOrderId}`}>
                          <Button size="sm" variant="outline">
                            {so.commissionStatus === "已分配" ? "查看分配" : "分配"}
                          </Button>
                        </PreserveListContextLink>
                      )}
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
