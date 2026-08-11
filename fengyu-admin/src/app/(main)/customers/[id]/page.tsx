import { notFound } from 'next/navigation'
import {
  getCustomerById,
  getCustomerOrders,
  getCustomerCoupons,
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
import { hasUiCapability } from '@/lib/permission-contract'
import { requireUiPageCapability } from '@/lib/page-capability'
import CustomerDetailPage from './_components/customer-detail-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const session = await getSession()
  requireUiPageCapability(session, 'customer:list')
  const canListEmployees = session ? hasPermission(session, 'employee:list') : false
  const canListStores = session ? hasPermission(session, 'store:list') : false

  const [customer, orders, appointments, stores, employees, phoneChangeLogs, serviceOrders, orphanProfiles, prepaidBalance, coupons] = await Promise.all([
    getCustomerById(id),
    getCustomerOrders(id),
    getCustomerAppointments(id),
    canListStores ? getStores() : Promise.resolve([]),
    canListEmployees ? getEmployees() : Promise.resolve([]),
    getCustomerPhoneChangeLogs(id),
    getCustomerServiceOrders(id),
    getOrphanProfilesByUserId(id),
    getCustomerPrepaidBalance(id),
    getCustomerCoupons(id),
  ])

  if (!customer) notFound()

  // 仅 admin / manager / customer_mgr 可见"编辑手机号"入口（hr/finance/product 不可见）
  const canUpdate = hasUiCapability(session?.permissions.actions ?? [], 'customer:update')
  const canEditPhone = session && canUpdate
    ? hasRole(session, 'admin') || hasRole(session, 'manager') || hasRole(session, 'customer_mgr')
    : false

  const canMerge = !!(session && canUpdate && (hasRole(session, 'manager') || isAdminScope(session)))

  const canPullLegacy = hasUiCapability(session?.permissions.actions ?? [], 'legacy_order:pull')
  // 物理删除顾客：仅系统管理员（customer:delete）
  const canDelete = !!(session && hasUiCapability(session.permissions.actions, 'customer:delete') && isAdminScope(session))

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
      coupons={coupons}
      prepaidBalance={prepaidBalance.balance}
      canUpdate={canUpdate}
      canMerge={canMerge}
      canListEmployees={canListEmployees}
      canEditPhone={canEditPhone}
      canPullLegacy={canPullLegacy}
      canDelete={canDelete}
    />
  )
}
