"use client"

import { useState, useTransition, useCallback } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { StatusBadge, Badge } from "@/components/ui/badge"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter } from "@/components/ui/alert-dialog"
import { Pagination } from "@/components/ui/pagination"
import { startServiceOrder, completeServiceOrder, confirmServiceOrder, cancelServiceOrder, exportServiceOrders } from "@/actions/services"
import { ExportButton } from "@/components/ui/export-button"
import { exportToXlsx, fmtDate as xlsxDate, fmtDateTime as xlsxDateTime, fmtPercent } from "@/lib/export-xlsx"
import { actionErrorMessage } from "@/lib/action-error"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import type { ServiceOrder, Store, ServiceOrderStatus } from "@/lib/types"
import { formatDate as fmtDate } from "@/lib/utils"

const PAGE_SIZE_OPTIONS = [10, 20, 50]

function formatDate(dt: string | null | undefined) {
  if (!dt) return "—"
  return fmtDate(dt)
}

function ServiceActions({ so }: { so: ServiceOrder }) {
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

  return (
    <>
      <div className="flex gap-1">
        {so.status === "待服务" && (
          <>
            <Button size="sm" variant="outline" onClick={() => handleAction(startServiceOrder)} disabled={pending}>开始服务</Button>
            <Button size="sm" variant="ghost" className="text-[#D94040]" onClick={() => setConfirmDialog('cancel')} disabled={pending}>取消</Button>
          </>
        )}
        {so.status === "服务中" && (
          <Button size="sm" variant="outline" onClick={() => setConfirmDialog('complete')} disabled={pending}>完成服务</Button>
        )}
        {so.status === "待客户确认" && (
          <Button size="sm" variant="outline" onClick={() => setConfirmDialog('confirm')} disabled={pending}>代客户确认</Button>
        )}
      </div>

      <AlertDialog open={confirmDialog === 'cancel'} onOpenChange={(open) => !open && setConfirmDialog(null)}>
        <AlertDialogTitle>确认取消服务单？</AlertDialogTitle>
        <AlertDialogDescription>取消后服务单将标记为已取消，不扣减次数。此操作不可撤销。</AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setConfirmDialog(null)}>返回</AlertDialogCancel>
          <AlertDialogAction onClick={() => handleAction(cancelServiceOrder)}>确认取消</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>

      <AlertDialog open={confirmDialog === 'complete'} onOpenChange={(open) => !open && setConfirmDialog(null)}>
        <AlertDialogTitle>标记完成服务？</AlertDialogTitle>
        <AlertDialogDescription>标记完成后服务单进入「待客户确认」，需顾客（或后台代）确认后才扣减次数、计提成。</AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setConfirmDialog(null)}>返回</AlertDialogCancel>
          <AlertDialogAction onClick={() => handleAction(completeServiceOrder)}>标记完成</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>

      <AlertDialog open={confirmDialog === 'confirm'} onOpenChange={(open) => !open && setConfirmDialog(null)}>
        <AlertDialogTitle>代客户确认服务完成？</AlertDialogTitle>
        <AlertDialogDescription>确认后将扣减关联销售明细的剩余次数并完成服务单。此操作不可撤销，仅在顾客不便自行确认时使用。</AlertDialogDescription>
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
  stores,
  total,
}: {
  serviceOrders: ServiceOrder[]
  stores: Store[]
  total: number
}) {
  const { get, set, setMany } = useUrlFilters()
  const searchParams = useSearchParams()

  /** 导出当前筛选命中的服务单提成分配明细（按被分配员工×服务项展开，跨分页） */
  const handleExport = useCallback(async () => {
    const raw = Object.fromEntries(searchParams.entries())
    const { rows, truncated } = await exportServiceOrders(raw)
    if (rows.length === 0) {
      toast.info("当前筛选无数据可导出")
      return
    }
    await exportToXlsx({
      filename: "服务单-提成明细",
      sheetName: "服务单提成",
      columns: [
        { header: "市场", width: 12, accessor: (r) => r.market },
        { header: "门店", width: 18, accessor: (r) => r.storeName },
        { header: "服务单号", width: 22, accessor: (r) => r.serviceOrderId },
        { header: "订单类型", width: 12, accessor: (r) => r.saleOrderType },
        { header: "单据类型", width: 12, accessor: (r) => r.serviceOrderType },
        { header: "顾客", accessor: (r) => r.customerName },
        { header: "顾客手机", width: 14, accessor: (r) => r.customerPhone },
        { header: "商品类型", width: 12, accessor: (r) => r.productType },
        { header: "品项（一级）", width: 14, accessor: (r) => r.categoryL1 },
        { header: "品项（二级）", width: 12, accessor: (r) => r.categoryL2 },
        { header: "商品明细", width: 24, accessor: (r) => r.productName },
        { header: "消耗次数", width: 10, accessor: (r) => r.sessionUsed },
        { header: "消耗金额", width: 12, accessor: (r) => r.consumeMoney },
        { header: "单价", width: 12, accessor: (r) => r.unitRealPrice },
        { header: "状态", width: 12, accessor: (r) => r.status },
        { header: "负责美容师", accessor: (r) => r.employeeName },
        { header: "员工职位", width: 12, accessor: (r) => r.positionName },
        { header: "分配占比", width: 10, accessor: (r) => fmtPercent(r.allocationRatio) },
        { header: "分配额", width: 12, accessor: (r) => r.allocationAmount },
        { header: "提成比例", width: 10, accessor: (r) => fmtPercent(r.commissionRate) },
        { header: "提成金额", width: 12, accessor: (r) => r.commissionAmount },
        { header: "顾客评价", width: 24, accessor: (r) => r.reviewComment },
        { header: "顾客评分", width: 8, accessor: (r) => r.rating },
        { header: "经营类价", width: 12, accessor: (r) => r.salesCategory },
        { header: "顾客类型", width: 12, accessor: (r) => r.customerType },
        { header: "开单人", accessor: (r) => r.openedByName },
        { header: "来源订单号", width: 22, accessor: (r) => r.sourceSaleOrderId },
        { header: "服务日期", width: 14, accessor: (r) => xlsxDate(r.serviceDate) },
        { header: "创建时间", width: 20, accessor: (r) => xlsxDateTime(r.createdAt) },
        { header: "备注", width: 20, accessor: (r) => r.remark },
      ],
      rows,
    })
    if (truncated) toast.warning("数据量过大，已导出前 10000 条，请缩小筛选范围")
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
  const storeFilter = get("store")
  const dateFrom = get("from")
  const dateTo = get("to")
  const currentPage = Math.max(1, Number(get("page", "1")) || 1)
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(get("size"))) ? Number(get("size")) : 20

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">服务单管理</h1>
        <Link href="/services/create">
          <Button>新建服务单</Button>
        </Link>
      </div>

      {/* Filters — URL-driven, 触发服务端重新查询 */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap gap-3">
            <Select className="w-40" value={statusFilter} onChange={(e) => setFilter("status", e.target.value)}>
              <option value="">全部状态</option>
              {(["待服务", "服务中", "待客户确认", "已完成", "已取消"] as ServiceOrderStatus[]).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </Select>
            <Select className="w-40" value={storeFilter} onChange={(e) => setFilter("store", e.target.value)}>
              <option value="">全部门店</option>
              {stores.map((s) => (
                <option key={s.storeId} value={s.storeId}>{s.storeName}</option>
              ))}
            </Select>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground whitespace-nowrap">服务日期</span>
              <Input type="date" className="w-36" value={dateFrom} onChange={(e) => setFilter("from", e.target.value)} />
              <span className="text-[#999999]">-</span>
              <Input type="date" className="w-36" value={dateTo} onChange={(e) => setFilter("to", e.target.value)} />
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
                      <Link href={`/services/${so.serviceOrderId}`} className="text-[var(--primary)] hover:underline">
                        {so.serviceOrderId}
                      </Link>
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
                      <ServiceActions so={so} />
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
