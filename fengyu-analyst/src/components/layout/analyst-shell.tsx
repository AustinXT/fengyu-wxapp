"use client"

import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import {
  BarChart3,
  BookOpen,
  Bot,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  GripVertical,
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react"
import { AnalystPageLoading } from "@/components/analyst-page-loading"
import { metricGroups } from "@/lib/metric-catalog"
import type { AuthSession } from "@/lib/types"
import { cn } from "@/lib/utils"

const DEFAULT_SIDEBAR_WIDTH = 260
const MIN_SIDEBAR_WIDTH = 220
const MAX_SIDEBAR_WIDTH = 380
const SIDEBAR_WIDTH_STORAGE_KEY = "fengyu-analyst.sidebar.width"
const SIDEBAR_HIDDEN_STORAGE_KEY = "fengyu-analyst.sidebar.hidden"
const METRIC_LIST_STORAGE_KEY = "fengyu-analyst.sidebar.metrics.expanded"
const METRIC_GROUPS_STORAGE_KEY = "fengyu-analyst.sidebar.metric-groups.expanded"
const DEFAULT_EXPANDED_GROUPS = metricGroups.map((group) => group.id)

const navItems = [
  { label: "看板", href: "/dashboard", icon: LayoutDashboard },
  { label: "助手", href: "/assistant", icon: Bot },
  { label: "知识库", href: "/knowledge", icon: BookOpen },
]

const NAVIGATION_ORIGIN = "https://fengyu-analyst.local"

function navigationDestination(href: string): URL {
  return new URL(href, NAVIGATION_ORIGIN)
}

export function getNavigationLabel(href: string): string {
  const destination = navigationDestination(href)

  if (destination.pathname === "/dashboard") {
    const metricId = destination.searchParams.get("metric")
    const metric = metricGroups.flatMap((group) => group.metrics).find((item) => item.id === metricId)
    return metric?.label ?? "看板"
  }

  return navItems.find((item) => item.href === destination.pathname)?.label ?? "页面"
}

function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width))
}

export function AnalystShell({
  session,
  children,
}: {
  session: AuthSession
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pendingHref, setPendingHref] = useState<string | null>(null)
  const pendingDestination = pendingHref ? navigationDestination(pendingHref) : null
  const displayedPathname = pendingDestination?.pathname ?? pathname
  const displayedSearchParams = pendingDestination?.searchParams ?? searchParams
  const activeMetric = displayedSearchParams.get("metric") || "repurchase"
  const activeScope = searchParams.get("scope")
  const activeScopeId = searchParams.get("scopeId")
  const adminOrigin = process.env.NEXT_PUBLIC_ADMIN_ORIGIN || "http://localhost:3000"
  const dashboardActive = displayedPathname === "/dashboard"
  const resizeState = useRef<{ startX: number; startWidth: number } | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH)
  const [sidebarHidden, setSidebarHidden] = useState(false)
  const [metricListExpanded, setMetricListExpanded] = useState(true)
  const [expandedGroupIds, setExpandedGroupIds] = useState(DEFAULT_EXPANDED_GROUPS)
  const [settingsReady, setSettingsReady] = useState(false)

  useEffect(() => {
    setPendingHref(null)
  }, [pathname, searchParams])

  useEffect(() => {
    const storedWidth = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY))
    if (Number.isFinite(storedWidth) && storedWidth > 0) {
      setSidebarWidth(clampSidebarWidth(storedWidth))
    }

    setSidebarHidden(window.localStorage.getItem(SIDEBAR_HIDDEN_STORAGE_KEY) === "true")

    const storedMetricList = window.localStorage.getItem(METRIC_LIST_STORAGE_KEY)
    if (storedMetricList !== null) {
      setMetricListExpanded(storedMetricList !== "false")
    }

    const storedGroups = window.localStorage.getItem(METRIC_GROUPS_STORAGE_KEY)
    if (storedGroups !== null) {
      try {
        const parsedGroups = JSON.parse(storedGroups)
        if (Array.isArray(parsedGroups)) {
          setExpandedGroupIds(parsedGroups.filter((id): id is string => DEFAULT_EXPANDED_GROUPS.includes(id)))
        }
      } catch {
        setExpandedGroupIds(DEFAULT_EXPANDED_GROUPS)
      }
    }

    setSettingsReady(true)
  }, [])

  useEffect(() => {
    if (!settingsReady) return
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth))
    window.localStorage.setItem(SIDEBAR_HIDDEN_STORAGE_KEY, String(sidebarHidden))
    window.localStorage.setItem(METRIC_LIST_STORAGE_KEY, String(metricListExpanded))
    window.localStorage.setItem(METRIC_GROUPS_STORAGE_KEY, JSON.stringify(expandedGroupIds))
  }, [expandedGroupIds, metricListExpanded, settingsReady, sidebarHidden, sidebarWidth])

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (!resizeState.current) return
      const nextWidth = resizeState.current.startWidth + event.clientX - resizeState.current.startX
      setSidebarWidth(clampSidebarWidth(nextWidth))
    }

    const stopResize = () => {
      if (!resizeState.current) return
      resizeState.current = null
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
    }

    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", stopResize)
    window.addEventListener("pointercancel", stopResize)

    return () => {
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerup", stopResize)
      window.removeEventListener("pointercancel", stopResize)
      stopResize()
    }
  }, [])

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (sidebarHidden) return
      event.preventDefault()
      resizeState.current = {
        startX: event.clientX,
        startWidth: sidebarWidth,
      }
      document.body.style.cursor = "col-resize"
      document.body.style.userSelect = "none"
    },
    [sidebarHidden, sidebarWidth],
  )

  const toggleMetricGroup = useCallback((groupId: string) => {
    setExpandedGroupIds((current) =>
      current.includes(groupId) ? current.filter((id) => id !== groupId) : [...current, groupId],
    )
  }, [])

  const shellStyle = {
    "--analyst-sidebar-width": `${sidebarWidth}px`,
  } as CSSProperties

  function withCurrentScope(href: string): string {
    if (!href.startsWith("/dashboard")) return href
    const [pathnamePart, queryPart] = href.split("?", 2)
    const next = new URLSearchParams(queryPart)
    if (activeScope) next.set("scope", activeScope)
    if (activeScopeId) next.set("scopeId", activeScopeId)
    const query = next.toString()
    return query ? `${pathnamePart}?${query}` : pathnamePart
  }

  function handleNavigate(href: string) {
    const destination = navigationDestination(href)
    const currentSearch = searchParams.toString()

    if (destination.pathname === pathname && destination.search === (currentSearch ? `?${currentSearch}` : "")) {
      setPendingHref(null)
      return
    }

    setPendingHref(`${destination.pathname}${destination.search}`)
  }

  return (
    <div className="min-h-screen bg-[var(--background)]" style={shellStyle} aria-busy={pendingHref !== null}>
      {pendingHref ? (
        <div className="fixed inset-x-0 top-0 z-[60] h-0.5 overflow-hidden bg-red-100" role="progressbar" aria-label="页面加载中">
          <div className="h-full w-1/3 animate-[analyst-progress_900ms_ease-in-out_infinite] bg-[var(--primary)]" />
        </div>
      ) : null}
      {!sidebarHidden ? (
        <aside
          className="fixed inset-y-0 left-0 z-20 hidden border-r border-[var(--border)] bg-white lg:block"
          style={{ width: "var(--analyst-sidebar-width)" }}
        >
          <div className="flex h-14 items-center justify-between gap-3 border-b border-[var(--border)] px-5">
            <Link href={withCurrentScope("/dashboard")} onNavigate={() => handleNavigate(withCurrentScope("/dashboard"))} className="flex min-w-0 items-center gap-2">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-[var(--primary)] text-white">
                <BarChart3 className="size-5" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-neutral-950">凤御经营分析</span>
                <span className="block truncate text-xs text-neutral-500">fengyu-analyst</span>
              </span>
            </Link>
            <button
              type="button"
              onClick={() => setSidebarHidden(true)}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-50 hover:text-neutral-950"
              aria-label="隐藏左侧导航"
              title="隐藏左侧导航"
            >
              <PanelLeftClose className="size-4" />
            </button>
          </div>

          <nav className="h-[calc(100vh-4rem)] space-y-1 overflow-y-auto px-3 py-4">
            {navItems.map((item) => {
              const active = displayedPathname === item.href
              const isDashboardItem = item.href === "/dashboard"

              return (
                <div key={item.href}>
                  {isDashboardItem ? (
                    <div
                      className={cn(
                        "flex h-10 items-center rounded-md text-sm font-medium",
                        active
                          ? "bg-[var(--accent)] text-[var(--accent-foreground)]"
                          : "text-neutral-600 hover:bg-neutral-50 hover:text-neutral-950",
                      )}
                    >
                      <Link href={withCurrentScope(item.href)} onNavigate={() => handleNavigate(withCurrentScope(item.href))} className="flex h-full min-w-0 flex-1 items-center gap-2 px-3">
                        <item.icon className="size-4 shrink-0" />
                        <span className="truncate">{item.label}</span>
                      </Link>
                      <button
                        type="button"
                        onClick={() => setMetricListExpanded((expanded) => !expanded)}
                        className="mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-white/60"
                        aria-label={metricListExpanded ? "折叠指标列表" : "展开指标列表"}
                        title={metricListExpanded ? "折叠指标列表" : "展开指标列表"}
                      >
                        {metricListExpanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                      </button>
                    </div>
                  ) : (
                    <Link
                      href={item.href}
                      onNavigate={() => handleNavigate(item.href)}
                      className={cn(
                        "flex h-10 items-center gap-2 rounded-md px-3 text-sm font-medium",
                        active
                          ? "bg-[var(--accent)] text-[var(--accent-foreground)]"
                          : "text-neutral-600 hover:bg-neutral-50 hover:text-neutral-950",
                      )}
                    >
                      <item.icon className="size-4" />
                      {item.label}
                    </Link>
                  )}

                  {isDashboardItem && metricListExpanded ? (
                    <div className="mt-3 space-y-3 border-l border-[var(--border)] pl-3">
                      {metricGroups.map((group) => {
                        const groupExpanded = expandedGroupIds.includes(group.id)

                        return (
                          <div key={group.id} className="space-y-1">
                            <button
                              type="button"
                              onClick={() => toggleMetricGroup(group.id)}
                              className="flex h-7 w-full items-center justify-between gap-2 rounded-md px-2 text-left text-[11px] font-medium text-neutral-500 hover:bg-neutral-50 hover:text-neutral-800"
                              aria-expanded={groupExpanded}
                            >
                              <span className="truncate">{group.label}</span>
                              {groupExpanded ? (
                                <ChevronDown className="size-3.5 shrink-0" />
                              ) : (
                                <ChevronRight className="size-3.5 shrink-0" />
                              )}
                            </button>
                            {groupExpanded
                              ? group.metrics.map((metric) => {
                                  const metricActive = dashboardActive && activeMetric === metric.id

                                  return (
                                    <Link
                                      key={metric.id}
                                      href={withCurrentScope(metric.href)}
                                      onNavigate={() => handleNavigate(withCurrentScope(metric.href))}
                                      className={cn(
                                        "flex min-h-8 items-center justify-between gap-2 rounded-md px-2 text-xs",
                                        metricActive
                                          ? "bg-neutral-100 font-medium text-neutral-950"
                                          : "text-neutral-500 hover:bg-neutral-50 hover:text-neutral-800",
                                      )}
                                    >
                                      <span className="truncate">{metric.label}</span>
                                      {metric.status === "planned" ? (
                                        <span className="shrink-0 rounded-sm bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-400">
                                          预留
                                        </span>
                                      ) : null}
                                    </Link>
                                  )
                                })
                              : null}
                          </div>
                        )
                      })}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </nav>

          <button
            type="button"
            onPointerDown={startResize}
            className="group absolute inset-y-0 right-0 flex w-3 translate-x-1/2 cursor-col-resize items-center justify-center"
            aria-label="调整左侧导航宽度"
            title="调整左侧导航宽度"
          >
            <span className="flex h-14 w-1 items-center justify-center rounded-full bg-transparent text-neutral-300 transition group-hover:bg-neutral-200 group-hover:text-neutral-600">
              <GripVertical className="size-3 opacity-0 transition group-hover:opacity-100" />
            </span>
          </button>
        </aside>
      ) : (
        <button
          type="button"
          onClick={() => setSidebarHidden(false)}
          className="fixed left-3 top-3 z-30 hidden size-10 items-center justify-center rounded-md border border-[var(--border)] bg-white text-neutral-600 shadow-sm hover:bg-neutral-50 hover:text-neutral-950 lg:inline-flex"
          aria-label="显示左侧导航"
          title="显示左侧导航"
        >
          <PanelLeftOpen className="size-4" />
        </button>
      )}

      <div className={cn("transition-[padding-left] duration-150", sidebarHidden ? "lg:pl-0" : "lg:pl-[var(--analyst-sidebar-width)]")}>
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-[var(--border)] bg-white/95 px-4 backdrop-blur lg:h-14 lg:px-6">
          <div className="text-sm font-medium text-neutral-950 lg:hidden">凤御经营分析</div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-neutral-700">{session.name}</span>
            <a
              href={adminOrigin}
              className="inline-flex size-9 items-center justify-center rounded-md border border-[var(--border)] text-neutral-600 hover:bg-neutral-50"
              aria-label="返回管理后台"
            >
              <ExternalLink className="size-4" />
            </a>
          </div>
        </header>

        <main className="px-4 py-4 pb-24 sm:px-6 lg:px-8 lg:py-6">
          {pendingHref ? <AnalystPageLoading key={pendingHref} label={getNavigationLabel(pendingHref)} /> : children}
        </main>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-3 border-t border-[var(--border)] bg-white lg:hidden">
        {navItems.map((item) => {
          const active = displayedPathname === item.href
          const href = withCurrentScope(item.href)
          return (
            <Link
              key={item.href}
              href={href}
              onNavigate={() => handleNavigate(href)}
              className={cn(
                "flex min-h-14 flex-col items-center justify-center gap-1 text-xs font-medium",
                active ? "text-[var(--primary)]" : "text-neutral-500",
              )}
            >
              <item.icon className="size-5" />
              {item.label}
            </Link>
          )
        })}
      </nav>
    </div>
  )
}
