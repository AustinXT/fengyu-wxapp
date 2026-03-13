import { getOrders } from '@/actions/orders'
import AllocationsPageClient from './_components/allocations-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const orders = await getOrders()
  return <AllocationsPageClient orders={orders} />
}
