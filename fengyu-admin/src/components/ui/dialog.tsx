"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

export interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
  className?: string
}

function Dialog({ open, onOpenChange, children, className }: DialogProps) {
  const dialogRef = React.useRef<HTMLDialogElement>(null)
  const onOpenChangeRef = React.useRef(onOpenChange)

  React.useEffect(() => {
    onOpenChangeRef.current = onOpenChange
  }, [onOpenChange])

  
  
  
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

  
  
  React.useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    const handleClose = () => onOpenChangeRef.current(false)
    dialog.addEventListener("close", handleClose)
    return () => dialog.removeEventListener("close", handleClose)
  }, [])

  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    
    
    
    
    if (e.target !== e.currentTarget) return
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
        "m-auto w-full max-w-lg rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--card)] p-0 text-[var(--card-foreground)] shadow-lg backdrop:bg-black/50",
        "open:animate-in open:fade-in-0 open:zoom-in-95",
        className,
      )}
      onClick={handleBackdropClick}
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
