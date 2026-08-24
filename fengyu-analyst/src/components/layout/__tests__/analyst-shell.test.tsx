// @vitest-environment happy-dom

import type { AnchorHTMLAttributes, ReactNode } from "react"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AnalystShell } from "@/components/layout/analyst-shell"
import type { AuthSession } from "@/lib/types"

let mockPathname = "/dashboard"
let mockSearchParams = new URLSearchParams()
const storage = new Map<string, string>()

const localStorageMock = {
  get length() {
    return storage.size
  },
  clear: () => storage.clear(),
  getItem: (key: string) => storage.get(key) ?? null,
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  removeItem: (key: string) => {
    storage.delete(key)
  },
  setItem: (key: string, value: string) => {
    storage.set(key, String(value))
  },
} satisfies Storage

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => mockSearchParams,
}))

vi.mock("next/link", () => ({
  default: ({
    href,
    onNavigate,
    onClick,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string
    children: ReactNode
    onNavigate?: (event: { preventDefault: () => void }) => void
  }) => (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        event.preventDefault()
        onNavigate?.({ preventDefault: () => undefined })
      }}
    >
      {children}
    </a>
  ),
}))

const session: AuthSession = {
  employeeId: "EMP-1",
  name: "测试用户",
  phone: "13800000000",
  roles: [],
  permissions: {
    actions: ["data_center:dashboard"],
    scopeStoreIds: [],
  },
}

function renderShell(children: ReactNode = <div>原页面内容</div>) {
  return render(<AnalystShell session={session}>{children}</AnalystShell>)
}

describe("AnalystShell 即时导航", () => {
  beforeEach(() => {
    mockPathname = "/dashboard"
    mockSearchParams = new URLSearchParams("metric=repurchase&scope=market&scopeId=MKT-1")
    storage.clear()
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: localStorageMock,
    })
  })

  afterEach(cleanup)

  it("点击指标后立即卸载旧内容、显示目标骨架并更新选中态", () => {
    renderShell()

    const penetrationLink = screen.getByRole("link", { name: "普及率" })
    fireEvent.click(penetrationLink)

    expect(screen.queryByText("原页面内容")).not.toBeInTheDocument()
    expect(screen.getByRole("status", { name: "正在加载普及率" })).toBeInTheDocument()
    expect(penetrationLink).toHaveClass("bg-neutral-100")
    expect(penetrationLink).toHaveAttribute(
      "href",
      "/dashboard?metric=penetration&scope=market&scopeId=MKT-1",
    )
  })

  it("目标路由提交后清除骨架并展示新页面", async () => {
    const view = renderShell()
    fireEvent.click(screen.getAllByRole("link", { name: "助手" })[0])
    expect(screen.getByRole("status", { name: "正在加载助手" })).toBeInTheDocument()

    mockPathname = "/assistant"
    mockSearchParams = new URLSearchParams()
    view.rerender(
      <AnalystShell session={session}>
        <div>助手页面内容</div>
      </AnalystShell>,
    )

    await waitFor(() => {
      expect(screen.getByText("助手页面内容")).toBeInTheDocument()
    })
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("点击当前地址不进入加载态", () => {
    renderShell()

    fireEvent.click(screen.getByRole("link", { name: "复购率" }))

    expect(screen.getByText("原页面内容")).toBeInTheDocument()
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("桌面端和移动端看板菜单都保留当前组织范围", () => {
    renderShell()

    for (const link of screen.getAllByRole("link", { name: "看板" })) {
      expect(link).toHaveAttribute("href", "/dashboard?scope=market&scopeId=MKT-1")
    }
  })

  it("快速连续点击时始终以最后一个菜单为准", () => {
    renderShell()

    fireEvent.click(screen.getAllByRole("link", { name: "助手" })[0])
    fireEvent.click(screen.getAllByRole("link", { name: "知识库" })[0])

    expect(screen.queryByRole("status", { name: "正在加载助手" })).not.toBeInTheDocument()
    expect(screen.getByRole("status", { name: "正在加载知识库" })).toBeInTheDocument()
    const knowledgeLinks = screen.getAllByRole("link", { name: "知识库" })
    expect(knowledgeLinks.some((link) => link.classList.contains("bg-[var(--accent)]"))).toBe(true)
    expect(knowledgeLinks.some((link) => link.classList.contains("text-[var(--primary)]"))).toBe(true)
  })
})
