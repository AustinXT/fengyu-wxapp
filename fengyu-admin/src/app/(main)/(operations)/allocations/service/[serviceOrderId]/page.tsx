import { notFound } from 'next/navigation'
import { getServiceOrderById, getServiceItems } from '@/actions/services'
import { getServiceOrderCommissions } from '@/actions/service-commissions'
import { getAllocationEmployeeCandidates } from '@/actions/employees'
import { getRates } from '@/actions/commission'
import { getSkillTags } from '@/actions/skill-tags'
import { getSession } from '@/lib/auth'
import { hasUiCapability } from '@/lib/permission-contract'
import { requireUiPageCapability } from '@/lib/page-capability'
import ServiceCommissionDetailPageClient from '../../_components/service-commission-detail-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ serviceOrderId: string }> }) {
  const { serviceOrderId } = await params
  const session = await getSession()
  requireUiPageCapability(session, 'allocation:list')
  const serviceOrder = await getServiceOrderById(serviceOrderId)
  if (!serviceOrder) notFound()

  const [items, commissions, employees, commissionRates, skillTags] = await Promise.all([
    getServiceItems(serviceOrderId),
    getServiceOrderCommissions(serviceOrderId),
    getAllocationEmployeeCandidates(serviceOrder.storeId),
    getRates().catch(() => []),
    getSkillTags(),
  ])

  return (
    <ServiceCommissionDetailPageClient
      serviceOrder={serviceOrder}
      serviceItems={items}
      commissions={commissions}
      employees={employees}
      commissionRates={commissionRates}
      skillTags={skillTags}
      canSave={hasUiCapability(session.permissions.actions, 'allocation:save')}
    />
  )
}
