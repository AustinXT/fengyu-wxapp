/**
 * 拉卡拉商户入网 · 编辑页（plan §4，6 分组表单）
 *
 * 分组：基本 / 法人 / 经营 / 结算 / 附件 / 实名报备（不含费率分组 — plan §0★）
 * 守护测试：lakala-no-rate-leak.test.ts 静态扫描禁字
 *
 * 权限：lakala:onboarding:update（action 内 withPermission）
 * draft 态可改；其他态由 action 内 nextState 判定是否允许编辑
 */
import Link from "next/link"
import { notFound } from "next/navigation"
import { getLakalaMerchant } from "@/actions/lakala-onboarding"
import LakalaEditForm from "./_form"

export const dynamic = "force-dynamic"

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const detail = await getLakalaMerchant(id).catch(() => null)
  if (!detail) notFound()

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href={`/lakala-onboarding/${id}`} className="text-sm text-[var(--primary)] hover:underline">
          &larr; 返回详情
        </Link>
      </div>
      <LakalaEditForm id={id} merchant={detail.merchant as Record<string, unknown>} />
    </div>
  )
}
