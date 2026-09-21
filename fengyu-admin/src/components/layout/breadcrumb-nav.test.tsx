import { render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DATA_CENTER_BOARD_LABELS, DATA_CENTER_TABS } from "@/lib/data-center/params"

const RETURN_TO = "/products?category=cat-2&kind=护理项目&page=2"

const nav = vi.hoisted(() => ({ pathname: "/products/sku-1", search: "" }))

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}))

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}))

import { BreadcrumbNav } from "./breadcrumb-nav"

beforeEach(() => {
  nav.pathname = "/products/sku-1"
  // 默认带 returnTo（详情页从列表跳进来的常态）；板块/404 路径的用例各自清掉
  nav.search = new URLSearchParams({ returnTo: RETURN_TO }).toString()
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
  // ROUTE_LABELS 是 Record<string,string>，漏配某个板块 tsc 不报错、末级会静默退化成「详情」，
  // 所以这里按 DATA_CENTER_TABS 逐个渲染，顺带锁住它与 DATA_CENTER_BOARD_LABELS 的文案一致。
  it.each(DATA_CENTER_TABS)("数据中心板块 %s 显示「数据中心 / 板块」两级", (board) => {
    nav.pathname = `/data-center/${board}`
    nav.search = ""
    render(<BreadcrumbNav />)

    const label = DATA_CENTER_BOARD_LABELS[board]
    const nodes = screen.getByRole("navigation", { name: "面包屑导航" })
    expect(nodes).toHaveTextContent("数据中心")
    expect(nodes).toHaveTextContent(label)
    expect(nodes).not.toHaveTextContent("详情")
    // 末级是当前页，不可点；父级「数据中心」无独立路由，也不是链接
    expect(screen.queryByRole("link", { name: label })).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "数据中心" })).not.toBeInTheDocument()
  })

  // 非法板块段（404 页）：此时 ROUTE_LABELS 的 "/data-center" 条目是唯一入口，
  // 且因为不是末级而渲染成可点链接——点它会经裸路径 redirect 回销售板块，是误输入用户的逃生路径。
  it("非法板块段的面包屑保留可点的「数据中心」逃生链接", () => {
    nav.pathname = "/data-center/zzz"
    nav.search = ""
    render(<BreadcrumbNav />)

    expect(screen.getByRole("link", { name: "数据中心" })).toHaveAttribute("href", "/data-center")
  })
})
