import { notFound } from 'next/navigation'
import { getOrderById } from '@/actions/orders'
import { getOrderAllocations } from '@/actions/allocations'
import { getAllocationEmployeeCandidates } from '@/actions/employees'
import { getRates } from '@/actions/commission'
import { getSkillTags } from '@/actions/skill-tags'
import { getSession } from '@/lib/auth'
import { hasUiCapability } from '@/lib/permission-contract'
import { requireUiPageCapability } from '@/lib/page-capability'
import AllocationDetailPageClient from '../_components/allocation-detail-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params
  const session = await getSession()
  requireUiPageCapability(session, 'allocation:list')
  const order = await getOrderById(orderId)
  if (!order) notFound()

  const [allocations, employees, commissionRates, skillTags] = await Promise.all([
    getOrderAllocations(orderId),
    getAllocationEmployeeCandidates(order.storeId),
    getRates().catch(() => []),
    getSkillTags(),
  ])

  return (
    <AllocationDetailPageClient
      order={order}
      allocations={allocations}
      employees={employees}
      commissionRates={commissionRates}
      skillTags={skillTags}
      canSave={hasUiCapability(session.permissions.actions, 'allocation:save')}
    />
  )
}
