import type { SaleItem, SaleOrder } from "@/lib/types"

const VISIBLE_CARD_ORDER_STATUSES: ReadonlySet<SaleOrder["status"]> = new Set([
  "已支付",
  "部分支付",
  "已完成",
])

function isCardEntitlementItem(order: SaleOrder, item: SaleItem) {
  return (
    item.itemDirection === "购买" ||
    (order.saleOrderType === "转换单" && item.itemDirection === "转入")
  )
}

export function getCustomerVisibleSaleItems(orders: SaleOrder[]): SaleItem[] {
  const items: SaleItem[] = []

  for (const order of orders) {
    if (!VISIBLE_CARD_ORDER_STATUSES.has(order.status)) continue
    for (const item of order.items ?? []) {
      if (
        isCardEntitlementItem(order, item) &&
        item.sessionCount !== null &&
        (item.remainingSessions ?? 0) > 0 &&
        (item.paidSessions ?? 0) > 0
      ) {
        items.push(item)
      }
    }
  }

  return items
}
