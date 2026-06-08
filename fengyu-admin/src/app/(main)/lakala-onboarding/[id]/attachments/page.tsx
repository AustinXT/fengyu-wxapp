/**
 * 拉卡拉商户入网 · 附件管理（plan §4）
 *
 * 拖拽上传 → /api/upload → reuploadToFixedPath → uploadAttachment action（Phase 2D）
 * 权限：lakala:onboarding:update
 *
 * **费率全不可见 plan §0★**
 */
import Link from "next/link"
import { notFound } from "next/navigation"
import { getLakalaMerchant } from "@/actions/lakala-onboarding"
import AttachmentsPanel from "./_panel"

export const dynamic = "force-dynamic"

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const detail = await getLakalaMerchant(id).catch(() => null)
  if (!detail) notFound()

  const m = detail.merchant as { merchantName: string }

  // 把 attachments 投影成 panel 用的最小字段集
  const attachments = detail.attachments.map((a) => ({
    id: a.id as string,
    attachmentType: a.attachmentType as string,
    localUrl: a.localUrl as string,
    attchId: (a.attchId as string | null) ?? null,
    uploadedToLakalaAt: (a.uploadedToLakalaAt as string | null) ?? null,
  }))

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href={`/lakala-onboarding/${id}`} className="text-sm text-[var(--primary)] hover:underline">
          &larr; 返回详情
        </Link>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">附件管理 - {m.merchantName}</h1>
      </div>
      <AttachmentsPanel id={id} attachments={attachments} />
    </div>
  )
}
