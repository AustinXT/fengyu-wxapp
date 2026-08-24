import { notFound } from 'next/navigation'
import { getOrderById } from '@/actions/orders'
import { getOrderAllocations } from '@/actions/allocations'
import { getEmployees, getEmployeesOnBusinessTrip } from '@/actions/employees'
import { getRates } from '@/actions/commission'
import { getSkillTags } from '@/actions/skill-tags'
import { mergeEmployeesById } from '@/lib/merge-employees'
import { getSession } from '@/lib/auth'
import { hasUiCapability } from '@/lib/permission-contract'
import { requireUiPageCapability } from '@/lib/page-capability'
import AllocationDetailPageClient from '../_components/allocation-detail-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params
  const session = await getSession()
  requireUiPageCapability(session, 'allocation:list')
  const [order, allocations, scopedEmployees, tripEmployees, commissionRates, skillTags] = await Promise.all([
    getOrderById(orderId),
    getOrderAllocations(orderId),
    getEmployees(),
    getEmployeesOnBusinessTrip(),
    getRates().catch(() => []),
    getSkillTags(),
  ])

  if (!order) notFound()

  // 候选池按 employeeId 合并；前端仅保留订单门店员工或同市场出差员工，再按技能筛选。
  const employees = mergeEmployeesById(scopedEmployees, tripEmployees)

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
