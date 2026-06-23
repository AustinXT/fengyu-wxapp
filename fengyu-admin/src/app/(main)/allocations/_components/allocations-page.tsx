"use client"

import { useCallback, useRef, useState, useTransition } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Pagination } from "@/components/ui/pagination"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { ExportButton } from "@/components/ui/export-button"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import { exportAllocationOrders } from "@/actions/orders"
import { exportAllocationServiceOrders } from "@/actions/services"
import { exportToXlsx, fmtDateTime as xlsxDateTime, fmtDate as xlsxDate, fmtPercent } from "@/lib/export-xlsx"
import type { ServiceOrder, Store } from "@/lib/types"
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
  stores = [],
  payments = [],
  saleTotal = 0,
  serviceOrders = [],
  serviceTotal = 0,
}: {
  tab: 'sale' | 'service'
  stores?: Store[]
  payments?: PaymentAllocationRow[]
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

  // 导出走当前 URL 全部筛选（跨分页），与列表口径一致
  const searchParams = useSearchParams()

  const handleExportSale = useCallback(async () => {
    const raw = Object.fromEntries(searchParams.entries())
    const { rows, truncated } = await exportAllocationOrders(raw)
    if (rows.length === 0) {
      toast.info("当前筛选无数据可导出")
      return
    }
    await exportToXlsx({
      filename: "营业额分配-销售提成",
      sheetName: "销售提成",
      columns: [
        { header: "订单号", width: 22, accessor: (r) => r.saleOrderId },
        { header: "顾客", accessor: (r) => r.customerName },
        { header: "门店", width: 18, accessor: (r) => r.storeName },
        { header: "订单金额", accessor: (r) => r.totalAmount },
        { header: "分配状态", accessor: (r) => r.allocationStatus },
        { header: "支付时间", width: 20, accessor: (r) => xlsxDateTime(r.paidAt) },
      ],
      rows,
    })
    if (truncated) toast.warning("数据量过大，已导出前 10000 条，请缩小筛选范围")
  }, [searchParams])

  const handleExportService = useCallback(async () => {
    const raw = Object.fromEntries(searchParams.entries())
    const { rows, truncated } = await exportAllocationServiceOrders(raw)
    if (rows.length === 0) {
      toast.info("当前筛选无数据可导出")
      return
    }
    await exportToXlsx({
      filename: "营业额分配-服务提成",
      sheetName: "服务提成",
      columns: [
        { header: "市场", width: 12, accessor: (r) => r.market },
        { header: "门店", width: 18, accessor: (r) => r.storeName },
        { header: "服务单号", width: 22, accessor: (r) => r.serviceOrderId },
        { header: "销售单类型", width: 12, accessor: (r) => r.saleOrderType },
        { header: "服务单类型", width: 12, accessor: (r) => r.serviceOrderType },
        { header: "顾客", accessor: (r) => r.customerName },
        { header: "顾客手机", width: 14, accessor: (r) => r.customerPhone },
        { header: "商品类型", width: 12, accessor: (r) => r.productType },
        { header: "一级分类", width: 14, accessor: (r) => r.categoryL1 },
        { header: "商品大类", width: 12, accessor: (r) => r.categoryL2 },
        { header: "商品名称", width: 24, accessor: (r) => r.productName },
        { header: "消耗次数", width: 10, accessor: (r) => r.sessionUsed },
        { header: "消耗金额", width: 12, accessor: (r) => r.consumeMoney },
        { header: "单次价", width: 12, accessor: (r) => r.unitRealPrice },
        { header: "状态", width: 12, accessor: (r) => r.status },
        { header: "美容师", accessor: (r) => r.employeeName },
        { header: "职位", width: 12, accessor: (r) => r.positionName },
        { header: "分配占比", width: 10, accessor: (r) => fmtPercent(r.allocationRatio) },
        { header: "分配金额", width: 12, accessor: (r) => r.allocationAmount },
        { header: "提成比例", width: 10, accessor: (r) => fmtPercent(r.commissionRate) },
        { header: "提成金额", width: 12, accessor: (r) => r.commissionAmount },
        { header: "评分", width: 8, accessor: (r) => r.rating },
        { header: "评价内容", width: 24, accessor: (r) => r.reviewComment },
        { header: "销售分类", width: 12, accessor: (r) => r.salesCategory },
        { header: "顾客类型", width: 12, accessor: (r) => r.customerType },
        { header: "开单人", accessor: (r) => r.openedByName },
        { header: "来源销售单", width: 22, accessor: (r) => r.sourceSaleOrderId },
        { header: "服务日期", width: 14, accessor: (r) => xlsxDate(r.serviceDate) },
        { header: "创建时间", width: 20, accessor: (r) => xlsxDateTime(r.createdAt) },
        { header: "备注", width: 20, accessor: (r) => r.remark },
      ],
      rows,
    })
    if (truncated) toast.warning("数据量过大，已导出前 10000 条，请缩小筛选范围")
  }, [searchParams])

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
            <div className="ml-auto">
              <ExportButton onExport={tab === 'service' ? handleExportService : handleExportSale} />
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
            <SaleAllocationTable payments={payments} />
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

// 销售提成「回款维度」：分配单元从订单下沉到每笔回款（sale_payment_id）。
// 列：回款(类型+金额) / 顾客 / 门店 / 订单号 / 分配状态 / 到账时间 / 操作。
function SaleAllocationTable({ payments }: { payments: PaymentAllocationRow[] }) {
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
                      <Link href={`/orders/${p.saleOrderId}`} className="text-[var(--primary)] hover:underline">
                        {p.saleOrderId}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className={statusInfo.className}>
                        {statusInfo.label}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-[#999999]">{p.paidAt ? formatTime(p.paidAt) : "-"}</td>
                    <td className="px-4 py-3">
                      <Link href={`/allocations/payments/${p.salePaymentId}`}>
                        <Button size="sm" variant="outline">
                          {p.allocationStatus === "已分配" ? "查看分配" : "分配"}
                        </Button>
                      </Link>
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
