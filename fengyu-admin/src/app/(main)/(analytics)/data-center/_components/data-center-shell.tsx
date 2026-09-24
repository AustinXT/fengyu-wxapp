"use client"

import type { ReactNode } from "react"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import type { DataCenterScopeOptions } from "@/lib/data-center/types"
import { ScopeTimeFilter } from "./scope-time-filter"

const BOARD_TABS = [
  { value: "sales", label: "销售" },
  { value: "customer", label: "客量" },
  { value: "efficiency", label: "人效" },
  { value: "product", label: "品项" },
] as const

/**
 * 数据中心外壳：板块 Tab（绑 ?tab=，切换不重置 scope/时间）+ 公共筛选器 + 当前板块内容（children）。
 * 当前板块组件由 Server Component（page.tsx）按 tab 渲染后作为 children 传入。
 */
export function DataCenterShell({
  scopeOptions,
  activeTab,
  children,
}: {
  scopeOptions: DataCenterScopeOptions
  activeTab: string
  children: ReactNode
}) {
  const { setMany } = useUrlFilters()
  return (
    <div className="flex flex-col gap-4">
      <Tabs value={activeTab} onValueChange={(v) => setMany({ tab: v })}>
        <TabsList>
          {BOARD_TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <ScopeTimeFilter scopeOptions={scopeOptions} />
      {children}
    </div>
  )
}
