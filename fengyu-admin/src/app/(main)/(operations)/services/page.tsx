import { Suspense } from 'react'
import { getServiceOrdersPaginated } from '@/actions/services'
import { parseServiceOrderFilters } from '@/lib/list-filters'
import { getMarketStoreFilterOptions } from '@/actions/stores'
import { getSession } from '@/lib/auth'
import { hasUiCapability } from '@/lib/permission-contract'
import ServicesPageClient from './_components/services-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  const [{ data: serviceOrders, total }, filterOptions, session] = await Promise.all([
    getServiceOrdersPaginated({
      ...parseServiceOrderFilters(params),
      page: params.page ? Number(params.page) : undefined,
      pageSize: params.size ? Number(params.size) : undefined,
    }),
    getMarketStoreFilterOptions(),
    getSession(),
  ])

  const actions = session?.permissions.actions ?? []
  const canCreate = hasUiCapability(actions, 'service:create')
  const canUpdate = hasUiCapability(actions, 'service:update')

  return (
    <Suspense>
      <ServicesPageClient
        serviceOrders={serviceOrders}
        filterOptions={filterOptions}
        total={total}
        canCreate={canCreate}
        canUpdate={canUpdate}
      />
    </Suspense>
  )
}
