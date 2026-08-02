import { Suspense } from 'react'
import { getCustomersPaginated } from '@/actions/customers'
import { parseCustomerFilters } from '@/lib/list-filters'
import { getMarketStoreFilterOptions, getStores } from '@/actions/stores'
import CustomersPageClient from './_components/customers-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  const [{ data: customers, total }, stores, filterOptions] = await Promise.all([
    getCustomersPaginated(parseCustomerFilters(params)),
    getStores(),
    getMarketStoreFilterOptions(),
  ])

  return (
    <Suspense>
      <CustomersPageClient customers={customers} stores={stores} filterOptions={filterOptions} total={total} />
    </Suspense>
  )
}
