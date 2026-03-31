import { notFound } from 'next/navigation'
import { getServiceOrderById, getServiceItems } from '@/actions/services'
import { getServiceOrderCommissions } from '@/actions/service-commissions'
import { getEmployees } from '@/actions/employees'
import { getRates } from '@/actions/commission'
import { getMarketStoreIds } from '@/actions/stores'
import ServiceCommissionDetailPageClient from '../../_components/service-commission-detail-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ serviceOrderId: string }> }) {
  const { serviceOrderId } = await params
  const [serviceOrder, items, commissions, employees, commissionRates] = await Promise.all([
    getServiceOrderById(serviceOrderId),
    getServiceItems(serviceOrderId),
    getServiceOrderCommissions(serviceOrderId),
    getEmployees(),
    getRates().catch(() => []),
  ])

  if (!serviceOrder) notFound()

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
