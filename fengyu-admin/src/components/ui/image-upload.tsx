"use client"

import { useState, useRef, useCallback } from "react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"

const CDN_BASE =
  "https://636c-cloud1-3gpht4b01ff88838-1406056527.tcb.qcloud.la"

/**
 * 将 cloud:// 协议的 fileID 转换为 HTTPS CDN URL
 * 标准格式: cloud://envId.bucketSuffix/path → CDN_BASE/path（第一段含 . 则为 envId，跳过）
 * 简化格式: cloud://store-covers/nc02.jpg  → CDN_BASE/store-covers/nc02.jpg（整段都是路径）
 */
function toHttpUrl(url: string): string {
  if (!url || !url.startsWith("cloud://")) return url
  const withoutProtocol = url.slice("cloud://".length)
  const slashIndex = withoutProtocol.indexOf("/")
  if (slashIndex === -1) return url
  const firstSegment = withoutProtocol.slice(0, slashIndex)
  // 标准 fileID 的第一段是 envId.bucketSuffix（含 .），简化格式不含 .
  if (firstSegment.includes(".")) {
    return `${CDN_BASE}/${withoutProtocol.slice(slashIndex + 1)}`
  }
  // 简化格式：整个 withoutProtocol 都是 cloudPath
  return `${CDN_BASE}/${withoutProtocol}`
}

interface ImageUploadProps {
  value: string | string[]
  onChange: (value: string | string[]) => void
  /** Upload path prefix, e.g. "product-covers", "store-images" */
  path?: string
  /** Exact cloud key to overwrite, e.g. "fengyu-client/banner/banner1.jpg" */
  exactKey?: string
  /** Allow multiple images */
  multiple?: boolean
  /** Max number of images (only for multiple) */
  max?: number
  className?: string
}

export function ImageUpload({
  value,
  onChange,
  path,
  exactKey,
  multiple = false,
  max = 9,
  className,
}: ImageUploadProps) {
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const urls: string[] = (multiple
    ? Array.isArray(value) ? value : value ? [value as string] : []
    : value ? [value as string] : []
  ).map(toHttpUrl)

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return

      const filesToUpload = Array.from(files)
      if (multiple && urls.length + filesToUpload.length > max) {
        toast.error(`最多上传 ${max} 张图片`)
        return
      }

      setUploading(true)
      try {
        const newUrls: string[] = []
        for (const file of filesToUpload) {
          const fd = new FormData()
          fd.append("file", file)
          if (exactKey) {
            fd.append("exactKey", exactKey)
          } else if (path) {
            fd.append("path", path)
          }

          const res = await fetch("/api/upload", { method: "POST", body: fd })
          const data = await res.json()
          if (!res.ok) {
            toast.error(data.error || "上传失败")
            continue
          }
          // Append cache-buster for exactKey uploads
          newUrls.push(exactKey ? `${data.url}?t=${Date.now()}` : data.url)
        }

        if (multiple) {
          onChange([...urls, ...newUrls])
        } else {
          if (newUrls.length > 0) onChange(newUrls[0])
        }
      } finally {
        setUploading(false)
        if (inputRef.current) inputRef.current.value = ""
      }
    },
    [urls, onChange, path, exactKey, multiple, max]
  )

  const handleRemove = (index: number) => {
    if (multiple) {
      const next = urls.filter((_, i) => i !== index)
      onChange(next)
    } else {
      onChange("")
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    handleFiles(e.dataTransfer.files)
  }

  const canAdd = multiple ? urls.length < max : urls.length === 0

  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {urls.map((url, i) => (
        <div
          key={`${url}-${i}`}
          className="group relative h-24 w-24 rounded-[var(--radius)] border border-[var(--input)] overflow-hidden"
        >
          <img
            src={url}
            alt=""
            className="h-full w-full object-cover"
          />
          <button
            type="button"
            onClick={() => handleRemove(i)}
            className="absolute top-0.5 right-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity"
          >
            &times;
          </button>
        </div>
      ))}

      {canAdd && (
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          className={cn(
            "flex h-24 w-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-[var(--radius)] border-2 border-dashed border-[var(--input)] text-[var(--muted-foreground)] transition-colors hover:border-[var(--ring)] hover:text-[var(--foreground)]",
            uploading && "pointer-events-none opacity-50"
          )}
        >
          {uploading ? (
            <span className="text-xs">上传中...</span>
          ) : (
            <>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              <span className="text-xs">上传</span>
            </>
          )}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        multiple={multiple}
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
    </div>
  )
}
