// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import MainError from "@/app/(main)/error"
import RootError from "@/app/error"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

// 两个 wrapper 的 useEffect 都会 console.error 完整 Error（有意的可观测性设计）。
// 这里静音，避免每次渲染往 stderr 刷 stack 噪音——与 admin 侧 error.test.tsx 的做法一致。
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(cleanup)

/**
 * 这两个文件本身只是薄 wrapper，但**接线传反了不会有任何别的测试发现**
 * （共用组件的测试直接传 `layout`，绕过了 wrapper）——#316 闸门 2 GLM 指出的覆盖缺口。
 *
 * 两层的分工是本 PR 的核心设计：
 * - `(main)/error.tsx` 兜三个看板的数据加载错，**外壳还在**，所以不给「返回」出口，也不铺满视口
 * - `app/error.tsx` 兜 `(main)/layout.tsx` 自身的错，**外壳渲染不出来**，所以要整页居中 + 给出口
 */
describe("error 边界的 layout 接线（#316）", () => {
  const error = Object.assign(new Error("boom"), { digest: "1234567890" })

  it("段级 (main)/error.tsx 用 section 外壳：不铺满视口、不给「返回」出口", () => {
    const { container } = render(<MainError error={error} reset={() => {}} />)

    expect(container.firstElementChild).not.toHaveClass("min-h-screen")
    expect(screen.queryByRole("link")).not.toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "数据加载失败" })).toBeInTheDocument()
  })

  it("根段 app/error.tsx 用 page 外壳：铺满视口、给指向站外的真出口", () => {
    const { container } = render(<RootError error={error} reset={() => {}} />)

    expect(container.firstElementChild).toHaveClass("min-h-screen")
    const link = screen.getByRole("link", { name: "返回管理后台" })
    expect(link.getAttribute("href")).toMatch(/^https?:\/\//)
  })

  it("两层都把 digest 透给共用组件的白名单（而不是各自判一遍）", () => {
    render(<MainError error={error} reset={() => {}} />)
    expect(screen.getByText(/错误编号：1234567890/)).toBeInTheDocument()
    cleanup()
    render(<RootError error={error} reset={() => {}} />)
    expect(screen.getByText(/错误编号：1234567890/)).toBeInTheDocument()
  })

  it("两层都不回显原始 error.message", () => {
    // dev 下 message 可能是原始 SQL / 连接串（含口令），prod 下 Next 已脱敏。
    // 组件根本不读 message，这里用一个显眼的串确认它不会出现在 DOM 里。
    const leaky = Object.assign(
      new Error("postgresql://fengyu:fengyu123@localhost:5432/fengyu"),
      { digest: "1234567890" },
    )
    const { container: a } = render(<MainError error={leaky} reset={() => {}} />)
    expect(a.textContent).not.toContain("fengyu123")
    cleanup()
    const { container: b } = render(<RootError error={leaky} reset={() => {}} />)
    expect(b.textContent).not.toContain("fengyu123")
  })
})
