"use client"

import type { ReactNode } from "react"
import type { DataCenterScopeOptions } from "@/lib/data-center/types"
import { ScopeTimeFilter } from "./scope-time-filter"

/**
 * 数据中心外壳：公共筛选器 + 当前板块内容（children）。
 * 板块切换由侧边栏二级菜单承担（各板块独立路径），页内不再有第二套入口；
 * 切换板块是整页导航，scope/时间/同比环比随之回落默认（已拍板的取舍，见 #212）。
 */
export function DataCenterShell({
  scopeOptions,
  children,
}: {
  scopeOptions: DataCenterScopeOptions
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-4">
      <ScopeTimeFilter scopeOptions={scopeOptions} />
      {children}
    </div>
  )
}
