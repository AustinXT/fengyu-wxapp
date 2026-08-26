"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { Button } from "./button"

export interface PaginationProps {
  total: number
  page: number
  pageSize: number
  onPageChange: (page: number) => void
  /** 提供后渲染"N条/页"下拉选择器 */
  pageSizeOptions?: number[]
  onPageSizeChange?: (size: number) => void
  className?: string
}

function Pagination({ total: rawTotal, page: rawPage, pageSize: rawPageSize, onPageChange, pageSizeOptions, onPageSizeChange, className }: PaginationProps) {
  // 输入防护：防止 NaN/Infinity/负值导致渲染异常
  const total = Math.max(0, Math.floor(rawTotal) || 0)
  const pageSize = Math.max(1, Math.floor(rawPageSize) || 20)
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.min(Math.max(1, Math.floor(rawPage) || 1), totalPages)
  const correctedPageRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    const correctionKey = `${rawPage}:${totalPages}`
    if (Number.isFinite(rawPage) && rawPage > totalPages) {
      if (correctedPageRef.current !== correctionKey) {
        correctedPageRef.current = correctionKey
        onPageChange(totalPages)
      }
      return
    }
    correctedPageRef.current = null
  }, [onPageChange, rawPage, totalPages])

  if (totalPages <= 1 && total <= pageSize) {
    return (
      <div className={cn("flex items-center justify-between px-2 py-3", className)}>
        <span className="text-sm text-[var(--muted-foreground)]">
          共 {total} 条
        </span>
      </div>
    )
  }

  const pages: (number | "...")[] = []
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pages.push(i)
  } else {
    pages.push(1)
    if (page > 3) pages.push("...")
    for (let i = Math.max(2, page - 1); i <= Math.min(totalPages - 1, page + 1); i++) {
      pages.push(i)
    }
    if (page < totalPages - 2) pages.push("...")
    pages.push(totalPages)
  }

  return (
    <div className={cn("flex items-center justify-between px-2 py-3", className)}>
      <span className="text-sm text-[var(--muted-foreground)]">
        共 {total} 条
      </span>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          上一页
        </Button>
        {pages.map((p, i) =>
          p === "..." ? (
            <span key={`dots-${i}`} className="px-2 text-sm text-[var(--muted-foreground)]">...</span>
          ) : (
            <Button
              key={p}
              variant={p === page ? "default" : "outline"}
              size="sm"
              onClick={() => onPageChange(p)}
            >
              {p}
            </Button>
          )
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          下一页
        </Button>
        {pageSizeOptions && onPageSizeChange && (
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="ml-2 h-8 rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 text-sm"
          >
            {pageSizeOptions.map((n) => (
              <option key={n} value={n}>{n}条/页</option>
            ))}
          </select>
        )}
      </div>
    </div>
  )
}

export { Pagination }
