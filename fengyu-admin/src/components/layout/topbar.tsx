"use client"

import { useState, useRef, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Menu, PanelLeftClose, Bell, LogOut, KeyRound } from "lucide-react"
import { cn } from "@/lib/utils"
import { getRoleLabel } from "@/lib/auth"
import { logout } from "@/actions/auth"
import type { AuthSession } from "@/lib/types"
import { ExportTasksMenu } from "@/components/layout/export-tasks-menu"

interface TopbarProps {
  collapsed: boolean
  onToggle: () => void
  session: AuthSession
}

export function Topbar({ collapsed, onToggle, session }: TopbarProps) {
  const router = useRouter()
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const primaryRole = session.roles[0]

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    if (dropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside)
    }
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [dropdownOpen])

  async function handleLogout() {
    setDropdownOpen(false)
    await logout()
    router.push("/login")
  }

  function handleChangePassword() {
    setDropdownOpen(false)
    router.push("/change-password")
  }

  return (
    <header className="flex h-14 shrink-0 items-center border-b border-[var(--border)] bg-white px-4">
      {/* Left: sidebar toggle */}
      <button
        onClick={onToggle}
        className="flex size-9 items-center justify-center rounded-[var(--radius)] text-[#666666] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
        aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
      >
        {collapsed ? (
          <Menu className="size-5" />
        ) : (
          <PanelLeftClose className="size-5" />
        )}
      </button>

      {/* Center: spacer */}
      <div className="flex-1" />

      {/* Right: notification + avatar */}
      <div className="flex items-center gap-2">
        <ExportTasksMenu />
        {/* Notification bell */}
        <button
          className="relative flex size-9 items-center justify-center rounded-[var(--radius)] text-[#666666] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
          aria-label="通知"
        >
          <Bell className="size-5" />
        </button>

        {/* User avatar dropdown */}
        <div ref={dropdownRef} className="relative">
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="flex items-center gap-2 rounded-[var(--radius)] px-2 py-1.5 text-sm transition-colors hover:bg-[var(--muted)]"
          >
            <div className="flex size-8 items-center justify-center rounded-full bg-[var(--primary)] text-xs font-medium text-white">
              {session.name.charAt(0)}
            </div>
            <span className="hidden text-[var(--foreground)] sm:inline">{session.name}</span>
          </button>

          {/* Dropdown menu */}
          {dropdownOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 w-56 rounded-[var(--radius-lg)] border border-[var(--border)] bg-white py-1 shadow-lg">
              {/* User info header */}
              <div className="border-b border-[var(--border)] px-4 py-3">
                <div className="text-sm font-medium text-[var(--foreground)]">
                  {session.name}
                </div>
                <div className="mt-0.5 text-xs text-[#999999]">
                  {primaryRole ? getRoleLabel(primaryRole.role, primaryRole.roleName) : "未分配角色"}
                </div>
              </div>

              {/* Menu items */}
              <div className="py-1">
                <button
                  onClick={handleChangePassword}
                  className={cn(
                    "flex w-full items-center gap-3 px-4 py-2 text-sm text-[#666666] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
                  )}
                >
                  <KeyRound className="size-4" />
                  修改密码
                </button>
              </div>

              <div className="border-t border-[var(--border)] py-1">
                <button
                  onClick={handleLogout}
                  className="flex w-full items-center gap-3 px-4 py-2 text-sm text-[var(--destructive)] transition-colors hover:bg-[var(--muted)]"
                >
                  <LogOut className="size-4" />
                  退出登录
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
