"use client"

import { useState, useRef, useEffect, useMemo, useCallback } from "react"
import { cn } from "@/lib/utils"
import type { MallCategory } from "@/lib/types"

interface MallCategoryCascaderProps {
  categories: MallCategory[]
  /** Selected sub-category ID */
  value: string
  /** Called with categoryId. Empty string = cleared */
  onChange: (categoryId: string) => void
  placeholder?: string
  className?: string
  disabled?: boolean
  /** Show "全部" options for filter use */
  allowEmpty?: boolean
}

export function MallCategoryCascader({
  categories,
  value,
  onChange,
  placeholder = "请选择商城分类",
  className,
  disabled = false,
  allowEmpty = false,
}: MallCategoryCascaderProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const groups = useMemo(
    () => categories.filter((c) => c.categoryGroup === null).sort((a, b) => a.sortOrder - b.sortOrder),
    [categories],
  )

  const subCats = useMemo(
    () => categories.filter((c) => c.categoryGroup !== null).sort((a, b) => a.sortOrder - b.sortOrder),
    [categories],
  )

  const selectedCategory = useMemo(
    () => subCats.find((c) => c.categoryId === value),
    [subCats, value],
  )

  const [activeGroup, setActiveGroup] = useState<string | null>(
    selectedCategory?.categoryGroup ?? null,
  )

  const filteredSubCats = useMemo(
    () => (activeGroup ? subCats.filter((c) => c.categoryGroup === activeGroup) : []),
    [subCats, activeGroup],
  )

  const displayText = useMemo(() => {
    if (selectedCategory) {
      return `${selectedCategory.categoryGroup} / ${selectedCategory.categoryName}`
    }
    return ""
  }, [selectedCategory])

  // Click outside
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

  // Escape
  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("keydown", handleKey)
    return () => document.removeEventListener("keydown", handleKey)
  }, [open])

  const handleOpen = useCallback(() => {
    if (disabled) return
    const nextOpen = !open
    setOpen(nextOpen)
    if (nextOpen) {
      setActiveGroup(selectedCategory?.categoryGroup ?? groups[0]?.categoryName ?? null)
    }
  }, [disabled, open, selectedCategory, groups])

  const handleSelectCategory = useCallback(
    (categoryId: string) => {
      onChange(categoryId)
      setOpen(false)
    },
    [onChange],
  )

  const handleClear = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onChange("")
    },
    [onChange],
  )

  const handleClearAll = useCallback(() => {
    onChange("")
    setOpen(false)
  }, [onChange])

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={handleOpen}
        className={cn(
          "flex h-10 w-full items-center justify-between rounded-[var(--radius)] border border-[var(--input)] bg-[var(--background)] px-3 text-sm",
          "focus:outline-none focus:ring-1 focus:ring-[var(--ring)]",
          disabled && "cursor-not-allowed opacity-50",
          !displayText && "text-[var(--muted-foreground)]",
        )}
      >
        <span className="truncate">{displayText || placeholder}</span>
        <span className="flex items-center gap-1 shrink-0 ml-2">
          {value && !disabled && (
            <span
              className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] cursor-pointer text-xs"
              onClick={handleClear}
            >
              ✕
            </span>
          )}
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            className="text-[var(--muted-foreground)]"
          >
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
        <div className="absolute z-50 mt-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] shadow-md flex min-w-full">
          {/* Left: groups */}
          <div className="border-r border-[var(--border)] py-1 shrink-0">
            {allowEmpty && (
              <button
                type="button"
                className={cn(
                  "flex w-full items-center px-4 py-2 text-sm hover:bg-[var(--accent)] transition-colors whitespace-nowrap",
                  !value && "text-[#C0322A] font-medium",
                )}
                onClick={handleClearAll}
              >
                全部分类
              </button>
            )}
            {groups.map((group) => {
              const isActive = activeGroup === group.categoryName
              const isGroupSelected = selectedCategory?.categoryGroup === group.categoryName
              return (
                <button
                  key={group.categoryId}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 px-4 py-2 text-sm transition-colors whitespace-nowrap",
                    isActive ? "bg-[var(--accent)]" : "hover:bg-[var(--accent)]",
                    isGroupSelected && "font-medium",
                  )}
                  onMouseEnter={() => setActiveGroup(group.categoryName)}
                >
                  {group.categoryName}
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    className="ml-auto text-[var(--muted-foreground)] shrink-0"
                  >
                    <path
                      d="M4 2L7 5L4 8"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              )
            })}
          </div>

          {/* Right: sub-categories */}
          <div className="min-w-[140px] max-h-[260px] overflow-y-auto py-1">
            {filteredSubCats.length === 0 ? (
              <div className="px-4 py-2 text-sm text-[var(--muted-foreground)]">
                暂无分类
              </div>
            ) : (
              filteredSubCats.map((c) => (
                <button
                  key={c.categoryId}
                  type="button"
                  className={cn(
                    "flex w-full items-center px-4 py-2 text-sm hover:bg-[var(--accent)] transition-colors whitespace-nowrap",
                    value === c.categoryId && "bg-[#FFF0EE] text-[#C0322A] font-medium",
                  )}
                  onClick={() => handleSelectCategory(c.categoryId)}
                >
                  {c.categoryName}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
