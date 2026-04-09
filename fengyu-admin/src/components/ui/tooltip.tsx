import * as React from "react"
import { cn } from "@/lib/utils"

// 使用 Omit 排除 HTMLDivElement 固有的 content 属性（原为 meta content string），
// 使我们的 content 可以接受 ReactNode（含长文案、JSX）
export interface TooltipProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "content"> {
  content: React.ReactNode
  side?: "top" | "bottom" | "left" | "right"
  /** 宽松模式：允许换行，限制最大宽度（用于长文案说明） */
  wide?: boolean
}

function Tooltip({ content, side = "top", wide = false, className, children, ...props }: TooltipProps) {
  return (
    <div className={cn("group relative inline-flex", className)} {...props}>
      {children}
      <div
        role="tooltip"
        className={cn(
          "pointer-events-none absolute z-50 hidden rounded-[var(--radius)] bg-[var(--foreground)] px-3 py-1.5 text-xs text-[var(--background)] shadow-md group-hover:block",
          wide ? "max-w-[320px] whitespace-normal leading-relaxed" : "whitespace-nowrap",
          side === "top" && "bottom-full left-1/2 -translate-x-1/2 mb-2",
          side === "bottom" && "top-full left-1/2 -translate-x-1/2 mt-2",
          side === "left" && "right-full top-1/2 -translate-y-1/2 mr-2",
          side === "right" && "left-full top-1/2 -translate-y-1/2 ml-2"
        )}
      >
        {content}
      </div>
    </div>
  )
}

export { Tooltip }
