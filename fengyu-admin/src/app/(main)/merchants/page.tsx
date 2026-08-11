import { Suspense } from "react"
import {
  getMerchantsPaginated,
  getMerchantMarketOptions,
  type MerchantEnabledFilter,
} from "@/actions/merchants"
import { getMarketStoreFilterOptions } from "@/actions/stores"
import { getSession } from "@/lib/auth"
import { hasUiCapability } from "@/lib/permission-contract"
import MerchantsPageClient from "./_components/merchants-page"

export const dynamic = "force-dynamic"

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const enabled = params.enabled as MerchantEnabledFilter | undefined

  const session = await getSession()
  const canCreate = hasUiCapability(session?.permissions.actions ?? [], "merchant:create")

  const [{ data, total }, markets, filterOptions] = await Promise.all([
    getMerchantsPaginated({
      search: params.q,
      enabled: enabled === "enabled" || enabled === "disabled" ? enabled : undefined,
      marketId: params.market,
      storeId: params.store,
      page: params.page ? Number(params.page) : undefined,
      pageSize: params.size ? Number(params.size) : undefined,
    }),
    getMerchantMarketOptions(),
    getMarketStoreFilterOptions(),
  ])

  return (
    <Suspense>
      <MerchantsPageClient
        merchants={data}
        total={total}
        markets={markets}
        canCreate={canCreate}
        filterOptions={filterOptions}
      />
    </Suspense>
  )
}
