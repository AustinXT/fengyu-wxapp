import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SaleOrder } from "@/lib/types"

const mockSetMany = vi.fn()

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/orders",
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

vi.mock("@/lib/hooks/use-url-filters", () => ({
  useUrlFilters: () => ({
    get: (_key: string, defaultValue = "") => defaultValue,
    set: vi.fn(),
    setMany: mockSetMany,
    searchParams: new URLSearchParams(),
  }),
}))

vi.mock("@/actions/orders", () => ({
  confirmOfflinePayment: vi.fn(),
  closeOrder: vi.fn(),
  resetOrderFailed: vi.fn(),
  generateOrderWxacode: vi.fn(),
}))

vi.mock("@/actions/export-jobs", () => ({ createExportJob: vi.fn() }))

import OrdersPage from "./orders-page"

describe("OrdersPage — 订单类型筛选", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("URL 导航完成前连续勾选时保留已有选择", async () => {
    const user = userEvent.setup()
    render(
      <OrdersPage
        orders={[]}
        filterOptions={{ markets: [], stores: [] }}
        total={0}
        canCreateOrder={false}
        canUpdate={false}
      />,
    )

    await user.click(screen.getByRole("button", { name: "全部单据" }))
    await user.click(screen.getByRole("button", { name: "销售单" }))
    await user.click(screen.getByRole("button", { name: "内部单" }))

    expect(mockSetMany).toHaveBeenNthCalledWith(1, { type: "销售单", page: "" })
    expect(mockSetMany).toHaveBeenNthCalledWith(2, { type: "销售单,内部单", page: "" })
    expect(screen.getByRole("button", { name: /销售单、内部单/ })).toBeInTheDocument()
  })

  it("可切换到款项发生日期并写入导出共用的 URL 参数", async () => {
    const user = userEvent.setup()
    render(
      <OrdersPage
        orders={[]}
        filterOptions={{ markets: [], stores: [] }}
        total={0}
        canCreateOrder={false}
        canUpdate={false}
      />,
    )

    await user.selectOptions(screen.getByRole("combobox", { name: "日期口径" }), "payment")

    expect(mockSetMany).toHaveBeenCalledWith({ dateBasis: "payment", page: "" })
  })

  it("WorkFine 历史单底层支付方式为无时展示为未知", () => {
    const order: SaleOrder = {
      saleOrderId: "FY-XSD2607260012",
      status: "已支付",
      saleOrderType: "销售单",
      documentType: "售前一次",
      refSaleOrderId: null,
      legacySource: "workfine",
      marketName: "南昌",
      storeId: "store-1",
      storeName: "南昌店",
      saleOrderDatetime: "2026-07-26T08:00:00.000Z",
      performanceAttributionDate: "2026-07-26",
      performanceAttributionAdjustedAt: null,
      performanceAttributionAdjustedBy: null,
      clientUserId: "customer-1",
      clientPhone: null,
      customerName: "陈凤婷",
      totalAmount: "2682.00",
      prepaidCardAmount: "0.00",
      pendingPrepaidCardAmount: "0.00",
      payableAmount: "2682.00",
      received: "2682.00",
      refundedAmount: "0.00",
      paymentMethod: "无",
      openedBy: null,
      preferredEmployeeId: null,
      paidAt: "2026-07-26T08:00:00.000Z",
      allocationStatus: null,
      couponId: null,
      couponDiscount: null,
      remark: null,
      createdAt: "2026-07-26T08:00:00.000Z",
      updatedAt: "2026-07-26T08:00:00.000Z",
    }

    render(
      <OrdersPage
        orders={[order]}
        filterOptions={{ markets: [], stores: [] }}
        total={1}
        canCreateOrder={false}
        canUpdate={false}
      />,
    )

    expect(screen.getByRole("cell", { name: "未知" })).toBeInTheDocument()
  })
})
