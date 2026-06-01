import { notFound } from 'next/navigation'
import { getOrderById, getOrderPayments } from '@/actions/orders'
import { getOrderAllocations } from '@/actions/allocations'
import { getOrderLogs } from '@/actions/logs'
import { getSession } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { db } from '@/db'
import { prepaidCards } from '@db/prepaid-card'
import { eq } from 'drizzle-orm'
import OrderDetailPageClient from '../_components/order-detail-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await getSession()
  const canListAllocations = !!(session && hasPermission(session, 'allocation:list'))
  // 支付流水 + 审计日志：订单查看者、退款提单/审批人、操作日志查看者任一即可看
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

  // 录入回款权限 + 顾客储值卡余额（ticket 2026-04-24 多次回款 PR-B）
  const canRecordPayment = !!(session && hasPermission(session, 'sale_order:record_payment'))
  // 确认线下收款权限（与 confirmOfflinePayment action 同权限 sale_order:update）
  const canConfirmOffline = !!(session && hasPermission(session, 'sale_order:update'))
  // 「创建退款」按钮：仅提单权限（所有 admin 角色都有）；审批走 /refunds 流程
  const canRefund = !!(session && hasPermission(session, 'sale_order:refund_create'))
  // 寄存单「修改实收」：与开寄存单同权限 sale_order:create（finance 无此权限，不可编辑）
  const canEditDepositReceipt = !!(session && hasPermission(session, 'sale_order:create'))
  // 物理删除订单：仅系统管理员（sale_order:delete）
  const canDelete = !!(session && hasPermission(session, 'sale_order:delete'))
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
      canEditDepositReceipt={canEditDepositReceipt}
      canDelete={canDelete}
    />
  )
}
