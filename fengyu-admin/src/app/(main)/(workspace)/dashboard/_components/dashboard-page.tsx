"use client"

import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import type { DashboardStats } from "@/lib/types"
import { hasUiCapability } from "@/lib/permission-contract"
import {
  FLAT_TEXT,
  NA_TEXT,
  NOT_TURNED_TEXT,
  TURNED_POSITIVE_TEXT,
  deltaScaled,
  deltaTone,
  isFlatAfterRounding,
  resolveDeltaDisplay,
} from "@/lib/delta-display"
import { cn } from "@/lib/utils"

/** 首页看板的展示精度：整数百分比。数据中心用 2 位小数，**两处阈值不同，别互抄**。 */
const TREND_DIGITS = 0

const ARROW_UP = <path d="M12 19V5M5 12l7-7 7 7" />
const ARROW_DOWN = <path d="M12 5v14M5 12l7 7 7-7" />

/**
 * 「vs 昨日」涨跌徽章（#315）。
 *
 * 旧实现 `previous > 0 ? Math.round(Math.abs(diff)/previous*100) : 0` 有两个缺陷：
 * 基期 ≤ 0 时幅度被**吞成 0** 却仍走 `diff` 的绿/红分支，渲染出「↑ 0%」这种
 * 「涨了、涨幅是 0」的自相矛盾展示；而昨日业绩**真的会 ≤ 0**——
 * `yesterdayRevenue` 的 SQL 把退款以负数计入且无 `GREATEST` 夹底，
 * 生产实测 1020 个门店日里 67 天非正（6.6%，最差 −22,800），
 * 即每 15 个门店日就有 1 个门店负责人第二天看到「↑ 0%」。
 *
 * 现在与数据中心共用 `resolveDeltaDisplay`（决策 1 全站统一），基期为负时改出
 * 「由负转正」/「未转正」，零基期出 '--'，并按决策 3 把舍入后为 0 的并入「持平」。
 *
 * 导出仅为可测——该组件此前零覆盖，直接原因就是它没被导出。
 *
 * ## `baseLabel`：把决策 1 吃掉的信息补回来
 *
 * 「今日客流」是 `COUNT(DISTINCT client_user_id)`（`actions/dashboard.ts`），**恒 ≥ 0，
 * 只会零基期、不会负基期**。生产实测：1993 个门店日里 231 个客流为 0（**11.6%**）。
 * 决策 1 要求 `base === 0` → `--` 灰，于是「昨日 0 人 → 今日 5 人」从绿色箭头变成一根灰杠——
 * 这是拍板的既定结果不是回归，但信息损失面比 issue 里估计的大。
 *
 * 所以给徽章挂 hover 露出基期原值（「昨日 0 人」），把「为什么算不出」说清楚。
 * 与 #310 给 DeltaBadge 挂基期区间是同一个思路，不与决策 1 冲突。
 */
export function TrendArrow({
  current,
  previous,
  baseLabel,
}: {
  current: number
  previous: number
  /** 基期原值的展示文案（如「0 人」/「¥1,200」）。由调用点按卡片单位格式化后传入。 */
  baseLabel?: string
}) {
  const display = resolveDeltaDisplay(current, previous)
  const tone = deltaTone(display, TREND_DIGITS)
  const title = baseLabel === undefined ? undefined : `昨日 ${baseLabel}`

  if (display.kind === "pct" && !isFlatAfterRounding(display.value, TREND_DIGITS)) {
    // 走 deltaScaled 而非自行 Math.round —— 那两者在 -0.5 处分叉
    // （Math.round(-0.5) === -0），会让「不算持平」的值渲染成 0%，把缺陷造回来。
    const pct = Math.abs(deltaScaled(display.value, TREND_DIGITS))
    const up = tone === "positive"
    return (
      <span
        className={cn("text-xs flex items-center gap-0.5", up ? "text-[#3D8A5A]" : "text-[#D94040]")}
        title={title}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          {up ? ARROW_UP : ARROW_DOWN}
        </svg>
        {pct}%
      </span>
    )
  }

  // pct 但舍入为 0（决策 3）、以及 na —— 都没有方向可言，走灰色无箭头。
  if (display.kind === "pct" || display.kind === "na") {
    return (
      <span className="text-xs text-[#999999]" title={title}>
        {display.kind === "na" ? NA_TEXT : FLAT_TEXT}
      </span>
    )
  }

  // 负基期两态：保留箭头传达方向，但文案说的是「转正与否」而不是一个假的百分比。
  //
  // ⚠️ 这里是 if 链收尾，不像 deltaTone/formatDelta 的 switch 那样有 TS 穷尽性检查兜底。
  // 下面这行断言把漏网的 kind 变成**编译错误**：若将来给 DeltaDisplay 加第 5 个成员却忘了
  // 在本组件处理，`display` 就不再是 never，TS2322 会当场报错——
  // 否则新态会静默渲染成红色「未转正」，零告警。
  const exhaustive: "turnedPositive" | "notTurned" = display.kind
  const turned = exhaustive === "turnedPositive"
  return (
    <span
      className={cn("text-xs flex items-center gap-0.5", turned ? "text-[#3D8A5A]" : "text-[#D94040]")}
      title={title}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        {turned ? ARROW_UP : ARROW_DOWN}
      </svg>
      {turned ? TURNED_POSITIVE_TEXT : NOT_TURNED_TEXT}
    </span>
  )
}

interface Props {
  stats: DashboardStats
  actions: string[]
}

/**
 * 业务角色看板：manager / finance
 *
 * 关键展示口径（以 actions/dashboard.ts 的 SQL 为准，本段是摘要）：
 *   - "今日客流" = service_orders[已完成] DISTINCT client_user_id（与 metrics §"客流"对齐）
 *   - "今日业绩" = SUM(sale_order_performance_events.amount)，含首次支付/回款/退款
 *     （退款为负、天然冲销）；**不再**是 SUM(received - refunded_amount)
 *     ——2026-08 现金流口径修订起该描述即失效，2026-09-14 随 #140 一并订正
 *   - "今日已退款"独立展示（> 0 时才点亮，避免噪音）
 *   - ⚠ 日期口径统一为业绩归属日期 performance_date（#140），
 *     业绩与实付/退款同口径；「今日实付」不再与银行流水逐日对齐
 */
function BusinessDashboard({ stats, actions }: Props) {
  const canAccess = (action: string | readonly string[]) =>
    (Array.isArray(action) ? action : [action]).some((item) => hasUiCapability(actions, item))
  const metricCards = [
    {
      label: "今日客流",
      value: stats.todayVisitors,
      format: (v: number) => String(v),
      prev: stats.yesterdayVisitors,
      href: "/services",
      action: "service:list",
      hint: "按已完成服务单去重",
    },
    {
      label: "今日业绩",
      value: stats.todayRevenue,
      format: (v: number) => `¥${v.toLocaleString()}`,
      prev: stats.yesterdayRevenue,
      href: "/orders",
      action: "sale_order:list",
      hint:
        stats.todayRefundedAmount > 0
          ? `已扣退款 ¥${stats.todayRefundedAmount.toLocaleString()}`
          : "已扣退款",
    },
    {
      label: "待处理订单",
      value: stats.pendingOrders,
      format: (v: number) => String(v),
      prev: null as number | null,
      href: "/orders",
      action: "sale_order:list",
      hint: undefined as string | undefined,
    },
    {
      label: "待确认预约",
      value: stats.pendingAppointments,
      format: (v: number) => String(v),
      prev: null as number | null,
      href: "/appointments",
      action: "appointment:list",
      hint: undefined as string | undefined,
    },
  ]

  const todoItems = [
    { text: `${stats.pendingAllocations} 笔订单待分配`, href: "/allocations", count: stats.pendingAllocations, action: "allocation:list" },
    { text: `${stats.pendingOrders} 笔订单待处理`, href: "/orders", count: stats.pendingOrders, action: "sale_order:list" },
    { text: `${stats.pendingAppointments} 条预约待确认`, href: "/appointments", count: stats.pendingAppointments, action: "appointment:list" },
    { text: `${stats.activeServices} 个服务单进行中`, href: "/services", count: stats.activeServices, action: "service:list" },
  ].filter(item => item.count > 0 && canAccess(item.action))

  const shortcuts = [
    { label: "开单", href: "/orders/create", action: "sale_order:create" },
    { label: "订单管理", href: "/orders", action: "sale_order:list" },
    { label: "顾客管理", href: "/customers", action: "customer:list" },
    { label: "营业额分配", href: "/allocations", action: "allocation:list" },
  ].filter(item => canAccess(item.action))

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {metricCards.filter((card) => canAccess(card.action)).map((card) => (
          <Link key={card.label} href={card.href}>
            <Card className="hover:border-[#C0322A]/30 transition-colors cursor-pointer">
              <CardContent className="p-5">
                <p className="text-sm text-[#999999]">{card.label}</p>
                <p className="mt-2 text-2xl font-bold text-[var(--foreground)]">{card.format(card.value)}</p>
                {card.prev !== null && (
                  <div className="mt-1 flex items-center gap-1 text-xs text-[#999999]">
                    vs 昨日 <TrendArrow current={card.value} previous={card.prev} baseLabel={card.format(card.prev)} />
                  </div>
                )}
                {card.hint && (
                  <p className="mt-1 text-xs text-[#999999]">{card.hint}</p>
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
function SystemDashboard({ stats, actions }: Props) {
  const a = stats.adminStats
  if (!a) return null
  const canAccess = (action: string | readonly string[]) =>
    (Array.isArray(action) ? action : [action]).some((item) => hasUiCapability(actions, item))

  const ROLE_CARDS: Record<string, Array<{ label: string; value: number; href: string; action: string | readonly string[] }>> = {
    admin: [
      { label: "营业门店", value: a.totalStores, href: "/stores", action: "store:list" },
      { label: "在职员工", value: a.totalEmployees, href: "/employees", action: "employee:create" },
      { label: "在售商品", value: a.totalProducts, href: "/products", action: "product:list" },
      { label: "注册顾客", value: a.totalCustomers, href: "/customers", action: "customer:list" },
    ],
    hr: [
      { label: "营业门店", value: a.totalStores, href: "/stores", action: "store:list" },
      { label: "在职员工", value: a.totalEmployees, href: "/employees", action: "employee:create" },
    ],
    product: [
      { label: "在售商品", value: a.totalProducts, href: "/products", action: "product:list" },
    ],
  }

  const ROLE_SHORTCUTS: Record<string, Array<{ label: string; href: string; action: string | readonly string[] }>> = {
    admin: [
      { label: "组织架构", href: "/org", action: "org:list" },
      { label: "门店管理", href: "/stores", action: "store:list" },
      { label: "员工管理", href: "/employees", action: "employee:create" },
      { label: "商品管理", href: "/products", action: "product:list" },
      { label: "权限管理", href: "/permissions", action: "permission:list" },

    ],
    hr: [
      { label: "组织架构", href: "/org", action: "org:list" },
      { label: "门店管理", href: "/stores", action: "store:list" },
      { label: "员工管理", href: "/employees", action: "employee:create" },
      { label: "权限管理", href: "/permissions", action: "permission:list" },
    ],
    product: [
      { label: "商品管理", href: "/products", action: "product:list" },
      { label: "品项分类", href: "/products/categories", action: "product:list" },
      { label: "优惠券管理", href: "/coupons", action: "coupon:list" },
    ],
  }

  const ctx = stats.roleContext
  const cards = ROLE_CARDS[ctx] ?? ROLE_CARDS.admin!
  const shortcuts = ROLE_SHORTCUTS[ctx] ?? ROLE_SHORTCUTS.admin!

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.filter((card) => canAccess(card.action)).map((card) => (
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
            {shortcuts.filter((item) => canAccess(item.action)).map((item) => (
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

export default function DashboardPage({ stats, actions }: Props) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">工作台</h1>
        <p className="mt-1 text-sm text-[#999999]">欢迎使用凤御美业管理后台</p>
      </div>

      {stats.roleContext === 'business'
        ? <BusinessDashboard stats={stats} actions={actions} />
        : <SystemDashboard stats={stats} actions={actions} />
      }
    </div>
  )
}
