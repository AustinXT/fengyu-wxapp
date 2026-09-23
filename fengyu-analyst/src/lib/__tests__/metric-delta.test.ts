import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  FLAT_TEXT,
  NO_BASE_TEXT,
  NO_LAST_YEAR_TEXT,
  formatDeltaPart,
  formatMetricDelta,
  formatPointDelta,
  formatPointDeltaValue,
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
    expect(FLAT_TEXT).toBe("持平")
    // 三者刻意不合并：「基期不可用」≠「上一年区间根本不存在」≠「变化量为 0」。
    expect(new Set([NO_BASE_TEXT, NO_LAST_YEAR_TEXT, FLAT_TEXT]).size).toBe(3)
  })
})

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

  it("基期为负零走「基期为 0」分支而不是「基期为负」分支", () => {
    // -0 是**可达**的：round2(-0.004) = Math.round(-0.4)/100 = -0。
    // `-0 === 0` 为 true，所以落在 previous === 0 上；两条路都返回无基数，语义一致。
    expect(Object.is(Math.round(-0.004 * 100) / 100, -0)).toBe(true)
    expect(formatDeltaPart(100, -0, "money")).toBe(NO_BASE_TEXT)
  })

  it("当期为负零时按普通下跌处理，不走任何特殊分支", () => {
    // delta = (-0 − 100) / 100 = −1，与 -0 无关。
    // 「不会渲染出 -0.0%」由 renderScaledDelta 的 `Number(fixed) === 0` 判零保证
    // （`Number("-0.0")` 是 -0，而 -0 === 0 为 true）；delta 本身也取不到 -0——减法 x − x 恒为 +0。
    expect(formatDeltaPart(-0, 100, "money")).toBe("-100.0%")
    expect(Object.is(100 - 100, 0)).toBe(true)
    expect(formatDeltaPart(100, 100, "money")).toBe(FLAT_TEXT)
  })

  it("count 与 money 在除法分支上输出逐字相同", () => {
    // 模块头声明「两者走同一条分支」。上面那条负基期用例两个 type 都在守卫处早退，
    // 走不到除法，钉不住这个结构声明——这里补一组真正进入除法分支的对照。
    expect(formatDeltaPart(120, 100, "count")).toBe(formatDeltaPart(120, 100, "money"))
    expect(formatDeltaPart(80, 100, "count")).toBe(formatDeltaPart(80, 100, "money"))
    expect(formatDeltaPart(120, 100, "count")).toBe("+20.0%")
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

  it("商有限但乘 100 才溢出时也挡住（最阴的一条）", () => {
    // MAX_VALUE / 1 的商是 1.79e308，**有限**；只查 delta 会以为封死了，
    // 实际渲染的是 delta * 100 = Infinity → "+Infinity%"。守卫必须落在最终渲染值上。
    const delta = (Number.MAX_VALUE - 1) / 1
    expect(Number.isFinite(delta)).toBe(true)
    expect(Number.isFinite(delta * 100)).toBe(false)
    expect(formatDeltaPart(Number.MAX_VALUE, 1, "money")).toBe(NO_BASE_TEXT)
  })

  it("rate 分支的减法溢出也挡住", () => {
    // MAX_VALUE − (−MAX_VALUE) = Infinity，入参两个都有限。
    expect(Number.MAX_VALUE - -Number.MAX_VALUE).toBe(Number.POSITIVE_INFINITY)
    expect(formatDeltaPart(Number.MAX_VALUE, -Number.MAX_VALUE, "rate")).toBe(NO_BASE_TEXT)
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

describe("formatDeltaPart · rate 分支不挡零基期也不挡负基期（#314 决策 2）", () => {
  it("负基期仍按百分点差值出数——减法不翻转符号", () => {
    // 与 money/count 分支刻意不同：rate 走 current − previous，没有除法。
    // ⚠️ 该输入在 analyst **当前数据通路不可达**：rate 型 previous 全部来自 safeRate
    //    （new-customer-funnel-utils.ts:90-92），分子分母都是数组长度 ≥ 0，故 previous 恒 ≥ 0。
    //    这里钉的是**模块契约**，不是生产场景——别据此以为 rate 负基期真的会出现。
    expect(formatDeltaPart(0.1, -0.05, "rate")).toBe("+15.0pct")
    expect(formatDeltaPart(-0.2, -0.05, "rate")).toBe("-15.0pct")
  })

  it("基期为 0 照常出百分点差值，涨跌两侧对称", () => {
    // #307 阶段这里返回「无基数」，导致只藏涨不藏跌。#314 决策 2 把守卫挪到 rate 分支之后。
    // 减法不需要非零分母，旧的守卫位置是沿用 count/money 除法分支的历史巧合。
    expect(formatDeltaPart(0.3, 0, "rate")).toBe("+30.0pct")
    expect(formatDeltaPart(0, 0.3, "rate")).toBe("-30.0pct")
  })

  it("⚠️ 割点造成的零基期出数，在历史数据补齐前显示的是伪影而非经营变化", () => {
    // service_orders（已完成）最早 2026-07-08，新客入口走首单（回溯到 2022-08），
    // 分子分母不同源 → 2022–2025 的 1,352 个新客到店恒为 0。
    // ⚠️ 标题写「割点造成的零基期」而非泛指「零基期」：后文还有一类与割点无关的零基期
    //    （safeRate 把「分母为 0」压成 0），那类不随数据补齐消失，别混为一谈。
    // ⚠️ 别把时限写成「2027-01-01 前」：同比基期平移 12 个月，2027 上半年仍命中；
    //    判据是到店观察窗 [entry_date, +90天] 相对 2026-07-08 的三态（模块头有完整说明）。
    // 集团级 2026 到店率 3156/3639 = 86.7% → 同比徽章将渲染成 "+86.7pct" 绿色。
    // 这是**知情选择**（#314 决策 2，量化依据 issuecomment-5788019145，根因登记在 #289），
    // 不是本模块的 bug。钉住它，省得后来者看到夸张正值就来「修」。
    expect(formatDeltaPart(0.867, 0, "rate")).toBe("+86.7pct")
    expect(formatMetricDelta(0.867, 0, 0.8, "rate").tone).toBe("positive")
  })

  it("零基期且当期也是 0 时出「持平」而非「无基数」", () => {
    // 两期都是 0% 确实是持平，减法给得出这个结论——不该再借用除法分支的「无基数」。
    expect(formatDeltaPart(0, 0, "rate")).toBe(FLAT_TEXT)
  })

  it("count / money 的零基期**不受影响**，仍是无基数（守卫只对 rate 让路）", () => {
    // 决策 2 只松开 rate；除法分支的零基期仍然算不出，别顺手一起改了。
    expect(formatDeltaPart(100, 0, "count")).toBe(NO_BASE_TEXT)
    expect(formatDeltaPart(100, 0, "money")).toBe(NO_BASE_TEXT)
  })

  it("正常百分点差值与持平", () => {
    expect(formatDeltaPart(0.3, 0.2, "rate")).toBe("+10.0pct")
    expect(formatDeltaPart(0.2, 0.3, "rate")).toBe("-10.0pct")
    expect(formatDeltaPart(0.2, 0.2, "rate")).toBe(FLAT_TEXT)
  })
})

describe("formatDeltaPart · 伪持平并入「持平」（#314 决策 3）", () => {
  it("money 舍入到 0.0 时不再输出自相矛盾的 +0.0%", () => {
    // 真实 +0.02%。旧实现输出 "+0.0%"——「涨了、涨幅是 0」。
    expect(formatDeltaPart(500100, 500000, "money")).toBe(FLAT_TEXT)
  })

  it("负向舍入同样并入，不再输出 -0.0%", () => {
    // 真实 −0.0002%。-0.0 不来自 -0，来自 (-0.0002).toFixed(1)——旧实现照样带符号印出来。
    expect((-0.0002).toFixed(1)).toBe("-0.0")
    expect(formatDeltaPart(499999, 500000, "money")).toBe(FLAT_TEXT)
  })

  it("count 需基期 > 2000 才可达，舍入边界两侧都钉住", () => {
    // 1/2000 = 0.05% 恰好进位到 "0.1"，仍出数；基期再大一点才舍成 "0.0"。
    // 这条实测印证了 issue 正文的可达性判断，别把它当成「随手挑的数」改掉。
    expect(formatDeltaPart(2001, 2000, "count")).toBe("+0.1%")
    expect(formatDeltaPart(2501, 2500, "count")).toBe(FLAT_TEXT)
    expect(formatDeltaPart(10001, 10000, "count")).toBe(FLAT_TEXT)
  })

  it("rate 分支同样适用", () => {
    // 0.3000 → 0.30002：差 0.002pct，印出来是 0.0pct。
    expect(formatDeltaPart(0.30002, 0.3, "rate")).toBe(FLAT_TEXT)
  })

  it("判零看的是印出来的那个数，不是原始 delta", () => {
    // (100.05 − 100) / 100 * 100 = 0.04999999999999716 —— 数学上 0.05 该进位，
    // 浮点减法的余数让它落在边界下侧印成 "0.0"。判零跟着渲染值走，所以这里是持平。
    expect(((100.05 - 100) / 100) * 100).toBeLessThan(0.05)
    expect(formatDeltaPart(100.05, 100, "money")).toBe(FLAT_TEXT)
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

  it("负基期原地不动时不判方向（−1000 → −1000 不该是红色）", () => {
    // tone 在负基期下靠两期差值补方向，而「相等」的差值是 0——
    // 由 `toneFromSign` 的 `value === 0 → default` 接住。若漏掉会渲染成红色「下降」。
    expect(formatMetricDelta(-1000, -1000, 100, "money").tone).toBe("default")
  })

  it("溢出时不判方向——数都印不出来，配色不能假装知道方向", () => {
    // ⚠️ 这条钉的是 #314 闸门 2 codex 谱系揪出的 P1：`rendered === null` 压着四种成因
    //    （零基期 / 负基期 / 非有限入参 / 溢出），早先只看 `rendered === null` 时，
    //    溢出会顺着「负基期补方向」那条路径被涂成绿色。
    // 三条溢出路径逐条钉住，别只留一条。
    const divisionOverflow = formatMetricDelta(Number.MAX_VALUE, 1, 1, "money")
    expect(divisionOverflow.text).toBe(`同比 ${NO_BASE_TEXT} / 环比 ${NO_BASE_TEXT}`)
    expect(divisionOverflow.tone).toBe("default")
    // 减法溢出（rate 型）。
    expect(formatMetricDelta(Number.MAX_VALUE, -Number.MAX_VALUE, 0, "rate").tone).toBe("default")
    // 除法本身溢出（1 / 1e-320）。
    expect(formatMetricDelta(1, 1e-320, 1, "money").tone).toBe("default")
  })

  it("零基期与负基期的弃判/补方向差异仍然成立（没被溢出那条一起改掉）", () => {
    // 同为「无基数」文案，三者 tone 故意不同：零基期灰、负基期有色、溢出灰。
    expect(formatMetricDelta(120, 0, 100, "count").tone).toBe("default")
    expect(formatMetricDelta(264, -2646, 200, "money").tone).toBe("positive")
    expect(formatMetricDelta(Number.MAX_VALUE, 1, 1, "money").tone).toBe("default")
  })
})

describe("formatMetricDelta · 配色与文案同源（#314 决策 2/3）", () => {
  it("rate 零基期出数时配色跟着出方向，不再是灰色", () => {
    // 旧实现：文案走 formatDeltaPart（改后出 +30.0pct），tone 却撞 `prevYear === 0` 变灰
    // → 「+30.0pct + 灰色」自相矛盾。tone 现在读实际渲染出的那个数。
    const result = formatMetricDelta(0.3, 0, 0.2, "rate")
    expect(result.text).toBe("同比 +30.0pct / 环比 +10.0pct")
    expect(result.tone).toBe("positive")
  })

  it("rate 零基期跌向也对称——0 基期不是只给绿色", () => {
    expect(formatMetricDelta(0, 0.3, 0.3, "rate").tone).toBe("negative")
  })

  it("伪持平的配色并入灰，不出现「持平 + 绿色」", () => {
    // 旧实现：文案 "+0.0%"、tone positive。改后文案「持平」，配色必须跟着变灰。
    const result = formatMetricDelta(500100, 500000, 500000, "money")
    expect(result.text).toBe(`同比 ${FLAT_TEXT} / 环比 ${FLAT_TEXT}`)
    expect(result.tone).toBe("default")
  })

  it("负向伪持平同样并入灰，不出现「持平 + 红色」", () => {
    expect(formatMetricDelta(499999, 500000, 500000, "money").tone).toBe("default")
  })

  it("tone 只跟同比那一半走——环比伪持平不影响同比方向", () => {
    // 与「tone 刻意不查 prevPeriod」同一条规则，换成伪持平这个新分支再钉一次。
    const result = formatMetricDelta(120, 100, 120.01, "money")
    expect(result.text).toBe(`同比 +20.0% / 环比 ${FLAT_TEXT}`)
    expect(result.tone).toBe("positive")
  })

  it("负基期仍走差值补方向，没被 rendered 分支抢走", () => {
    // 负基期 rendered 为 null（文案是「无基数」），必须落到 `canInferDirection` 那条补方向路径。
    expect(formatMetricDelta(264, -2646, 200, "money").tone).toBe("positive")
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

  it("入参有限但乘 100 溢出时也挡住", () => {
    // 旧式：MAX_VALUE 有限 → 直接渲染 (MAX_VALUE*100).toFixed(1) → "同比 +Infinitypct"，tone 绿。
    expect(Number.isFinite(Number.MAX_VALUE)).toBe(true)
    expect(formatPointDelta(Number.MAX_VALUE)).toEqual({ text: NO_LAST_YEAR_TEXT, tone: "default" })
  })

  it("null 表示上一年区间不存在，用独立文案而非「无基数」", () => {
    const result = formatPointDelta(null)
    expect(result.text).toBe(NO_LAST_YEAR_TEXT)
    expect(result.tone).toBe("default")
  })

  it("正常涨跌与持平（对照组，确认守卫没误伤）", () => {
    expect(formatPointDelta(0.1)).toEqual({ text: "同比 +10.0pct", tone: "positive" })
    expect(formatPointDelta(-0.1)).toEqual({ text: "同比 -10.0pct", tone: "negative" })
    expect(formatPointDelta(0)).toEqual({ text: `同比${FLAT_TEXT}`, tone: "default" })
  })

  it("伪持平并入「同比持平」——这里可达，不是理论边界（#314 决策 3）", () => {
    // 上游 repurchase.ts:422 的 round4 最小非零值就是 0.0001 → scaled 0.01 → 印成 "0.0"。
    // 旧实现输出「同比 +0.0pct」且 tone 绿，是复购率看板上真会出现的自相矛盾徽章。
    expect(formatPointDelta(0.0001)).toEqual({ text: `同比${FLAT_TEXT}`, tone: "default" })
    expect(formatPointDelta(-0.0001)).toEqual({ text: `同比${FLAT_TEXT}`, tone: "default" })
  })

  it("舍入边界外侧仍照常出数", () => {
    expect(formatPointDelta(0.001)).toEqual({ text: "同比 +0.1pct", tone: "positive" })
  })

  it("与 formatDeltaPart 的判零规则同源", () => {
    // 两个导出函数共用 fixDelta，同一个 scaled（0.02）应当同时被判为持平（防后来者只改一处）。
    // ⚠️ 这里刻意用**非零基期**的 rate 输入：若借道 `formatDeltaPart(0.0002, 0, "rate")`，
    //    这条断言就同时依赖决策 2，日后回退决策 2 会以误导性信息翻红（双谱系评审 P3）。
    expect(formatPointDelta(0.0002).tone).toBe("default")
    expect(formatDeltaPart(0.3002, 0.3, "rate")).toBe(FLAT_TEXT)
  })
})

describe("formatPointDeltaValue · 无前缀内核，AI 助手与看板共用（#314 评审 P1）", () => {
  it("渲染不出数字时返回 null，由调用方决定占位文案", () => {
    expect(formatPointDeltaValue(null)).toBeNull()
    expect(formatPointDeltaValue(Number.NaN)).toBeNull()
    expect(formatPointDeltaValue(Number.POSITIVE_INFINITY)).toBeNull()
    // 入参有限但乘 100 溢出。
    expect(formatPointDeltaValue(Number.MAX_VALUE)).toBeNull()
  })

  it("文案不带「同比」前缀——调用点外层自带，套带前缀的会出「同比变化 同比 +1.0pct」", () => {
    expect(formatPointDeltaValue(0.01)).toEqual({ text: "+1.0pct", tone: "positive" })
    expect(formatPointDeltaValue(-0.01)).toEqual({ text: "-1.0pct", tone: "negative" })
  })

  it("伪持平在内核层就并入「持平」，两个消费方因此不可能再分叉", () => {
    // 这是评审 P1 的核心：assistant-answer.ts 曾各自判零，同一个 delta 在看板出「持平」、
    // 在 AI 助手出「+0.0pct」。内核统一后，任何消费方都拿到同一个判定。
    expect(formatPointDeltaValue(0.0001)).toEqual({ text: FLAT_TEXT, tone: "default" })
    expect(formatPointDeltaValue(0)).toEqual({ text: FLAT_TEXT, tone: "default" })
  })

  it("formatPointDelta 是它加前缀的薄壳，两者结论必须一致", () => {
    for (const value of [0.0001, 0, 0.01, -0.01, null, Number.NaN]) {
      const core = formatPointDeltaValue(value)
      const wrapped = formatPointDelta(value)
      expect(wrapped.tone).toBe(core?.tone ?? "default")
      if (core) expect(wrapped.text).toContain(core.text)
      else expect(wrapped.text).toBe(NO_LAST_YEAR_TEXT)
    }
  })
})
