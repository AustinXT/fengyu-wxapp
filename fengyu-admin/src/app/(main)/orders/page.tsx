import { Suspense } from 'react'
import { getOrdersPaginated } from '@/actions/orders'
import { getStores } from '@/actions/stores'
import OrdersPageClient from './_components/orders-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  const [{ data: orders, total }, stores] = await Promise.all([
    getOrdersPaginated({
      status: params.status,
      type: params.type,
      storeId: params.store,
      dateFrom: params.from,
      dateTo: params.to,
      search: params.q,
      page: params.page ? Number(params.page) : undefined,
      pageSize: params.size ? Number(params.size) : undefined,
    }),
    getStores(),
  ])

  return (
    <Suspense>
      <OrdersPageClient orders={orders} stores={stores} total={total} />
    </Suspense>
  )
}
