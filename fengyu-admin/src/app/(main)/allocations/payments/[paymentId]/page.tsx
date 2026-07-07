import { notFound } from 'next/navigation'
import { getPaymentAllocatables } from '@/actions/allocations'
import { getOrderById } from '@/actions/orders'
import { getEmployees, getEmployeesOnBusinessTrip } from '@/actions/employees'
import { getRates } from '@/actions/commission'
import { getActiveSkillTags } from '@/actions/skill-tags'
import { mergeEmployeesById } from '@/lib/merge-employees'
import PaymentAllocationDetailPageClient from '../../_components/payment-allocation-detail-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ paymentId: string }> }) {
  const { paymentId } = await params

  
  const [payment, scopedEmployees, tripEmployees, commissionRates, skillTags] = await Promise.all([
    getPaymentAllocatables(paymentId),
    getEmployees(),
    getEmployeesOnBusinessTrip(),
    getRates().catch(() => []),
    getActiveSkillTags(),
  ])

  if (!payment) notFound()

  
  
  const order = await getOrderById(payment.saleOrderId)

  
  const employees = mergeEmployeesById(scopedEmployees, tripEmployees)

  return (
    <PaymentAllocationDetailPageClient
      payment={payment}
      storeId={order?.storeId ?? null}
      customerName={order?.customerName ?? null}
      employees={employees}
      commissionRates={commissionRates}
      skillTags={skillTags}
    />
  )
}
