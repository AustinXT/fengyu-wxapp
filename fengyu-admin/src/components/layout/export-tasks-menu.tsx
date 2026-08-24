"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Check, Download, FileDown, LoaderCircle, RotateCw, TriangleAlert } from "lucide-react"
import { listMyExportJobs, retryMyExportJob } from "@/actions/export-jobs"
import { EXPORT_JOB_CREATED_EVENT, type ExportJobListItem } from "@/lib/export-job-types"
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

const COMPLETED_AT_STORAGE_KEY_PREFIX = "fengyu-admin:export-tasks:last-seen-ready-at:"

function latestReadyCompletedAt(jobs: ExportJobListItem[]): number {
  return jobs.reduce((latest, job) => {
    if (job.status !== "ready" || !job.completedAt) return latest
    const completedAt = Date.parse(job.completedAt)
    return Number.isFinite(completedAt) ? Math.max(latest, completedAt) : latest
  }, 0)
}

function readLastSeenReadyAt(storageKey: string): number {
  try {
    const storedValue = Number(window.localStorage.getItem(storageKey))
    return Number.isFinite(storedValue) && storedValue > 0 ? storedValue : 0
  } catch {
    return 0
  }
}

function persistLastSeenReadyAt(storageKey: string, timestamp: number): void {
  try {
    window.localStorage.setItem(storageKey, String(timestamp))
  } catch {
    // 浏览器禁用本地存储时，本次页面会话仍可用 ref 保留已查看状态。
  }
}

interface ExportTasksMenuProps {
  employeeId: string
}

export function ExportTasksMenu({ employeeId }: ExportTasksMenuProps) {
  const [open, setOpen] = useState(false)
  const [jobs, setJobs] = useState<ExportJobListItem[]>([])
  const [hasUnreadReady, setHasUnreadReady] = useState(false)
  const [loading, setLoading] = useState(false)
  const [retrying, setRetrying] = useState<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const lastSeenReadyAtRef = useRef<number | null>(null)
  const lastSeenEmployeeIdRef = useRef<string | null>(null)
  const completedAtStorageKey = `${COMPLETED_AT_STORAGE_KEY_PREFIX}${employeeId}`

  const refresh = useCallback(async ({ markReadyAsSeen = false }: { markReadyAsSeen?: boolean } = {}) => {
    setLoading(true)
    try {
      const nextJobs = await listMyExportJobs()
      setJobs(nextJobs)

      const latestCompletedAt = latestReadyCompletedAt(nextJobs)
      if (markReadyAsSeen) {
        const lastSeenReadyAt = Math.max(lastSeenReadyAtRef.current ?? 0, latestCompletedAt)
        lastSeenReadyAtRef.current = lastSeenReadyAt
        persistLastSeenReadyAt(completedAtStorageKey, lastSeenReadyAt)
        setHasUnreadReady(false)
      } else if (lastSeenReadyAtRef.current !== null) {
        setHasUnreadReady(latestCompletedAt > lastSeenReadyAtRef.current)
      }
    } catch {
      // 无导出权限或网络临时失败时保持安静，避免顶栏轮询打断当前工作。
    } finally {
      setLoading(false)
    }
  }, [completedAtStorageKey])

  useEffect(() => {
    if (lastSeenEmployeeIdRef.current !== employeeId) {
      lastSeenEmployeeIdRef.current = employeeId
      lastSeenReadyAtRef.current = readLastSeenReadyAt(completedAtStorageKey)
    }

    void refresh({ markReadyAsSeen: open })
    const timer = window.setInterval(() => void refresh({ markReadyAsSeen: open }), 10_000)
    return () => window.clearInterval(timer)
  }, [completedAtStorageKey, open, refresh])

  useEffect(() => {
    const onCreated = () => void refresh()
    window.addEventListener(EXPORT_JOB_CREATED_EVENT, onCreated)
    return () => window.removeEventListener(EXPORT_JOB_CREATED_EVENT, onCreated)
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
      await refresh({ markReadyAsSeen: open })
    } finally {
      setRetrying(null)
    }
  }, [open, refresh])

  const toggleMenu = () => {
    const nextOpen = !open
    setOpen(nextOpen)
    if (nextOpen) setHasUnreadReady(false)
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={toggleMenu}
        className="relative flex size-9 items-center justify-center rounded-[var(--radius)] text-[#666666] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
        aria-label={hasUnreadReady ? "导出任务，有新的已完成任务" : "导出任务"}
        title="导出任务"
      >
        <FileDown className="size-5" />
        {hasUnreadReady && (
          <span
            data-testid="export-tasks-unread-indicator"
            className="absolute right-1 top-1 size-2 rounded-full bg-[#C0322A] ring-2 ring-white"
            aria-hidden="true"
          />
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-[360px] overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
            <span className="text-sm font-medium text-[var(--foreground)]">导出任务</span>
            <button
              type="button"
              onClick={() => void refresh({ markReadyAsSeen: true })}
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
