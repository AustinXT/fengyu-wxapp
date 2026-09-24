import { notFound } from 'next/navigation'
import { getPaymentAllocatables } from '@/actions/allocations'
import { getOrderById } from '@/actions/orders'
import { getAllocationEmployeeCandidates } from '@/actions/employees'
import { getRates } from '@/actions/commission'
import { getSkillTags } from '@/actions/skill-tags'
import { getSession } from '@/lib/auth'
import { hasUiCapability } from '@/lib/permission-contract'
import { requireUiPageCapability } from '@/lib/page-capability'
import PaymentAllocationDetailPageClient from '../../_components/payment-allocation-detail-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ paymentId: string }> }) {
  const { paymentId } = await params
  const session = await getSession()
  requireUiPageCapability(session, 'allocation:list')

  const payment = await getPaymentAllocatables(paymentId)

  if (!payment) notFound()

  // getPaymentAllocatables 不下发 storeId / customerName；按回款所属订单补取，
  // 供目标门店级分配候选查询与摘要展示用。
  const order = await getOrderById(payment.saleOrderId)
  if (!order) notFound()

  const [employees, commissionRates, skillTags] = await Promise.all([
    getAllocationEmployeeCandidates(order.storeId),
    getRates().catch(() => []),
    getSkillTags(),
  ])

  return (
    <PaymentAllocationDetailPageClient
      payment={payment}
      storeId={order.storeId}
      customerName={order.customerName ?? null}
      employees={employees}
      commissionRates={commissionRates}
      skillTags={skillTags}
      canSave={hasUiCapability(session.permissions.actions, 'allocation:save')}
    />
  )
}
