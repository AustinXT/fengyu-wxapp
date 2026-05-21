"use client"

import { useState } from "react"
import Link from "next/link"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { StatusBadge, Badge } from "@/components/ui/badge"
import type { SaleOrder, SaleAllocation, OperationLog, SaleOrderPayment } from "@/lib/types"
import { RecordPaymentDialog } from "./record-payment-dialog"
import { ConfirmOfflineDialog } from "./confirm-offline-dialog"
import { RefundForm } from "@/components/orders/refund-form"

/** ticket 2026-04-24 PR-3 §3.3 — change_type/status 中文展示，退款金额红色 */
const paymentChangeTypeLabelMap: Record<string, string> = {
  首次支付: "首次支付",
  回款: "回款",
  退款: "退款",
  储值卡抵扣: "储值卡抵扣",
}
/**
 * 2026-04-26 sale-order-domain-refactor：paymentFlowStatusEnum 4→5 值，新增 '待审批'
 * （退款审批流："发起 → 待审批 → 已支付 / 已作废"）
 */
const paymentFlowStatusColorMap: Record<string, string> = {
  待支付: "bg-[#FFF7E6] text-[#D4820A]",
  待审批: "bg-[#FFF7E6] text-[#D4820A]",
  已支付: "bg-[#F0F9F2] text-[#3D8A5A]",
  已作废: "bg-gray-100 text-[#888888]",
  已退款: "bg-[#FFEBEE] text-[#C62828]",
}

const paymentMethodMap: Record<string, string> = {
  微信: "微信支付",
  支付宝: "支付宝",
  线下: "线下支付",
  无: "无（全额抵扣）",
}

// 2026-04-26 sale-order-domain-refactor：5→3 值
// 历史"回款单"/"退款单"语义已迁至 sale_order_payments[change_type]
// 2026-05-18 B5：+寄存单（剩余次数初始化，不计金额，灰底标识）
const orderTypeColorMap: Record<string, string> = {
  "销售单": "bg-[#E8F0FE] text-[#3574C4]",
  "内部单": "bg-[#F0F9F2] text-[#3D8A5A]",
  "转换单": "bg-[#E3F2FD] text-[#1565C0]",
  "寄存单": "bg-[#F3F4F6] text-[#6B7280]",
}

function formatDateTime(dt: string | null) {
  if (!dt) return "-"
  return new Date(dt).toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  })
}

export default function OrderDetailPageClient({
  order,
  allocations,
  logs,
  payments,
  canRecordPayment = false,
  canConfirmOffline = false,
  canRefund = false,
  cardBalance = null,
  canListAllocations = true,
}: {
  order: SaleOrder
  allocations: SaleAllocation[]
  logs: OperationLog[]
  payments?: SaleOrderPayment[]
  /** ticket 2026-04-24 多次回款 PR-B — 是否展示"录入回款"按钮 */
  canRecordPayment?: boolean
  /** 是否展示"确认收款"按钮（线下待支付首次收款入账，权限 sale_order:update） */
  canConfirmOffline?: boolean
  /** ticket 2026-04-24 退款 PR-Y — 是否展示"创建退款"按钮 */
  canRefund?: boolean
  /** 顾客当前储值卡余额（元，null=未查询或无账户） */
  cardBalance?: number | null
  /**
   * 是否拥有 `allocation:list` 权限。
   * 缺该权限的角色（如 admin）不展示"营业额分配"分区，避免误导（admin 不参与分配流程）。
   */
  canListAllocations?: boolean
}) {
  const items = order.items || []
  const prepaidCardAmount = Number(order.prepaidCardAmount ?? "0")
  const paidAmount = Number(order.received ?? "0")
  const refundedAmount = Number(order.refundedAmount ?? "0")
  const hasPrepaidDeduction = prepaidCardAmount > 0
  // 2026-04-26 sale-order-domain-refactor：refunded_amount > 0 推导"已退款"标签
  const hasRefund = refundedAmount > 0

  // 剩余欠款 = payable_amount - received（payable_amount = total_amount - prepaid_card_amount）
  const totalAmount = Number(order.totalAmount ?? "0")
  const payableAmount = Math.max(0, Math.round((totalAmount - prepaidCardAmount) * 100) / 100)
  const remainingPayable = Math.max(0, Math.round((payableAmount - paidAmount) * 100) / 100)
  // 确认收款：线下「待支付」订单的首次收款入账入口
  const canShowConfirmOffline =
    canConfirmOffline &&
    order.paymentMethod === "线下" &&
    order.status === "待支付"

  // 录入回款：用于已开始收款的订单补尾款。
  // 与确认收款互斥——线下「待支付」走确认收款，避免双按钮歧义（录入回款写'回款'且不自动扣预选卡）。
  const canShowRecordPayment =
    canRecordPayment &&
    remainingPayable > 0 &&
    (order.status === "部分支付" || order.status === "待支付") &&
    !canShowConfirmOffline

  const [repaymentDialogOpen, setRepaymentDialogOpen] = useState(false)
  const [confirmOfflineDialogOpen, setConfirmOfflineDialogOpen] = useState(false)
  const [refundFormOpen, setRefundFormOpen] = useState(false)

  // 退款按钮仅对销售单 + 已支付/已完成/部分支付 可见
  const canShowRefund =
    canRefund &&
    order.saleOrderType === "销售单" &&
    (order.status === "已支付" || order.status === "已完成" || order.status === "部分支付")

  // 是否存在待审批中的退款（payments 中有 change_type='退款' status∈{'待审批','待支付'}）
  // 2026-04-26 sale-order-domain-refactor：paymentFlowStatusEnum 新增 '待审批'；兼容旧数据保留 '待支付' 检测
  const hasPendingRefund = (payments ?? []).some(
    (p) => p.changeType === "退款" && (p.status === "待审批" || p.status === "待支付"),
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/orders" className="text-[#999999] hover:text-[var(--foreground)]">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
          </Link>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">订单详情</h1>
        </div>
        <div className="flex items-center gap-2">
          {canShowRefund && !hasPendingRefund && (
            <Button variant="outline" onClick={() => setRefundFormOpen(true)}>
              创建退款
            </Button>
          )}
        </div>
      </div>

      {/* 退款审批中提示 */}
      {hasPendingRefund && (
        <div className="rounded-[var(--radius)] bg-[#FFF7E6] border border-[#F3C77E] px-4 py-3 text-sm text-[#D4820A]">
          该订单有退款申请正在审批中，审批完成后可再次发起退款。
          <Link href="/refunds" className="ml-2 underline">查看退款管理</Link>
        </div>
      )}

      {/* B5 — 寄存单提示：不计入营业额 / 提成 / 客单价等统计；仅次数维度纳入 cardHolders */}
      {order.saleOrderType === "寄存单" && (
        <div className="rounded-[var(--radius)] bg-[#F3F4F6] border border-[#D1D5DB] px-4 py-3 text-sm text-[#6B7280]">
          此订单为剩余次数寄存单，不收款、不计入营业额 / 提成 / 客单价统计；可正常生成服务单核销次数。
        </div>
      )}

      {/* 订单信息 */}
      <Card>
        <CardHeader>
          <CardTitle>订单信息</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-y-4 gap-x-8 text-sm">
            <div>
              <span className="text-[#999999]">订单号</span>
              <p className="font-medium mt-1">{order.saleOrderId}</p>
            </div>
            <div>
              <span className="text-[#999999]">状态</span>
              <p className="mt-1"><StatusBadge status={order.status} /></p>
            </div>
            <div>
              <span className="text-[#999999]">类型</span>
              <p className="mt-1 flex items-center gap-2">
                <Badge variant="secondary" className={orderTypeColorMap[order.saleOrderType] || ""}>
                  {order.saleOrderType}
                </Badge>
                {/* 2026-04-26 sale-order-domain-refactor：refunded_amount > 0 推导"已退款"角标 */}
                {hasRefund && (
                  <Badge variant="secondary" className="bg-[#FFEBEE] text-[#C62828]">
                    已退款
                  </Badge>
                )}
              </p>
            </div>
            <div>
              <span className="text-[#999999]">门店</span>
              <p className="font-medium mt-1">{order.storeName}</p>
            </div>
            <div>
              <span className="text-[#999999]">开单人</span>
              <p className="font-medium mt-1">{order.openedByName || "顾客自助"}</p>
            </div>
            <div>
              <span className="text-[#999999]">顾客</span>
              <p className="font-medium mt-1">{order.customerName || "-"}</p>
            </div>
            <div>
              <span className="text-[#999999]">下单时间</span>
              <p className="font-medium mt-1">{formatDateTime(order.saleOrderDatetime)}</p>
            </div>
            <div>
              <span className="text-[#999999]">支付时间</span>
              <p className="font-medium mt-1">{formatDateTime(order.paidAt)}</p>
            </div>
            <div>
              <span className="text-[#999999]">支付方式</span>
              <p className="font-medium mt-1">{paymentMethodMap[order.paymentMethod] || order.paymentMethod}</p>
            </div>
            <div>
              <span className="text-[#999999]">订单总额</span>
              <p className="font-bold text-lg mt-1 text-[var(--primary)]">¥{Number(order.totalAmount).toLocaleString()}</p>
            </div>
            {hasPrepaidDeduction && (
              <>
                <div>
                  <span className="text-[#999999]">储值卡抵扣</span>
                  <p className="font-bold text-lg mt-1 text-[#C0322A]">-¥{prepaidCardAmount.toLocaleString()}</p>
                </div>
                <div>
                  <span className="text-[#999999]">实付金额</span>
                  <p className="font-bold text-lg mt-1 text-[var(--foreground)]">¥{paidAmount.toLocaleString()}</p>
                </div>
              </>
            )}
            {/* 2026-04-26 sale-order-domain-refactor：已退款金额由 saleOrders.refunded_amount 直接读取（聚合 sale_order_payments[退款,已支付]） */}
            {hasRefund && (
              <div>
                <span className="text-[#999999]">已退款金额</span>
                <p className="font-bold text-lg mt-1 text-[#C62828]">-¥{refundedAmount.toLocaleString()}</p>
              </div>
            )}
            {order.remark && (
              <div className="col-span-2 md:col-span-3">
                <span className="text-[#999999]">备注</span>
                <p className="font-medium mt-1">{order.remark}</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 商品明细 */}
      <Card>
        <CardHeader>
          <CardTitle>商品明细</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">商品名称</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">单价</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">数量</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">实收</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">状态/次数（已用/已付/共）</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {items.map((item) => {
                  // ticket 2026-05-19 D10=A：三段次数展示
                  // 已用 = sessionCount - remainingSessions；已付 = paidSessions ?? 0；共 = sessionCount
                  const sessionCell = item.sessionCount !== null
                    ? `已用 ${item.sessionCount - (item.remainingSessions ?? 0)} / 已付 ${item.paidSessions ?? 0} / 共 ${item.sessionCount} 次`
                    : "家居产品"
                  return (
                  <tr key={item.saleItemId} className="hover:bg-[#FFF0EE] transition-colors">
                    <td className="px-4 py-3 font-medium">{item.skuName || item.productName || "-"}</td>
                    <td className="px-4 py-3 text-right">¥{Number(item.unitPrice).toLocaleString()}</td>
                    <td className="px-4 py-3 text-right">{item.quantity}</td>
                    <td className="px-4 py-3 text-right font-medium">¥{Number(item.received).toLocaleString()}</td>
                    <td className="px-4 py-3">{sessionCell}</td>
                  </tr>
                  )
                })}
                {items.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-[#999999]">暂无明细</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* 款项流水（ticket 2026-04-24 PR-3 §3.3） */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>款项流水</CardTitle>
            {remainingPayable > 0 && (
              <p className="text-xs text-[#C0322A] mt-1">
                剩余欠款 ¥{remainingPayable.toFixed(2)}
              </p>
            )}
          </div>
          {canShowConfirmOffline && (
            <Button size="sm" className="bg-[#3D8A5A] hover:bg-[#2E6B45] text-white" onClick={() => setConfirmOfflineDialogOpen(true)}>
              确认收款
            </Button>
          )}
          {canShowRecordPayment && (
            <Button size="sm" onClick={() => setRepaymentDialogOpen(true)}>
              录入回款
            </Button>
          )}
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">时间</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">类型</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">金额</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">通道</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">状态</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">操作人</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">备注</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {(payments ?? []).map((p) => {
                  const amt = Number(p.amount)
                  const isRefund = p.changeType === "退款" || amt < 0
                  // 退款行展示退款专属字段（refundReason / auditEmployeeId / auditAt / auditRemark / refSaleItemId / sessionCount）
                  const refundDetailParts: string[] = []
                  if (isRefund) {
                    if (p.refundReason) refundDetailParts.push(`原因：${p.refundReason}`)
                    if (p.refSaleItemId) refundDetailParts.push(`关联明细 ${p.refSaleItemId}`)
                    if (p.sessionCount != null) refundDetailParts.push(`次数：${p.sessionCount}`)
                    if (p.auditAt) {
                      refundDetailParts.push(
                        `审批：${formatDateTime(p.auditAt)}` +
                          (p.auditRemark ? `（${p.auditRemark}）` : ""),
                      )
                    }
                  }
                  const noteLine = p.note || "-"
                  const detailLine = refundDetailParts.join(" · ")
                  return (
                    <tr key={p.id} className="hover:bg-[#FFF0EE] transition-colors">
                      <td className="px-4 py-3 whitespace-nowrap">
                        {formatDateTime(p.paidAt || p.createdAt)}
                      </td>
                      <td className="px-4 py-3">
                        {paymentChangeTypeLabelMap[p.changeType] ?? p.changeType}
                      </td>
                      <td
                        className={`px-4 py-3 text-right font-medium ${
                          isRefund ? "text-[#C62828]" : "text-[var(--foreground)]"
                        }`}
                      >
                        {isRefund ? "" : "+"}¥{amt.toLocaleString()}
                      </td>
                      <td className="px-4 py-3">{p.paymentMethod}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block px-2 py-0.5 rounded text-xs ${
                            paymentFlowStatusColorMap[p.status] ?? "bg-gray-100 text-[#888888]"
                          }`}
                        >
                          {p.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {p.operatorName || (p.sourceEnd === "client" ? "顾客自助" : p.sourceEnd === "notify" ? "支付回调" : "-")}
                      </td>
                      <td className="px-4 py-3 text-[#666666]">
                        <div>{noteLine}</div>
                        {detailLine && (
                          <div className="text-xs text-[#999999] mt-0.5">{detailLine}</div>
                        )}
                      </td>
                    </tr>
                  )
                })}
                {(payments ?? []).length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-[#999999]">
                      暂无款项流水
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* 营业额分配 — 仅 allocation:list 权限可见（admin 不参与分配流程） */}
      {canListAllocations && (
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>营业额分配</CardTitle>
            {order.status === '已支付' && (
              <Link href={`/allocations/${order.saleOrderId}`}>
                <Button size="sm" variant="outline">编辑分配</Button>
              </Link>
            )}
          </CardHeader>
          <CardContent className="p-0">
            {allocations.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium text-gray-500">员工</th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500">部门</th>
                      <th className="px-4 py-3 text-right font-medium text-gray-500">金额</th>
                      <th className="px-4 py-3 text-right font-medium text-gray-500">比例</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {allocations.map((a) => (
                      <tr key={a.id} className="hover:bg-[#FFF0EE] transition-colors">
                        <td className="px-4 py-3 font-medium">{a.employeeName}</td>
                        <td className="px-4 py-3">{a.departmentName || "-"}</td>
                        <td className="px-4 py-3 text-right">¥{Number(a.totalAmount).toLocaleString()}</td>
                        <td className="px-4 py-3 text-right">{(Number(a.allocationRatio) * 100).toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="px-4 py-8 text-center text-[#999999]">暂未分配</div>
            )}
          </CardContent>
        </Card>
      )}

      {/* 操作日志 */}
      <Card>
        <CardHeader>
          <CardTitle>操作日志</CardTitle>
        </CardHeader>
        <CardContent>
          {logs.length > 0 ? (
            <div className="space-y-4">
              {logs.map((log) => (
                <div key={log.id} className="flex gap-4">
                  <div className="flex flex-col items-center">
                    <div className="h-2.5 w-2.5 rounded-full bg-[var(--primary)] mt-1.5" />
                    <div className="flex-1 w-px bg-[var(--border)]" />
                  </div>
                  <div className="pb-4">
                    <p className="text-sm font-medium text-[var(--foreground)]">
                      {log.operatorName} - {log.action}
                    </p>
                    <p className="text-xs text-[#999999] mt-1">{formatDateTime(log.createdAt)}</p>
                    {log.detail && (
                      <p className="text-xs text-[#999999] mt-1 bg-gray-50 rounded px-2 py-1 font-mono">
                        {JSON.stringify(log.detail)}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-center text-[#999999] py-4">暂无日志</p>
          )}
        </CardContent>
      </Card>

      {/* 录入回款弹层（ticket 2026-04-24 多次回款 PR-B） */}
      {canShowRecordPayment && (
        <RecordPaymentDialog
          open={repaymentDialogOpen}
          onOpenChange={setRepaymentDialogOpen}
          saleOrderId={order.saleOrderId}
          remainingPayable={remainingPayable}
          cardBalance={cardBalance}
        />
      )}

      {/* 确认收款弹层（线下待支付首次收款入账） */}
      {canShowConfirmOffline && (
        <ConfirmOfflineDialog
          open={confirmOfflineDialogOpen}
          onOpenChange={setConfirmOfflineDialogOpen}
          saleOrderId={order.saleOrderId}
          remainingPayable={remainingPayable}
          cardBalance={cardBalance}
        />
      )}

      {/* 创建退款弹层（ticket 2026-04-24 退款 PR-Y） */}
      {canShowRefund && (
        <RefundForm
          open={refundFormOpen}
          onOpenChange={setRefundFormOpen}
          saleOrderId={order.saleOrderId}
        />
      )}
    </div>
  )
}
