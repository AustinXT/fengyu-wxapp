"use client"

import { useEffect, useRef, useState } from "react"
import { Check, ChevronDown, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { CascadeOption } from "@/lib/cascade-tree"

interface FilterCascaderProps {
  options: CascadeOption[]
  level1Value?: string
  level2Value?: string
  level1Name: string
  level2Name: string
  placeholder?: string
  level1AllLabel?: string
  level2AllLabel?: string
  /** 提交时若一/二级发生变化，额外清空的同级表单字段 name（如品项变化清空「系列/商品」） */
  extraResetFields?: string[]
  className?: string
}

/**
 * 两级筛选级联选择器。一个触发框 + 左右两列弹层：
 * 左列点具体一级只刷新右列（不提交），点「全部一级」/右列项/✕ 才提交。
 * 提交通过写两个 hidden input 的 DOM value 再 form.requestSubmit()——
 * 编程式改 value 不触发 change，故不会惊动外层 AutoSubmitFilterForm，两者并存。
 */
export function FilterCascader({
  options,
  level1Value = "",
  level2Value = "",
  level1Name,
  level2Name,
  placeholder = "全部",
  level1AllLabel = "全部一级",
  level2AllLabel = "全部二级",
  extraResetFields,
  className,
}: FilterCascaderProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const level1Ref = useRef<HTMLInputElement>(null)
  const level2Ref = useRef<HTMLInputElement>(null)

  const [open, setOpen] = useState(false)
  // 面板内活跃一级（决定右列内容），≠ 已提交的 level1Value
  const [activeLevel1, setActiveLevel1] = useState(level1Value)

  // GET 提交后 RSC 是 re-render 非 remount，需把面板活跃一级同步到最新已提交值
  useEffect(() => {
    setActiveLevel1(level1Value)
  }, [level1Value])

  // 点外部关闭
  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("pointerdown", handlePointerDown)
    return () => document.removeEventListener("pointerdown", handlePointerDown)
  }, [open])

  // Esc 关闭（不提交）
  useEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("keydown", handleKey)
    return () => document.removeEventListener("keydown", handleKey)
  }, [open])

  const activeChildren = options.find((opt) => opt.value === activeLevel1)?.children ?? []
  const hasActiveLevel1 = Boolean(activeLevel1)

  const commit = (next1: string, next2: string) => {
    const form = level1Ref.current?.form
    if (level1Ref.current) level1Ref.current.value = next1
    if (level2Ref.current) level2Ref.current.value = next2
    // 一/二级确实变化时，清空关联下级字段（与原 select 的 data-reset-fields 等价）
    if (form && extraResetFields?.length && (next1 !== level1Value || next2 !== level2Value)) {
      for (const field of extraResetFields) {
        const control = form.elements.namedItem(field)
        if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) {
          control.value = ""
        }
      }
    }
    setOpen(false)
    form?.requestSubmit()
  }

  const toggle = () => {
    if (open) {
      setOpen(false)
    } else {
      setActiveLevel1(level1Value) // 每次打开回到当前已提交一级
      setOpen(true)
    }
  }

  const display = !level1Value
    ? placeholder
    : level2Value
      ? `${level1Value} / ${level2Value}`
      : `${level1Value} / ${level2AllLabel}`

  const showClear = Boolean(level1Value || level2Value)
  const level1Committed = activeLevel1 === level1Value

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <input type="hidden" name={level1Name} ref={level1Ref} defaultValue={level1Value} />
      <input type="hidden" name={level2Name} ref={level2Ref} defaultValue={level2Value} />

      <button
        type="button"
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-10 w-full items-center justify-between gap-2 rounded-md border border-[var(--input)] bg-white px-3 text-sm outline-none transition-colors hover:border-[var(--ring)] focus:border-[var(--ring)]"
      >
        <span className={cn("truncate text-left", !level1Value && "text-neutral-400")}>{display}</span>
        <span className="flex shrink-0 items-center gap-1 text-neutral-400">
          {showClear ? (
            <X
              className="size-3.5 hover:text-neutral-700"
              onClick={(event) => {
                event.stopPropagation()
                commit("", "")
              }}
              role="button"
              aria-label="清除筛选"
            />
          ) : null}
          <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
        </span>
      </button>

      {open ? (
        <div
          className="absolute left-0 z-50 mt-1 flex max-h-80 min-w-[20rem] gap-2 rounded-md border border-[var(--border)] bg-white p-2 shadow-lg"
          role="listbox"
        >
          {/* 左列：一级。点具体一级仅刷新右列，点「全部一级」直接提交（清除筛选） */}
          <div className="flex-1 space-y-0.5 overflow-y-auto">
            <CascaderItem
              label={level1AllLabel}
              selected={activeLevel1 === ""}
              onClick={() => commit("", "")}
            />
            {options.map((opt) => (
              <CascaderItem
                key={opt.value}
                label={opt.label}
                selected={activeLevel1 === opt.value}
                onClick={() => setActiveLevel1(opt.value)}
              />
            ))}
          </div>

          {/* 右列：二级。随活跃一级即时刷新，选中任一项（含「全部二级」）即提交 */}
          <div className="flex-1 space-y-0.5 overflow-y-auto border-l border-[var(--border)] pl-2">
            <CascaderItem
              label={hasActiveLevel1 ? level2AllLabel : "请先选一级"}
              disabled={!hasActiveLevel1}
              selected={hasActiveLevel1 && level1Committed && !level2Value}
              onClick={() => hasActiveLevel1 && commit(activeLevel1, "")}
            />
            {hasActiveLevel1
              ? activeChildren.map((child) => (
                  <CascaderItem
                    key={child.value}
                    label={child.label}
                    selected={level1Committed && level2Value === child.value}
                    onClick={() => commit(activeLevel1, child.value)}
                  />
                ))
              : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function CascaderItem({
  label,
  selected,
  disabled,
  onClick,
}: {
  label: string
  selected?: boolean
  disabled?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-8 w-full items-center justify-between gap-2 rounded px-2 text-left text-sm",
        disabled
          ? "cursor-not-allowed text-neutral-300"
          : selected
            ? "bg-[var(--accent)] text-[var(--accent-foreground)]"
            : "text-neutral-700 hover:bg-neutral-50",
      )}
    >
      <span className="truncate">{label}</span>
      {selected && !disabled ? <Check className="size-3.5 shrink-0" /> : null}
    </button>
  )
}
