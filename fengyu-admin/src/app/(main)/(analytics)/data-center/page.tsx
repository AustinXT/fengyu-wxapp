import { redirect } from "next/navigation"
import { getDataCenterScopeOptions } from "@/actions/data-center/shared"
import { parseTab, parseScope } from "@/lib/data-center/params"
import type { DataCenterScopeOptions } from "@/lib/data-center/types"
import { Card, CardContent } from "@/components/ui/card"
import { DataCenterShell } from "./_components/data-center-shell"
import { SalesBoard } from "./_components/sales/sales-board"
import { CustomerBoard } from "./_components/customer/customer-board"
import { EfficiencyBoard } from "./_components/efficiency/efficiency-board"
import { ProductBoard } from "./_components/product/product-board"

export const dynamic = "force-dynamic"

/**
 * 非总部账号的默认 scope（门店级→唯一门店，市场级→唯一市场）。
 * markets 为空（退化配置，非总部但无可视市场）→ 返回 null，由页面渲染空态。
 */
function resolveDefaultScope(
  scopeOptions: DataCenterScopeOptions,
): { scope: "store" | "market"; scopeId: string } | null {
  const firstMarket = scopeOptions.markets[0]
  if (!firstMarket) return null
  // 门店级账号落到唯一门店（若该市场下有门店详情）
  if (scopeOptions.topLevel === "store") {
    const firstStore = firstMarket.stores[0]
    if (firstStore) return { scope: "store", scopeId: firstStore.storeId }
  }
  // 市场级 / 门店级但无门店详情 → 落到市场
  return { scope: "market", scopeId: firstMarket.id }
}

/**
 * 数据中心入口（Server Component）。
 * - getDataCenterScopeOptions 兼任权限闸门（无 data_center:dashboard → PermissionError → 403）
 * - 按 ?tab= 渲染对应板块（懒加载：仅当前板块组件挂载并自取数）
 * - scope/时间/同比环比 状态由公共筛选器写 URL，板块组件读 URL 取数
 *
 * 默认 scope 解析：非总部账号在 URL 无有效 scope（默认 'all'）时，入口 redirect 到其
 * 可见的最宽 scope。否则 board action 的 validateScope 对「非 admin + scope='all'」会抛
 * PERMISSION_DENIED，生产脱敏后表现为板块内联「数据加载失败」（店长/市场财务曾踩过）。
 * 对齐 staff mgmt-dashboard：非总部绝不以 'all' 取数，入口解析出具体 scope。
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const tab = parseTab(params.tab)
  const scopeOptions = await getDataCenterScopeOptions()

  // 非总部账号 + URL 无有效 scope → 落到默认 scope（redirect 一次，板块挂载时 URL 已具体）
  const rawScope = parseScope({ scope: params.scope, scopeId: params.scopeId })
  const needsDefaultScope = rawScope.type === "all" && scopeOptions.topLevel !== "all"
  let noViewableScope = false
  if (needsDefaultScope) {
    const defaultScope = resolveDefaultScope(scopeOptions)
    if (defaultScope) {
      const next = new URLSearchParams()
      for (const [k, v] of Object.entries(params)) {
        if (v == null || k === "scope" || k === "scopeId") continue
        next.set(k, v)
      }
      next.set("scope", defaultScope.scope)
      next.set("scopeId", defaultScope.scopeId)
      redirect(`/data-center?${next.toString()}`)
    }
    // 无可视市场（退化配置）→ 渲染空态，不挂载板块（避免 validateScope 必然抛错）
    noViewableScope = true
  }

  const board =
    tab === "customer" ? (
      <CustomerBoard />
    ) : tab === "efficiency" ? (
      <EfficiencyBoard />
    ) : tab === "product" ? (
      <ProductBoard />
    ) : (
      <SalesBoard />
    )

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-[var(--foreground)]">数据中心</h1>
      <DataCenterShell scopeOptions={scopeOptions} activeTab={tab}>
        {noViewableScope ? (
          <Card>
            <CardContent className="p-8 text-center text-sm text-[var(--muted-foreground)]">
              当前账号暂无可查看的数据范围
            </CardContent>
          </Card>
        ) : (
          board
        )}
      </DataCenterShell>
    </div>
  )
}
