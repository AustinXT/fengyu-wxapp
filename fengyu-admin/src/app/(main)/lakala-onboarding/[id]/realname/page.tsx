/**
 * 拉卡拉商户入网 · 实名报备子页（plan §4）
 *
 * 微信 + 支付宝双 tab；扫码 url 渲染 QR + 每 5s router.refresh() 重新拉取状态（推动 cron 兜底数据落库）。
 * 完成提示"法人扫码授权完成"。
 * 权限：lakala:onboarding:realname
 *
 * **费率全不可见 plan §0★**
 */
import Link from "next/link"
import { notFound } from "next/navigation"
import { getLakalaMerchant } from "@/actions/lakala-onboarding"
import RealnamePanel from "./_panel"

export const dynamic = "force-dynamic"

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const detail = await getLakalaMerchant(id).catch(() => null)
  if (!detail) notFound()
  const m = detail.merchant as {
    merchantName: string
    wxRealnameStatus: string
    wxRealnameQrcodeUrl: string | null
    wxSubMchid: string | null
    alipayRealnameStatus: string
    alipayRealnameQrcodeUrl: string | null
    alipaySubMchid: string | null
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href={`/lakala-onboarding/${id}`} className="text-sm text-[var(--primary)] hover:underline">
          &larr; 返回详情
        </Link>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">实名报备 - {m.merchantName}</h1>
      </div>
      <RealnamePanel id={id} merchant={m} />
    </div>
  )
}
