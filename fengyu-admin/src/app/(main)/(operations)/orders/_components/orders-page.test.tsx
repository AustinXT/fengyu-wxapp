import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockSetMany = vi.fn()

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
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
})
