import * as React from "react"
import { cn } from "@/lib/utils"

export interface TooltipProps extends React.HTMLAttributes<HTMLDivElement> {
  content: string
  side?: "top" | "bottom" | "left" | "right"
}

function Tooltip({ content, side = "top", className, children, ...props }: TooltipProps) {
  return (
    <div className={cn("group relative inline-flex", className)} {...props}>
      {children}
      <div
        role="tooltip"
        className={cn(
          "pointer-events-none absolute z-50 hidden whitespace-nowrap rounded-[var(--radius)] bg-[var(--foreground)] px-3 py-1.5 text-xs text-[var(--background)] shadow-md group-hover:block",
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
