"use client"

import { useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { StatusBadge } from "@/components/ui/badge"
import { Pagination } from "@/components/ui/pagination"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter } from "@/components/ui/alert-dialog"
import { confirmAppointment, checkinAppointment, cancelAppointment, deleteAppointment } from "@/actions/appointments"
import { RowDeleteMenu } from "@/components/delete-action"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import { actionErrorMessage } from "@/lib/action-error"
import type { Appointment, Store } from "@/lib/types"
import { formatDateTime as fmtDateTime } from "@/lib/utils"

const PAGE_SIZE_OPTIONS = [10, 20, 50]

function formatDateTime(dt: string | null) {
  if (!dt) return "—"
  return fmtDateTime(dt)
}

const TAB_OPTIONS = [
  { value: "pending", label: "待确认" },
  { value: "confirmed", label: "已确认" },
  { value: "today", label: "今日" },
  { value: "all", label: "全部" },
] as const

type TabValue = typeof TAB_OPTIONS[number]['value']


export default function AppointmentsPageClient({
  appointments,
  stores,
  total,
  pendingCount,
  confirmedCount,
  canDelete = false,
}: {
  appointments: Appointment[]
  stores: Store[]
  total: number
  pendingCount: number
  confirmedCount: number
  
  canDelete?: boolean
}) {
  const router = useRouter()
  const { get, set, setMany } = useUrlFilters()

  
  const setFilter = useCallback((key: string, value: string) => {
    setMany({ [key]: value, page: '' })
  }, [setMany])

  
  const [searchInput, setSearchInput] = useState(get("q"))
  const debounceRef = useState<ReturnType<typeof setTimeout> | null>(null)
  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value)
    if (debounceRef[0]) clearTimeout(debounceRef[0])
    debounceRef[0] = setTimeout(() => setFilter("q", value), 300)
  }, [setFilter, debounceRef])

  const activeTab = (get("tab") || "pending") as TabValue
  const storeFilter = get("store")
  const dateFrom = get("from")
  const dateTo = get("to")
  const currentPage = Math.max(1, Number(get("page", "1")) || 1)
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(get("size"))) ? Number(get("size")) : 20

  
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [cancelTarget, setCancelTarget] = useState<Appointment | null>(null)

  const handleAction = async (action: 'confirm' | 'checkin' | 'cancel', appt: Appointment) => {
    if (action === 'cancel') {
      setCancelTarget(null)
    }
    setPendingId(appt.appointmentId)
    try {
      const actionMap = { confirm: confirmAppointment, checkin: checkinAppointment, cancel: cancelAppointment }
      const res = await actionMap[action](appt.appointmentId)
      if (res.success) {
        toast.success(res.message)
        router.refresh()
      } else {
        toast.error(res.message)
      }
    } catch (err) {
      toast.error(actionErrorMessage(err, '操作失败，请稍后重试'))
    } finally {
      setPendingId(null)
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-[var(--foreground)]">预约管理</h1>

      {}
      <div className="flex items-center gap-1 border-b border-[var(--border)]">
        {TAB_OPTIONS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setFilter("tab", tab.value === "pending" ? "" : tab.value)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.value
                ? "border-[var(--primary)] text-[var(--primary)]"
                : "border-transparent text-[#999999] hover:text-[var(--foreground)]"
            }`}
          >
            {tab.label}
            {tab.value === "pending" && pendingCount > 0 && (
              <span className="ml-1 text-xs bg-[#FFF8E6] text-[#D4820A] rounded-full px-1.5">{pendingCount}</span>
            )}
            {tab.value === "confirmed" && confirmedCount > 0 && (
              <span className="ml-1 text-xs bg-[#F0F9F2] text-[#3D8A5A] rounded-full px-1.5">{confirmedCount}</span>
            )}
          </button>
        ))}
      </div>

      {}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap gap-3">
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
              placeholder="搜索顾客/美容师"
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">状态</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">顾客</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">预约时间</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">门店</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">美容师</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">签到时间</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {appointments.map((appt) => (
                  <tr key={appt.appointmentId} className="hover:bg-[#FFF0EE] transition-colors">
                    <td className="px-4 py-3"><StatusBadge status={appt.status} /></td>
                    <td className="px-4 py-3 font-medium">{appt.clientName}</td>
                    <td className="px-4 py-3">{formatDateTime(appt.appointmentTime)}</td>
                    <td className="px-4 py-3">{appt.storeName || "—"}</td>
                    <td className="px-4 py-3">{appt.employeeName}</td>
                    <td className="px-4 py-3 text-[#999999]">{appt.checkinAt ? formatDateTime(appt.checkinAt) : "—"}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        {appt.status === "待确认" && (
                          <>
                            <Button size="sm" variant="outline" onClick={() => handleAction("confirm", appt)} disabled={pendingId === appt.appointmentId}>确认</Button>
                            <Button size="sm" variant="ghost" className="text-[#D94040]" onClick={() => setCancelTarget(appt)} disabled={pendingId === appt.appointmentId}>取消</Button>
                          </>
                        )}
                        {appt.status === "已确认" && (
                          <>
                            <Button size="sm" variant="outline" onClick={() => handleAction("checkin", appt)} disabled={pendingId === appt.appointmentId}>签到</Button>
                            <Button size="sm" variant="ghost" className="text-[#D94040]" onClick={() => setCancelTarget(appt)} disabled={pendingId === appt.appointmentId}>取消</Button>
                          </>
                        )}
                        {canDelete && (appt.status === "已取消" || appt.status === "已完成" || appt.status === "已关闭") && (
                          <RowDeleteMenu
                            entityLabel="预约"
                            onConfirm={() => deleteAppointment(appt.appointmentId)}
                            description={<>确定要删除该预约（{appt.clientName}）吗？此操作不可恢复。</>}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {appointments.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-[#999999]">
                      {total === 0 ? "暂无预约数据" : "未找到匹配结果，请调整筛选条件"}
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

      <AlertDialog open={!!cancelTarget} onOpenChange={(open) => !open && setCancelTarget(null)}>
        <AlertDialogTitle>确认取消预约？</AlertDialogTitle>
        <AlertDialogDescription>
          {cancelTarget?.status === '已确认' ? '该预约已确认，' : ''}取消后不可恢复。
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setCancelTarget(null)}>返回</AlertDialogCancel>
          <AlertDialogAction onClick={() => cancelTarget && handleAction("cancel", cancelTarget)}>确认取消</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>
    </div>
  )
}
