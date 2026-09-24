import { render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DATA_CENTER_BOARD_LABELS, DATA_CENTER_TABS } from "@/lib/data-center/params"
import { DATA_CENTER_REPORT_LIST } from "@/lib/data-center/reports"

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

  // 经营明细报表（#367）：入口未打开（menu.enabled=false）时父级「数据中心」仍由 MENU_CONFIG 推出
  // （getMenuParentForPath 不看 hidden），深链进来的面包屑与入口打开后一致。
  it.each(DATA_CENTER_REPORT_LIST.filter((report) => !report.parent))(
    "经营明细报表 $path 显示「数据中心 / 报表名」两级",
    (report) => {
      nav.pathname = report.path
      nav.search = ""
      render(<BreadcrumbNav />)

      const nodes = screen.getByRole("navigation", { name: "面包屑导航" })
      expect(nodes).toHaveTextContent(`数据中心${report.title}`)
      expect(nodes).not.toHaveTextContent("详情")
    },
  )

  it("提成明细显示「数据中心 / 员工提成日报 / 提成明细」，中间一级可点且恢复下钻前的筛选", () => {
    const returnTo = "/data-center/commission-daily?month=2026-08&scope=market&scopeId=M1"
    nav.pathname = "/data-center/commission-daily/detail"
    nav.search = new URLSearchParams({ returnTo, employeeId: "E1" }).toString()
    render(<BreadcrumbNav />)

    const nodes = screen.getByRole("navigation", { name: "面包屑导航" })
    expect(nodes).toHaveTextContent("数据中心员工提成日报提成明细")
    expect(screen.getByRole("link", { name: "员工提成日报" })).toHaveAttribute("href", returnTo)
    expect(screen.queryByRole("link", { name: "提成明细" })).not.toBeInTheDocument()
  })

  it("提成明细没有 returnTo 时中间一级回到日报默认页", () => {
    nav.pathname = "/data-center/commission-daily/detail"
    nav.search = ""
    render(<BreadcrumbNav />)

    expect(screen.getByRole("link", { name: "员工提成日报" })).toHaveAttribute("href", "/data-center/commission-daily")
  })
})
