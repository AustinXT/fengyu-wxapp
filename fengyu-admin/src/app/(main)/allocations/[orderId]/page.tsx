import { notFound } from 'next/navigation'
import { getOrderById } from '@/actions/orders'
import { getOrderAllocations } from '@/actions/allocations'
import { getEmployees } from '@/actions/employees'
import AllocationDetailPageClient from '../_components/allocation-detail-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params
  const [order, allocations, employees] = await Promise.all([
    getOrderById(orderId),
    getOrderAllocations(orderId),
    getEmployees(),
  ])

  if (!order) notFound()

  return (
    <AllocationDetailPageClient
      order={order}
      allocations={allocations}
      employees={employees}
    />
  )
}
