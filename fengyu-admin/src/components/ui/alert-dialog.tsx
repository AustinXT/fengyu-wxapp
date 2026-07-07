"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

export interface AlertDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}

function AlertDialog({ open, onOpenChange, children }: AlertDialogProps) {
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
            console.warn("[AlertDialog] showModal failed, falling back to .show()", err)
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
    const dialog = dialogRef.current
    if (!dialog) return
    
    
    if (e.target !== dialog) return
    const rect = dialog.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const isInDialog =
      rect.top <= e.clientY &&
      e.clientY <= rect.top + rect.height &&
      rect.left <= e.clientX &&
      e.clientX <= rect.left + rect.width
    if (!isInDialog) {
      
      
      e.stopPropagation()
    }
  }

  
  const handleCancel = (e: React.SyntheticEvent) => {
    e.preventDefault()
  }

  return (
    <dialog
      ref={dialogRef}
      className={cn(
        "m-auto w-full max-w-md rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--card)] p-0 text-[var(--card-foreground)] shadow-lg backdrop:bg-black/50",
        "open:animate-in open:fade-in-0 open:zoom-in-95"
      )}
      onClick={handleBackdropClick}
      onCancel={handleCancel}
    >
      <div className="p-6">{children}</div>
    </dialog>
  )
}

function AlertDialogTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn("text-lg font-semibold leading-none tracking-tight", className)}
      {...props}
    />
  )
}

function AlertDialogDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn("mt-2 text-sm text-[var(--muted-foreground)]", className)}
      {...props}
    />
  )
}

function AlertDialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 mt-6", className)}
      {...props}
    />
  )
}

function AlertDialogCancel({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center justify-center rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-4 py-2 text-sm font-medium hover:bg-[var(--accent)] hover:text-[var(--accent-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 transition-colors",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogAction({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center justify-center rounded-[var(--radius)] bg-[var(--destructive)] text-[var(--destructive-foreground)] px-4 py-2 text-sm font-medium hover:bg-[var(--destructive)]/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 transition-colors",
        className
      )}
      {...props}
    />
  )
}

export {
  AlertDialog,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
}
