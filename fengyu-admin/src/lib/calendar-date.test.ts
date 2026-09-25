import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { CALENDAR_MAX_YEAR, CALENDAR_MIN_YEAR, isValidCalendarDate } from './calendar-date'

describe('isValidCalendarDate（#308 单源）', () => {
  it('合法日历日期放行（含闰日、年份上下界）', () => {
    for (const d of ['2028-02-29', '2000-02-29', '2026-01-31', '1900-01-01', '2100-12-31', '1999-12-31']) {
      expect(isValidCalendarDate(d), d).toBe(true)
    }
  })

  it('只过位数、不过日历的值拒绝', () => {
    for (const d of ['2027-02-29', '1900-02-29', '2100-02-29', '2026-02-30', '2026-13-01', '2026-00-01', '2026-01-32', '2026-01-00']) {
      expect(isValidCalendarDate(d), d).toBe(false)
    }
  })

  it('年份越界（含不足 4 位语义）拒绝', () => {
    for (const d of ['0001-01-01', '0000-01-01', '1899-12-31', '2101-01-01', '9999-12-31']) {
      expect(isValidCalendarDate(d), d).toBe(false)
    }
  })

  it('非 YYYY-MM-DD 串与非字符串拒绝', () => {
    for (const v of ['2026-1-01', '2026-01-01T00:00:00', ' 2026-01-01', '20260101', '', undefined, null, 20260101, {}]) {
      expect(isValidCalendarDate(v), String(v)).toBe(false)
    }
  })

  it('年份范围钉死为拍板值 1900–2100（date-picker 默认可选年份引用同一对常量）', () => {
    expect([CALENDAR_MIN_YEAR, CALENDAR_MAX_YEAR]).toEqual([1900, 2100])
  })
})

describe('单源守护：数据中心一侧不许再长出日历校验（#308「不许第三份实现」）', () => {
  const SRC = resolve(__dirname, '..')
  // 数据中心取数 / 解析 / 导出的全部源码目录（含报表页、提成日报、看板组件与 export-worker）
  const ROOTS = ['lib/data-center', 'actions/data-center', 'export-worker', 'app/(main)/(analytics)/data-center']

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name)
      if (e.isDirectory()) return e.name === '__tests__' ? [] : sourceFiles(p)
      return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : []
    })
  }
  const files = ROOTS.flatMap((r) => sourceFiles(join(SRC, r)))

  it('扫描范围非空（防目录改名后守护静默失效）', () => {
    for (const r of ['lib/data-center/params.ts', 'lib/data-center/report-period.ts', 'lib/data-center/commission-daily.ts', 'export-worker/registry.ts']) {
      expect(files.map((f) => relative(SRC, f))).toContain(r)
    }
  })

  /**
   * 闭集判据（不枚举「日历校验的写法」——那是开放集合，换个操作数顺序、换个分组写法就绕过）：
   * 钉住各文件里**日期运算原语**的出现次数。任何新增的日期解析 / 往返比对 / 日期正则都必然用到其中之一，
   * 表一变就红，逼改动者回来确认它不是第三份日历校验（是的话改用 @/lib/calendar-date）。
   * 合法的日期运算（time-range 的加减、report-period 的月末）照实登记进表即可。计数含注释，改注释也要同步。
   * 刻意不计 `new Date(`：export-worker 的心跳 / 时间戳大量使用，计入会让无关改动频繁误红。
   */
  const DATE_PRIMITIVE = /getUTC(?:Date|Month|FullYear|Day)|get(?:Date|Month|FullYear|Day)\(|Date\.UTC|Date\.parse|getTime\(|toISOString|\\d\{[0-9,]+\}|\[0-9\]/g
  const EXPECTED_DATE_PRIMITIVES: Record<string, number> = {
    'lib/data-center/time-range.ts': 11,
    'lib/data-center/report-period.ts': 9,
    'lib/data-center/matrix.ts': 7,
    'lib/data-center/customer-frequency.ts': 2,
    'lib/data-center/remaining-cards.ts': 1,
    'app/(main)/(analytics)/data-center/_components/kpi-card.tsx': 2,
    'export-worker/index.ts': 1,
  }

  it('日期运算原语的分布与登记表逐文件相等', () => {
    const actual: Record<string, number> = {}
    for (const f of files) {
      const n = readFileSync(f, 'utf8').match(DATE_PRIMITIVE)?.length ?? 0
      if (n > 0) actual[relative(SRC, f)] = n
    }
    expect(actual).toEqual(EXPECTED_DATE_PRIMITIVES)
  })

  it('原语正则自检：calendar-date.ts 本体的正则与 UTC 往返都被计入', () => {
    const own = readFileSync(join(SRC, 'lib/calendar-date.ts'), 'utf8').match(DATE_PRIMITIVE) ?? []
    expect(own).toEqual(expect.arrayContaining(['\\d{4}', 'Date.UTC', 'getUTCFullYear', 'getUTCMonth', 'getUTCDate']))
  })

  it('params / report-period / commission-daily 都从 @/lib/calendar-date 取校验函数', () => {
    for (const f of ['params.ts', 'report-period.ts', 'commission-daily.ts']) {
      const src = readFileSync(join(SRC, 'lib/data-center', f), 'utf8')
      expect(src, f).toMatch(/import \{[^}]*\bisValidCalendarDate\b[^}]*\} from '@\/lib\/calendar-date'/)
    }
  })

  it('两个服务端复检入口从 params 取校验函数（context → isValidTimeRangeInput，导出 → isValidCustomRange）', () => {
    const ctx = readFileSync(join(SRC, 'lib/data-center/context.ts'), 'utf8')
    expect(ctx).toMatch(/import \{[^}]*\bisValidTimeRangeInput\b[^}]*\} from '\.\/params'/)
    const reg = readFileSync(join(SRC, 'export-worker/registry.ts'), 'utf8')
    expect(reg).toMatch(/import \{[^}]*\bisValidCustomRange\b[^}]*\} from '@\/lib\/data-center\/params'/)
  })
})
