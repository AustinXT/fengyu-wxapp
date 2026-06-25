import { Suspense } from "react"
import {
  getMerchantsPaginated,
  getMerchantMarketOptions,
  type MerchantEnabledFilter,
} from "@/actions/merchants"
import { getSession } from "@/lib/auth"
import { hasPermission } from "@/lib/permissions"
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
  const canCreate = !!(session && hasPermission(session, "merchant:create"))

  const [{ data, total }, markets] = await Promise.all([
    getMerchantsPaginated({
      search: params.q,
      enabled: enabled === "enabled" || enabled === "disabled" ? enabled : undefined,
      marketId: params.market,
      page: params.page ? Number(params.page) : undefined,
      pageSize: params.size ? Number(params.size) : undefined,
    }),
    getMerchantMarketOptions(),
  ])

  return (
    <Suspense>
      <MerchantsPageClient
        merchants={data}
        total={total}
        markets={markets}
        canCreate={canCreate}
      />
    </Suspense>
  )
}
