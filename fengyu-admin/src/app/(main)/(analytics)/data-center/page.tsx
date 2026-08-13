import { redirect } from "next/navigation"
import { getDataCenterScopeOptions } from "@/actions/data-center/shared"
import { parseTab, parseScope } from "@/lib/data-center/params"
import { resolveDefaultDataCenterScope } from "@/lib/data-center/scope-options"
import { Card, CardContent } from "@/components/ui/card"
import { DataCenterShell } from "./_components/data-center-shell"
import { SalesBoard } from "./_components/sales/sales-board"
import { CustomerBoard } from "./_components/customer/customer-board"
import { EfficiencyBoard } from "./_components/efficiency/efficiency-board"
import { ProductBoard } from "./_components/product/product-board"

export const dynamic = "force-dynamic"

/**
 * 数据中心入口（Server Component）。
 * - getDataCenterScopeOptions 兼任权限闸门（无 data_center:dashboard → PermissionError → 403）
 * - 按 ?tab= 渲染对应板块（懒加载：仅当前板块组件挂载并自取数）
 * - scope/时间/同比环比 状态由公共筛选器写 URL，板块组件读 URL 取数
 *
 * 默认 scope 解析：非总部账号在 URL 无有效 scope（默认 'all'）时，单店落到
 * 具体门店，多店落到 authorized 授权汇总。否则 board action 的 validateScope 对「非 admin + scope='all'」会抛
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
  const defaultScope = resolveDefaultDataCenterScope(scopeOptions)
  const noViewableScope = scopeOptions.topLevel !== "all" && defaultScope === null
  if (needsDefaultScope) {
    if (defaultScope) {
      const next = new URLSearchParams()
      for (const [k, v] of Object.entries(params)) {
        if (v == null || k === "scope" || k === "scopeId") continue
        next.set(k, v)
      }
      next.set("scope", defaultScope.type)
      if (defaultScope.type === "market" || defaultScope.type === "store") {
        next.set("scopeId", defaultScope.id)
      }
      redirect(`/data-center?${next.toString()}`)
    }
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
