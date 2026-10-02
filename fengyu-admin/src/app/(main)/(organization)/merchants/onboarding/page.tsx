import { notFound } from "next/navigation"
import { listOnboardingApplications } from "@/actions/lakala-onboarding"
import { getSession } from "@/lib/auth"
import { hasPermission } from "@/lib/permissions"
import { OnboardingList } from "./_components/onboarding-page"
import { getMarketStoreFilterOptions } from "@/actions/stores"
import type { OnboardingStatusGroup } from "@/actions/lakala-onboarding"

export const dynamic = "force-dynamic"

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const session = await getSession()
  if (!session || !hasPermission(session, "merchant:list")) notFound()

  const params = await searchParams
  const [applications, filterOptions] = await Promise.all([
    listOnboardingApplications({
      search: params.oq,
      marketId: params.omarket,
      storeId: params.ostore,
      status: params.ostatus as OnboardingStatusGroup | undefined,
      page: params.opage ? Number(params.opage) : undefined,
      pageSize: params.osize ? Number(params.osize) : undefined,
    }),
    getMarketStoreFilterOptions(),
  ])
  return (
    <OnboardingList
      applications={applications.data}
      total={applications.total}
      counts={applications.counts}
      filterOptions={filterOptions}
      canCreate={hasPermission(session, "merchant:create")}
    />
  )
}
