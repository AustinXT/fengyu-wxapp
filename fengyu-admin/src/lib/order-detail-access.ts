import { hasUiCapability } from '@/lib/permission-contract'

/**
 * 订单详情页 `/orders/[id]` 的入口权限（OR）——页面守卫与所有「跳转到订单详情」的链接共用这一份（#350）。
 *
 * 链接判据必须与目标页守卫同源：链接比页面宽，点进去就是 404；比页面窄，有权看订单的人却只拿到纯文本。
 */
export const ORDER_DETAIL_PAGE_CAPABILITIES = [
  'sale_order:list',
  'sale_order:refund_create',
  'sale_order:refund_approve',
] as const

export function canOpenOrderDetail(actions: readonly string[]): boolean {
  return ORDER_DETAIL_PAGE_CAPABILITIES.some((action) => hasUiCapability(actions, action))
}
