"use client"

import { useState, useRef, useEffect } from "react"
import { cn } from "@/lib/utils"

export interface MultiSelectOption {
  value: string
  label: string
}

interface MultiSelectProps {
  options: MultiSelectOption[]
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  className?: string
  disabled?: boolean
}

export function MultiSelect({
  options,
  value,
  onChange,
  placeholder = "请选择",
  className,
  disabled = false,
}: MultiSelectProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  
  useEffect(() => {
    if (!open) return
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [open])

  
  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("keydown", handleKey)
    return () => document.removeEventListener("keydown", handleKey)
  }, [open])

  const valueSet = new Set(value)
  const selectedLabels = options.filter((o) => valueSet.has(o.value)).map((o) => o.label)
  const count = selectedLabels.length

  let displayText = ""
  if (count === 1) displayText = selectedLabels[0]
  else if (count === 2) displayText = selectedLabels.join("、")
  else if (count >= 3) displayText = `${selectedLabels[0]} 等 ${count} 项`

  function toggle(v: string) {
    if (disabled) return
    onChange(valueSet.has(v) ? value.filter((s) => s !== v) : [...value, v])
  }

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen(!open)}
        className={cn(
          "flex h-10 w-full items-center justify-between rounded-[var(--radius)] border border-[var(--input)] bg-[var(--background)] px-3 text-sm",
          "focus:outline-none focus:ring-2 focus:ring-[var(--ring)] focus:ring-offset-2",
          disabled && "cursor-not-allowed opacity-50",
          !displayText && "text-[var(--muted-foreground)]",
        )}
      >
        <span className="truncate">{displayText || placeholder}</span>
        <span className="flex items-center gap-1 shrink-0 ml-2">
          {count > 0 && !disabled && (
            <span
              role="button"
              tabIndex={-1}
              aria-label="清空"
              className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] cursor-pointer text-xs"
              onClick={(e) => {
                e.stopPropagation()
                onChange([])
              }}
            >
              ✕
            </span>
          )}
          <svg width="12" height="12" viewBox="0 0 12 12" className="text-[var(--muted-foreground)]">
            <path
              d="M3 4.5L6 7.5L9 4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] shadow-md">
          {options.length === 0 ? (
            <div className="px-3 py-2 text-sm text-[var(--muted-foreground)]">暂无数据</div>
          ) : (
            <>
              <div className="max-h-[300px] overflow-y-auto py-1">
                {options.map((o) => {
                  const checked = valueSet.has(o.value)
                  return (
                    <button
                      key={o.value}
                      type="button"
                      onClick={() => toggle(o.value)}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-[var(--accent)]",
                        checked && "text-[#C0322A]",
                      )}
                    >
                      <span
                        className={cn(
                          "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                          checked ? "border-[#C0322A] bg-[#C0322A] text-white" : "border-[var(--input)]",
                        )}
                      >
                        {checked && (
                          <svg width="10" height="10" viewBox="0 0 12 12">
                            <path
                              d="M2.5 6L5 8.5L9.5 3.5"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </span>
                      <span className="truncate">{o.label}</span>
                    </button>
                  )
                })}
              </div>
              {count > 0 && (
                <div className="flex justify-end border-t border-[var(--border)] px-3 py-1.5">
                  <button
                    type="button"
                    onClick={() => onChange([])}
                    className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  >
                    清空
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
