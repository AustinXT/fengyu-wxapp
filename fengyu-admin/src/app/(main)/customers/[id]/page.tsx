import { notFound } from 'next/navigation'
import {
  getCustomerById,
  getCustomerOrders,
  getCustomerAppointments,
  getCustomerPhoneChangeLogs,
  getOrphanProfilesByUserId,
} from '@/actions/customers'
import { getStores } from '@/actions/stores'
import { getEmployees } from '@/actions/employees'
import { getSession, hasRole } from '@/lib/auth'
import CustomerDetailPage from './_components/customer-detail-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const [customer, orders, appointments, stores, employees, phoneChangeLogs, orphanProfiles, session] = await Promise.all([
    getCustomerById(id),
    getCustomerOrders(id),
    getCustomerAppointments(id),
    getStores(),
    getEmployees(),
    getCustomerPhoneChangeLogs(id),
    getOrphanProfilesByUserId(id),
    getSession(),
  ])

  if (!customer) notFound()

  // 仅 admin / manager / customer_mgr 可见"编辑手机号"入口（hr/finance/product 不可见）
  const canEditPhone = session
    ? hasRole(session, 'admin') || hasRole(session, 'manager') || hasRole(session, 'customer_mgr')
    : false

  return (
    <CustomerDetailPage
      customer={customer}
      orders={orders}
      appointments={appointments}
      stores={stores}
      employees={employees}
      phoneChangeLogs={phoneChangeLogs}
      orphanProfiles={orphanProfiles}
      canEditPhone={canEditPhone}
    />
  )
}
