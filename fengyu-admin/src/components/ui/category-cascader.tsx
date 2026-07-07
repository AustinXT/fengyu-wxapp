"use client"

import { useState, useRef, useEffect, useMemo, useCallback } from "react"
import { cn } from "@/lib/utils"
import type { ProductCategory } from "@/lib/types"

const KIND_PALETTE = [
  "bg-[#FFF8E6] text-[#D4820A]",
  "bg-[#F0F5FA] text-[#5E8BB3]",
  "bg-[#F0F9F2] text-[#3D8A5A]",
  "bg-[#F5F5F5] text-[#888888]",
  "bg-[#FFF0EE] text-[#C0322A]",
  "bg-[#F5F0FF] text-[#8B5CF6]",
  "bg-[#FFF0F5] text-[#EC4899]",
  "bg-[#F0FAFA] text-[#0E7490]",
]

interface CategoryCascaderProps {
  categories: ProductCategory[]
  
  value: string
  
  onChange: (categoryId: string, productKind: string) => void
  placeholder?: string
  className?: string
  
  name?: string
  disabled?: boolean
  
  allowEmpty?: boolean
  
  kindValue?: string
  
  productKinds?: ProductCategory[]
}

export function CategoryCascader({
  categories,
  value,
  onChange,
  placeholder = "请选择品项分类",
  className,
  name,
  disabled = false,
  allowEmpty = false,
  kindValue = "",
  productKinds,
}: CategoryCascaderProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  
  const kindList = useMemo(() => {
    if (productKinds) {
      return productKinds.filter(k => k.isValid).sort((a, b) => a.sortOrder - b.sortOrder).map(k => k.categoryName)
    }
    const seen = new Set<string>()
    const result: string[] = []
    for (const c of categories) {
      if (c.productKind && !seen.has(c.productKind)) {
        seen.add(c.productKind)
        result.push(c.productKind)
      }
    }
    return result
  }, [productKinds, categories])

  
  const kindColors = useMemo(() => {
    const map: Record<string, string> = {}
    kindList.forEach((k, i) => {
      map[k] = KIND_PALETTE[i % KIND_PALETTE.length]
    })
    return map
  }, [kindList])

  const selectedCategory = useMemo(
    () => categories.find((c) => c.categoryId === value),
    [categories, value],
  )

  const [activeKind, setActiveKind] = useState<string | null>(
    selectedCategory?.productKind ?? null,
  )

  const filteredCategories = useMemo(
    () => (activeKind ? categories.filter((c) => c.productKind === activeKind && c.isValid) : []),
    [categories, activeKind],
  )

  
  const displayText = useMemo(() => {
    if (selectedCategory) {
      return `${selectedCategory.productKind} / ${selectedCategory.categoryName}`
    }
    if (allowEmpty && kindValue) {
      return kindValue
    }
    return ""
  }, [selectedCategory, allowEmpty, kindValue])

  
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

  const handleOpen = useCallback(() => {
    if (disabled) return
    const nextOpen = !open
    setOpen(nextOpen)
    if (nextOpen) {
      setActiveKind(
        selectedCategory?.productKind ??
          (kindValue || kindList[0] || null),
      )
    }
  }, [disabled, open, selectedCategory, kindValue, kindList])

  const handleSelectCategory = useCallback(
    (categoryId: string, kind: string) => {
      onChange(categoryId, kind)
      setOpen(false)
    },
    [onChange],
  )

  const handleSelectKindOnly = useCallback(
    (kind: string) => {
      onChange("", kind)
      setOpen(false)
    },
    [onChange],
  )

  const handleClearAll = useCallback(() => {
    onChange("", "")
    setOpen(false)
  }, [onChange])

  const handleClear = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onChange("", "")
    },
    [onChange],
  )

  const hasValue = !!value || (allowEmpty && !!kindValue)

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      {name && <input type="hidden" name={name} value={value} />}
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
          {hasValue && !disabled && (
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
          {}
          <div className="border-r border-[var(--border)] py-1 shrink-0">
            {allowEmpty && (
              <button
                type="button"
                className={cn(
                  "flex w-full items-center px-4 py-2 text-sm hover:bg-[var(--accent)] transition-colors whitespace-nowrap",
                  !kindValue && !value && "text-[#C0322A] font-medium",
                )}
                onClick={handleClearAll}
              >
                全部类型
              </button>
            )}
            {kindList.map((kind) => {
              const isActive = activeKind === kind
              const isKindSelected =
                selectedCategory?.productKind === kind ||
                (!value && kindValue === kind)
              return (
                <button
                  key={kind}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 px-4 py-2 text-sm transition-colors whitespace-nowrap",
                    isActive
                      ? "bg-[var(--accent)]"
                      : "hover:bg-[var(--accent)]",
                    isKindSelected && "font-medium",
                  )}
                  onMouseEnter={() => setActiveKind(kind)}
                >
                  <span
                    className={cn(
                      "inline-block w-2 h-2 rounded-full shrink-0",
                      kindColors[kind] ?? KIND_PALETTE[0],
                    )}
                  />
                  {kind}
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

          {}
          <div className="min-w-[140px] max-h-[260px] overflow-y-auto py-1">
            {allowEmpty && activeKind && (
              <button
                type="button"
                className={cn(
                  "flex w-full items-center px-4 py-2 text-sm hover:bg-[var(--accent)] transition-colors whitespace-nowrap",
                  !value && kindValue === activeKind && "text-[#C0322A] font-medium",
                )}
                onClick={() => handleSelectKindOnly(activeKind)}
              >
                全部品项
              </button>
            )}
            {filteredCategories.length === 0 ? (
              !allowEmpty && (
                <div className="px-4 py-2 text-sm text-[var(--muted-foreground)]">
                  暂无分类
                </div>
              )
            ) : (
              filteredCategories.map((c) => (
                <button
                  key={c.categoryId}
                  type="button"
                  className={cn(
                    "flex w-full items-center px-4 py-2 text-sm hover:bg-[var(--accent)] transition-colors whitespace-nowrap",
                    value === c.categoryId &&
                      "bg-[#FFF0EE] text-[#C0322A] font-medium",
                  )}
                  onClick={() =>
                    handleSelectCategory(c.categoryId, c.productKind!)
                  }
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
