import { notFound } from 'next/navigation'
import { getOrderById } from '@/actions/orders'
import { getOrderAllocations } from '@/actions/allocations'
import { getEmployees, getEmployeesOnBusinessTrip } from '@/actions/employees'
import { getRates } from '@/actions/commission'
import { getActiveSkillTags } from '@/actions/skill-tags'
import { mergeEmployeesById } from '@/lib/merge-employees'
import AllocationDetailPageClient from '../_components/allocation-detail-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params
  const [order, allocations, scopedEmployees, tripEmployees, commissionRates, skillTags] = await Promise.all([
    getOrderById(orderId),
    getOrderAllocations(orderId),
    getEmployees(),
    getEmployeesOnBusinessTrip(),
    getRates().catch(() => []),
    getActiveSkillTags(),
  ])

  if (!order) notFound()

  
  
  const employees = mergeEmployeesById(scopedEmployees, tripEmployees)

  return (
    <AllocationDetailPageClient
      order={order}
      allocations={allocations}
      employees={employees}
      commissionRates={commissionRates}
      skillTags={skillTags}
    />
  )
}
