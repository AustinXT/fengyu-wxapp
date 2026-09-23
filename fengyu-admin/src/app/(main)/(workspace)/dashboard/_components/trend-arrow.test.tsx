import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TrendArrow } from './dashboard-page'

/**
 * #315 的守护。该组件此前**零测试覆盖**（直接原因是它没被导出）。
 *
 * 生产背景：`yesterdayRevenue` 的 SQL 把退款以负数计入且无 GREATEST 夹底，
 * 只读实测 1020 个门店日中 67 天非正（6.6%，最差 −22,800）——
 * 负基期在这里是**正在触发**的，不是潜伏的。
 */

/** 取渲染出的可见文本（去掉 svg），便于逐字对照。 */
function renderText(current: number, previous: number): string {
  const { container, unmount } = render(<TrendArrow current={current} previous={previous} />)
  const text = container.textContent ?? ''
  unmount()
  return text.trim()
}

/** 取徽章的颜色类名，用于验证配色语义。 */
function renderClass(current: number, previous: number): string {
  const { container, unmount } = render(<TrendArrow current={current} previous={previous} />)
  const cls = container.querySelector('span')?.className ?? ''
  unmount()
  return cls
}

const GREEN = '#3D8A5A'
const RED = '#D94040'
const GREY = '#999999'

describe('TrendArrow · 基期为正（常规路径）', () => {
  it('上涨出绿色 + 百分比', () => {
    expect(renderText(120, 100)).toBe('20%')
    expect(renderClass(120, 100)).toContain(GREEN)
  })

  it('下跌出红色 + 百分比（幅度取绝对值，不带负号）', () => {
    expect(renderText(80, 100)).toBe('20%')
    expect(renderClass(80, 100)).toContain(RED)
  })

  it('完全持平出灰色「持平」', () => {
    expect(renderText(100, 100)).toBe('持平')
    expect(renderClass(100, 100)).toContain(GREY)
  })

  it('决策 3 · 舍入后为 0 的小幅变化并入「持平」，不再出「↑ 0%」', () => {
    // +0.4%：整数精度下舍成 0。旧实现会渲染出绿色「↑ 0%」——本次要消灭的展示之一。
    expect(renderText(1004, 1000)).toBe('持平')
    expect(renderClass(1004, 1000)).toContain(GREY)
    // 负向同理，不出红色「↓ 0%」
    expect(renderText(996, 1000)).toBe('持平')
  })

  it('刚好够一个百分点的仍出数，不被吞', () => {
    expect(renderText(1010, 1000)).toBe('1%')
    expect(renderText(990, 1000)).toBe('1%')
  })
})

describe('TrendArrow · 基期 ≤ 0（#315 的核心缺陷）', () => {
  it('基期为负且当期转正 → 绿色「由负转正」，不再是「↑ 0%」', () => {
    // 生产样本量级：昨日 −22,800，今日回正。
    expect(renderText(1000, -22800)).toBe('由负转正')
    expect(renderClass(1000, -22800)).toContain(GREEN)
  })

  it('基期为负且当期仍为负 → 红色「未转正」', () => {
    expect(renderText(-5000, -22800)).toBe('未转正')
    expect(renderClass(-5000, -22800)).toContain(RED)
  })

  it('亏损收窄但仍亏 → 仍是「未转正」（拍板取舍：按当期值本身正负着色）', () => {
    expect(renderText(-500, -1000)).toBe('未转正')
    expect(renderClass(-500, -1000)).toContain(RED)
  })

  it('基期为负、当期恰好归零 → 「未转正」', () => {
    expect(renderText(0, -1000)).toBe('未转正')
  })

  it('基期为 0 → 灰色 --（除零，算不出，不是「持平」）', () => {
    expect(renderText(500, 0)).toBe('--')
    expect(renderClass(500, 0)).toContain(GREY)
    // 昨日 0、今日也 0：同样是算不出，不能谎称持平
    expect(renderText(0, 0)).toBe('--')
  })

  it('非有限值不渲染 NaN% / Infinity%，也不被涂成红色「下降」', () => {
    for (const [cur, prev] of [
      [NaN, 100],
      [100, NaN],
      [Infinity, 100],
      [100, -Infinity],
    ] as const) {
      expect(renderText(cur, prev)).toBe('--')
      expect(renderClass(cur, prev)).toContain(GREY)
    }
  })
})

/**
 * #315 AC2：`previous > 0` 的常规路径**渲染逐字不变**。
 *
 * 本次把展示值从 `Math.round` 换成了 `toFixed`，属于会改渲染的那类改动，
 * 所以这里用**旧实现原样复刻**做逐输入对照，而不是靠推理。
 *
 * 结论（见断言）：两者在 `previous > 0` 上逐字等价——旧实现先 `Math.abs` 再 `Math.round`，
 * 对正数即 away-from-zero，与 `toFixed` 一致。
 * ⚠️ 但若写成 `Math.abs(Math.round(delta * 100))`（先 round 后 abs）就会分叉：
 * `Math.round(-0.5) === -0` → 渲染 `0%`，把缺陷造回来。这正是不能用 Math.round 的原因。
 */
describe('TrendArrow · 基期为正的回归对照（AC2 逐字不变）', () => {
  /** PR #313 之前的原实现，逐字复刻，仅用于对照。 */
  function legacyText(current: number, previous: number): string {
    const diff = current - previous
    const pct = previous > 0 ? Math.round((Math.abs(diff) / previous) * 100) : 0
    if (diff > 0) return `${pct}%`
    if (diff < 0) return `${pct}%`
    return '持平'
  }

  const CASES: Array<[number, number]> = [
    [120, 100],
    [80, 100],
    [100, 100],
    [1010, 1000],
    [990, 1000],
    [3, 2],
    [1, 3],
    [12345, 6789],
    [1, 100000],
    [250, 100], // +150%
    [0, 100], // 归零 = -100%
    [205, 200], // +2.5% → 边界：两种舍入都给 3%（下一位是 .5）
    [195, 200], // -2.5% → 同上
  ]

  it.each(CASES)('current=%s previous=%s 与旧实现逐字一致', (cur, prev) => {
    const legacy = legacyText(cur, prev)
    const actual = renderText(cur, prev)
    // 唯一允许的差异：旧实现渲染 '0%' 的地方，新实现按决策 3 改出「持平」。
    if (legacy === '0%') {
      expect(actual).toBe('持平')
    } else {
      expect(actual).toBe(legacy)
    }
  })

  it('旧实现会渲染「0%」的那些输入，新实现一律改出「持平」（决策 3 的全部可见差异）', () => {
    // 0.4% 与 -0.4%：旧实现 Math.round(0.4) = 0 → 「↑ 0%」/「↓ 0%」
    expect(legacyText(1004, 1000)).toBe('0%')
    expect(legacyText(996, 1000)).toBe('0%')
    expect(renderText(1004, 1000)).toBe('持平')
    expect(renderText(996, 1000)).toBe('持平')
  })
})

describe('TrendArrow · 可访问性回归', () => {
  it('有方向的三态都带箭头 svg，无方向的两态不带', () => {
    const withArrow = [
      [120, 100],
      [80, 100],
      [1000, -22800],
      [-5000, -22800],
    ] as const
    for (const [cur, prev] of withArrow) {
      const { container, unmount } = render(<TrendArrow current={cur} previous={prev} />)
      expect(container.querySelector('svg')).not.toBeNull()
      unmount()
    }

    const withoutArrow = [
      [100, 100],
      [500, 0],
    ] as const
    for (const [cur, prev] of withoutArrow) {
      const { container, unmount } = render(<TrendArrow current={cur} previous={prev} />)
      expect(container.querySelector('svg')).toBeNull()
      unmount()
    }
  })

  it('screen 查询可达（冒烟：组件确实挂载进了 DOM）', () => {
    render(<TrendArrow current={120} previous={100} />)
    expect(screen.getByText('20%')).toBeTruthy()
  })
})
