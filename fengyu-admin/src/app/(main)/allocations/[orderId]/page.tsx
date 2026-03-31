import { notFound } from 'next/navigation'
import { getOrderById } from '@/actions/orders'
import { getOrderAllocations } from '@/actions/allocations'
import { getEmployees } from '@/actions/employees'
import { getRates } from '@/actions/commission'
import { getMarketStoreIds } from '@/actions/stores'
import AllocationDetailPageClient from '../_components/allocation-detail-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params
  const [order, allocations, employees, commissionRates] = await Promise.all([
    getOrderById(orderId),
    getOrderAllocations(orderId),
    getEmployees(),
    getRates().catch(() => []),
  ])

  if (!order) notFound()

  // 获取订单所在市场的所有门店 ID（养生师/推广师可跨门店选人）
  const marketStoreIds = await getMarketStoreIds(order.storeId)

  return (
    <AllocationDetailPageClient
      order={order}
      allocations={allocations}
      employees={employees}
      commissionRates={commissionRates}
      marketStoreIds={marketStoreIds}
    />
  )
}
