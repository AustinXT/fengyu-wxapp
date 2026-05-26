import { Suspense } from 'react'
import { getCustomersPaginated } from '@/actions/customers'
import { getStores } from '@/actions/stores'
import { getOrgNodes } from '@/actions/org'
import CustomersPageClient from './_components/customers-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  const [{ data: customers, total }, stores, orgNodes] = await Promise.all([
    getCustomersPaginated({
      marketId: params.market,
      storeId: params.store,
      memberLevel: params.level,
      customerSource: params.source,
      customerType: params.type,
      spendingTier: params.tier,
      monthlyActivity: params.activity,
      customerStatus: params.status,
      search: params.q,
      page: params.page ? Number(params.page) : undefined,
      pageSize: params.size ? Number(params.size) : undefined,
    }),
    getStores(),
    getOrgNodes(),
  ])

  return (
    <Suspense>
      <CustomersPageClient customers={customers} stores={stores} orgNodes={orgNodes} total={total} />
    </Suspense>
  )
}
