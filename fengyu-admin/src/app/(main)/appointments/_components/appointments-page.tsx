"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { StatusBadge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { confirmAppointment, checkinAppointment } from "@/actions/appointments"
import type { Appointment } from "@/lib/types"

function formatDateTime(dt: string | null) {
  if (!dt) return "-"
  return new Date(dt).toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  })
}

function isToday(dt: string) {
  const d = new Date(dt)
  const today = new Date()
  return d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
}

function AppointmentTable({ appointments }: { appointments: Appointment[] }) {
  const router = useRouter()
  const [pendingId, setPendingId] = useState<string | null>(null)

  const handleAction = async (action: 'confirm' | 'checkin', appt: Appointment) => {
    setPendingId(appt.appointmentId)
    try {
      const actionFn = action === 'confirm' ? confirmAppointment : checkinAppointment
      const res = await actionFn(appt.appointmentId)
      if (res.success) {
        toast.success(res.message)
        router.refresh()
      } else {
        toast.error(res.message)
      }
    } catch {
      toast.error('操作失败，请稍后重试')
    } finally {
      setPendingId(null)
    }
  }

  return (
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
            <th className="px-4 py-3 text-left font-medium text-gray-500">备注</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">操作</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {appointments.map((appt) => (
            <tr key={appt.appointmentId} className="hover:bg-[#FFF0EE] transition-colors">
              <td className="px-4 py-3"><StatusBadge status={appt.status} /></td>
              <td className="px-4 py-3 font-medium">{appt.clientName}</td>
              <td className="px-4 py-3">{formatDateTime(appt.appointmentTime)}</td>
              <td className="px-4 py-3">{appt.storeName || "-"}</td>
              <td className="px-4 py-3">{appt.employeeName}</td>
              <td className="px-4 py-3 text-[#999999]">{appt.checkinAt ? formatDateTime(appt.checkinAt) : "-"}</td>
              <td className="px-4 py-3 text-[#999999] max-w-32 truncate">{appt.notes || "-"}</td>
              <td className="px-4 py-3">
                {appt.status === "待确认" && (
                  <Button size="sm" variant="outline" onClick={() => handleAction("confirm", appt)} disabled={pendingId === appt.appointmentId}>确认</Button>
                )}
                {appt.status === "已确认" && (
                  <Button size="sm" variant="outline" onClick={() => handleAction("checkin", appt)} disabled={pendingId === appt.appointmentId}>签到</Button>
                )}
              </td>
            </tr>
          ))}
          {appointments.length === 0 && (
            <tr>
              <td colSpan={8} className="px-4 py-12 text-center text-[#999999]">暂无预约数据</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

export default function AppointmentsPageClient({
  appointments,
}: {
  appointments: Appointment[]
}) {
  const pendingAppts = appointments.filter((a) => a.status === "待确认")
  const confirmedAppts = appointments.filter((a) => a.status === "已确认")
  const todayAppts = appointments.filter((a) => isToday(a.appointmentTime))
  const allAppts = appointments

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-[var(--foreground)]">预约管理</h1>

      <Tabs defaultValue="pending">
        <TabsList>
          <TabsTrigger value="pending">
            待确认 <span className="ml-1 text-xs bg-[#FFF8E6] text-[#D4820A] rounded-full px-1.5">{pendingAppts.length}</span>
          </TabsTrigger>
          <TabsTrigger value="confirmed">
            已确认 <span className="ml-1 text-xs bg-[#F0F9F2] text-[#3D8A5A] rounded-full px-1.5">{confirmedAppts.length}</span>
          </TabsTrigger>
          <TabsTrigger value="today">今日</TabsTrigger>
          <TabsTrigger value="all">全部</TabsTrigger>
        </TabsList>

        <TabsContent value="pending">
          <Card>
            <CardContent className="p-0">
              <AppointmentTable appointments={pendingAppts} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="confirmed">
          <Card>
            <CardContent className="p-0">
              <AppointmentTable appointments={confirmedAppts} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="today">
          <Card>
            <CardContent className="p-0">
              <AppointmentTable appointments={todayAppts} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="all">
          <Card>
            <CardContent className="p-0">
              <AppointmentTable appointments={allAppts} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
