import type { SaleItem, SaleOrder } from "@/lib/types"
import { getTreatmentCardBusinessIdentity, groupTreatmentCards, sumGroupValue } from "@/lib/treatment-card-group"

const VISIBLE_CARD_ORDER_STATUSES: ReadonlySet<SaleOrder["status"]> = new Set([
  "已支付",
  "部分支付",
  "已完成",
])

function isCardEntitlementItem(order: SaleOrder, item: SaleItem) {
  return (
    item.productType === "疗程卡" &&
    (
      item.itemDirection === "购买" ||
      (order.saleOrderType === "转换单" && item.itemDirection === "转入")
    )
  )
}

function hasPaidUnusedSessions(item: SaleItem) {
  if (item.sessionCount === null || item.remainingSessions === null) return false
  if (item.remainingSessions <= 0) return false
  if (item.paidSessions === null) return true

  const usedSessions = Math.max(item.sessionCount - item.remainingSessions, 0)
  return item.paidSessions > usedSessions
}

export interface CustomerVisibleSaleItem extends SaleItem {
  /** 聚合展示的疗程卡张数；不参与服务、退款等业务操作。 */
  cardCount: number
}

interface CustomerCardSource {
  order: SaleOrder
  item: SaleItem
}

export function getCustomerVisibleSaleItems(orders: SaleOrder[]): CustomerVisibleSaleItem[] {
  const items: CustomerCardSource[] = []

  for (const order of orders) {
    if (!VISIBLE_CARD_ORDER_STATUSES.has(order.status)) continue
    for (const item of order.items ?? []) {
      if (
        isCardEntitlementItem(order, item) &&
        hasPaidUnusedSessions(item)
      ) {
        items.push({ order, item })
      }
    }
  }

  return groupTreatmentCards(items, {
    getId: ({ item }) => item.saleItemId,
    getQuantity: ({ item }) => item.quantity,
    preserveNonUnitQuantity: false,
    getIdentity: ({ order, item }) => getTreatmentCardBusinessIdentity({
      saleOrderId: order.saleOrderId,
      orderStatus: order.status,
      saleOrderType: order.saleOrderType,
      documentType: order.documentType,
      storeId: order.storeId,
      marketName: order.marketName,
      saleOrderDatetime: order.saleOrderDatetime,
      paidAt: order.paidAt,
      itemDirection: item.itemDirection,
      refSaleItemId: item.refSaleItemId,
      skuId: item.skuId,
      unit: item.unit,
      sessionCount: item.sessionCount,
      remainingSessions: item.remainingSessions,
      paidSessions: item.paidSessions,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      unitRealPrice: item.unitRealPrice,
      saleAmount: item.saleAmount,
      received: item.received,
      pendingReceived: item.pendingReceived,
      expireDate: item.expireDate,
      pickedUpQuantity: item.pickedUpQuantity,
      remark: item.remark,
      salesCategory: item.salesCategory,
      productName: item.productName,
      skuName: item.skuName,
      productKind: item.productKind,
      categoryId: item.categoryId,
      categoryName: item.categoryName,
    }),
  }).map((group) => {
    const primary = group.primary.item
    const sessionCount = sumGroupValue(group, ({ item }) => item.sessionCount)
    const remainingSessions = sumGroupValue(group, ({ item }) => item.remainingSessions)
    const paidSessions = primary.paidSessions === null
      ? null
      : sumGroupValue(group, ({ item }) => item.paidSessions)

    return {
      ...primary,
      quantity: sumGroupValue(group, ({ item }) => item.quantity),
      sessionCount,
      remainingSessions,
      paidSessions,
      saleAmount: sumGroupValue(group, ({ item }) => item.saleAmount).toFixed(2),
      received: sumGroupValue(group, ({ item }) => item.received).toFixed(2),
      pendingReceived: sumGroupValue(group, ({ item }) => item.pendingReceived).toFixed(2),
      pickedUpQuantity: sumGroupValue(group, ({ item }) => item.pickedUpQuantity),
      cardCount: group.cardCount,
    }
  })
}
