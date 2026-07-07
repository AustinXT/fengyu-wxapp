import { getDataCenterScopeOptions } from "@/actions/data-center/shared"
import { parseTab } from "@/lib/data-center/params"
import { DataCenterShell } from "./_components/data-center-shell"
import { SalesBoard } from "./_components/sales/sales-board"
import { CustomerBoard } from "./_components/customer/customer-board"
import { EfficiencyBoard } from "./_components/efficiency/efficiency-board"
import { ProductBoard } from "./_components/product/product-board"

export const dynamic = "force-dynamic"


export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const tab = parseTab(params.tab)
  const scopeOptions = await getDataCenterScopeOptions()

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
        {board}
      </DataCenterShell>
    </div>
  )
}
