"use client"

import { useState } from "react"
import { Download } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { actionErrorMessage } from "@/lib/action-error"
import { createExportJob } from "@/actions/export-jobs"
import { EXPORT_JOB_CREATED_EVENT, type CreateExportJobInput } from "@/lib/export-job-types"

interface ExportButtonProps {
  /** 兼容旧入口；迁移完成后应优先使用 exportRequest。 */
  onExport?: () => Promise<void>
  /** 创建异步任务。数据查询、XLSX 生成和上传均由 export-worker 完成。 */
  exportRequest?: CreateExportJobInput
  disabled?: boolean
  /** 按钮文案，默认「导出」 */
  label?: string
}

/**
 * 列表导出按钮 — 主题色（品牌红）+ 下载图标 + loading 态。
 * 统一放在筛选/搜索控件之后。失败 toast 提示。
 */
export function ExportButton({ onExport, exportRequest, disabled, label = "导出" }: ExportButtonProps) {
  const [busy, setBusy] = useState(false)

  async function handleClick() {
    if (busy) return
    setBusy(true)
    try {
      if (exportRequest) {
        const result = await createExportJob(exportRequest)
        toast.success(result.reused ? "相同导出任务正在生成" : "已加入导出任务")
        window.dispatchEvent(new Event(EXPORT_JOB_CREATED_EVENT))
      } else if (onExport) {
        await onExport()
      }
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
