import { Suspense } from 'react'
import { getCustomersPaginated } from '@/actions/customers'
import { parseCustomerFilters } from '@/lib/list-filters'
import { getMarketStoreFilterOptions, getStores } from '@/actions/stores'
import { getSession } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { hasUiCapability } from '@/lib/permission-contract'
import CustomersPageClient from './_components/customers-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  const [{ data: customers, total }, filterOptions, session] = await Promise.all([
    getCustomersPaginated(parseCustomerFilters(params)),
    getMarketStoreFilterOptions(),
    getSession(),
  ])
  const actions = session?.permissions.actions ?? []
  const canCreate = hasUiCapability(actions, 'customer:create')
  const stores = canCreate && !!session && hasPermission(session, 'store:list')
    ? await getStores()
    : []

  return (
    <Suspense>
      <CustomersPageClient
        customers={customers}
        stores={stores}
        filterOptions={filterOptions}
        total={total}
        canCreate={canCreate}
      />
    </Suspense>
  )
}
