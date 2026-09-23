// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AnalystErrorState, DIGEST_PATTERN_SOURCE } from "@/components/analyst-error-state"

const mockRefresh = vi.fn()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}))

beforeEach(() => {
  mockRefresh.mockClear()
})
afterEach(cleanup)

describe("AnalystErrorState · digest 白名单（#316 验收 3）", () => {
  it("正则字面量锚定——与 admin 侧那份刻意副本须一致", () => {
    // 跨端共享目录已 veto，两份各留一份。断言写死字面量，改一边不同步另一边时这里先红。
    // admin 侧同源实现在 fengyu-admin/src/app/(main)/error.tsx。
    expect(DIGEST_PATTERN_SOURCE).toBe("^\\d{1,10}(?:@E\\d{1,6})?$")
  })

  it("Next 自动生成的编号照常展示，方便用户报障时对上服务端日志", () => {
    render(<AnalystErrorState digest="1234567890" reset={() => {}} layout="section" />)
    expect(screen.getByText(/错误编号：1234567890/)).toBeInTheDocument()
  })

  it("15.5 起带 @E<数字> 后缀的编号同样放行", () => {
    render(<AnalystErrorState digest="42@E404" reset={() => {}} layout="section" />)
    expect(screen.getByText(/错误编号：42@E404/)).toBeInTheDocument()
  })

  // ⚠️ 用 it.each 而不是循环：循环挂掉时只报 it 名，看不出是哪条样本。
  it.each([
    ["含冒号空格的业务错误串", "INVALID_STATE: CLIENT_SECRET is not configured"],
    ["原始 SQL", 'select * from "staff_wechat_users" where "employee_id" = $1'],
    ["连接串（含口令）", "postgresql://fengyu:fengyu123@localhost:5432/fengyu"],
    ["带空格的底层错误", "ECONNREFUSED 127.0.0.1:5432"],
    // ↓ 这四条是闸门 1 boundary-critic 实测能绕过初稿正则的：`[\w-]*` 含 `_` 与 `-`，
    //   于是任何 snake_case / kebab-case 技术串都整串放行。收紧成 @E<数字> 后才挡住。
    ["snake_case 的底层错误（初稿会放行）", "1@ECONNREFUSED_127-0-0-1_5432"],
    ["snake_case 的连接串（初稿会放行）", "0@postgresql_fengyu_fengyu123_localhost_5432"],
    ["snake_case 的业务串（初稿会放行）", "1@INVALID_STATE_CLIENT_SECRET_not_configured"],
    ["无上界的长后缀（初稿会放行，撑破卡片）", `1@${"a".repeat(60)}`],
  ])("⚠️ digest 是 %s 时整段不渲染——这是防泄漏的唯一闸门", (_label, leaky) => {
    render(<AnalystErrorState digest={leaky} reset={() => {}} layout="section" />)
    expect(screen.queryByText(/错误编号/)).not.toBeInTheDocument()
  })

  it("11 位纯数字不放行（超出 stringHash 的 uint32 十进制位数）", () => {
    render(<AnalystErrorState digest="12345678901" reset={() => {}} layout="section" />)
    expect(screen.queryByText(/错误编号/)).not.toBeInTheDocument()
  })

  it("没有 digest 时不渲染空的编号行", () => {
    render(<AnalystErrorState reset={() => {}} layout="section" />)
    expect(screen.queryByText(/错误编号/)).not.toBeInTheDocument()
  })

  it("⚠️ digest 不是字符串时不得进入渲染——否则错误边界自己会崩", () => {
    // TS 声明是 string | undefined，运行时不保证。`RE.test()` 的隐式 String() 会让
    // `{ toString: () => "123" }` 通过，随后 React 渲染对象抛
    // "Objects are not valid as a React child"——边界自身崩溃会冒泡到上一层，
    // 根段那层则直接退回 Next 内建页，等于 #316 白修。守卫是 typeof === "string"。
    const objectDigest = { toString: () => "123" } as unknown as string
    expect(() =>
      render(<AnalystErrorState digest={objectDigest} reset={() => {}} layout="section" />),
    ).not.toThrow()
    expect(screen.queryByText(/错误编号/)).not.toBeInTheDocument()
  })
})

describe("AnalystErrorState · 重试真的会重新取数（#316 验收 2）", () => {
  it("⚠️ 点重试必须同时 router.refresh() 与 reset()，光调 reset 救不回 RSC 错误", () => {
    // Next 15 的 reset 实现只有 setState({ error: null })
    // （next/dist/client/components/error-boundary.js，全文无 router.refresh / 无 refetch）。
    // 三个看板都是 async server component，清掉 error state 后重渲染的是同一份已出错的
    // RSC payload，use(rsc) 会同步重抛 —— 画面纹丝不动，DB 恢复也不自愈。
    // 这条钉住「refresh 先于 reset」的组合，别把任何一半删掉。
    const reset = vi.fn()
    render(<AnalystErrorState reset={reset} layout="section" />)

    fireEvent.click(screen.getByRole("button", { name: "重试" }))

    expect(mockRefresh).toHaveBeenCalledTimes(1)
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it("文案不承诺「通常就能恢复」，只说会重新取数", () => {
    // 初稿写的是「点『重试』通常就能恢复」，在 reset 不刷新的实现下是假承诺。
    render(<AnalystErrorState reset={() => {}} layout="section" />)
    expect(screen.getByText(/点「重试」可重新取数/)).toBeInTheDocument()
  })

  it("文案说明「数据加载失败」，不回显任何原始错误内容", () => {
    render(<AnalystErrorState digest="123" reset={() => {}} layout="section" />)
    expect(screen.getByText("数据加载失败")).toBeInTheDocument()
  })
})

describe("AnalystErrorState · 可访问性", () => {
  it("role=alert 只圈住文本，不圈交互控件", () => {
    // alert 隐含 aria-live=assertive + aria-atomic：把按钮圈进去，部分屏幕阅读器
    // 会把「重试」当静态文本一口气念掉，用户听不出那是可聚焦的。
    render(<AnalystErrorState digest="123" reset={() => {}} layout="page" />)
    const alert = screen.getByRole("alert")

    expect(alert).toHaveTextContent("数据加载失败")
    expect(alert.querySelector("button")).toBeNull()
    expect(alert.querySelector("a")).toBeNull()
  })

  it("标题可聚焦并在挂载时拿到焦点——否则键盘/读屏用户没有落点", () => {
    render(<AnalystErrorState reset={() => {}} layout="section" />)
    const heading = screen.getByRole("heading", { name: "数据加载失败" })

    expect(heading).toHaveAttribute("tabindex", "-1")
    expect(heading).toHaveFocus()
  })
})

describe("AnalystErrorState · 两种外壳（#316 验收 4）", () => {
  it("段级不给「返回」链接——外壳导航还在，用户本来就能切", () => {
    render(<AnalystErrorState reset={() => {}} layout="section" />)
    expect(screen.queryByRole("link")).not.toBeInTheDocument()
  })

  it("⚠️ 整页级的出口指向 analyst 之外，不能指回 /dashboard", () => {
    // 走到根段边界说明 (main)/layout.tsx 挂了，而 /dashboard 就在 (main) 段里——
    // 点它必然再跑一遍同一个 layout、转回同一张错误页，是个假出口。
    render(<AnalystErrorState reset={() => {}} layout="page" />)
    const link = screen.getByRole("link", { name: "返回管理后台" })

    expect(link).toBeInTheDocument()
    expect(link.getAttribute("href")).not.toBe("/dashboard")
  })

  it("整页级铺满视口、段级不铺满（后者要嵌在外壳的内容区里）", () => {
    const { container: page } = render(<AnalystErrorState reset={() => {}} layout="page" />)
    expect(page.firstElementChild).toHaveClass("min-h-screen")
    cleanup()
    const { container: section } = render(<AnalystErrorState reset={() => {}} layout="section" />)
    expect(section.firstElementChild).not.toHaveClass("min-h-screen")
  })
})
