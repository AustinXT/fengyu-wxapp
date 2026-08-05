import { describe, expect, it } from "vitest"
import type { SaleItem, SaleOrder } from "@/lib/types"
import { getCustomerVisibleSaleItems } from "./customer-entitlement-items"

function makeItem(overrides: Partial<SaleItem> = {}): SaleItem {
  return {
    saleItemId: "SI-1",
    saleOrderId: "SO-1",
    itemDirection: "购买",
    refSaleItemId: null,
    skuId: "SKU-1",
    sessionCount: 1,
    remainingSessions: 1,
    paidSessions: 1,
    unitPrice: "211.00",
    quantity: 1,
    unitRealPrice: "211.00",
    saleAmount: "211.00",
    received: "211.00",
    pendingReceived: "0",
    expireDate: null,
    remark: null,
    salesCategory: null,
    createdAt: "2026-07-25T09:00:00.000Z",
    updatedAt: "2026-07-25T09:00:00.000Z",
    productName: "肩颈舒缓SPA",
    ...overrides,
  }
}

function makeOrder(overrides: Partial<SaleOrder> = {}): SaleOrder {
  return {
    saleOrderId: "SO-1",
    status: "已支付",
    saleOrderType: "销售单",
    documentType: "售前",
    refSaleOrderId: null,
    legacySource: null,
    marketName: "南昌市场",
    storeId: "STORE-1",
    saleOrderDatetime: "2026-07-25T09:00:00.000Z",
    clientUserId: "USER-1",
    clientPhone: "13800000000",
    customerName: "欧阳娟娟",
    totalAmount: "211.00",
    prepaidCardAmount: "0",
    received: "211.00",
    refundedAmount: "0",
    paymentMethod: "线下",
    openedBy: null,
    preferredEmployeeId: null,
    paidAt: "2026-07-25T09:00:00.000Z",
    allocationStatus: null,
    couponId: null,
    couponDiscount: null,
    remark: null,
    createdAt: "2026-07-25T09:00:00.000Z",
    updatedAt: "2026-07-25T09:00:00.000Z",
    items: [makeItem()],
    ...overrides,
  }
}

describe("getCustomerVisibleSaleItems", () => {
  it("排除已关闭订单里的疗程卡明细", () => {
    const closedItem = makeItem({ saleItemId: "SI-CLOSED", paidSessions: 0 })
    const paidItem = makeItem({ saleItemId: "SI-PAID" })

    const result = getCustomerVisibleSaleItems([
      makeOrder({ saleOrderId: "SO-CLOSED", status: "已关闭", items: [closedItem] }),
      makeOrder({ saleOrderId: "SO-PAID", status: "已支付", items: [paidItem] }),
    ])

    expect(result.map((item) => item.saleItemId)).toEqual(["SI-PAID"])
  })

  it("只展示有已付未用次数的权益卡", () => {
    const unpaidItem = makeItem({ saleItemId: "SI-UNPAID", paidSessions: 0 })
    const exhaustedItem = makeItem({ saleItemId: "SI-EXHAUSTED", remainingSessions: 0 })
    const paidUsedUpItem = makeItem({
      saleItemId: "SI-PAID-USED-UP",
      sessionCount: 10,
      remainingSessions: 5,
      paidSessions: 5,
    })
    const paidUnusedItem = makeItem({
      saleItemId: "SI-PAID-UNUSED",
      sessionCount: 10,
      remainingSessions: 5,
      paidSessions: 6,
    })

    const result = getCustomerVisibleSaleItems([
      makeOrder({ items: [unpaidItem, exhaustedItem, paidUsedUpItem, paidUnusedItem] }),
    ])

    expect(result.map((item) => item.saleItemId)).toEqual(["SI-PAID-UNUSED"])
  })

  it("兼容 paidSessions 为 NULL 的历史行，按物理剩余显示", () => {
    const legacyNullItem = makeItem({
      saleItemId: "SI-LEGACY-NULL",
      sessionCount: 10,
      remainingSessions: 3,
      paidSessions: null,
    })

    const result = getCustomerVisibleSaleItems([
      makeOrder({ items: [legacyNullItem] }),
    ])

    expect(result.map((item) => item.saleItemId)).toEqual(["SI-LEGACY-NULL"])
  })

  it("保留有效转换单的转入疗程卡", () => {
    const transferIn = makeItem({ saleItemId: "SI-IN", itemDirection: "转入" })
    const transferOut = makeItem({ saleItemId: "SI-OUT", itemDirection: "转出" })

    const result = getCustomerVisibleSaleItems([
      makeOrder({ saleOrderType: "转换单", status: "已完成", items: [transferIn, transferOut] }),
    ])

    expect(result.map((item) => item.saleItemId)).toEqual(["SI-IN"])
  })
})
