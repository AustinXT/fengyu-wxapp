"use client"

import { useState, useTransition, useCallback } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { StatusBadge, Badge } from "@/components/ui/badge"
import { Pagination } from "@/components/ui/pagination"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter } from "@/components/ui/alert-dialog"
import { confirmOfflinePayment, closeOrder, resetOrderFailed } from "@/actions/orders"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import type { SaleOrder, Store, OrderStatus, SaleOrderType } from "@/lib/types"

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

function OrderActions({ order }: { order: SaleOrder }) {
  const [pending, startTransition] = useTransition()
  const router = useRouter()
  const [confirmDialog, setConfirmDialog] = useState<'confirm' | 'close' | 'reset' | null>(null)

  const handleAction = (actionFn: (id: string) => Promise<{ success: boolean; message: string }>) => {
    setConfirmDialog(null)
    startTransition(async () => {
      const res = await actionFn(order.saleOrderId)
      if (res.success) {
        toast.success(res.message)
        router.refresh()
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <>
      <div className="flex gap-1">
        {order.status === "待确认收款" && (
          <Button size="sm" variant="outline" onClick={() => setConfirmDialog('confirm')} disabled={pending}>确认收款</Button>
        )}
        {order.status === "待支付" && (
          <Button size="sm" variant="ghost" className="text-[#D94040]" onClick={() => setConfirmDialog('close')} disabled={pending}>关闭订单</Button>
        )}
        {order.status === "支付失败" && (
          <>
            <Button size="sm" variant="outline" onClick={() => setConfirmDialog('reset')} disabled={pending}>重置</Button>
            <Button size="sm" variant="ghost" className="text-[#D94040]" onClick={() => setConfirmDialog('close')} disabled={pending}>关闭</Button>
          </>
        )}
      </div>

      <AlertDialog open={confirmDialog === 'confirm'} onOpenChange={(open) => !open && setConfirmDialog(null)}>
        <AlertDialogTitle>确认收款？</AlertDialogTitle>
        <AlertDialogDescription>
          确认后订单将变为"已支付"状态，请确保已收到线下款项。
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setConfirmDialog(null)}>返回</AlertDialogCancel>
          <AlertDialogAction onClick={() => handleAction(confirmOfflinePayment)}>确认收款</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>

      <AlertDialog open={confirmDialog === 'close'} onOpenChange={(open) => !open && setConfirmDialog(null)}>
        <AlertDialogTitle>确认关闭订单？</AlertDialogTitle>
        <AlertDialogDescription>
          关闭后顾客无法继续支付，关联的分配记录也将被作废。此操作不可撤销。
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setConfirmDialog(null)}>返回</AlertDialogCancel>
          <AlertDialogAction onClick={() => handleAction(closeOrder)}>关闭订单</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>

      <AlertDialog open={confirmDialog === 'reset'} onOpenChange={(open) => !open && setConfirmDialog(null)}>
        <AlertDialogTitle>确认重置为待支付？</AlertDialogTitle>
        <AlertDialogDescription>
          重置后订单状态将变为"待支付"，顾客可重新发起支付。
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setConfirmDialog(null)}>返回</AlertDialogCancel>
          <AlertDialogAction onClick={() => handleAction(resetOrderFailed)}>确认重置</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>
    </>
  )
}

const PAGE_SIZE_OPTIONS = [10, 20, 50]

/**
 * 订单列表页 — 服务端分页
 *
 * 数据已在 Server Component 中通过 getOrdersPaginated() 完成 DB 级过滤+分页，
 * 此组件仅负责展示和 URL 筛选控制。筛选变更触发 URL 更新 → Server Component 重新执行。
 */
export default function OrdersPageClient({
  orders,
  stores,
  total,
}: {
  orders: SaleOrder[]
  stores: Store[]
  total: number
}) {
  const { get, set, setMany } = useUrlFilters()

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
  const typeFilter = get("type")
  const storeFilter = get("store")
  const dateFrom = get("from")
  const dateTo = get("to")

  const currentPage = Math.max(1, Number(get("page", "1")) || 1)
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(get("size"))) ? Number(get("size")) : 20

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">订单管理</h1>
        <Link href="/orders/create">
          <Button>新建订单</Button>
        </Link>
      </div>

      {/* Filters — URL-driven, 触发服务端重新查询 */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap gap-3">
            <Select className="w-40" value={statusFilter} onChange={(e) => setFilter("status", e.target.value)}>
              <option value="">全部状态</option>
              {(["待支付", "待确认收款", "已支付", "已完成", "支付失败", "已关闭"] as OrderStatus[]).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </Select>
            <Select className="w-40" value={typeFilter} onChange={(e) => setFilter("type", e.target.value)}>
              <option value="">全部类型</option>
              {(["普通", "体验", "内部", "福利活动", "回款", "转换", "退款"] as SaleOrderType[]).map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </Select>
            <Select className="w-40" value={storeFilter} onChange={(e) => setFilter("store", e.target.value)}>
              <option value="">全部门店</option>
              {stores.map((s) => (
                <option key={s.storeId} value={s.storeId}>{s.storeName}</option>
              ))}
            </Select>
            <div className="flex items-center gap-2">
              <Input type="date" className="w-36" value={dateFrom} onChange={(e) => setFilter("from", e.target.value)} />
              <span className="text-[#999999]">-</span>
              <Input type="date" className="w-36" value={dateTo} onChange={(e) => setFilter("to", e.target.value)} />
            </div>
            <Input
              className="w-56"
              placeholder="搜索订单号/顾客/手机号"
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
            />
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
                {orders.map((order) => (
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
                {orders.length === 0 && (
                  <tr>
                    <td colSpan={10} className="px-4 py-12 text-center text-[#999999]">
                      {total === 0 ? "暂无订单数据" : "未找到匹配结果，请调整筛选条件"}
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
