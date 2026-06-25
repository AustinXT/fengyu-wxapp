"use client"

import { useState } from "react"
import { Download } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { actionErrorMessage } from "@/lib/action-error"

interface ExportButtonProps {
  /** 执行导出，内部应自行拉取数据并生成 xlsx */
  onExport: () => Promise<void>
  disabled?: boolean
  /** 按钮文案，默认「导出」 */
  label?: string
}

/**
 * 列表导出按钮 — 主题色（品牌红）+ 下载图标 + loading 态。
 * 统一放在筛选/搜索控件之后。失败 toast 提示。
 */
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
