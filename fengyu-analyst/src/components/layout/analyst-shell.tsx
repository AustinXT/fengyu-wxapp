"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { BarChart3, BookOpen, Bot, ExternalLink, LayoutDashboard } from "lucide-react"
import type { AuthSession } from "@/lib/types"
import { cn } from "@/lib/utils"

const navItems = [
  { label: "看板", href: "/dashboard", icon: LayoutDashboard },
  { label: "助手", href: "/assistant", icon: Bot },
  { label: "知识库", href: "/knowledge", icon: BookOpen },
]

export function AnalystShell({
  session,
  children,
}: {
  session: AuthSession
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const adminOrigin = process.env.NEXT_PUBLIC_ADMIN_ORIGIN || "http://localhost:3000"

  return (
    <div className="min-h-screen bg-[var(--background)]">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-60 border-r border-[var(--border)] bg-white lg:block">
        <div className="flex h-16 items-center gap-2 border-b border-[var(--border)] px-5">
          <div className="flex size-9 items-center justify-center rounded-md bg-[var(--primary)] text-white">
            <BarChart3 className="size-5" />
          </div>
          <div>
            <div className="text-sm font-semibold text-neutral-950">凤御经营分析</div>
            <div className="text-xs text-neutral-500">fengyu-analyst</div>
          </div>
        </div>
        <nav className="space-y-1 px-3 py-4">
          {navItems.map((item) => {
            const active = pathname === item.href
            return (
              <Link
                key={item.href}
                href={item.href}
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
            )
          })}
        </nav>
      </aside>

      <div className="lg:pl-60">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-[var(--border)] bg-white/95 px-4 backdrop-blur lg:h-16 lg:px-6">
          <div className="text-sm font-medium text-neutral-950 lg:hidden">凤御经营分析</div>
          <div className="hidden text-sm text-neutral-500 lg:block">独立分析站点</div>
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

        <main className="px-4 py-4 pb-24 sm:px-6 lg:px-8 lg:py-6">{children}</main>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-3 border-t border-[var(--border)] bg-white lg:hidden">
        {navItems.map((item) => {
          const active = pathname === item.href
          return (
            <Link
              key={item.href}
              href={item.href}
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

