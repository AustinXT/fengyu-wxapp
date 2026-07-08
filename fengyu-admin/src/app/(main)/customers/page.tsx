import { Suspense } from 'react'
import { getCustomersPaginated } from '@/actions/customers'
import { parseCustomerFilters } from '@/lib/list-filters'
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
    getCustomersPaginated(parseCustomerFilters(params)),
    getStores(),
    getOrgNodes(),
  ])

  return (
    <Suspense>
      <CustomersPageClient customers={customers} stores={stores} orgNodes={orgNodes} total={total} />
    </Suspense>
  )
}
