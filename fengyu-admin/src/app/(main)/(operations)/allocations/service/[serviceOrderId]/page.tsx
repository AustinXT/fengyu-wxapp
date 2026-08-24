import { notFound } from 'next/navigation'
import { getServiceOrderById, getServiceItems } from '@/actions/services'
import { getServiceOrderCommissions } from '@/actions/service-commissions'
import { getEmployees, getEmployeesOnBusinessTrip } from '@/actions/employees'
import { getRates } from '@/actions/commission'
import { getSkillTags } from '@/actions/skill-tags'
import { mergeEmployeesById } from '@/lib/merge-employees'
import { getSession } from '@/lib/auth'
import { hasUiCapability } from '@/lib/permission-contract'
import { requireUiPageCapability } from '@/lib/page-capability'
import ServiceCommissionDetailPageClient from '../../_components/service-commission-detail-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ serviceOrderId: string }> }) {
  const { serviceOrderId } = await params
  const session = await getSession()
  requireUiPageCapability(session, 'allocation:list')
  const [serviceOrder, items, commissions, scopedEmployees, tripEmployees, commissionRates, skillTags] = await Promise.all([
    getServiceOrderById(serviceOrderId),
    getServiceItems(serviceOrderId),
    getServiceOrderCommissions(serviceOrderId),
    getEmployees(),
    getEmployeesOnBusinessTrip(),
    getRates().catch(() => []),
    getSkillTags(),
  ])

  if (!serviceOrder) notFound()

  // 候选池按 employeeId 合并；前端仅保留服务单门店员工或同市场出差员工，再按技能筛选。
  const employees = mergeEmployeesById(scopedEmployees, tripEmployees)

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
