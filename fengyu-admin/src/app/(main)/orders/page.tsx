import { Suspense } from 'react'
import { getOrders } from '@/actions/orders'
import { getStores } from '@/actions/stores'
import OrdersPageClient from './_components/orders-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [orders, stores] = await Promise.all([getOrders(), getStores()])
  return (
    <Suspense>
      <OrdersPageClient orders={orders} stores={stores} />
    </Suspense>
  )
}
