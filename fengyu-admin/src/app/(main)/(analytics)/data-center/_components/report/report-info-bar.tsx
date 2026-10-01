import type { ReactNode } from "react"

export interface ReportInfoItem {
  label: string
  value: ReactNode
}

/**
 * 报表信息条（#367，5 页共用）：表格上方一行数据性标签，写明「范围 · 期间 · 条数 · 合计」等。
 * 原型 §二要求保留这类数据性信息；口径说明不写在这里（不加表下大段说明）。
 */
export function ReportInfoBar({ items }: { items: readonly ReportInfoItem[] }) {
  if (items.length === 0) return null
  return (
    <div
      data-testid="report-info-bar"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[var(--muted-foreground)]"
    >
      {items.map((item, index) => (
        <span key={item.label} className="flex items-center gap-1">
          {index > 0 && <span aria-hidden className="mr-2 text-[var(--border)]">|</span>}
          <span>{item.label}</span>
          <span className="font-medium text-[var(--foreground)]">{item.value}</span>
        </span>
      ))}
    </div>
  )
}
