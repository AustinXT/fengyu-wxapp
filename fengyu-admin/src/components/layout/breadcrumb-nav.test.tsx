import { render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const nav = vi.hoisted(() => ({ pathname: "/products/sku-1" }))

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams({
    returnTo: "/products?category=cat-2&kind=护理项目&page=2",
  }),
}))

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}))

import { BreadcrumbNav } from "./breadcrumb-nav"

beforeEach(() => {
  nav.pathname = "/products/sku-1"
})

describe("BreadcrumbNav return context", () => {
  it("详情页父级面包屑恢复来源列表上下文", () => {
    render(<BreadcrumbNav />)
    expect(screen.getByRole("link", { name: "商品管理" })).toHaveAttribute(
      "href",
      "/products?category=cat-2&kind=%E6%8A%A4%E7%90%86%E9%A1%B9%E7%9B%AE&page=2",
    )
  })

  // 数据中心板块（#212）：父级由 getMenuParentForPath 推出，末级靠 ROUTE_LABELS 的板块子路径。
  it("数据中心板块显示「数据中心 / 板块」两级", () => {
    nav.pathname = "/data-center/customer"
    render(<BreadcrumbNav />)

    const nodes = screen.getByRole("navigation", { name: "面包屑导航" })
    expect(nodes).toHaveTextContent("数据中心")
    expect(nodes).toHaveTextContent("客量")
    // 末级是当前页，不可点；父级「数据中心」无独立路由，也不是链接
    expect(screen.queryByRole("link", { name: "客量" })).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "数据中心" })).not.toBeInTheDocument()
  })
})
