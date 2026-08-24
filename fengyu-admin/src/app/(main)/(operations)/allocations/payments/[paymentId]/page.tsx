import { notFound } from 'next/navigation'
import { getPaymentAllocatables } from '@/actions/allocations'
import { getOrderById } from '@/actions/orders'
import { getEmployees, getEmployeesOnBusinessTrip } from '@/actions/employees'
import { getRates } from '@/actions/commission'
import { getSkillTags } from '@/actions/skill-tags'
import { mergeEmployeesById } from '@/lib/merge-employees'
import { getSession } from '@/lib/auth'
import { hasUiCapability } from '@/lib/permission-contract'
import { requireUiPageCapability } from '@/lib/page-capability'
import PaymentAllocationDetailPageClient from '../../_components/payment-allocation-detail-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ paymentId: string }> }) {
  const { paymentId } = await params
  const session = await getSession()
  requireUiPageCapability(session, 'allocation:list')

  // 主取数并行：本笔回款可分配项 + 候选员工（scope ∪ 出差）+ 提成矩阵 + 技能标签字典
  const [payment, scopedEmployees, tripEmployees, commissionRates, skillTags] = await Promise.all([
    getPaymentAllocatables(paymentId),
    getEmployees(),
    getEmployeesOnBusinessTrip(),
    getRates().catch(() => []),
    getSkillTags(),
  ])

  if (!payment) notFound()

  // getPaymentAllocatables 不下发 storeId / customerName；按回款所属订单补取，
  // 供「订单门店 ∪ 出差员工」候选过滤与摘要展示用。
  const order = await getOrderById(payment.saleOrderId)

  // 跨门店共享（2026-06-24）：scope 内员工 ∪ 全公司出差员工（按 employeeId 去重）
  const employees = mergeEmployeesById(scopedEmployees, tripEmployees)

  return (
    <PaymentAllocationDetailPageClient
      payment={payment}
      storeId={order?.storeId ?? null}
      customerName={order?.customerName ?? null}
      employees={employees}
      commissionRates={commissionRates}
      skillTags={skillTags}
      canSave={hasUiCapability(session.permissions.actions, 'allocation:save')}
    />
  )
}
