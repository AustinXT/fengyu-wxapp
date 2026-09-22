import { describe, expect, it } from "vitest"
import { NO_BASE_TEXT, formatDeltaPart, formatMetricDelta } from "../metric-delta"

describe("formatDeltaPart · 负基期（#307）", () => {
  it("基期为负、当期回正时不输出翻转的百分比", () => {
    // #283 admin 侧实测案例：南昌梦祥店「本周」业绩，基期 −2,646.00、当期 +264.00。
    // 旧式 (264 − (−2646)) / (−2646) = −1.0998 → 渲染成 −110.0%「下降」，方向恰好反了。
    expect(formatDeltaPart(264, -2646, "money")).toBe(NO_BASE_TEXT)
    expect(formatDeltaPart(264, -2646, "count")).toBe(NO_BASE_TEXT)
  })

  it("基期为负、当期更负时同样不出数（分母为负，倍数无意义）", () => {
    // 旧式 (−5000 − (−1000)) / (−1000) = +4 → 渲染成 +400.0%「增长」，同样反了。
    expect(formatDeltaPart(-5000, -1000, "money")).toBe(NO_BASE_TEXT)
  })

  it("基期为负、当期为 0 时不出数", () => {
    // 旧式 (0 − (−100)) / (−100) = −1 → −100.0%，看着像「归零」其实是回正。
    expect(formatDeltaPart(0, -100, "money")).toBe(NO_BASE_TEXT)
  })

  it("基期为 0 维持原行为", () => {
    expect(formatDeltaPart(100, 0, "money")).toBe(NO_BASE_TEXT)
    expect(formatDeltaPart(0, 0, "count")).toBe(NO_BASE_TEXT)
  })

  it("正基期照常出数（对照组，确认守卫没误伤）", () => {
    expect(formatDeltaPart(120, 100, "money")).toBe("+20.0%")
    expect(formatDeltaPart(80, 100, "count")).toBe("-20.0%")
    expect(formatDeltaPart(100, 100, "money")).toBe("持平")
    // 当期为负、基期为正是合法的下跌，必须照常出数——守卫只看基期。
    expect(formatDeltaPart(-50, 100, "money")).toBe("-150.0%")
  })
})

describe("formatDeltaPart · 非有限值", () => {
  it("基期为 NaN / ±Infinity 时返回无基数，不渲染 NaN%", () => {
    // 旧式：NaN === 0 为 false → 漏进除法 → (100 − NaN)/NaN = NaN → "NaN%"。
    expect(formatDeltaPart(100, Number.NaN, "money")).toBe(NO_BASE_TEXT)
    expect(formatDeltaPart(100, Number.POSITIVE_INFINITY, "money")).toBe(NO_BASE_TEXT)
    expect(formatDeltaPart(100, Number.NEGATIVE_INFINITY, "money")).toBe(NO_BASE_TEXT)
  })

  it("当期为 NaN / ±Infinity 时返回无基数，不渲染 +Infinity%", () => {
    // 旧式：(Infinity − 5)/5 = Infinity → "+Infinity%"。
    expect(formatDeltaPart(Number.NaN, 100, "money")).toBe(NO_BASE_TEXT)
    expect(formatDeltaPart(Number.POSITIVE_INFINITY, 5, "money")).toBe(NO_BASE_TEXT)
  })

  it("rate 分支同样挡住非有限值", () => {
    expect(formatDeltaPart(0.5, Number.NaN, "rate")).toBe(NO_BASE_TEXT)
    expect(formatDeltaPart(Number.NaN, 0.5, "rate")).toBe(NO_BASE_TEXT)
  })
})

describe("formatDeltaPart · rate 分支维持现状（#307 AC3）", () => {
  it("负基期仍按百分点差值出数——减法不翻转符号", () => {
    // 与 money/count 分支刻意不同：rate 走 current − previous，没有除法。
    expect(formatDeltaPart(0.1, -0.05, "rate")).toBe("+15.0pct")
    expect(formatDeltaPart(-0.2, -0.05, "rate")).toBe("-15.0pct")
  })

  it("基期为 0 仍返回无基数（改动前就有的行为，未动）", () => {
    expect(formatDeltaPart(0.1, 0, "rate")).toBe(NO_BASE_TEXT)
  })

  it("正常百分点差值与持平", () => {
    expect(formatDeltaPart(0.3, 0.2, "rate")).toBe("+10.0pct")
    expect(formatDeltaPart(0.2, 0.3, "rate")).toBe("-10.0pct")
    expect(formatDeltaPart(0.2, 0.2, "rate")).toBe("持平")
  })
})

describe("formatMetricDelta · 同比与环比两路都被覆盖（#307 AC2）", () => {
  it("同比基期为负、环比基期为正时，只有同比那半句变成无基数", () => {
    const result = formatMetricDelta(264, -2646, 200, "money")
    expect(result.text).toBe(`同比 ${NO_BASE_TEXT} / 环比 +32.0%`)
  })

  it("环比基期为负、同比基期为正时，只有环比那半句变成无基数", () => {
    const result = formatMetricDelta(264, 200, -2646, "money")
    expect(result.text).toBe(`同比 +32.0% / 环比 ${NO_BASE_TEXT}`)
  })

  it("两路基期都为负时两句都是无基数", () => {
    expect(formatMetricDelta(264, -2646, -100, "money").text).toBe(`同比 ${NO_BASE_TEXT} / 环比 ${NO_BASE_TEXT}`)
  })
})

describe("formatMetricDelta · tone 判定（#307 AC5）", () => {
  it("负基期下颜色依然正确——tone 走直接比大小，不经除法", () => {
    // 由负回正 = 向好 = 绿。文案给不出倍数，但方向不能丢。
    expect(formatMetricDelta(264, -2646, 200, "money").tone).toBe("positive")
    // 负得更深 = 变坏 = 红。
    expect(formatMetricDelta(-5000, -1000, 200, "money").tone).toBe("negative")
  })

  it("正基期下的常规涨跌", () => {
    expect(formatMetricDelta(120, 100, 100).tone).toBe("positive")
    expect(formatMetricDelta(80, 100, 100).tone).toBe("negative")
    expect(formatMetricDelta(100, 100, 100).tone).toBe("default")
  })

  it("同比基期为 0 时不判方向", () => {
    expect(formatMetricDelta(120, 0, 100).tone).toBe("default")
  })

  it("非有限值不判方向，不会渲染成红色「下降」", () => {
    // 旧式：current > NaN 恒 false → tone 落到 negative，脏数据被涂成红色。
    expect(formatMetricDelta(120, Number.NaN, 100).tone).toBe("default")
    expect(formatMetricDelta(Number.NaN, 100, 100).tone).toBe("default")
    expect(formatMetricDelta(120, Number.POSITIVE_INFINITY, 100).tone).toBe("default")
  })

  it("默认 type 为 count", () => {
    expect(formatMetricDelta(120, 100, 100).text).toBe("同比 +20.0% / 环比 +20.0%")
  })
})
