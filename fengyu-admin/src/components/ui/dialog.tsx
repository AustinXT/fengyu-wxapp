"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

export interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
  className?: string
  /**
   * 是否允许「点遮罩 / 按 ESC」关闭，默认允许。
   *
   * 置 false 时两条路径都被拦住（ESC 走 `onCancel` 的 preventDefault），
   * 用于提交在途这类「关掉了但事情还在办」会造成误解的时刻 —— 否则只给确认/取消
   * 按钮加 disabled 是拦不住的，遮罩与 ESC 会绕过去。
   */
  dismissible?: boolean
  /**
   * 弹窗的可及名称。原生 `<dialog>` 不会自动把 `DialogTitle` 当成名称，不给的话
   * 读屏只会念一句「对话框」。
   */
  ariaLabel?: string
  /** 弹窗的可及描述（单据号、不可撤销后果等），指向内容里某个元素的 id。 */
  ariaDescribedBy?: string
}

function Dialog({
  open,
  onOpenChange,
  children,
  className,
  dismissible = true,
  ariaLabel,
  ariaDescribedBy,
}: DialogProps) {
  const dialogRef = React.useRef<HTMLDialogElement>(null)
  const onOpenChangeRef = React.useRef(onOpenChange)

  React.useEffect(() => {
    onOpenChangeRef.current = onOpenChange
  }, [onOpenChange])

  // Drive native <dialog> open state from the React prop. useLayoutEffect
  // ensures showModal() runs before paint, avoiding the React 19 concurrent
  // rendering race where the dialog never appears.
  React.useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    if (open) {
      if (!dialog.open) {
        try {
          dialog.showModal()
        } catch (err) {
          if (process.env.NODE_ENV !== "production") {
            console.warn("[Dialog] showModal failed, falling back to .show()", err)
          }
          try {
            dialog.show()
          } catch {
            dialog.setAttribute("open", "")
          }
        }
      }
    } else {
      if (dialog.open) dialog.close()
    }
  }, [open])

  // Bind native "close" event once (use ref for callback to avoid re-attaching
  // on every parent re-render, which previously raced with showModal).
  React.useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    const handleClose = () => onOpenChangeRef.current(false)
    dialog.addEventListener("close", handleClose)
    return () => dialog.removeEventListener("close", handleClose)
  }, [])

  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    // Only treat clicks landing on the <dialog> itself as backdrop clicks —
    // clicks bubbling up from descendants have a different target and should
    // not close the dialog (regression fix: old code would close on inner
    // clicks when the dialog rect hadn't committed yet).
    if (e.target !== e.currentTarget) return
    if (!dismissible) return
    const dialog = dialogRef.current
    if (!dialog) return
    const rect = dialog.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const isInDialog =
      rect.top <= e.clientY &&
      e.clientY <= rect.top + rect.height &&
      rect.left <= e.clientX &&
      e.clientX <= rect.left + rect.width
    if (!isInDialog) {
      onOpenChange(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className={cn(
        "m-auto w-full max-w-lg overflow-visible rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--card)] p-0 text-[var(--card-foreground)] shadow-lg backdrop:bg-black/50",
        "open:animate-in open:fade-in-0 open:zoom-in-95",
        className,
      )}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      onClick={handleBackdropClick}
      // ESC 触发的是 cancel。用 DOM 事件属性而不是 addEventListener + ref：
      // ref 在 passive effect 里更新，点完「确认」立刻按 ESC 时监听可能还读着旧值。
      onCancel={(e) => {
        if (!dismissible) e.preventDefault()
      }}
    >
      <div className="p-6">{children}</div>
    </dialog>
  )
}

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-col space-y-1.5 text-center sm:text-left", className)}
      {...props}
    />
  )
}

function DialogTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn("text-lg font-semibold leading-none tracking-tight", className)}
      {...props}
    />
  )
}

function DialogDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn("text-sm text-[var(--muted-foreground)]", className)}
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 mt-6", className)}
      {...props}
    />
  )
}

function DialogClose({ onOpenChange, children, className, ...props }: { onOpenChange: (open: boolean) => void } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn("absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-[var(--ring)] focus:ring-offset-2", className)}
      onClick={() => onOpenChange(false)}
      {...props}
    >
      {children ?? (
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      )}
      <span className="sr-only">关闭</span>
    </button>
  )
}

export { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose }
