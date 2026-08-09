"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Check, Download, FileDown, LoaderCircle, RotateCw, TriangleAlert } from "lucide-react"
import { listMyExportJobs, retryMyExportJob } from "@/actions/export-jobs"
import type { ExportJobListItem } from "@/lib/export-job-types"
import { fmtDateTime } from "@/lib/datetime"
import { cn } from "@/lib/utils"

const STATUS_LABEL: Record<ExportJobListItem["status"], string> = {
  queued: "排队中",
  running: "生成中",
  ready: "可下载",
  empty: "无数据",
  failed: "失败",
  expired: "已过期",
}

const STATUS_CLASS: Record<ExportJobListItem["status"], string> = {
  queued: "text-[#D4820A]",
  running: "text-[#5E8BB3]",
  ready: "text-[#3D8A5A]",
  empty: "text-[#888888]",
  failed: "text-[#D94040]",
  expired: "text-[#888888]",
}

export function ExportTasksMenu() {
  const [open, setOpen] = useState(false)
  const [jobs, setJobs] = useState<ExportJobListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [retrying, setRetrying] = useState<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setJobs(await listMyExportJobs())
    } catch {
      // 无导出权限或网络临时失败时保持安静，避免顶栏轮询打断当前工作。
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void refresh()
    const timer = window.setInterval(() => void refresh(), 10_000)
    return () => window.clearInterval(timer)
  }, [open, refresh])

  useEffect(() => {
    const onCreated = () => void refresh()
    window.addEventListener("export-job-created", onCreated)
    return () => window.removeEventListener("export-job-created", onCreated)
  }, [refresh])

  useEffect(() => {
    const closeOnOutside = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener("mousedown", closeOnOutside)
    return () => document.removeEventListener("mousedown", closeOnOutside)
  }, [open])

  const retry = useCallback(async (id: number) => {
    setRetrying(id)
    try {
      await retryMyExportJob(id)
      await refresh()
    } finally {
      setRetrying(null)
    }
  }, [refresh])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="relative flex size-9 items-center justify-center rounded-[var(--radius)] text-[#666666] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
        aria-label="导出任务"
        title="导出任务"
      >
        <FileDown className="size-5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-[360px] overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
            <span className="text-sm font-medium text-[var(--foreground)]">导出任务</span>
            <button
              type="button"
              onClick={() => void refresh()}
              className="flex size-7 items-center justify-center rounded-[var(--radius)] text-[#666666] hover:bg-[var(--muted)]"
              aria-label="刷新导出任务"
              title="刷新"
            >
              <RotateCw className={cn("size-4", loading && "animate-spin")} />
            </button>
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            {jobs.length === 0 && !loading && (
              <div className="px-4 py-8 text-center text-sm text-[var(--muted-foreground)]">暂无导出任务</div>
            )}
            {jobs.map((job) => (
              <div key={job.id} className="flex items-start gap-2 border-b border-[var(--border)] px-3 py-3 last:border-b-0">
                <div className="mt-0.5 shrink-0">
                  {job.status === "ready" ? <Check className="size-4 text-[#3D8A5A]" /> : job.status === "failed" ? <TriangleAlert className="size-4 text-[#D94040]" /> : <LoaderCircle className={cn("size-4 text-[#5E8BB3]", (job.status === "queued" || job.status === "running") && "animate-spin")} />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-[var(--foreground)]">{job.label}</div>
                  <div className="mt-0.5 text-xs text-[var(--muted-foreground)]">{fmtDateTime(job.createdAt)}</div>
                  {job.errorMessage && <div className="mt-1 line-clamp-2 text-xs text-[#D94040]">{job.errorMessage}</div>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <span className={cn("text-xs", STATUS_CLASS[job.status])}>{STATUS_LABEL[job.status]}</span>
                  {job.status === "ready" && (
                    <a
                      href={`/api/exports/${job.id}/download`}
                      className="flex size-7 items-center justify-center rounded-[var(--radius)] text-[#3D8A5A] hover:bg-[#F0F9F2]"
                      title="下载"
                      aria-label={`下载${job.label}`}
                    >
                      <Download className="size-4" />
                    </a>
                  )}
                  {(job.status === "failed" || job.status === "empty" || job.status === "expired") && (
                    <button
                      type="button"
                      onClick={() => void retry(job.id)}
                      disabled={retrying === job.id}
                      className="flex size-7 items-center justify-center rounded-[var(--radius)] text-[#666666] hover:bg-[var(--muted)] disabled:opacity-50"
                      title="重新导出"
                      aria-label={`重新导出${job.label}`}
                    >
                      <RotateCw className={cn("size-4", retrying === job.id && "animate-spin")} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
