"use client"

import { useState } from "react"
import { Sidebar } from "@/components/layout/sidebar"
import { Topbar } from "@/components/layout/topbar"
import { BreadcrumbNav } from "@/components/layout/breadcrumb-nav"
import type { AuthSession } from "@/lib/types"

interface MainShellProps {
  session: AuthSession
  children: React.ReactNode
}

export function MainShell({ session, children }: MainShellProps) {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} session={session} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} session={session} />
        <main className="flex-1 overflow-auto bg-[#FAFAFA] p-6">
          <BreadcrumbNav />
          {children}
        </main>
      </div>
    </div>
  )
}
