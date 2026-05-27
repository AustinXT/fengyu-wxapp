import { Suspense } from 'react'
import { getServiceOrdersPaginated } from '@/actions/services'
import { parseServiceOrderFilters } from '@/lib/list-filters'
import { getStores } from '@/actions/stores'
import ServicesPageClient from './_components/services-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  const [{ data: serviceOrders, total }, stores] = await Promise.all([
    getServiceOrdersPaginated({
      ...parseServiceOrderFilters(params),
      page: params.page ? Number(params.page) : undefined,
      pageSize: params.size ? Number(params.size) : undefined,
    }),
    getStores(),
  ])

  return (
    <Suspense>
      <ServicesPageClient serviceOrders={serviceOrders} stores={stores} total={total} />
    </Suspense>
  )
}
