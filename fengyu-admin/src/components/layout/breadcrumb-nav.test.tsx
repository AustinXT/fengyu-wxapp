import { render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({
  usePathname: () => "/products/sku-1",
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

describe("BreadcrumbNav return context", () => {
  it("详情页父级面包屑恢复来源列表上下文", () => {
    render(<BreadcrumbNav />)
    expect(screen.getByRole("link", { name: "商品管理" })).toHaveAttribute(
      "href",
      "/products?category=cat-2&kind=%E6%8A%A4%E7%90%86%E9%A1%B9%E7%9B%AE&page=2",
    )
  })
})
