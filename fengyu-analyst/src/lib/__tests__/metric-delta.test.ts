import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  NO_BASE_TEXT,
  NO_LAST_YEAR_TEXT,
  formatDeltaPart,
  formatMetricDelta,
  formatPointDelta,
} from "../metric-delta"

// 非有限值分支会 console.warn（有意的可观测性设计，见模块内 warnNonFinite 的注释）。
// 这里静音它，避免测试输出被刷屏；专门断言告警的用例自己开 spy。
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
})

describe("文案常量锚定", () => {
  // 断言若只写 toBe(NO_BASE_TEXT)，文案被改坏时测试仍全绿（断言与实现共用真相源）。
  // 这两条是唯一锚定字面量的地方，改文案必须从这里过一道。
  it("文案串本身钉住字面量", () => {
    expect(NO_BASE_TEXT).toBe("无基数")
    expect(NO_LAST_YEAR_TEXT).toBe("无上一年对比")
    // 两者刻意不合并：「基期不可用」≠「上一年区间根本不存在」。
    expect(NO_BASE_TEXT).not.toBe(NO_LAST_YEAR_TEXT)
  })
})

describe("formatDeltaPart · 负基期（#307）", () => {
  it("基期为负、当期回正时不输出翻转的百分比", () => {
    // #283 admin 侧实测案例：南昌梦祥店「本周」业绩，基期 −2,646.00、当期 +264.00。
    // 旧式 (264 − (−2646)) / (−2646) = −1.0998 → 渲染成 −110.0%「下降」，方向恰好反了。
    expect(formatDeltaPart(264, -2646, "money")).toBe(NO_BASE_TEXT)
    // count 与 money 走同一条分支，输出逐字相同（模块头「count 与 money 行为完全相同」）。
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

  it("基期为负零走「基期为 0」分支而不是「基期为负」分支", () => {
    // -0 是**可达**的：round2(-0.004) = Math.round(-0.4)/100 = -0。
    // `-0 === 0` 为 true，所以落在 previous === 0 上；两条路都返回无基数，语义一致。
    expect(Object.is(Math.round(-0.004 * 100) / 100, -0)).toBe(true)
    expect(formatDeltaPart(100, -0, "money")).toBe(NO_BASE_TEXT)
  })

  it("当期为负零时不会渲染出 -0.0%", () => {
    // (-0 * 100).toFixed(1) 是 "0.0" 不是 "-0.0"；且 delta === 0 会先命中「持平」。
    expect(formatDeltaPart(-0, 100, "money")).toBe("-100.0%")
    expect(formatDeltaPart(100, 100, "money")).toBe("持平")
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

  it("入参有限但商溢出时也挡住", () => {
    // 入参各自有限，商仍可 Infinity：1 / 1e-320 溢出。
    // analyst 侧不可达（previous 来自 round2，最小非零正值 0.01），
    // 钉的是对外导出模块的契约——只挡入参等于守卫只做了一半。
    expect(Number.isFinite(1e-320)).toBe(true)
    expect(formatDeltaPart(1, 1e-320, "money")).toBe(NO_BASE_TEXT)
  })

  it("非有限值会落一条 console.warn（bug 信号不能被静默吞掉）", () => {
    warnSpy.mockClear()
    formatDeltaPart(100, Number.NaN, "money")
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toContain("metric-delta")
  })

  it("正常路径不产生任何 console.warn", () => {
    warnSpy.mockClear()
    formatDeltaPart(120, 100, "money")
    formatDeltaPart(100, 0, "money")
    formatDeltaPart(264, -2646, "money")
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe("formatDeltaPart · rate 分支维持现状（#307 AC3）", () => {
  it("负基期仍按百分点差值出数——减法不翻转符号", () => {
    // 与 money/count 分支刻意不同：rate 走 current − previous，没有除法。
    // ⚠️ 该输入在 analyst **当前数据通路不可达**：rate 型 previous 全部来自 safeRate
    //    （new-customer-funnel-utils.ts:90-92），分子分母都是数组长度 ≥ 0，故 previous 恒 ≥ 0。
    //    这里钉的是**模块契约**，不是生产场景——别据此以为 rate 负基期真的会出现。
    expect(formatDeltaPart(0.1, -0.05, "rate")).toBe("+15.0pct")
    expect(formatDeltaPart(-0.2, -0.05, "rate")).toBe("-15.0pct")
  })

  it("基期为 0 仍返回无基数（改动前就有的行为，未动）", () => {
    // ⚠️ 已知代价：「到店率 0% → 30%」被吞成无基数，而「30% → 0%」照常出 -30.0pct，
    //    涨跌不对称。新店/新市场的同比基期必然全 0，命中不低。已另行登记，不在 #307 范围内。
    expect(formatDeltaPart(0.3, 0, "rate")).toBe(NO_BASE_TEXT)
    expect(formatDeltaPart(0, 0.3, "rate")).toBe("-30.0pct")
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

  it("tone 刻意不查 prevPeriod——环比脏了不影响同比方向", () => {
    // 这是全模块唯一一处「守卫覆盖面不一致」，是设计不是漏网：
    // tone 的定义就是同比方向。钉住它，防止后来者「顺手补齐」把正确行为改坏。
    const result = formatMetricDelta(120, 100, Number.NaN)
    expect(result.text).toBe(`同比 +20.0% / 环比 ${NO_BASE_TEXT}`)
    expect(result.tone).toBe("positive")
  })

  it("默认 type 为 count", () => {
    expect(formatMetricDelta(120, 100, 100).text).toBe("同比 +20.0% / 环比 +20.0%")
  })
})

describe("formatPointDelta · 百分点差值型同比徽章（sibling audit P1）", () => {
  it("非有限值不再渲染成红色「下降」", () => {
    // 旧式：NaN > 0 恒 false → tone negative（红），文案 "同比 NaNpct"。
    // 上游 repurchase.ts 的 round4(repurchaseRate - prevYearRate) 不挡 NaN。
    const result = formatPointDelta(Number.NaN)
    expect(result.text).toBe(NO_LAST_YEAR_TEXT)
    expect(result.tone).toBe("default")
    expect(formatPointDelta(Number.POSITIVE_INFINITY).tone).toBe("default")
  })

  it("非有限值同样落 console.warn", () => {
    warnSpy.mockClear()
    formatPointDelta(Number.NaN)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it("null 表示上一年区间不存在，用独立文案而非「无基数」", () => {
    const result = formatPointDelta(null)
    expect(result.text).toBe(NO_LAST_YEAR_TEXT)
    expect(result.tone).toBe("default")
  })

  it("正常涨跌与持平（对照组，确认守卫没误伤）", () => {
    expect(formatPointDelta(0.1)).toEqual({ text: "同比 +10.0pct", tone: "positive" })
    expect(formatPointDelta(-0.1)).toEqual({ text: "同比 -10.0pct", tone: "negative" })
    expect(formatPointDelta(0)).toEqual({ text: "同比持平", tone: "default" })
  })
})
