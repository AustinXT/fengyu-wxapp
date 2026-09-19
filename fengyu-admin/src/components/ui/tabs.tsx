"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

interface TabsContextValue {
  value: string
  onChange: (value: string) => void
}

const TabsContext = React.createContext<TabsContextValue | null>(null)

function useTabsContext() {
  const ctx = React.useContext(TabsContext)
  if (!ctx) throw new Error("Tabs components must be used within <Tabs>")
  return ctx
}

export interface TabsProps extends React.HTMLAttributes<HTMLDivElement> {
  defaultValue?: string
  value?: string
  onValueChange?: (value: string) => void
}

function Tabs({ defaultValue, value: controlledValue, onValueChange, className, children, ...props }: TabsProps) {
  const [uncontrolledValue, setUncontrolledValue] = React.useState(defaultValue ?? "")

  const isControlled = controlledValue !== undefined
  const value = isControlled ? controlledValue : uncontrolledValue

  const onChange = React.useCallback(
    (v: string) => {
      if (!isControlled) setUncontrolledValue(v)
      onValueChange?.(v)
    },
    [isControlled, onValueChange]
  )

  return (
    <TabsContext.Provider value={{ value, onChange }}>
      <div className={cn("w-full", className)} {...props}>
        {children}
      </div>
    </TabsContext.Provider>
  )
}

function TabsList({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="tablist"
      className={cn(
        "inline-flex items-center gap-1 border-b border-[var(--border)] w-full",
        className
      )}
      {...props}
    />
  )
}

export interface TabsTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string
}

function TabsTrigger({ value, className, children, ...props }: TabsTriggerProps) {
  const { value: activeValue, onChange } = useTabsContext()
  const isActive = activeValue === value

  return (
    <button
      role="tab"
      type="button"
      aria-selected={isActive}
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 -mb-px border-b-2",
        isActive
          ? "border-[var(--primary)] text-[var(--primary)]"
          : "border-transparent text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
        className
      )}
      onClick={() => onChange(value)}
      {...props}
    >
      {children}
    </button>
  )
}

export interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string
  /**
   * 非激活时保留 DOM（隐藏而非卸载），默认 false 维持原行为。
   *
   * 给「面板里装着填了一半的表单」的场景用（#190 办理台）：默认的卸载语义会把
   * 受控表单的 useState 一起清掉，切去看单据再切回来输入就没了。
   *
   * 隐藏的实现分两层，各司其职：
   * - `hidden` 属性：把子树移出可访问性树与 Tab 键序（读屏不会连着念两个面板）
   * - 内联 `display:none`：真正保证不可见。**不能用 `hidden` 工具类**——
   *   `cn()` 走 twMerge，`hidden` 与调用方传进来的 `flex` / `grid` / `block`
   *   属于同一个 display 冲突组，后者会把它直接合并掉，届时两个面板会同时显示，
   *   而 `[hidden]` 的 UA 样式特异性低于任何作者类，也压不住。内联样式则永远赢。
   */
  keepMounted?: boolean
}

function TabsContent({ value, keepMounted = false, className, style, children, ...props }: TabsContentProps) {
  const { value: activeValue } = useTabsContext()
  const isActive = activeValue === value

  if (!isActive && !keepMounted) return null

  return (
    <div
      role="tabpanel"
      hidden={!isActive}
      className={cn("mt-4 focus-visible:outline-none", className)}
      style={isActive ? style : { ...style, display: "none" }}
      {...props}
    >
      {children}
    </div>
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
