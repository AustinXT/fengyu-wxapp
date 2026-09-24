"use client"

import { useState, useTransition, useCallback, useEffect } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DatePicker } from "@/components/ui/date-picker"
import { MultiSelect } from "@/components/ui/multi-select"
import { StatusBadge, Badge } from "@/components/ui/badge"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter } from "@/components/ui/alert-dialog"
import { Pagination } from "@/components/ui/pagination"
import { startServiceOrder, completeServiceOrder, confirmServiceOrder, cancelServiceOrder } from "@/actions/services"
import { createExportJob } from "@/actions/export-jobs"
import { ExportButton } from "@/components/ui/export-button"
import { actionErrorMessage } from "@/lib/action-error"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import { PreserveListContextLink } from "@/components/return-context"
import type { ServiceOrder } from "@/lib/types"
import type { MarketStoreFilterOptions } from "@/lib/market-store-filter-types"
import MarketStoreFilter from "@/components/market-store-filter"
import { formatDate as fmtDate } from "@/lib/utils"
import { SERVICE_ORDER_STATUS_FILTER_OPTIONS, parseServiceOrderStatusFilters } from "@/lib/list-filters"
import { normalizePage } from "@/lib/paging"

const PAGE_SIZE_OPTIONS = [10, 20, 50]

function formatDate(dt: string | null | undefined) {
  if (!dt) return "—"
  return fmtDate(dt)
}

function ServiceActions({ so, canUpdate }: { so: ServiceOrder; canUpdate: boolean }) {
  const [pending, startTransition] = useTransition()
  const router = useRouter()
  const [confirmDialog, setConfirmDialog] = useState<'cancel' | 'complete' | 'confirm' | null>(null)

  const handleAction = (actionFn: (id: string) => Promise<{ success: boolean; message: string }>) => {
    setConfirmDialog(null)
    startTransition(async () => {
      try {
        const res = await actionFn(so.serviceOrderId)
        if (res.success) {
          toast.success(res.message)
          router.refresh()
        } else {
          toast.error(res.message)
        }
      } catch (err) {
        toast.error(actionErrorMessage(err, '操作失败，请稍后重试'))
      }
    })
  }

  if (!canUpdate) return null

  return (
    <>
      <div className="flex gap-1">
        {so.status === "待服务" && (
          <Button size="sm" variant="outline" onClick={() => handleAction(startServiceOrder)} disabled={pending}>开始服务</Button>
        )}
        {so.status === "服务中" && (
          <Button size="sm" variant="outline" onClick={() => setConfirmDialog('complete')} disabled={pending}>完成服务</Button>
        )}
        {so.status === "待客户确认" && (
          <Button size="sm" variant="outline" onClick={() => setConfirmDialog('confirm')} disabled={pending}>代客户确认</Button>
        )}
        {(so.status === "待服务" || so.status === "服务中" || so.status === "待客户确认") && (
          <Button size="sm" variant="ghost" className="text-[#D94040]" onClick={() => setConfirmDialog('cancel')} disabled={pending}>取消</Button>
        )}
      </div>

      <AlertDialog open={confirmDialog === 'cancel'} onOpenChange={(open) => !open && setConfirmDialog(null)}>
        <AlertDialogTitle>确认取消服务单？</AlertDialogTitle>
        <AlertDialogDescription>取消后服务单将标记为已取消，不扣减服务额度。此操作不可撤销。</AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setConfirmDialog(null)}>返回</AlertDialogCancel>
          <AlertDialogAction onClick={() => handleAction(cancelServiceOrder)}>确认取消</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>

      <AlertDialog open={confirmDialog === 'complete'} onOpenChange={(open) => !open && setConfirmDialog(null)}>
        <AlertDialogTitle>标记完成服务？</AlertDialogTitle>
        <AlertDialogDescription>标记完成后服务单进入「待客户确认」，需顾客（或后台代）确认后才扣减服务额度、计提成。</AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setConfirmDialog(null)}>返回</AlertDialogCancel>
          <AlertDialogAction onClick={() => handleAction(completeServiceOrder)}>标记完成</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>

      <AlertDialog open={confirmDialog === 'confirm'} onOpenChange={(open) => !open && setConfirmDialog(null)}>
        <AlertDialogTitle>代客户确认服务完成？</AlertDialogTitle>
        <AlertDialogDescription>确认后将扣减关联销售明细的剩余服务额度并完成服务单。此操作不可撤销，仅在顾客不便自行确认时使用。</AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setConfirmDialog(null)}>返回</AlertDialogCancel>
          <AlertDialogAction onClick={() => handleAction(confirmServiceOrder)}>确认完成</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>
    </>
  )
}

/**
 * 服务单列表页 — 服务端分页
 *
 * 数据已在 Server Component 中通过 getServiceOrdersPaginated() 完成 DB 级过滤+分页，
 * 此组件仅负责展示和 URL 筛选控制。
 */
export default function ServicesPageClient({
  serviceOrders,
  filterOptions,
  total,
  canCreate,
  canUpdate,
}: {
  serviceOrders: ServiceOrder[]
  filterOptions: MarketStoreFilterOptions
  total: number
  canCreate: boolean
  canUpdate: boolean
}) {
  const { get, set, setMany } = useUrlFilters()
  const searchParams = useSearchParams()

  /** 仅创建异步任务；worker 在任务开始时重新读取已完成服务单消耗明细。 */
  const handleExport = useCallback(async () => {
    const raw = Object.fromEntries(searchParams.entries())
    // 消耗明细仅含「已完成」服务单（已扣减次数）；若当前按其它状态筛选，导出会因 WHERE
    // status='已完成' AND status=筛选值 恒空，提前提示而非发空请求，避免「列表有数据、导出无数据」困惑。
    const exportStatuses = parseServiceOrderStatusFilters(raw.status)
    if (exportStatuses?.length && !exportStatuses.includes('已完成')) {
      toast.warning(`消耗明细仅包含「已完成」服务单，当前筛选状态为「${raw.status}」，无已实现消耗可导出`)
      return
    }
    const result = await createExportJob({ exportType: "services", payload: raw })
    toast.success(result.reused ? "相同导出任务正在生成" : "已加入导出任务")
  }, [searchParams])

  /** 筛选变更时重置到第 1 页 */
  const setFilter = useCallback((key: string, value: string) => {
    setMany({ [key]: value, page: '' })
  }, [setMany])

  // 搜索框防抖：本地 state 即时响应，URL 延迟更新
  const [searchInput, setSearchInput] = useState(get("q"))
  const debounceRef = useState<ReturnType<typeof setTimeout> | null>(null)

  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value)
    if (debounceRef[0]) clearTimeout(debounceRef[0])
    debounceRef[0] = setTimeout(() => setFilter("q", value), 300)
  }, [setFilter, debounceRef])

  const statusFilter = get("status")
  const [selectedStatuses, setSelectedStatuses] = useState<string[]>(
    () => parseServiceOrderStatusFilters(statusFilter) ?? [],
  )
  useEffect(() => {
    setSelectedStatuses(parseServiceOrderStatusFilters(statusFilter) ?? [])
  }, [statusFilter])
  const handleStatusesChange = useCallback((statuses: string[]) => {
    setSelectedStatuses(statuses)
    setFilter("status", statuses.join(","))
  }, [setFilter])
  const marketFilter = get("market")
  const storeFilter = get("store")
  const dateFrom = get("from")
  const dateTo = get("to")
  const currentPage = normalizePage(get("page", "1"))
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(get("size"))) ? Number(get("size")) : 20

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">服务单管理</h1>
        {canCreate && (
          <Link href="/services/create">
            <Button>新建服务单</Button>
          </Link>
        )}
      </div>

      {/* Filters — URL-driven, 触发服务端重新查询 */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap gap-3">
            <MultiSelect
              className="w-40"
              options={SERVICE_ORDER_STATUS_FILTER_OPTIONS.map((status) => ({ value: status, label: status }))}
              value={selectedStatuses}
              onChange={handleStatusesChange}
              placeholder="全部状态"
            />
            <MarketStoreFilter
              options={filterOptions}
              marketValue={marketFilter}
              storeValue={storeFilter}
              onMarketChange={(value) => setMany({ market: value, store: '', page: '' })}
              onStoreChange={(value) => setFilter("store", value)}
            />
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground whitespace-nowrap">服务日期</span>
              <DatePicker className="w-36" value={dateFrom} onValueChange={(value) => setFilter("from", value)} />
              <span className="text-[#999999]">-</span>
              <DatePicker className="w-36" value={dateTo} onValueChange={(value) => setFilter("to", value)} />
            </div>
            <Input
              className="w-56"
              placeholder="搜索服务单号/顾客/美容师"
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
            />
            <ExportButton onExport={handleExport} />
          </div>
        </CardContent>
      </Card>

      {/* Table — 数据已经是当前页的切片 */}
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
                {serviceOrders.map((so) => (
                  <tr key={so.serviceOrderId} className="hover:bg-[#FFF0EE] transition-colors">
                    <td className="px-4 py-3">
                      <PreserveListContextLink href={`/services/${so.serviceOrderId}`} className="text-[var(--primary)] hover:underline">
                        {so.serviceOrderId}
                      </PreserveListContextLink>
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={so.status} /></td>
                    <td className="px-4 py-3">
                      <Badge variant="secondary" className={so.serviceOrderType === "售前" ? "bg-[#FFF0EE] text-[#C45C48]" : "bg-[#E8F0FE] text-[#3574C4]"}>
                        {so.serviceOrderType}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">{so.customerName || "—"}</td>
                    <td className="px-4 py-3">{so.storeName || "—"}</td>
                    <td className="px-4 py-3">{so.employeeName || "—"}</td>
                    <td className="px-4 py-3 text-[#999999]">{formatDate(so.serviceDate)}</td>
                    <td className="px-4 py-3">
                      <ServiceActions so={so} canUpdate={canUpdate} />
                    </td>
                  </tr>
                ))}
                {serviceOrders.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-12 text-center text-[#999999]">
                      {total === 0 ? "暂无服务单数据" : "未找到匹配结果，请调整筛选条件"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Pagination
        total={total}
        pageSize={pageSize}
        page={currentPage}
        onPageChange={(p) => set("page", p === 1 ? "" : String(p))}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        onPageSizeChange={(size) => setMany({ size: String(size), page: '' })}
      />
    </div>
  )
}
