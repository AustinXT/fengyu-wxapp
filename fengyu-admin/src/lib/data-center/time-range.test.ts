import { describe, it, expect } from 'vitest'
import { resolveTimeRange, shanghaiToday, addDays, addYears } from './time-range'

// 锚点：Shanghai = 2024-01-03（周三）。2024-01-01 是周一，便于断言周/月/年边界。
const NOW = new Date('2024-01-03T04:00:00Z') // UTC+8 → 2024-01-03 12:00 上海

describe('shanghaiToday', () => {
  it('取 Asia/Shanghai 当日（UTC 凌晨也算上海当天）', () => {
    expect(shanghaiToday(NOW)).toBe('2024-01-03')
    // UTC 2024-01-02 23:00 → 上海 2024-01-03 07:00
    expect(shanghaiToday(new Date('2024-01-02T23:00:00Z'))).toBe('2024-01-03')
  })
})

describe('日期运算 helper', () => {
  it('addDays 跨月跨年', () => {
    expect(addDays('2024-01-01', -1)).toBe('2023-12-31')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29') // 闰年
  })
  it('addYears', () => {
    expect(addYears('2024-05-26', -1)).toBe('2023-05-26')
  })
})

describe('resolveTimeRange', () => {
  it('today：当日 / 昨日 / 去年今日', () => {
    const r = resolveTimeRange({ preset: 'today' }, NOW)
    expect(r.current).toEqual({ start: '2024-01-03', end: '2024-01-03' })
    expect(r.previous).toEqual({ start: '2024-01-02', end: '2024-01-02' })
    expect(r.lastYear).toEqual({ start: '2023-01-03', end: '2023-01-03' })
    expect(r.presetLabel).toBe('今日')
  })

  // #283：previous 是环比基期（分母），必须与 current 等长。
  // 这两条用例原本断言 previous=整段上周/整段上月，把缺陷反向钉死了。
  it('week：本周一至今 / 上周一至上周同一天（等长）/ 去年同区间', () => {
    const r = resolveTimeRange({ preset: 'week' }, NOW)
    expect(r.current).toEqual({ start: '2024-01-01', end: '2024-01-03' }) // 周一=01-01
    // 上周三=2023-12-27，不是上周日 2023-12-31（那会拿 3 天比 7 天）
    expect(r.previous).toEqual({ start: '2023-12-25', end: '2023-12-27' })
    expect(r.lastYear).toEqual({ start: '2023-01-01', end: '2023-01-03' })
    expect(r.presetLabel).toBe('本周')
  })

  it('month：月初至今 / 上月初至上月同一日（等长）/ 去年同区间', () => {
    const r = resolveTimeRange({ preset: 'month' }, NOW)
    expect(r.current).toEqual({ start: '2024-01-01', end: '2024-01-03' })
    // 上月第 3 天=2023-12-03，不是上月末 2023-12-31（那会拿 3 天比 31 天）
    expect(r.previous).toEqual({ start: '2023-12-01', end: '2023-12-03' })
    expect(r.lastYear).toEqual({ start: '2023-01-01', end: '2023-01-03' })
    expect(r.presetLabel).toBe('本月')
  })

  it('week：周日看本周 → previous 恰是整段上周（此时才等长）', () => {
    // 2024-01-07 是周日，current=01-01~01-07 共 7 天
    const r = resolveTimeRange({ preset: 'week' }, new Date('2024-01-07T04:00:00Z'))
    expect(r.current).toEqual({ start: '2024-01-01', end: '2024-01-07' })
    expect(r.previous).toEqual({ start: '2023-12-25', end: '2023-12-31' })
  })

  it('month：月初第一天 → previous 也只取 1 天（原实现会 1 天比整月，徽章恒显 -97%）', () => {
    const r = resolveTimeRange({ preset: 'month' }, new Date('2024-01-01T04:00:00Z'))
    expect(r.current).toEqual({ start: '2024-01-01', end: '2024-01-01' })
    expect(r.previous).toEqual({ start: '2023-12-01', end: '2023-12-01' })
  })

  it('month：上月天数不足时 clamp 到上月末（3/31 → 2/28，闰年 → 2/29）', () => {
    const r = resolveTimeRange({ preset: 'month' }, new Date('2023-03-31T04:00:00Z'))
    expect(r.current).toEqual({ start: '2023-03-01', end: '2023-03-31' })
    // 要的是"上月第 31 天"，2023 年 2 月只有 28 天 → 落到 02-28（不得溢出到 03-03）
    expect(r.previous).toEqual({ start: '2023-02-01', end: '2023-02-28' })

    const leap = resolveTimeRange({ preset: 'month' }, new Date('2024-03-31T04:00:00Z'))
    expect(leap.previous).toEqual({ start: '2024-02-01', end: '2024-02-29' })
  })

  /**
   * #283 的回归闸门：缺陷的本质是"基期长于当期"，所以这里守的是**性质**而非具体日期。
   * 原来没有任何测试校验这个性质，于是 week/month 两个分支的错误写法被逐字断言锁了下来。
   *
   * ⚠️ 年份的选择本身是个陷阱：`year` 分支只在「当年平年 + 上一年闰年」时才违反硬底线
   * （基期含 2/29 而当期没有 → 基期反而长 1 天）。2023/2024/2026/2028 全都不落在这个窗口，
   * 只扫它们会让 year 分支的断言变成假阳性。所以这里**必须**包含 2025 与 2029 两个反例年份。
   */
  const DAILY_SCAN_YEARS = [
    2023, // 平年 + 上年平年
    2024, // 闰年 + 上年平年（当期多 2/29 → 基期短 1 天）
    2025, // 平年 + 上年闰年 ← year 分支的反例年（306/365 天基期长 1 天）
    2026, // 平年 + 上年平年（当前年份）
    2029, // 平年 + 上年闰年 ← 下一个反例年
  ]

  it('today/week/month 的 previous 绝不长于 current（逐日性质断言）', () => {
    const days = (r: { start: string; end: string }) =>
      Math.round((Date.parse(`${r.end}T00:00:00Z`) - Date.parse(`${r.start}T00:00:00Z`)) / 86400000) + 1
    const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0

    for (const year of DAILY_SCAN_YEARS) {
      for (let i = 0; i < (isLeap(year) ? 366 : 365); i++) {
        const now = new Date(Date.UTC(year, 0, 1, 4) + i * 86400000)
        for (const preset of ['today', 'week', 'month'] as const) {
          const r = resolveTimeRange({ preset }, now)
          // 类型上 previous 可为 null（ComparisonRanges 共用该形状），但 resolveTimeRange
          // 五个分支都必赋值 —— 顺带守住这个性质
          const prevRange = r.previous
          expect(prevRange, `${preset} @ ${r.current.end} 的 previous 不应为 null`).not.toBeNull()
          if (!prevRange) continue

          const cur = days(r.current)
          const prev = days(prevRange)
          const at = `${preset} @ ${r.current.end} (previous=${prevRange.start}~${prevRange.end})`

          // 硬底线：基期长于当期就是 #283
          expect(prev, at).toBeLessThanOrEqual(cur)

          if (preset === 'month') {
            // 上月天数不足时 clamp 到上月末 → 最多短 3 天（3/31 看 → 基期 2/1~2/28）
            expect(prev, at).toBeGreaterThanOrEqual(cur - 3)
          } else {
            expect(prev, at).toBe(cur) // 纯天数平移，恒等长
          }
        }
      }
    }
  })

  /**
   * year 分支**未被 #283 修复**，是一条 characterization test：钉住偏差量级（±1 天），
   * 既不假装它等长，也不放任它恶化。锚点写死具体日期而不是统计总数——统计数会随扫描
   * 年份清单变化而失败，那是测试脆弱不是行为回归。
   */
  it('year 的 previous 存在跨闰年 ±1 天偏差（既有缺陷，如实钉住量级）', () => {
    const days = (r: { start: string; end: string }) =>
      Math.round((Date.parse(`${r.end}T00:00:00Z`) - Date.parse(`${r.start}T00:00:00Z`)) / 86400000) + 1
    const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0

    // 锚点 1：当年平年 + 上一年闰年 → 基期含 2/29 而当期没有 → 基期**长 1 天**
    const y2025 = resolveTimeRange({ preset: 'year' }, new Date('2025-03-01T04:00:00Z'))
    expect(y2025.current).toEqual({ start: '2025-01-01', end: '2025-03-01' })
    expect(y2025.previous).toEqual({ start: '2024-01-01', end: '2024-03-01' })
    expect(days(y2025.current)).toBe(60)
    expect(days(y2025.previous!)).toBe(61) // ← 缺陷所在：基期比当期长 1 天

    // 锚点 2：当年闰年 + 上一年平年 → 反向，基期短 1 天
    const y2024 = resolveTimeRange({ preset: 'year' }, new Date('2024-03-01T04:00:00Z'))
    expect(days(y2024.current)).toBe(61)
    expect(days(y2024.previous!)).toBe(60)

    // 锚点 3：两年都不含额外闰日 → 恰好等长（2026 对比 2025，即当前状态）
    const y2026 = resolveTimeRange({ preset: 'year' }, new Date('2026-09-22T04:00:00Z'))
    expect(days(y2026.current)).toBe(days(y2026.previous!))

    // 量级上界：逐日扫描下偏差永远不超过 1 天（防止它从 ±1 恶化成 ±N）
    for (const year of DAILY_SCAN_YEARS) {
      for (let i = 0; i < (isLeap(year) ? 366 : 365); i++) {
        const r = resolveTimeRange({ preset: 'year' }, new Date(Date.UTC(year, 0, 1, 4) + i * 86400000))
        const at = `year @ ${r.current.end} (previous=${r.previous!.start}~${r.previous!.end})`
        expect(Math.abs(days(r.previous!) - days(r.current)), at).toBeLessThanOrEqual(1)
      }
    }
  })

  it('year：年初至今 / 去年同区间（previous=lastYear）', () => {
    const r = resolveTimeRange({ preset: 'year' }, NOW)
    expect(r.current).toEqual({ start: '2024-01-01', end: '2024-01-03' })
    expect(r.previous).toEqual({ start: '2023-01-01', end: '2023-01-03' })
    expect(r.lastYear).toEqual(r.previous)
    expect(r.presetLabel).toBe('今年')
  })

  it('custom：紧邻前一等长区间 / 各减一年', () => {
    const r = resolveTimeRange({ preset: 'custom', start: '2026-03-01', end: '2026-03-31' }, NOW)
    expect(r.current).toEqual({ start: '2026-03-01', end: '2026-03-31' })
    // 31 天窗口的紧邻前一段：[2026-01-29, 2026-02-28]
    expect(r.previous).toEqual({ start: '2026-01-29', end: '2026-02-28' })
    expect(r.lastYear).toEqual({ start: '2025-03-01', end: '2025-03-31' })
    expect(r.presetLabel).toBe('2026-03-01 ~ 2026-03-31')
  })
})
