import { notFound } from 'next/navigation'
import { getServiceOrderById, getServiceItems } from '@/actions/services'
import { getServiceOrderCommissions } from '@/actions/service-commissions'
import { getEmployees, getEmployeesOnBusinessTrip } from '@/actions/employees'
import { getRates } from '@/actions/commission'
import { getSkillTags } from '@/actions/skill-tags'
import { mergeEmployeesById } from '@/lib/merge-employees'
import ServiceCommissionDetailPageClient from '../../_components/service-commission-detail-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ serviceOrderId: string }> }) {
  const { serviceOrderId } = await params
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

  // 跨门店共享（2026-06-24）：scope 内员工 ∪ 全公司出差员工（按 employeeId 去重），
  // 前端按「服务单门店 ∪ 出差」+ 技能筛选；取消原市场级 marketStoreIds 与品项老师补充池。
  const employees = mergeEmployeesById(scopedEmployees, tripEmployees)

  return (
    <ServiceCommissionDetailPageClient
      serviceOrder={serviceOrder}
      serviceItems={items}
      commissions={commissions}
      employees={employees}
      commissionRates={commissionRates}
      skillTags={skillTags}
    />
  )
}
