import { notFound } from 'next/navigation'
import { getOrderById, getOrderPayments } from '@/actions/orders'
import { getOrderAllocations } from '@/actions/allocations'
import { getOrderLogs } from '@/actions/logs'
import { getSession } from '@/lib/auth'
import { hasPermission, isAdminScope } from '@/lib/permissions'
import { db } from '@/db'
import { prepaidCards } from '@db/prepaid-card'
import { eq } from 'drizzle-orm'
import OrderDetailPageClient from '../_components/order-detail-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await getSession()
  const canListAllocations = !!(session && hasPermission(session, 'allocation:list'))
  
  const canViewOrderDetail = !!(session && (
    hasPermission(session, 'sale_order:list') ||
    hasPermission(session, 'sale_order:refund_create') ||
    hasPermission(session, 'sale_order:refund_approve')
  ))
  const canListLogs = !!(session && (
    hasPermission(session, 'operation_log:list') ||
    hasPermission(session, 'sale_order:list') ||
    hasPermission(session, 'sale_order:refund_create') ||
    hasPermission(session, 'sale_order:refund_approve')
  ))

  const [order, allocations, logs, payments] = await Promise.all([
    getOrderById(id),
    canListAllocations ? getOrderAllocations(id) : Promise.resolve([]),
    canListLogs ? getOrderLogs(id) : Promise.resolve([]),
    canViewOrderDetail ? getOrderPayments(id) : Promise.resolve([]),
  ])

  if (!order) notFound()

  
  const canRecordPayment = !!(session && hasPermission(session, 'sale_order:record_payment'))
  
  const canConfirmOffline = !!(session && hasPermission(session, 'sale_order:update'))
  
  const canRefund = !!(session && hasPermission(session, 'sale_order:refund_create'))
  
  const canDelete = !!(session && isAdminScope(session))
  let cardBalance: number | null = null
  if ((canRecordPayment || canConfirmOffline) && order.clientUserId) {
    const [row] = await db
      .select({ balance: prepaidCards.balance })
      .from(prepaidCards)
      .where(eq(prepaidCards.userId, order.clientUserId))
      .limit(1)
    cardBalance = row ? Number(row.balance) : null
  }

  return (
    <OrderDetailPageClient
      order={order}
      allocations={allocations}
      logs={logs}
      payments={payments}
      canRecordPayment={canRecordPayment}
      canConfirmOffline={canConfirmOffline}
      canRefund={canRefund}
      cardBalance={cardBalance}
      canListAllocations={canListAllocations}
      canDelete={canDelete}
    />
  )
}
