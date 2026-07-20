import { notFound } from 'next/navigation'
import { getOrderById } from '@/actions/orders'
import { getOrderAllocations } from '@/actions/allocations'
import { getEmployees, getEmployeesOnBusinessTrip } from '@/actions/employees'
import { getRates } from '@/actions/commission'
import { getSkillTags } from '@/actions/skill-tags'
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
    getSkillTags(),
  ])

  if (!order) notFound()

  // 跨门店共享（2026-06-24）：scope 内员工 ∪ 全公司出差员工（按 employeeId 去重），
  // 前端按「订单门店 ∪ 出差」+ 技能筛选；取消原市场级 marketStoreIds 与品项老师补充池。
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
