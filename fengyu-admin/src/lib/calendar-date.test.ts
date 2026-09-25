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

  // 日历校验的两种写法签名（闭集）：YYYY-MM-DD 正则字面量；UTC 往返比对日 / 月
  it.each([
    ['YYYY-MM-DD 正则', /\\d\{4\}\)?-\(?\\d\{2\}\)?-\(?\\d\{2\}/],
    ['UTC 往返比对', /getUTC(?:Date|Month)\(\)\s*===/],
  ])('%s 只允许出现在 @/lib/calendar-date', (_, signature) => {
    const offenders = files.filter((f) => signature.test(readFileSync(f, 'utf8'))).map((f) => relative(SRC, f))
    expect(offenders).toEqual([])
  })

  it('params / report-period / commission-daily 都从 @/lib/calendar-date 取校验函数', () => {
    for (const f of ['params.ts', 'report-period.ts', 'commission-daily.ts']) {
      const src = readFileSync(join(SRC, 'lib/data-center', f), 'utf8')
      expect(src, f).toMatch(/import \{[^}]*\bisValidCalendarDate\b[^}]*\} from '@\/lib\/calendar-date'/)
    }
  })

  it('calendar-date.ts 自身确实带这两种签名（守护的正则没写错）', () => {
    const own = readFileSync(join(SRC, 'lib/calendar-date.ts'), 'utf8')
    expect(own).toMatch(/\\d\{4\}\)?-\(?\\d\{2\}\)?-\(?\\d\{2\}/)
    expect(own).toMatch(/getUTC(?:Date|Month)\(\)\s*===/)
  })
})
