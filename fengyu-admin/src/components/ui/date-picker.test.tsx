import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { DatePicker, DateTimePicker } from "./date-picker"

describe("DatePicker", () => {
  it("固定使用中文展示并保留 YYYY-MM-DD 表单值", async () => {
    const user = userEvent.setup()
    const { container } = render(
      <form>
        <DatePicker name="serviceDate" value="2026-05-20" aria-label="服务日期" />
      </form>,
    )

    expect(screen.getByRole("button", { name: "服务日期" })).toHaveTextContent("2026年5月20日")
    expect(container.querySelector('input[name="serviceDate"]')).toHaveValue("2026-05-20")

    await user.click(screen.getByRole("button", { name: "服务日期" }))
    const dialog = screen.getByRole("dialog", { name: "选择日期" })
    expect(dialog).toHaveAttribute("lang", "zh-CN")
    expect(within(dialog).getByRole("button", { name: "上个月" })).toBeInTheDocument()
    expect(within(dialog).getByRole("button", { name: "下个月" })).toBeInTheDocument()
    expect(within(dialog).getByText("周一")).toBeInTheDocument()
    expect(within(dialog).getByRole("option", { name: "5月" })).toBeInTheDocument()
    expect(within(dialog).getByRole("option", { name: "2026年" })).toBeInTheDocument()
  })

  it("选择日期后回传既有接口格式并关闭弹层", async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(<DatePicker value="2026-05-20" onValueChange={onValueChange} aria-label="选择服务日期" />)

    await user.click(screen.getByRole("button", { name: "选择服务日期" }))
    const dialog = screen.getByRole("dialog", { name: "选择日期" })
    await user.click(within(dialog).getByRole("button", { name: /2026年5月21日/ }))

    expect(onValueChange).toHaveBeenCalledWith("2026-05-21")
    expect(screen.queryByRole("dialog", { name: "选择日期" })).not.toBeInTheDocument()
  })

  it("用户修改值时从隐藏字段向表单冒泡 input 和 change 事件", async () => {
    const user = userEvent.setup()
    const onInput = vi.fn()
    const events: string[] = []
    const { container } = render(
      <form data-testid="form" onInput={onInput}>
        <DatePicker name="openingDate" defaultValue="2026-05-20" aria-label="开业日期" />
      </form>,
    )
    const form = screen.getByTestId("form")
    form.addEventListener("input", (event) => {
      events.push(`input:${(event.target as HTMLInputElement).value}`)
    })
    form.addEventListener("change", (event) => {
      events.push(`change:${(event.target as HTMLInputElement).value}`)
    })

    await user.click(screen.getByRole("button", { name: "开业日期" }))
    await user.click(
      within(screen.getByRole("dialog", { name: "选择日期" })).getByRole("button", {
        name: /2026年5月21日/,
      }),
    )

    expect(container.querySelector('input[name="openingDate"]')).toHaveValue("2026-05-21")
    expect(onInput).toHaveBeenCalledOnce()
    expect(events).toEqual(["input:2026-05-21", "change:2026-05-21"])
  })

  it("支持默认值、清空和 FormData 提交", async () => {
    const user = userEvent.setup()
    const { container } = render(
      <form data-testid="form">
        <DatePicker name="openingDate" defaultValue="2026-08-13" aria-label="开业日期" />
      </form>,
    )

    const form = screen.getByTestId("form") as HTMLFormElement
    expect(new FormData(form).get("openingDate")).toBe("2026-08-13")

    await user.click(screen.getByRole("button", { name: "清空日期" }))
    expect(new FormData(form).get("openingDate")).toBe("")
    expect(container.querySelector('input[name="openingDate"]')).toHaveValue("")
    expect(screen.getByRole("button", { name: "开业日期" })).toHaveTextContent("请选择日期")
  })

  it("遵守 min/max 日期边界", async () => {
    const user = userEvent.setup()
    render(
      <DatePicker
        value="2026-05-20"
        min="2026-05-20"
        max="2026-05-21"
        aria-label="边界日期"
      />,
    )

    await user.click(screen.getByRole("button", { name: "边界日期" }))
    const dialog = screen.getByRole("dialog", { name: "选择日期" })
    expect(within(dialog).getByRole("button", { name: /2026年5月19日/ })).toBeDisabled()
    expect(within(dialog).getByRole("button", { name: /2026年5月20日/ })).not.toBeDisabled()
    expect(within(dialog).getByRole("button", { name: /2026年5月22日/ })).toBeDisabled()
  })

  it("按 Escape 关闭并把焦点还给触发按钮", async () => {
    const user = userEvent.setup()
    render(<DatePicker aria-label="生日" />)
    const trigger = screen.getByRole("button", { name: "生日" })

    await user.click(trigger)
    await user.keyboard("{Escape}")

    expect(screen.queryByRole("dialog", { name: "选择日期" })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
})

describe("DateTimePicker", () => {
  it("使用中文日期和 24 小时制，确认后输出 datetime-local 格式", async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(
      <DateTimePicker
        value="2026-05-20T09:30"
        onValueChange={onValueChange}
        aria-label="请假开始"
      />,
    )

    expect(screen.getByRole("button", { name: "请假开始" })).toHaveTextContent("2026年5月20日 09:30")
    await user.click(screen.getByRole("button", { name: "请假开始" }))
    const dialog = screen.getByRole("dialog", { name: "选择日期和时间" })
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "小时" }), "18")
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "分钟" }), "45")
    await user.click(within(dialog).getByRole("button", { name: /2026年5月21日/ }))
    await user.click(within(dialog).getByRole("button", { name: "确定" }))

    expect(onValueChange).toHaveBeenCalledWith("2026-05-21T18:45")
    expect(screen.queryByRole("dialog", { name: "选择日期和时间" })).not.toBeInTheDocument()
  })

  it("取消时不修改原值，清空时回传空串", async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(
      <DateTimePicker
        value="2026-05-20T09:30"
        onValueChange={onValueChange}
        aria-label="请假结束"
      />,
    )

    await user.click(screen.getByRole("button", { name: "请假结束" }))
    await user.selectOptions(screen.getByRole("combobox", { name: "小时" }), "18")
    await user.click(screen.getByRole("button", { name: "取消" }))
    expect(onValueChange).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "清空日期" }))
    expect(onValueChange).toHaveBeenCalledWith("")
  })
})
