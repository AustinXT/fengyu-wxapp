// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AnalystErrorState } from "@/components/analyst-error-state"

afterEach(cleanup)

describe("AnalystErrorState · digest 白名单（#316 验收 3）", () => {
  it("Next 自动生成的编号照常展示，方便用户报障时对上服务端日志", () => {
    render(<AnalystErrorState digest="1234567890" reset={() => {}} layout="section" />)
    expect(screen.getByText(/错误编号：1234567890/)).toBeInTheDocument()
  })

  it("15.5 起带 @E<码> 后缀的编号同样放行", () => {
    render(<AnalystErrorState digest="42@E404" reset={() => {}} layout="section" />)
    expect(screen.getByText(/错误编号：42@E404/)).toBeInTheDocument()
  })

  it("⚠️ digest 是业务/技术文案时整段不渲染——这是防泄漏的唯一闸门", () => {
    // 生产环境 Next 会脱敏 error.message，但**不碰 digest**。上游若把完整错误串塞进
    // digest（admin 侧实测过 `INVALID_STATE: CLIENT_SECRET is not configured`），
    // 原样渲染就会把技术细节泄漏到页面上。
    for (const leaky of [
      "INVALID_STATE: CLIENT_SECRET is not configured",
      'select * from "staff_wechat_users" where "employee_id" = $1',
      "postgresql://fengyu:fengyu123@localhost:5432/fengyu",
      "ECONNREFUSED 127.0.0.1:5432",
    ]) {
      cleanup()
      render(<AnalystErrorState digest={leaky} reset={() => {}} layout="section" />)
      expect(screen.queryByText(/错误编号/)).not.toBeInTheDocument()
      expect(screen.queryByText(new RegExp(leaky.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).not.toBeInTheDocument()
    }
  })

  it("11 位以上的纯数字不放行（超出 stringHash 的 32 位无符号上界）", () => {
    // 32 位无符号最大 4294967295（10 位）。更长的不是 Next 生成的编号，来路不明就不显示。
    render(<AnalystErrorState digest="123456789012" reset={() => {}} layout="section" />)
    expect(screen.queryByText(/错误编号/)).not.toBeInTheDocument()
  })

  it("没有 digest 时不渲染空的编号行", () => {
    render(<AnalystErrorState reset={() => {}} layout="section" />)
    expect(screen.queryByText(/错误编号/)).not.toBeInTheDocument()
  })
})

describe("AnalystErrorState · 重试与文案（#316 验收 2）", () => {
  it("点「重试」调 reset()，这是多数瞬时抖动的恢复路径", () => {
    const reset = vi.fn()
    render(<AnalystErrorState reset={reset} layout="section" />)

    fireEvent.click(screen.getByRole("button", { name: "重试" }))
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it("文案说明「数据加载失败」，不回显任何原始错误内容", () => {
    render(<AnalystErrorState digest="123" reset={() => {}} layout="section" />)
    expect(screen.getByText("数据加载失败")).toBeInTheDocument()
    expect(screen.getByRole("alert")).toBeInTheDocument()
  })
})

describe("AnalystErrorState · 两种外壳（#316 验收 4）", () => {
  it("段级不给「返回看板」——外壳导航还在，用户本来就能切", () => {
    render(<AnalystErrorState reset={() => {}} layout="section" />)
    expect(screen.queryByRole("link", { name: "返回看板" })).not.toBeInTheDocument()
  })

  it("整页级给「返回看板」——此时外壳没渲染出来，不给出口就真卡死了", () => {
    render(<AnalystErrorState reset={() => {}} layout="page" />)
    expect(screen.getByRole("link", { name: "返回看板" })).toHaveAttribute("href", "/dashboard")
  })

  it("整页级铺满视口、段级不铺满（后者要嵌在外壳的内容区里）", () => {
    const { container: page } = render(<AnalystErrorState reset={() => {}} layout="page" />)
    expect(page.firstElementChild).toHaveClass("min-h-screen")
    cleanup()
    const { container: section } = render(<AnalystErrorState reset={() => {}} layout="section" />)
    expect(section.firstElementChild).not.toHaveClass("min-h-screen")
  })
})
