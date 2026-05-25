import { notFound } from 'next/navigation'
import { getOrderById } from '@/actions/orders'
import { getOrderAllocations } from '@/actions/allocations'
import { getEmployees, getItemTeachers } from '@/actions/employees'
import { getRates } from '@/actions/commission'
import { getMarketStoreIds } from '@/actions/stores'
import { mergeEmployeesById } from '@/lib/merge-employees'
import AllocationDetailPageClient from '../_components/allocation-detail-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params
  const [order, allocations, scopedEmployees, itemTeachers, commissionRates] = await Promise.all([
    getOrderById(orderId),
    getOrderAllocations(orderId),
    getEmployees(),
    getItemTeachers(),
    getRates().catch(() => []),
  ])

  if (!order) notFound()

  // 品项老师可跨门店分配，合并进 scope 内员工（按 employeeId 去重）
  const employees = mergeEmployeesById(scopedEmployees, itemTeachers)

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
