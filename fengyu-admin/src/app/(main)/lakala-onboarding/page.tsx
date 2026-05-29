/**
 * 拉卡拉商户入网 · 列表页（plan §4）
 *
 * 数据：listLakalaMerchants action（Phase 2D）—— 返回 MerchantListItem[]（前端分页/过滤）
 * 列：商户名 / 状态 Badge / merchant_no / 被几家门店选用 / 申请人 / 创建时间 / legacy 标识
 * 权限：lakala:onboarding:read（withPermission 闸门）
 *
 * **费率全不可见 plan §0★**：本页不渲染任何费率字段
 */
import { listLakalaMerchants, type MerchantListItem } from "@/actions/lakala-onboarding"
import type { LakalaOnboardingStatus } from "@/lib/lakala-onboarding-state"
import LakalaOnboardingListPage from "./_components/list-page"

export const dynamic = "force-dynamic"

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>
}) {
  const sp = await searchParams
  const rawStatus = sp.status ?? ""
  const status = rawStatus
    ? (rawStatus as LakalaOnboardingStatus | "all")
    : undefined
  const keyword = sp.q ?? undefined

  const rows: MerchantListItem[] = await listLakalaMerchants({
    status,
    keyword: keyword || undefined,
  })

  return <LakalaOnboardingListPage rows={rows} initial={{ status: sp.status ?? "", q: keyword ?? "" }} />
}
