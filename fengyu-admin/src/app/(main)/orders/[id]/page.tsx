import { notFound } from 'next/navigation'
import { getOrderById, getOrderPayments } from '@/actions/orders'
import { getOrderAllocations } from '@/actions/allocations'
import { getOrderLogs } from '@/actions/logs'
import { getSession } from '@/lib/auth'
import { hasPermission } from '@/lib/auth'
import { db } from '@/db'
import { prepaidCards } from '@db/prepaid-card'
import { eq } from 'drizzle-orm'
import OrderDetailPageClient from '../_components/order-detail-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [order, allocations, logs, payments, session] = await Promise.all([
    getOrderById(id),
    getOrderAllocations(id),
    getOrderLogs(id),
    getOrderPayments(id),
    getSession(),
  ])

  if (!order) notFound()

  // 录入回款权限 + 顾客储值卡余额（ticket 2026-04-24 多次回款 PR-B）
  const canRecordPayment = !!(session && hasPermission(session, 'sale_order:record_payment'))
  const canRefund = !!(session && hasPermission(session, 'sale_order:refund'))
  let cardBalance: number | null = null
  if (canRecordPayment && order.clientUserId) {
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
      canRefund={canRefund}
      cardBalance={cardBalance}
    />
  )
}
