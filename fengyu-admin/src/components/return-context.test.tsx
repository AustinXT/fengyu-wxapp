import { render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const push = vi.fn()
const replace = vi.fn()
let pathname = "/products"
let searchParams = new URLSearchParams("category=cat-2&page=3&size=50")

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => searchParams,
  useRouter: () => ({ push, replace }),
}))

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}))

import { PreserveListContextLink, ReturnContextLink } from "./return-context"

describe("return context components", () => {
  beforeEach(() => {
    pathname = "/products"
    searchParams = new URLSearchParams("category=cat-2&page=3&size=50")
    push.mockClear()
    replace.mockClear()
  })

  it("列表详情链接携带完整来源 URL", () => {
    render(<PreserveListContextLink href="/products/sku-1">编辑</PreserveListContextLink>)
    const href = screen.getByRole("link", { name: "编辑" }).getAttribute("href")!
    expect(new URL(href, "https://example.test").searchParams.get("returnTo"))
      .toBe("/products?category=cat-2&page=3&size=50")
  })

  it("详情返回链接恢复来源 URL", () => {
    pathname = "/products/sku-1"
    searchParams = new URLSearchParams({ returnTo: "/products?category=cat-2&page=3&size=50" })
    render(<ReturnContextLink href="/products">返回</ReturnContextLink>)
    expect(screen.getByRole("link", { name: "返回" })).toHaveAttribute(
      "href",
      "/products?category=cat-2&page=3&size=50",
    )
  })

  it("非法来源回退到模块列表", () => {
    searchParams = new URLSearchParams({ returnTo: "https://evil.example/path" })
    render(<ReturnContextLink href="/products">返回</ReturnContextLink>)
    expect(screen.getByRole("link", { name: "返回" })).toHaveAttribute("href", "/products")
  })
})
