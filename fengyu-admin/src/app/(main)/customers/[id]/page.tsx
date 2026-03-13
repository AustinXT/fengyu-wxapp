import { notFound } from 'next/navigation'
import { getCustomerById, getCustomerOrders, getCustomerAppointments } from '@/actions/customers'
import CustomerDetailPage from './_components/customer-detail-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const [customer, orders, appointments] = await Promise.all([
    getCustomerById(id),
    getCustomerOrders(id),
    getCustomerAppointments(id),
  ])

  if (!customer) notFound()

  return (
    <CustomerDetailPage
      customer={customer}
      orders={orders}
      appointments={appointments}
    />
  )
}
