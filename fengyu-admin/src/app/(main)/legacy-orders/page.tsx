import { Suspense } from 'react'
import { listLegacyOrders } from '@/actions/legacy-orders'
import { getStores } from '@/actions/stores'
import { getSession } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import LegacyOrdersPageClient from './_components/legacy-orders-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  const matched =
    params.matched === 'matched' || params.matched === 'unmatched' ? params.matched : undefined

  const [{ data: orders, total }, stores, session] = await Promise.all([
    listLegacyOrders({
      phone: params.q,
      storeId: params.store,
      dateFrom: params.from,
      dateTo: params.to,
      matched,
      page: params.page ? Number(params.page) : undefined,
      pageSize: params.size ? Number(params.size) : undefined,
    }),
    getStores(),
    getSession(),
  ])

  const canPull = session ? hasPermission(session, 'legacy_order:pull') : false

  return (
    <Suspense>
      <LegacyOrdersPageClient
        orders={orders}
        total={total}
        stores={stores.map((s) => ({ storeId: s.storeId, storeName: s.storeName }))}
        canPull={canPull}
      />
    </Suspense>
  )
}
