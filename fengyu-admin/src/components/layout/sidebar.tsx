'use client'

import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronsLeft, ChevronsRight } from 'lucide-react'
import logoFull from '../../../public/logo.png'
import logoIcon from '../../../public/logo-icon.png'
import { cn } from '@/lib/utils'
import { getMenuItemForPath, getMenuParentForPath, getVisibleMenuItems, isMenuParent, type MenuItem } from '@/lib/menu'
import { getRoleLabel } from '@/lib/auth'
import type { AuthSession } from '@/lib/types'
import { APP_VERSION, APP_COMMIT, BUILD_TIME } from '@/generated/version'

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
  session: AuthSession
}

export function Sidebar({ collapsed, onToggle, session }: SidebarProps) {
  const pathname = usePathname()
  const rootRef = useRef<HTMLElement>(null)
  const primaryRole = session.roles[0]
  const menuNodes = getVisibleMenuItems(session)
  const activeHref = useMemo(() => getMenuItemForPath(menuNodes, pathname)?.href ?? null, [menuNodes, pathname])
  const activeParentLabel = useMemo(
    () => getMenuParentForPath(menuNodes, pathname)?.label ?? null,
    [menuNodes, pathname],
  )
  const [expandedLabel, setExpandedLabel] = useState<string | null>(activeParentLabel)
  const [popupLabel, setPopupLabel] = useState<string | null>(null)

  useEffect(() => {
    setExpandedLabel(activeParentLabel)
    setPopupLabel(null)
  }, [activeParentLabel, pathname])

  useEffect(() => {
    if (!collapsed) setPopupLabel(null)
  }, [collapsed])

  useEffect(() => {
    if (!popupLabel) return
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setPopupLabel(null)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPopupLabel(null)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [popupLabel])

  function renderLeaf(item: MenuItem, nested = false) {
    const Icon = item.icon
    const active = item.href === activeHref
    return (
      <Link
        key={item.href}
        href={item.href}
        title={collapsed ? item.label : undefined}
        aria-label={collapsed ? item.label : undefined}
        className={cn(
          'group relative flex items-center gap-3 rounded-[var(--radius)] py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2',
          nested ? 'px-3 pl-10' : 'px-3',
          active
            ? 'bg-[#FFF0EE] font-medium text-[var(--primary)]'
            : 'text-[#666666] hover:bg-[var(--muted)] hover:text-[var(--foreground)]',
          collapsed && 'justify-center px-0',
        )}
      >
        <Icon className="size-[18px] shrink-0" />
        {!collapsed && <span className="min-w-0 truncate">{item.label}</span>}
        {collapsed && (
          <span className="pointer-events-none absolute left-full z-50 ml-2 hidden whitespace-nowrap rounded-[var(--radius)] bg-[var(--foreground)] px-2 py-1 text-xs text-white shadow-md group-hover:block">
            {item.label}
          </span>
        )}
      </Link>
    )
  }

  return (
    <aside
      ref={rootRef}
      className={cn(
        'flex h-screen flex-col border-r border-[var(--border)] bg-white transition-all duration-200',
        collapsed ? 'w-16' : 'w-56',
      )}
    >
      <div className="flex h-14 items-center border-b border-[var(--border)] px-4">
        {collapsed ? (
          <Image src={logoIcon} alt="凤御美业" width={30} height={32} className="mx-auto" priority />
        ) : (
          <Image src={logoFull} alt="凤御美业" width={93} height={36} priority />
        )}
      </div>

      <nav aria-label="主导航" className={cn('flex-1 px-2 py-3', collapsed ? 'overflow-visible' : 'overflow-y-auto')}>
        {menuNodes.map((node) => {
          if (!isMenuParent(node)) return <div key={node.href}>{renderLeaf(node)}</div>

          const Icon = node.icon
          const active = node.children.some((item) => item.href === activeHref)
          const expanded = expandedLabel === node.label
          const popupOpen = popupLabel === node.label
          const regionId = `sidebar-group-${node.label}`

          return (
            <div key={node.label} className="relative mb-1">
              <button
                type="button"
                onClick={() => {
                  if (collapsed) setPopupLabel(popupOpen ? null : node.label)
                  else setExpandedLabel(expanded ? null : node.label)
                }}
                aria-expanded={collapsed ? popupOpen : expanded}
                aria-controls={regionId}
                aria-label={collapsed ? node.label : undefined}
                className={cn(
                  'group flex w-full items-center gap-3 rounded-[var(--radius)] px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2',
                  active
                    ? 'bg-[#FFF0EE] font-medium text-[var(--primary)]'
                    : 'text-[#555555] hover:bg-[var(--muted)] hover:text-[var(--foreground)]',
                  collapsed && 'justify-center px-0',
                )}
              >
                <Icon className="size-[18px] shrink-0" />
                {!collapsed && (
                  <>
                    <span className="min-w-0 flex-1 text-left">{node.label}</span>
                    <ChevronDown className={cn('size-4 transition-transform', expanded && 'rotate-180')} />
                  </>
                )}
                {collapsed && (
                  <span className="pointer-events-none absolute left-full z-50 ml-2 hidden whitespace-nowrap rounded-[var(--radius)] bg-[var(--foreground)] px-2 py-1 text-xs text-white shadow-md group-hover:block">
                    {node.label}
                  </span>
                )}
              </button>

              {!collapsed && expanded && (
                <div id={regionId} className="mt-1 space-y-0.5">
                  {node.children.map((item) => renderLeaf(item, true))}
                </div>
              )}

              {collapsed && popupOpen && (
                <div
                  id={regionId}
                  role="menu"
                  className="absolute left-full top-0 z-50 ml-2 min-w-52 rounded-[var(--radius)] border border-[var(--border)] bg-white p-1 shadow-lg"
                >
                  <div className="px-2 py-1.5 text-xs font-medium text-[#888888]">{node.label}</div>
                  {node.children.map((item) => {
                    const ChildIcon = item.icon
                    const activeChild = item.href === activeHref
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        role="menuitem"
                        onClick={() => setPopupLabel(null)}
                        className={cn(
                          'flex items-center gap-2 rounded-[var(--radius)] px-2 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
                          activeChild
                            ? 'bg-[#FFF0EE] font-medium text-[var(--primary)]'
                            : 'text-[#555555] hover:bg-[var(--muted)] hover:text-[var(--foreground)]',
                        )}
                      >
                        <ChildIcon className="size-4" />
                        {item.label}
                      </Link>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </nav>

      {!collapsed && (
        <div className="border-t border-[var(--border)] px-4 py-3">
          <div className="truncate text-sm font-medium text-[var(--foreground)]">{session.name}</div>
          <div className="truncate text-xs text-[#999999]">
            {primaryRole ? getRoleLabel(primaryRole.role, primaryRole.roleName) : '未分配角色'}
          </div>
        </div>
      )}

      <div
        data-testid="build-version"
        className={cn(
          'truncate border-t border-[var(--border)] py-1 text-center text-[10px] leading-tight text-[#999999]',
          collapsed ? 'px-1' : 'px-2',
        )}
        title={`${APP_VERSION}${APP_COMMIT ? ` · ${APP_COMMIT}` : ''}\nBuilt: ${BUILD_TIME}`}
      >
        {collapsed ? APP_VERSION : `${APP_VERSION}${APP_COMMIT ? ` · ${APP_COMMIT}` : ''}`}
      </div>

      <button
        onClick={onToggle}
        className="flex h-10 items-center justify-center border-t border-[var(--border)] text-[#999999] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
      >
        {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
      </button>
    </aside>
  )
}
