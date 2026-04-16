"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import logoFull from "../../../public/logo.png";
import logoIcon from "../../../public/logo-icon.png";
import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { getVisibleMenuGroups } from "@/lib/menu";
import { getRoleLabel } from "@/lib/auth";
import type { AuthSession } from "@/lib/types";
import { APP_VERSION, APP_COMMIT, BUILD_TIME } from "@/generated/version";

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  session: AuthSession;
}

export function Sidebar({ collapsed, onToggle, session }: SidebarProps) {
  const pathname = usePathname();

  const primaryRole = session.roles[0];
  const menuGroups = getVisibleMenuGroups(session);

  function isActive(href: string): boolean {
    // Exact match for top-level routes
    if (href === pathname) return true;
    // For nested routes like /orders/create, check if /orders is parent
    // But /orders/create should match itself, not /orders
    if (href === "/orders/create" && pathname === "/orders/create") return true;
    if (href === "/orders" && pathname.startsWith("/orders") && pathname !== "/orders/create") return true;
    // Generic: pathname starts with href and href is not just "/"
    if (href !== "/orders" && href !== "/orders/create" && pathname.startsWith(href) && href.length > 1) return true;
    return false;
  }

  return (
    <aside
      className={cn(
        "flex h-screen flex-col border-r border-[var(--border)] bg-white transition-all duration-200",
        collapsed ? "w-16" : "w-40",
      )}
    >
      {/* Brand Logo */}
      <div className="flex h-14 items-center border-b border-[var(--border)] px-4">
        {collapsed ? (
          <Image src={logoIcon} alt="凤御美业" width={30} height={32} className="mx-auto" priority />
        ) : (
          <Image src={logoFull} alt="凤御美业" width={93} height={36} priority />
        )}
      </div>

      {/* Menu */}
      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {menuGroups.map((group, gi) => (
          <div key={gi} className="mb-1">
            {/* Group label */}
            {group.label && !collapsed && (
              <div className="mb-1 mt-3 px-3 text-[11px] font-medium uppercase tracking-wider text-[#999999]">
                {group.label}
              </div>
            )}
            {group.label && collapsed && gi > 0 && <div className="mx-3 my-2 border-t border-[var(--border)]" />}

            {/* Menu items */}
            {group.items.map((item) => {
              const Icon = item.icon;
              const active = isActive(item.href);

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={collapsed ? item.label : undefined}
                  className={cn(
                    "group relative flex items-center gap-3 rounded-[var(--radius)] px-3 py-2 text-sm transition-colors",
                    active
                      ? "bg-[#FFF0EE] font-medium text-[var(--primary)]"
                      : "text-[#666666] hover:bg-[var(--muted)] hover:text-[var(--foreground)]",
                    collapsed && "justify-center px-0",
                  )}
                >
                  <Icon className="size-[18px] shrink-0" />
                  {!collapsed && <span>{item.label}</span>}

                  {/* Tooltip on collapsed mode */}
                  {collapsed && (
                    <span className="pointer-events-none absolute left-full z-50 ml-2 hidden whitespace-nowrap rounded-[var(--radius)] bg-[var(--foreground)] px-2 py-1 text-xs text-white shadow-md group-hover:block">
                      {item.label}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* User info (collapsed: hidden) */}
      {!collapsed && (
        <div className="border-t border-[var(--border)] px-4 py-3">
          <div className="truncate text-sm font-medium text-[var(--foreground)]">{session.name}</div>
          <div className="truncate text-xs text-[#999999]">
            {primaryRole ? getRoleLabel(primaryRole.role) : "未分配角色"}
          </div>
        </div>
      )}

      {/* Version info */}
      <div
        className={cn(
          "truncate border-t border-[var(--border)] py-1 text-center text-[10px] leading-tight text-[#999999]",
          collapsed ? "px-1" : "px-2",
        )}
        title={`${APP_VERSION}${APP_COMMIT ? ` · ${APP_COMMIT}` : ""}\nBuilt: ${BUILD_TIME}`}
      >
        {collapsed
          ? APP_VERSION
          : `${APP_VERSION}${APP_COMMIT ? ` · ${APP_COMMIT}` : ""}`}
      </div>

      {/* Collapse toggle */}
      <button
        onClick={onToggle}
        className="flex h-10 items-center justify-center border-t border-[var(--border)] text-[#999999] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
        aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
      >
        {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
      </button>
    </aside>
  );
}
