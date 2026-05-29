"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { uploadAttachment, deleteAttachment } from "@/actions/lakala-onboarding"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select } from "@/components/ui/select"
import {
  ATTACHMENT_TYPES,
  ATTACHMENT_TYPE_LABEL,
  REQUIRED_ATTACHMENT_TYPES_FOR_SUBMIT,
} from "@/lib/lakala-dicts"
import { toHttpUrl } from "@/components/ui/image-upload"

interface AttachmentRow {
  id: string
  attachmentType: string
  localUrl: string
  attchId: string | null
  uploadedToLakalaAt: string | null
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const r = reader.result
      if (typeof r === "string") {
        // dataURL 前缀剥离：data:image/png;base64,xxxxx → xxxxx
        const idx = r.indexOf(",")
        resolve(idx >= 0 ? r.slice(idx + 1) : r)
      } else {
        reject(new Error("Read failed"))
      }
    }
    reader.onerror = () => reject(reader.error ?? new Error("Read failed"))
    reader.readAsDataURL(file)
  })
}

export default function AttachmentsPanel({
  id,
  attachments,
}: {
  id: string
  attachments: AttachmentRow[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [pickedType, setPickedType] = useState<string>("FR_ID_CARD_FRONT")
  const fileInput = useRef<HTMLInputElement>(null)

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 5 * 1024 * 1024) {
      toast.error("附件不可超过 5MB（拉卡拉限制）")
      return
    }

    setBusy(true)
    try {
      // 1. /api/upload 上传到 CloudBase 拿临时 URL
      const fd = new FormData()
      fd.append("file", file)
      fd.append("path", `lakala/${id}`)
      const r = await fetch("/api/upload", { method: "POST", body: fd })
      if (!r.ok) {
        toast.error("文件上传失败")
        return
      }
      const { url } = (await r.json()) as { url: string }

      // 2. 把文件本体转 base64（拉卡拉 attContext 需 Base64Utils.encodeToString，非 URL Safe）
      const attContext = await fileToBase64(file)
      const dotIdx = file.name.lastIndexOf(".")
      const attExtName = (dotIdx >= 0 ? file.name.slice(dotIdx + 1) : "jpg").toLowerCase()

      // 3. 调 uploadAttachment（reupload + 调拉卡拉 uploadFile）
      const result = await uploadAttachment(id, {
        attachmentType: pickedType,
        sourceUrl: url,
        attExtName,
        attContext,
        metadata: {
          mimeType: file.type,
          sizeBytes: file.size,
          originalName: file.name,
        },
      })
      if (!result?.success) {
        toast.error("上传失败")
        return
      }
      toast.success(result.attchId ? "已上传到拉卡拉" : "本地保存成功（待重试推送）")
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "上传失败")
    } finally {
      setBusy(false)
      if (fileInput.current) fileInput.current.value = ""
    }
  }

  const handleDelete = async (attachmentId: string) => {
    if (!confirm("确认删除该附件？")) return
    setBusy(true)
    try {
      const result = await deleteAttachment(id, attachmentId)
      if (!result?.success) {
        toast.error("删除失败")
        return
      }
      toast.success("已删除")
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败")
    } finally {
      setBusy(false)
    }
  }

  const uploadedTypes = new Set(attachments.map((a) => a.attachmentType))

  return (
    <div className="space-y-4">
      {/* 必备清单 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">进件必传附件清单</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {REQUIRED_ATTACHMENT_TYPES_FOR_SUBMIT.map((t) => {
              const ok = uploadedTypes.has(t)
              return (
                <div
                  key={t}
                  className={
                    "flex items-center justify-between border rounded px-2 py-1.5 text-xs " +
                    (ok
                      ? "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]"
                      : "border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]")
                  }
                >
                  <span>{ATTACHMENT_TYPE_LABEL[t] ?? t}</span>
                  <span>{ok ? "✓" : "缺"}</span>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* 上传 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">上传新附件</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3 flex-wrap">
            <Select value={pickedType} onChange={(e) => setPickedType(e.target.value)} disabled={busy} className="w-72">
              {ATTACHMENT_TYPES.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.label}
                </option>
              ))}
            </Select>
            <input ref={fileInput} type="file" accept="image/jpeg,image/png,application/pdf" onChange={handleFile} disabled={busy} />
            <span className="text-xs text-[var(--muted-foreground)]">支持 jpg/png/pdf，单文件 5MB 以内</span>
          </div>
        </CardContent>
      </Card>

      {/* 已上传 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">已上传附件（{attachments.length}）</CardTitle>
        </CardHeader>
        <CardContent>
          {attachments.length === 0 ? (
            <div className="text-sm text-[var(--muted-foreground)] py-4 text-center">尚未上传任何附件</div>
          ) : (
            <div className="space-y-2">
              {attachments.map((a) => (
                <div key={a.id} className="flex items-center justify-between border border-[var(--border)] rounded p-3">
                  <div className="flex items-center gap-3">
                    {a.localUrl.match(/\.(jpg|jpeg|png)$/i) ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={toHttpUrl(a.localUrl)} alt={a.attachmentType} className="w-16 h-16 object-cover rounded" />
                    ) : (
                      <div className="w-16 h-16 flex items-center justify-center bg-[var(--muted)] rounded text-xs">PDF</div>
                    )}
                    <div className="text-sm">
                      <div className="font-medium">{ATTACHMENT_TYPE_LABEL[a.attachmentType] ?? a.attachmentType}</div>
                      <div className="text-xs text-[var(--muted-foreground)]">
                        拉卡拉 attch_id：{a.attchId ?? "未推送"} · 推送时间：{a.uploadedToLakalaAt?.slice(0, 19).replace("T", " ") ?? "—"}
                      </div>
                    </div>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => handleDelete(a.id)} disabled={busy}>
                    删除
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
