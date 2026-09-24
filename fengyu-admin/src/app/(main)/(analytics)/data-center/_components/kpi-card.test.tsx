import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { KpiCard, type BasePeriodRanges } from './kpi-card'
import type { KpiCell } from '@/lib/data-center/types'

/**
 * #310 的守护，重点在 **hover 露出基期区间**——那是本 issue 的核心诉求：
 * 「本月」与「自定义同起止日」会给出两个不同的环比值（实测 +30.76% vs +46.39%，差 15.63pp），
 * 这是正确的语义差异，但用户从界面上得不到任何解释，看到同一当期窗口两个数只会认为是 bug。
 */

const RANGES: BasePeriodRanges = {
  previous: { start: '2026-08-01', end: '2026-08-22' },
  lastYear: { start: '2025-09-01', end: '2025-09-22' },
}

function renderCard(cell: KpiCell, baseRanges: BasePeriodRanges = RANGES) {
  const { container, unmount } = render(
    <KpiCard label="业绩" cell={cell} baseRanges={baseRanges} />,
  )
  const badges = Array.from(container.querySelectorAll('span')).map((el) => ({
    text: el.textContent?.trim() ?? '',
    title: el.getAttribute('title'),
    className: el.className,
  }))
  unmount()
  return badges
}

describe('DeltaBadge · hover 露出基期区间', () => {
  it('环比徽章挂 previous、同比徽章挂 lastYear —— 映射不能对调', () => {
    const badges = renderCard({
      value: 1000,
      unit: 'amount',
      mom: { kind: 'pct', value: 0.2 },
      yoy: { kind: 'pct', value: 0.5 },
    })
    const mom = badges.find((b) => b.text.startsWith('环比'))
    const yoy = badges.find((b) => b.text.startsWith('同比'))

    expect(mom?.title).toBe('环比基期：2026-08-01 ~ 2026-08-22（22 天）')
    expect(yoy?.title).toBe('同比基期：2025-09-01 ~ 2025-09-22（22 天）')
    // 反向断言：别把去年同期的区间挂到环比上
    expect(mom?.title).not.toContain('2025')
    expect(yoy?.title).not.toContain('2026-08')
  })

  it('天数含首尾两端', () => {
    const badges = renderCard(
      { value: 1, unit: 'count', mom: { kind: 'pct', value: 0.1 } },
      { previous: { start: '2026-08-01', end: '2026-08-01' }, lastYear: null },
    )
    expect(badges.find((b) => b.text.startsWith('环比'))?.title).toContain('（1 天）')
  })

  it('跨月跨年都按真实天数算，不按月份差', () => {
    const badges = renderCard(
      { value: 1, unit: 'count', mom: { kind: 'pct', value: 0.1 } },
      { previous: { start: '2025-12-15', end: '2026-01-14' }, lastYear: null },
    )
    expect(badges.find((b) => b.text.startsWith('环比'))?.title).toContain('（31 天）')
  })

  it('跨 2 月底（闰年 2/29）天数正确', () => {
    const badges = renderCard(
      { value: 1, unit: 'count', mom: { kind: 'pct', value: 0.1 } },
      { previous: { start: '2028-02-01', end: '2028-03-01' }, lastYear: null },
    )
    // 2028 是闰年：2/1~2/29 共 29 天 + 3/1 = 30 天
    expect(badges.find((b) => b.text.startsWith('环比'))?.title).toContain('（30 天）')
  })

  it('基期不存在（withComparison:false 等）→ 不挂 title，不渲染空 hover', () => {
    const badges = renderCard(
      { value: 1, unit: 'count', mom: { kind: 'na' } },
      { previous: null, lastYear: null },
    )
    expect(badges.find((b) => b.text.startsWith('环比'))?.title).toBeNull()
  })

  it('baseRanges 整个缺省时也不炸（向后兼容）', () => {
    const { container, unmount } = render(
      <KpiCard label="业绩" cell={{ value: 1, unit: 'count', mom: { kind: 'pct', value: 0.1 } }} />,
    )
    const badge = Array.from(container.querySelectorAll('span')).find((el) =>
      el.textContent?.startsWith('环比'),
    )
    expect(badge?.getAttribute('title')).toBeNull()
    expect(badge?.textContent).toContain('+10.00%')
    unmount()
  })
})

describe('DeltaBadge · 决策 1 展示矩阵（配色 + 文案）', () => {
  const GREEN = '#3D8A5A'
  const RED = '#D94040'
  const GREY = '#999999'

  function momBadge(mom: KpiCell['mom']) {
    return renderCard({ value: 1, unit: 'amount', mom }).find((b) => b.text.startsWith('环比'))!
  }

  it('base > 0：按 delta 正负着色', () => {
    expect(momBadge({ kind: 'pct', value: 0.2 }).className).toContain(GREEN)
    expect(momBadge({ kind: 'pct', value: -0.2 }).className).toContain(RED)
  })

  it('负基期转正 → 绿色「由负转正」，不再是灰 --（#310 核心诉求）', () => {
    const b = momBadge({ kind: 'turnedPositive' })
    expect(b.text).toBe('环比 由负转正')
    expect(b.className).toContain(GREEN)
  })

  it('负基期未转正 → 红色「未转正」', () => {
    const b = momBadge({ kind: 'notTurned' })
    expect(b.text).toBe('环比 未转正')
    expect(b.className).toContain(RED)
  })

  it('零基期 / 算不出 → 灰色 --', () => {
    const b = momBadge({ kind: 'na' })
    expect(b.text).toBe('环比 --')
    expect(b.className).toContain(GREY)
  })

  it('决策 3 · 伪持平出「持平」且配灰色（文案与配色必须同步，否则「持平」配绿）', () => {
    const b = momBadge({ kind: 'pct', value: 0.00002 })
    expect(b.text).toBe('环比 持平')
    expect(b.className).toContain(GREY)
  })

  it('刚好够 0.01% 的仍出数且着色', () => {
    const b = momBadge({ kind: 'pct', value: 0.0001 })
    expect(b.text).toBe('环比 +0.01%')
    expect(b.className).toContain(GREEN)
  })
})

describe('KpiCard · 徽章渲染条件', () => {
  it('mom/yoy 均为 undefined（withComparison:false）→ 整行徽章不渲染', () => {
    const badges = renderCard({ value: 100, unit: 'amount' })
    expect(badges.some((b) => b.text.startsWith('环比') || b.text.startsWith('同比'))).toBe(false)
  })

  it('只有 mom 时不渲染同比徽章', () => {
    const badges = renderCard({ value: 100, unit: 'amount', mom: { kind: 'na' } })
    expect(badges.some((b) => b.text.startsWith('环比'))).toBe(true)
    expect(badges.some((b) => b.text.startsWith('同比'))).toBe(false)
  })
})
