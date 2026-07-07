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
