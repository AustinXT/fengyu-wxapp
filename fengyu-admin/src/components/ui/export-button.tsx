"use client"

import { useState } from "react"
import { Download } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { actionErrorMessage } from "@/lib/action-error"

interface ExportButtonProps {
  
  onExport: () => Promise<void>
  disabled?: boolean
  
  label?: string
}


export function ExportButton({ onExport, disabled, label = "导出" }: ExportButtonProps) {
  const [busy, setBusy] = useState(false)

  async function handleClick() {
    if (busy) return
    setBusy(true)
    try {
      await onExport()
    } catch (err) {
      console.error("[export]", err)
      toast.error(actionErrorMessage(err, "导出失败，请稍后重试"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button onClick={handleClick} loading={busy} disabled={disabled}>
      {!busy && <Download className="size-4" />}
      {label}
    </Button>
  )
}
