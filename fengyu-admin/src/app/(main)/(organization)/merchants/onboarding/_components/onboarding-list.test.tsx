import { afterEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import type { OnboardingListItem } from "@/actions/lakala-onboarding"

const setMany = vi.fn()
const values: Record<string, string> = {}

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock("next/link", () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }))
vi.mock("@/components/return-context", () => ({
  PreserveListContextLink: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
  ReturnContextLink: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}))
vi.mock("@/lib/hooks/use-url-filters", () => ({
  useUrlFilters: () => ({ get: (key: string, fallback = "") => values[key] ?? fallback, setMany }),
}))

import { OnboardingList } from "./onboarding-page"

afterEach(() => {
  vi.useRealTimers()
  setMany.mockClear()
  for (const key of Object.keys(values)) delete values[key]
})

describe("入网申请列表筛选和分页", () => {
  it("资料保存中的申请在列表使用与筛选一致的业务状态和待办", () => {
    const application = {
      id: "app-uploading", orderNo: "ONB-2", storeName: "测试店", marketName: "测试市场",
      subjectName: "未填写", status: "FILES_UPLOADING", statusGroup: "missing",
      updatedAt: "2026-09-30T00:00:00.000Z", channelData: {},
    } as OnboardingListItem
    render(<OnboardingList
      applications={[application]}
      total={1}
      counts={{ missing: 1, ready: 0, reviewing: 0, completed: 0 }}
      filterOptions={{ markets: [], stores: [] }}
    />)

    expect(screen.getByText("待补资料", { selector: "span" })).toBeInTheDocument()
    expect(screen.getByText("请确认资料和附件已保存")).toBeInTheDocument()
    expect(screen.queryByText("资料保存中")).not.toBeInTheDocument()
  })

  it("刚好 20 条时仍显示页码和每页条数，可切换到每页 10 条", () => {
    render(<OnboardingList
      applications={[]}
      total={20}
      counts={{ missing: 0, ready: 0, reviewing: 0, completed: 20 }}
      filterOptions={{ markets: [], stores: [] }}
    />)

    expect(screen.getByRole("button", { name: "1" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled()
    fireEvent.change(screen.getByRole("combobox", { name: "每页条数" }), { target: { value: "10" } })
    expect(setMany).toHaveBeenCalledWith({ osize: "10", opage: "1" })
  })

  it("筛选条件与页码使用独立的入网 URL 参数", async () => {
    vi.useFakeTimers()
    values.opage = "2"
    const applications = [{
      id: "app-1", orderNo: "ONB-1", storeName: "蓝茉店", marketName: "南昌凤御",
      subjectName: "蓝茉美容院", status: "DRAFT", updatedAt: "2026-09-30T00:00:00.000Z",
      channelData: {},
    }] as OnboardingListItem[]
    render(<OnboardingList
      applications={applications}
      total={42}
      counts={{ missing: 5, ready: 0, reviewing: 0, completed: 21 }}
      filterOptions={{ markets: [{ marketId: "m1", marketName: "南昌凤御" }], stores: [{ storeId: "s1", storeName: "蓝茉店", marketId: "m1", marketName: "南昌凤御" }] }}
    />)

    fireEvent.change(screen.getByRole("textbox", { name: "搜索入网申请" }), { target: { value: "蓝茉" } })
    await act(async () => { vi.advanceTimersByTime(300) })
    expect(setMany).toHaveBeenCalledWith({ oq: "蓝茉", opage: "" })

    fireEvent.change(screen.getByRole("combobox", { name: "入网申请状态" }), { target: { value: "missing" } })
    expect(setMany).toHaveBeenCalledWith({ ostatus: "missing", opage: "" })
    expect(screen.getAllByRole("option").filter((option) => option.closest("select")?.getAttribute("aria-label") === "入网申请状态").map((option) => option.textContent)).toEqual([
      "全部状态", "待补资料", "待提交", "拉卡拉审核中", "办理完成",
    ])

    fireEvent.click(screen.getByRole("button", { name: "下一页" }))
    expect(setMany).toHaveBeenCalledWith({ opage: "3" })
    expect(screen.getByText("共 42 条")).toBeInTheDocument()
    expect(screen.getByText("21")).toBeInTheDocument()
  })
})
