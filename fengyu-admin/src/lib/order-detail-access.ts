import { hasUiCapability } from '@/lib/permission-contract'

/**
 * 订单详情页 `/orders/[id]` 的入口权限（OR）——页面守卫与所有「跳转到订单详情」的链接共用这一份（#350）。
 *
 * 链接判据必须与目标页守卫同源：链接比页面宽，点进去就是 404；比页面窄，有权看订单的人却只拿到纯文本。
 * `getOrderById` / `getOrderPayments` 的 action 权限门也引用这份，三处同源。
 *
 * ⚠️ 已知限制：这里只判**权限**，不判**门店 scope**。顾客可以跨店提货（GCK 挂在提货门店 B、
 * 销售单属于开单门店 A），B 店只有本店 scope 的账号能看到链接，点进去 `getOrderById` 按 scope
 * 过滤返回 null → 404。不泄露数据；要逐行按 scope 判需另查订单门店，本期不做（#350 评审记录）。
 */
export const ORDER_DETAIL_PAGE_CAPABILITIES = [
  'sale_order:list',
  'sale_order:refund_create',
  'sale_order:refund_approve',
] as const

export function canOpenOrderDetail(actions: readonly string[]): boolean {
  return ORDER_DETAIL_PAGE_CAPABILITIES.some((action) => hasUiCapability(actions, action))
}
