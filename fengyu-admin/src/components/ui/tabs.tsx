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
   * 隐藏用 `hidden` 属性 + `hidden` class 双保险：前者把子树移出可访问性树与 Tab 键序，
   * 后者保证调用方传了 `flex` 之类的 display 工具类时也压得住。
   */
  keepMounted?: boolean
}

function TabsContent({ value, keepMounted = false, className, children, ...props }: TabsContentProps) {
  const { value: activeValue } = useTabsContext()
  const isActive = activeValue === value

  if (!isActive && !keepMounted) return null

  return (
    <div
      role="tabpanel"
      hidden={!isActive}
      className={cn("mt-4 focus-visible:outline-none", !isActive && "hidden", className)}
      {...props}
    >
      {children}
    </div>
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
