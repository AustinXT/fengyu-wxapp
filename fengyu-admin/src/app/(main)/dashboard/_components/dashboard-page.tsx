"use client"

import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import type { DashboardStats } from "@/lib/types"

function TrendArrow({ current, previous }: { current: number; previous: number }) {
  const diff = current - previous
  const pct = previous > 0 ? Math.round(Math.abs(diff) / previous * 100) : 0
  if (diff > 0) {
    return (
      <span className="text-xs text-[#3D8A5A] flex items-center gap-0.5">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
        {pct}%
      </span>
    )
  }
  if (diff < 0) {
    return (
      <span className="text-xs text-[#D94040] flex items-center gap-0.5">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12l7 7 7-7" /></svg>
        {pct}%
      </span>
    )
  }
  return <span className="text-xs text-[#999999]">持平</span>
}

interface Props {
  stats: DashboardStats
}

export default function DashboardPage({ stats }: Props) {
  const metricCards = [
    {
      label: "今日客流",
      value: stats.todayVisitors,
      format: (v: number) => String(v),
      prev: stats.yesterdayVisitors,
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#C45C48" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      ),
    },
    {
      label: "今日业绩",
      value: stats.todayRevenue,
      format: (v: number) => `¥${v.toLocaleString()}`,
      prev: stats.yesterdayRevenue,
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#C45C48" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
        </svg>
      ),
    },
    {
      label: "待处理订单",
      value: stats.pendingOrders,
      format: (v: number) => String(v),
      prev: null as number | null,
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#C45C48" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" />
        </svg>
      ),
    },
    {
      label: "待确认预约",
      value: stats.pendingAppointments,
      format: (v: number) => String(v),
      prev: null as number | null,
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#C45C48" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
        </svg>
      ),
    },
  ]

  const todoItems = [
    { text: `${stats.pendingAllocations} 笔订单待分配`, href: "/allocations", count: stats.pendingAllocations },
    { text: `${stats.pendingOrders} 笔订单待处理`, href: "/orders", count: stats.pendingOrders },
    { text: `${stats.pendingAppointments} 条预约待确认`, href: "/appointments", count: stats.pendingAppointments },
    { text: `${stats.activeServices} 个服务单进行中`, href: "/services", count: stats.activeServices },
  ].filter(item => item.count > 0)

  const shortcuts = [
    { label: "开单", href: "/orders/create" },
    { label: "订单管理", href: "/orders" },
    { label: "顾客管理", href: "/customers" },
    { label: "员工管理", href: "/employees" },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">工作台</h1>
        <p className="mt-1 text-sm text-[#999999]">欢迎使用凤御美业管理后台</p>
      </div>

      {/* Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {metricCards.map((card) => (
          <Card key={card.label}>
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div className="space-y-2">
                  <p className="text-sm text-[#999999]">{card.label}</p>
                  <p className="text-2xl font-bold text-[var(--foreground)]">{card.format(card.value)}</p>
                  {card.prev !== null && (
                    <div className="flex items-center gap-1 text-xs text-[#999999]">
                      vs 昨日 <TrendArrow current={card.value} previous={card.prev} />
                    </div>
                  )}
                </div>
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#FFF0EE]">
                  {card.icon}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Two columns: Todo + Shortcuts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 待办事项 */}
        <Card>
          <CardContent className="p-5">
            <h2 className="text-base font-semibold text-[var(--foreground)] mb-4">待办事项</h2>
            <div className="space-y-3">
              {todoItems.map((item) => (
                <Link
                  key={item.text}
                  href={item.href}
                  className="flex items-center justify-between rounded-lg border border-[var(--border)] px-4 py-3 hover:bg-[#FFF0EE] transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <span className="h-2 w-2 rounded-full bg-[#D4820A]" />
                    <span className="text-sm text-[var(--foreground)]">{item.text}</span>
                  </div>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#999999" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* 快捷入口 */}
        <Card>
          <CardContent className="p-5">
            <h2 className="text-base font-semibold text-[var(--foreground)] mb-4">快捷入口</h2>
            <div className="grid grid-cols-2 gap-3">
              {shortcuts.map((item) => (
                <Link key={item.label} href={item.href}>
                  <Button variant="outline" className="w-full h-16 text-base">
                    {item.label}
                  </Button>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
