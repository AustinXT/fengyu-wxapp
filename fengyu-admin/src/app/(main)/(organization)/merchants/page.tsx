import { Suspense } from "react"
import {
  getMerchantsPaginated,
  getMerchantMarketOptions,
  type MerchantEnabledFilter,
} from "@/actions/merchants"
import { getMarketStoreFilterOptions } from "@/actions/stores"
import { listOnboardingApplications } from "@/actions/lakala-onboarding"
import { getSession } from "@/lib/auth"
import { hasUiCapability } from "@/lib/permission-contract"
import type { OnboardingStatusGroup } from "@/actions/lakala-onboarding"
import MerchantsPageClient from "./_components/merchants-page"

export const dynamic = "force-dynamic"

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const enabled = params.enabled as MerchantEnabledFilter | undefined

  const actions = (await getSession())?.permissions.actions ?? []
  const canCreate = hasUiCapability(actions, "merchant:create")
  const canOnboard = hasUiCapability(actions, "merchant:list")

  const [{ data, total }, markets, filterOptions, onboardingApplications] = await Promise.all([
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
    canOnboard ? listOnboardingApplications({
      search: params.oq,
      marketId: params.omarket,
      storeId: params.ostore,
      status: params.ostatus as OnboardingStatusGroup | undefined,
      page: params.opage ? Number(params.opage) : undefined,
      pageSize: params.osize ? Number(params.osize) : undefined,
    }) : Promise.resolve({ data: [], total: 0, counts: { missing: 0, ready: 0, reviewing: 0, completed: 0 } }),
  ])

  return (
    <Suspense>
      <MerchantsPageClient
        merchants={data}
        total={total}
        markets={markets}
        canCreate={canCreate}
        canOnboard={canOnboard}
        onboardingApplications={onboardingApplications.data}
        onboardingTotal={onboardingApplications.total}
        onboardingCounts={onboardingApplications.counts}
        filterOptions={filterOptions}
      />
    </Suspense>
  )
}
