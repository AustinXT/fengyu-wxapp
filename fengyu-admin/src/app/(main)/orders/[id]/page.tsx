import { notFound } from 'next/navigation'
import { getOrderById } from '@/actions/orders'
import { getOrderAllocations } from '@/actions/allocations'
import OrderDetailPageClient from '../_components/order-detail-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [order, allocations] = await Promise.all([
    getOrderById(id),
    getOrderAllocations(id),
  ])

  if (!order) notFound()

  return <OrderDetailPageClient order={order} allocations={allocations} />
}
