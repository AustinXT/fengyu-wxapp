import { notFound } from 'next/navigation'
import { getServiceOrderById, getServiceItems } from '@/actions/services'
import { getServiceOrderCommissions } from '@/actions/service-commissions'
import { getEmployees, getItemTeachers } from '@/actions/employees'
import { getRates } from '@/actions/commission'
import { getMarketStoreIds } from '@/actions/stores'
import { mergeEmployeesById } from '@/lib/merge-employees'
import ServiceCommissionDetailPageClient from '../../_components/service-commission-detail-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ serviceOrderId: string }> }) {
  const { serviceOrderId } = await params
  const [serviceOrder, items, commissions, scopedEmployees, itemTeachers, commissionRates] = await Promise.all([
    getServiceOrderById(serviceOrderId),
    getServiceItems(serviceOrderId),
    getServiceOrderCommissions(serviceOrderId),
    getEmployees(),
    getItemTeachers(),
    getRates().catch(() => []),
  ])

  if (!serviceOrder) notFound()

  // 品项老师可跨门店分配，合并进 scope 内员工（按 employeeId 去重）
  const employees = mergeEmployeesById(scopedEmployees, itemTeachers)

  const marketStoreIds = await getMarketStoreIds(serviceOrder.storeId)

  return (
    <ServiceCommissionDetailPageClient
      serviceOrder={serviceOrder}
      serviceItems={items}
      commissions={commissions}
      employees={employees}
      commissionRates={commissionRates}
      marketStoreIds={marketStoreIds}
    />
  )
}
