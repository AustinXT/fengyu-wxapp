import { Suspense } from "react"
import { getMerchantsPaginated, type MerchantEnabledFilter } from "@/actions/merchants"
import MerchantsPageClient from "./_components/merchants-page"

export const dynamic = "force-dynamic"

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const enabled = params.enabled as MerchantEnabledFilter | undefined

  const { data, total } = await getMerchantsPaginated({
    search: params.q,
    enabled: enabled === "enabled" || enabled === "disabled" ? enabled : undefined,
    page: params.page ? Number(params.page) : undefined,
    pageSize: params.size ? Number(params.size) : undefined,
  })

  return (
    <Suspense>
      <MerchantsPageClient merchants={data} total={total} />
    </Suspense>
  )
}
