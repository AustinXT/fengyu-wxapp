import { notFound } from 'next/navigation'
import {
  getCustomerById,
  getCustomerOrders,
  getCustomerAppointments,
  getCustomerPhoneChangeLogs,
  getCustomerServiceOrders,
  getOrphanProfilesByUserId,
  getCustomerPrepaidBalance,
} from '@/actions/customers'
import { getStores } from '@/actions/stores'
import { getEmployees } from '@/actions/employees'
import { getSession, hasRole } from '@/lib/auth'
import { hasPermission, isAdminScope } from '@/lib/permissions'
import CustomerDetailPage from './_components/customer-detail-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const session = await getSession()
  const canListEmployees = session ? hasPermission(session, 'employee:list') : false
  const canListStores = session ? hasPermission(session, 'store:list') : false

  const [customer, orders, appointments, stores, employees, phoneChangeLogs, serviceOrders, orphanProfiles, prepaidBalance] = await Promise.all([
    getCustomerById(id),
    getCustomerOrders(id),
    getCustomerAppointments(id),
    canListStores ? getStores() : Promise.resolve([]),
    canListEmployees ? getEmployees() : Promise.resolve([]),
    getCustomerPhoneChangeLogs(id),
    getCustomerServiceOrders(id),
    getOrphanProfilesByUserId(id),
    getCustomerPrepaidBalance(id),
  ])

  if (!customer) notFound()

  
  const canEditPhone = session
    ? hasRole(session, 'admin') || hasRole(session, 'manager') || hasRole(session, 'customer_mgr')
    : false

  const canPullLegacy = session ? hasPermission(session, 'legacy_order:pull') : false
  
  const canDelete = session ? isAdminScope(session) : false

  return (
    <CustomerDetailPage
      customer={customer}
      orders={orders}
      appointments={appointments}
      stores={stores}
      employees={employees}
      phoneChangeLogs={phoneChangeLogs}
      serviceOrders={serviceOrders}
      orphanProfiles={orphanProfiles}
      prepaidBalance={prepaidBalance.balance}
      canEditPhone={canEditPhone}
      canPullLegacy={canPullLegacy}
      canDelete={canDelete}
    />
  )
}
