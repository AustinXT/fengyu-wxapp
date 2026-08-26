import { act, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { MallCategory, Product } from "@/lib/types"

const searchParams = new URLSearchParams("q=护理&category=cat-2&size=50")
const { routerReplace } = vi.hoisted(() => ({ routerReplace: vi.fn() }))

vi.mock("next/navigation", () => ({
  usePathname: () => "/mall",
  useSearchParams: () => searchParams,
  useRouter: () => ({ replace: routerReplace, push: vi.fn() }),
}))

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))

vi.mock("@/components/ui/mall-category-cascader", () => ({
  MallCategoryCascader: ({ value }: { value: string }) => <div data-testid="category-value">{value}</div>,
}))

import MallPageClient from "./mall-page"

describe("MallPageClient URL 状态", () => {
  const categories = [{ categoryId: "cat-2", categoryName: "护理" }] as unknown as MallCategory[]
  const products = [{
    productId: "product-1",
    name: "护理套餐",
    categoryId: "cat-2",
    categoryName: "护理",
    categoryGroup: "面部",
    price: "100",
    specialPrice: null,
    isVisible: true,
    isBundle: false,
    skuCount: 1,
  }] as Product[]

  beforeEach(() => {
    vi.useFakeTimers()
    routerReplace.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("从 URL 恢复搜索、二级分类和详情来源上下文", () => {
    render(
      <MallPageClient
        categories={categories}
        products={products}
        canCreate={false}
        canUpdate
      />,
    )

    expect(screen.getByPlaceholderText("搜索商品名称")).toHaveValue("护理")
    expect(screen.getByTestId("category-value")).toHaveTextContent("cat-2")
    const href = screen.getByRole("link", { name: "编辑" }).getAttribute("href")!
    expect(new URL(href, "https://example.test").searchParams.get("returnTo"))
      .toBe("/mall?q=%E6%8A%A4%E7%90%86&category=cat-2&size=50")
  })

  it("连续输入时只用最后一次输入更新 URL", () => {
    render(
      <MallPageClient
        categories={categories}
        products={products}
        canCreate={false}
        canUpdate
      />,
    )

    const input = screen.getByPlaceholderText("搜索商品名称")
    fireEvent.change(input, { target: { value: "护" } })
    fireEvent.change(input, { target: { value: "护理新品" } })

    act(() => vi.advanceTimersByTime(300))

    expect(routerReplace).toHaveBeenCalledTimes(1)
    expect(routerReplace).toHaveBeenCalledWith(
      "/mall?q=%E6%8A%A4%E7%90%86%E6%96%B0%E5%93%81&category=cat-2&size=50",
      { scroll: false },
    )
  })

  it("卸载时清理尚未执行的搜索更新", () => {
    const { unmount } = render(
      <MallPageClient
        categories={categories}
        products={products}
        canCreate={false}
        canUpdate
      />,
    )

    fireEvent.change(screen.getByPlaceholderText("搜索商品名称"), {
      target: { value: "护理新品" },
    })
    unmount()

    act(() => vi.advanceTimersByTime(300))

    expect(routerReplace).not.toHaveBeenCalled()
  })
})
