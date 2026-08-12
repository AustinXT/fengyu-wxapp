import { Suspense } from 'react'
import { getOrdersPaginated } from '@/actions/orders'
import { parseOrderFilters } from '@/lib/list-filters'
import { getMarketStoreFilterOptions } from '@/actions/stores'
import { getSession } from '@/lib/auth'
import { hasUiCapability } from '@/lib/permission-contract'
import OrdersPageClient from './_components/orders-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const session = await getSession()
  const actions = session?.permissions.actions ?? []
  const canCreateOrder = hasUiCapability(actions, 'sale_order:create')
  const canUpdate = hasUiCapability(actions, 'sale_order:update')

  const [{ data: orders, total }, filterOptions] = await Promise.all([
    getOrdersPaginated({
      ...parseOrderFilters(params),
      page: params.page ? Number(params.page) : undefined,
      pageSize: params.size ? Number(params.size) : undefined,
    }),
    getMarketStoreFilterOptions(),
  ])

  return (
    <Suspense>
      <OrdersPageClient orders={orders} filterOptions={filterOptions} total={total} canCreateOrder={canCreateOrder} canUpdate={canUpdate} />
    </Suspense>
  )
}
