import { notFound } from 'next/navigation'
import { getServiceOrderById, getServiceItems } from '@/actions/services'
import { getServiceOrderCommissions } from '@/actions/service-commissions'
import { getEmployees, getEmployeesOnBusinessTrip } from '@/actions/employees'
import { getRates } from '@/actions/commission'
import { mergeEmployeesById } from '@/lib/merge-employees'
import ServiceCommissionDetailPageClient from '../../_components/service-commission-detail-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ serviceOrderId: string }> }) {
  const { serviceOrderId } = await params
  const [serviceOrder, items, commissions, scopedEmployees, tripEmployees, commissionRates] = await Promise.all([
    getServiceOrderById(serviceOrderId),
    getServiceItems(serviceOrderId),
    getServiceOrderCommissions(serviceOrderId),
    getEmployees(),
    getEmployeesOnBusinessTrip(),
    getRates().catch(() => []),
  ])

  if (!serviceOrder) notFound()

  
  
  const employees = mergeEmployeesById(scopedEmployees, tripEmployees)

  return (
    <ServiceCommissionDetailPageClient
      serviceOrder={serviceOrder}
      serviceItems={items}
      commissions={commissions}
      employees={employees}
      commissionRates={commissionRates}
    />
  )
}
