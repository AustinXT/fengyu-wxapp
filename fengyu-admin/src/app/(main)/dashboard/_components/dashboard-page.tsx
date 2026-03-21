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

/** 业务角色看板：manager / finance */
function BusinessDashboard({ stats }: Props) {
  const metricCards = [
    {
      label: "今日客流",
      value: stats.todayVisitors,
      format: (v: number) => String(v),
      prev: stats.yesterdayVisitors,
      href: "/orders",
    },
    {
      label: "今日业绩",
      value: stats.todayRevenue,
      format: (v: number) => `¥${v.toLocaleString()}`,
      prev: stats.yesterdayRevenue,
      href: "/orders",
    },
    {
      label: "待处理订单",
      value: stats.pendingOrders,
      format: (v: number) => String(v),
      prev: null as number | null,
      href: "/orders",
    },
    {
      label: "待确认预约",
      value: stats.pendingAppointments,
      format: (v: number) => String(v),
      prev: null as number | null,
      href: "/appointments",
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
    { label: "营业额分配", href: "/allocations" },
  ]

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {metricCards.map((card) => (
          <Link key={card.label} href={card.href}>
            <Card className="hover:border-[#C0322A]/30 transition-colors cursor-pointer">
              <CardContent className="p-5">
                <p className="text-sm text-[#999999]">{card.label}</p>
                <p className="mt-2 text-2xl font-bold text-[var(--foreground)]">{card.format(card.value)}</p>
                {card.prev !== null && (
                  <div className="mt-1 flex items-center gap-1 text-xs text-[#999999]">
                    vs 昨日 <TrendArrow current={card.value} previous={card.prev} />
                  </div>
                )}
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardContent className="p-5">
            <h2 className="text-base font-semibold text-[var(--foreground)] mb-4">待办事项</h2>
            {todoItems.length > 0 ? (
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
            ) : (
              <p className="text-sm text-[#999999] text-center py-6">暂无待办事项</p>
            )}
          </CardContent>
        </Card>

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
    </>
  )
}

/** 系统管理看板：admin / hr / product */
function SystemDashboard({ stats }: Props) {
  const a = stats.adminStats
  if (!a) return null

  const ROLE_CARDS: Record<string, Array<{ label: string; value: number; href: string }>> = {
    admin: [
      { label: "营业门店", value: a.totalStores, href: "/stores" },
      { label: "在职员工", value: a.totalEmployees, href: "/employees" },
      { label: "在售商品", value: a.totalProducts, href: "/products" },
      { label: "注册顾客", value: a.totalCustomers, href: "/customers" },
    ],
    hr: [
      { label: "营业门店", value: a.totalStores, href: "/stores" },
      { label: "在职员工", value: a.totalEmployees, href: "/employees" },
    ],
    product: [
      { label: "在售商品", value: a.totalProducts, href: "/products" },
    ],
  }

  const ROLE_SHORTCUTS: Record<string, Array<{ label: string; href: string }>> = {
    admin: [
      { label: "组织架构", href: "/org" },
      { label: "门店管理", href: "/stores" },
      { label: "员工管理", href: "/employees" },
      { label: "商品管理", href: "/products" },
      { label: "权限管理", href: "/permissions" },
      { label: "数据同步", href: "/sync" },
    ],
    hr: [
      { label: "组织架构", href: "/org" },
      { label: "门店管理", href: "/stores" },
      { label: "员工管理", href: "/employees" },
      { label: "权限管理", href: "/permissions" },
    ],
    product: [
      { label: "商品管理", href: "/products" },
      { label: "品项分类", href: "/products/categories" },
      { label: "优惠券管理", href: "/coupons" },
    ],
  }

  const ctx = stats.roleContext
  const cards = ROLE_CARDS[ctx] ?? ROLE_CARDS.admin!
  const shortcuts = ROLE_SHORTCUTS[ctx] ?? ROLE_SHORTCUTS.admin!

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((card) => (
          <Link key={card.label} href={card.href}>
            <Card className="hover:border-[#C0322A]/30 transition-colors cursor-pointer">
              <CardContent className="p-5">
                <p className="text-sm text-[#999999]">{card.label}</p>
                <p className="mt-2 text-2xl font-bold text-[var(--foreground)]">{card.value.toLocaleString()}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <Card>
        <CardContent className="p-5">
          <h2 className="text-base font-semibold text-[var(--foreground)] mb-4">快捷入口</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
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
    </>
  )
}

export default function DashboardPage({ stats }: Props) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">工作台</h1>
        <p className="mt-1 text-sm text-[#999999]">欢迎使用凤御美业管理后台</p>
      </div>

      {stats.roleContext === 'business'
        ? <BusinessDashboard stats={stats} />
        : <SystemDashboard stats={stats} />
      }
    </div>
  )
}
