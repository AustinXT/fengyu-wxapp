"use client"

import { Card } from "@/components/ui/card"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import { parseBoardParams } from "@/lib/data-center/params"

/**
 * 板块占位组件（地基阶段）。读 URL 参数并回显，验证公共筛选器联动。
 * 阶段二各 agent 用真实板块实现替换对应 *-board.tsx（导出名保持不变）。
 */
export function BoardPlaceholder({ name }: { name: string }) {
  const { searchParams } = useUrlFilters()
  const raw = Object.fromEntries(searchParams.entries())
  const params = parseBoardParams(raw)
  return (
    <Card className="p-8 flex flex-col items-center gap-2 text-[var(--muted-foreground)]">
      <div className="text-base font-medium text-[var(--foreground)]">{name} · 开发中</div>
      <div className="text-xs">scope: {JSON.stringify(params.scope)}</div>
      <div className="text-xs">time: {JSON.stringify(params.timeRange)}</div>
      <div className="text-xs">同比环比: {params.withComparison ? "开" : "关"}</div>
    </Card>
  )
}
