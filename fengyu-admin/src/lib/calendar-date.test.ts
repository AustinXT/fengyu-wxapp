import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import ts from 'typescript'
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
  const parse = (file: string) =>
    ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)

  /** 最近的具名外层函数（函数声明 / 方法 / 赋给变量或属性的函数表达式）；都没有记 <module> */
  function ownerName(node: ts.Node): string {
    for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
      if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) return n.name.getText()
      if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.parent) {
        const p = n.parent
        if ((ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)) && p.name) return p.name.getText()
      }
    }
    return '<module>'
  }

  /**
   * 日期运算原语（AST 判定，注释与普通字符串天然不计）：
   *   - Date 实例方法名：get/set[UTC](Date|Day|Month|FullYear|Time|…)、to(ISO|Locale…)String / toJSON（裸 toString 多是 URLSearchParams，不计）
   *   - Date.UTC / Date.parse、Intl.DateTimeFormat
   *   - 带参数的 new Date(x)（无参 new Date() 只是取当前时刻，不可能是解析 / 校验，故不计——
   *     export-worker 的心跳时间戳大量使用，计入会让无关改动频繁误红）
   *   - 含 \d / \D / [0-9] 的正则字面量
   * `.toLocaleString` 在这些目录里多是数字格式化，仍保守计入：Date#toLocaleString 也能拼出日期串，登记一次的摩擦可接受。
   */
  const DATE_METHOD = /^(?:(?:get|set)(?:UTC)?(?:Date|Day|Month|FullYear|Year|Time|Hours|Minutes|Seconds|Milliseconds)|to(?:ISO|UTC|GMT|Date|Time|Locale|LocaleDate|LocaleTime)String|toJSON)$/
  const DIGIT_REGEX = /\\d|\[0-9\]|\\D/
  function primitives(sf: ts.SourceFile): string[] {
    const out: string[] = []
    const visit = (node: ts.Node) => {
      let kind: string | null = null
      if (ts.isPropertyAccessExpression(node)) {
        const name = node.name.text
        const recv = node.expression.getText(sf)
        if (recv === 'Date' && (name === 'UTC' || name === 'parse')) kind = `Date.${name}`
        else if (recv === 'Intl' && name === 'DateTimeFormat') kind = 'Intl.DateTimeFormat'
        else if (DATE_METHOD.test(name)) kind = `.${name}`
      } else if (ts.isNewExpression(node) && node.expression.getText(sf) === 'Date' && (node.arguments?.length ?? 0) > 0) {
        kind = 'new Date(x)'
      } else if (node.kind === ts.SyntaxKind.RegularExpressionLiteral && DIGIT_REGEX.test(node.getText(sf))) {
        kind = `regex ${node.getText(sf)}`
      }
      if (kind) out.push(`${ownerName(node)} :: ${kind}`)
      ts.forEachChild(node, visit)
    }
    visit(sf)
    return out
  }

  function inventory(): Record<string, number> {
    const acc: Record<string, number> = {}
    for (const f of files) {
      for (const key of primitives(parse(f))) {
        const k = `${relative(SRC, f)} :: ${key}`
        acc[k] = (acc[k] ?? 0) + 1
      }
    }
    return acc
  }

  it('扫描范围非空（防目录改名后守护静默失效）', () => {
    for (const r of ['lib/data-center/params.ts', 'lib/data-center/report-period.ts', 'lib/data-center/commission-daily.ts', 'export-worker/registry.ts']) {
      expect(files.map((f) => relative(SRC, f))).toContain(r)
    }
  })

  it('src 下名为 data-center 的目录都在扫描范围内（新开并行目录要加进 ROOTS）', () => {
    const found: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name === 'node_modules') continue
        const p = join(dir, e.name)
        if (e.name === 'data-center') found.push(relative(SRC, p))
        walk(p)
      }
    }
    walk(SRC)
    expect(found.filter((d) => !ROOTS.some((r) => d === r || d.startsWith(`${r}/`)))).toEqual([])
  })

  /**
   * 闭集判据（不枚举「日历校验的写法」——那是开放集合）：按「文件 :: 所在函数 :: 原语」逐项钉出现次数。
   * 任何新增的日期解析 / 往返比对 / 格式化 / 日期正则都会新增或改变某一项而红，逼改动者回来确认
   * 它不是第三份日历校验（是的话改用 @/lib/calendar-date）；按函数登记，同文件「删一个旧的、加一个新的」也抵消不了。
   * 合法的日期运算照实登记即可。
   */
  const EXPECTED_DATE_PRIMITIVES: Record<string, number> = {
    "lib/data-center/customer-frequency.ts :: <module> :: regex /^1\\d{10}$/": 1,
    "lib/data-center/customer-frequency.ts :: normalizePhone :: regex /^(?:\\+|00)?86(?=1\\d{10}$)/": 1,
    "lib/data-center/format.ts :: formatAmount :: .toLocaleString": 1,
    "lib/data-center/format.ts :: formatCount :: .toLocaleString": 1,
    "lib/data-center/matrix.ts :: listMonthDays :: regex /^(\\d{4})-(\\d{2})$/": 1,
    "lib/data-center/matrix.ts :: listMonthDays :: .getUTCDate": 1,
    "lib/data-center/matrix.ts :: listMonthDays :: new Date(x)": 2,
    "lib/data-center/matrix.ts :: listMonthDays :: Date.UTC": 2,
    "lib/data-center/matrix.ts :: listMonthDays :: .getUTCDay": 1,
    "lib/data-center/remaining-cards.ts :: <module> :: regex /^1\\d{10}$/": 1,
    "lib/data-center/report-period.ts :: <module> :: regex /^(\\d{4})-(\\d{2})$/": 1,
    "lib/data-center/report-period.ts :: daysInclusive :: Date.parse": 2,
    "lib/data-center/report-period.ts :: monthRange :: .getUTCDate": 1,
    "lib/data-center/report-period.ts :: monthRange :: new Date(x)": 1,
    "lib/data-center/report-period.ts :: monthRange :: Date.UTC": 1,
    "lib/data-center/report-period.ts :: shiftMonth :: new Date(x)": 1,
    "lib/data-center/report-period.ts :: shiftMonth :: Date.UTC": 1,
    "lib/data-center/report-period.ts :: shiftMonth :: .getUTCFullYear": 1,
    "lib/data-center/report-period.ts :: shiftMonth :: .getUTCMonth": 1,
    "lib/data-center/report-period.ts :: parseReportRange :: new Date(x)": 1,
    "lib/data-center/time-range.ts :: parse :: new Date(x)": 1,
    "lib/data-center/time-range.ts :: fmt :: .getUTCFullYear": 1,
    "lib/data-center/time-range.ts :: fmt :: .getUTCMonth": 1,
    "lib/data-center/time-range.ts :: fmt :: .getUTCDate": 1,
    "lib/data-center/time-range.ts :: addDays :: .setUTCDate": 1,
    "lib/data-center/time-range.ts :: addDays :: .getUTCDate": 1,
    "lib/data-center/time-range.ts :: addYears :: .setUTCFullYear": 1,
    "lib/data-center/time-range.ts :: addYears :: .getUTCFullYear": 1,
    "lib/data-center/time-range.ts :: endOfMonth :: .setUTCMonth": 1,
    "lib/data-center/time-range.ts :: endOfMonth :: .getUTCMonth": 1,
    "lib/data-center/time-range.ts :: endOfMonth :: .setUTCDate": 1,
    "lib/data-center/time-range.ts :: startOfWeekMonday :: .getUTCDay": 1,
    "lib/data-center/time-range.ts :: daysInclusive :: .getTime": 2,
    "lib/data-center/time-range.ts :: shanghaiToday :: Intl.DateTimeFormat": 1,
    "export-worker/file-name.ts :: exportFileName :: .toLocaleTimeString": 1,
    "export-worker/index.ts :: failJob :: new Date(x)": 1,
    "export-worker/index.ts :: processJob :: new Date(x)": 1,
    "export-worker/index.ts :: processJob :: .getTime": 1,
    "app/(main)/(analytics)/data-center/_components/kpi-card.tsx :: basePeriodTitle :: Date.parse": 2,
  }

  it('日期运算原语与登记表逐项相等', () => {
    expect(inventory()).toEqual(EXPECTED_DATE_PRIMITIVES)
  })

  it('原语判定自检：每类写法各有代表样例命中，注释 / 字符串里的不计', () => {
    const sample = ts.createSourceFile('s.ts', String.raw`
      function f(d: Date, s: string) {
        d.getUTCDate(); d.getMonth(); d.setUTCDate(1); d.getTime(); d.toISOString(); d.toJSON()
        d.toLocaleDateString('sv'); new Intl.DateTimeFormat(); Date.UTC(1, 2, 3); Date.parse(s)
        new Date(s); new Date()
        ;/^\d{4}-\d{2}-\d{2}$/; /^[0-9]{4}$/; /^(?:\d{4})$/
        // d.getUTCDate() 注释不计
        const t = 'Date.parse(x) 字符串不计'
      }`, ts.ScriptTarget.Latest, true)
    expect(primitives(sample).map((k) => k.replace(/^f :: /, ''))).toEqual([
      '.getUTCDate', '.getMonth', '.setUTCDate', '.getTime', '.toISOString', '.toJSON',
      '.toLocaleDateString', 'Intl.DateTimeFormat', 'Date.UTC', 'Date.parse',
      'new Date(x)',
      'regex /^\\d{4}-\\d{2}-\\d{2}$/', 'regex /^[0-9]{4}$/', 'regex /^(?:\\d{4})$/',
    ])
    // calendar-date.ts 本体的正则与 UTC 往返都能被识别
    expect(primitives(parse(join(SRC, 'lib/calendar-date.ts')))).toEqual(expect.arrayContaining([
      'isValidCalendarDate :: .getUTCFullYear', 'isValidCalendarDate :: .getUTCMonth', 'isValidCalendarDate :: .getUTCDate',
      'isValidCalendarDate :: Date.UTC', 'isValidCalendarDate :: new Date(x)',
    ]))
  })

  /** 入口确实 import 并**调用**了单源函数，且本文件没有同名本地定义（AST 判定，注释里的同形 import 不算） */
  function expectUsesImported(file: string, name: string, from: string) {
    const sf = parse(join(SRC, file))
    let imported: string | null = null
    let calls = 0
    let localDefs = 0
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === from) {
        const named = node.importClause?.namedBindings
        if (named && ts.isNamedImports(named)) {
          for (const el of named.elements) if ((el.propertyName ?? el.name).text === name) imported = el.name.text
        } else if (named && ts.isNamespaceImport(named)) {
          imported = `${named.name.text}.${name}` // import * as ns → 调用形如 ns.name(...)
        }
      }
      if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name?.getText(sf) === name) localDefs++
      if (ts.isCallExpression(node) && node.expression.getText(sf) === (imported ?? name)) calls++
      ts.forEachChild(node, visit)
    }
    visit(sf)
    expect(imported, `${file} 没有从 ${from} import ${name}`).not.toBeNull()
    expect(calls, `${file} import 了 ${name} 却没调用`).toBeGreaterThan(0)
    expect(localDefs, `${file} 本地又定义了 ${name}`).toBe(0)
  }

  it('calendar-date.ts 的导出恰为闭集 {年份上下界, CalendarDate, isValidCalendarDate}（单源本体里不许再长出平行校验）', () => {
    const sf = parse(join(SRC, 'lib/calendar-date.ts'))
    const exported = sf.statements.flatMap((st) => {
      const isExport = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      if (ts.isExportDeclaration(st) || ts.isExportAssignment(st)) return ['<re-export>']
      if (!isExport) return []
      if (ts.isFunctionDeclaration(st)) return [st.name?.text ?? '<default>']
      if (ts.isTypeAliasDeclaration(st)) return [st.name.text]
      if (ts.isVariableStatement(st)) return st.declarationList.declarations.map((d) => d.name.getText(sf))
      return [`<${ts.SyntaxKind[st.kind]}>`]
    })
    expect(exported.sort()).toEqual(['CALENDAR_MAX_YEAR', 'CALENDAR_MIN_YEAR', 'CalendarDate', 'isValidCalendarDate'])
  })

  it.each([
    ['lib/data-center/params.ts', 'isValidCalendarDate', '@/lib/calendar-date'],
    ['lib/data-center/report-period.ts', 'isValidCalendarDate', '@/lib/calendar-date'],
    ['lib/data-center/commission-daily.ts', 'isValidCalendarDate', '@/lib/calendar-date'],
    ['lib/data-center/context.ts', 'toTimeRangeInput', './params'],
    ['export-worker/registry.ts', 'isValidCustomRange', '@/lib/data-center/params'],
  ])('%s 调用单源的 %s（from %s）', (file, name, from) => {
    expectUsesImported(file, name, from)
  })
})

/**
 * branded 类型的逃逸口守护（#308）：`CalendarDate` 只能经 `isValidCalendarDate` 的类型谓词得到，
 * custom `TimeRangeInput` 又只接受 `CalendarDate`——于是「进 resolveTimeRange 的日期必经单源校验」由 tsc 强制。
 *
 * 用 TypeChecker 做**语义**判定（按名字匹配会被 `import { X as Y }`、类型别名、`Parameters<typeof f>` 绕过）：
 * 判断一个类型是否「携带 brand」= 其结构里（联合 / 交叉成员、属性类型、类型实参，递归）出现 `calendarDateBrand` 键。
 * 能把非法日期送进这类位置的写法在语法上是闭集：
 *   ① 类型断言（`as T` / `<T>x`）的目标类型携带 brand；
 *   ② 断言成 any / never / unknown 后落在要求 brand 的上下文里；
 *   ③ any 类型的表达式直接落在要求 brand 的上下文里（JSON.parse 之类）；
 *   ④ 别处另写产出 brand 的类型谓词（`x is T` / `asserts x is T`）。
 * 扫描 src 下全部非测试源码中「引用了数据中心或 calendar-date 模块」的文件——要接触这些类型必须 import 它们。
 */
describe('CalendarDate 逃逸口守护（TypeChecker 语义判定）', () => {
  const ADMIN = resolve(__dirname, '../..')
  const SRC = resolve(__dirname, '..')
  let program: ts.Program
  let checker: ts.TypeChecker

  beforeAll(() => {
    const cfg = ts.getParsedCommandLineOfConfigFile(join(ADMIN, 'tsconfig.json'), {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')) },
    })!
    program = ts.createProgram({ rootNames: cfg.fileNames, options: { ...cfg.options, noEmit: true } })
    checker = program.getTypeChecker()
  }, 60_000)

  function carriesBrand(type: ts.Type, depth = 0, seen = new Set<ts.Type>()): boolean {
    if (depth > 5 || seen.has(type)) return false
    seen.add(type)
    if (type.isUnionOrIntersection() && type.types.some((t) => carriesBrand(t, depth + 1, seen))) return true
    for (const prop of type.getProperties()) {
      if (prop.escapedName.toString().startsWith('__@calendarDateBrand')) return true
      const decl = prop.valueDeclaration ?? prop.declarations?.[0]
      if (decl && carriesBrand(checker.getTypeOfSymbolAtLocation(prop, decl), depth + 1, seen)) return true
    }
    if (type.flags & ts.TypeFlags.Object && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) {
      if (checker.getTypeArguments(type as ts.TypeReference).some((t) => carriesBrand(t, depth + 1, seen))) return true
    }
    return false
  }
  const LOOSE = ts.TypeFlags.Any | ts.TypeFlags.Never | ts.TypeFlags.Unknown

  function escapes(sf: ts.SourceFile): string[] {
    const out: string[] = []
    const at = (node: ts.Node, what: string) => {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
      out.push(`${relative(SRC, sf.fileName)}:${line + 1} ${what} ${node.getText(sf).slice(0, 80)}`)
    }
    const visit = (node: ts.Node) => {
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        const target = checker.getTypeFromTypeNode(node.type)
        if (carriesBrand(target)) at(node, '断言成携带 brand 的类型')
        else if (target.flags & LOOSE) {
          const ctx = checker.getContextualType(node)
          if (ctx && carriesBrand(ctx)) at(node, '宽松断言落在要求 brand 的上下文')
        }
      } else if (ts.isExpression(node) && !ts.isAsExpression(node.parent) && !ts.isTypeAssertionExpression(node.parent)) {
        const ctx = checker.getContextualType(node)
        if (ctx && checker.getTypeAtLocation(node).flags & ts.TypeFlags.Any && carriesBrand(ctx)) at(node, 'any 值落在要求 brand 的上下文')
      }
      if (ts.isTypePredicateNode(node) && node.type && carriesBrand(checker.getTypeFromTypeNode(node.type))) {
        at(node, '产出 brand 的类型谓词')
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    return out
  }

  const relevant = (sf: ts.SourceFile) => {
    const rel = relative(SRC, sf.fileName)
    if (rel.startsWith('..') || /\.(?:test|spec)\.tsx?$/.test(rel) || rel.includes('__tests__') || rel.endsWith('.d.ts')) return false
    return /data-center|calendar-date/.test(rel) || /['"][^'"]*(?:data-center|calendar-date)[^'"]*['"]/.test(sf.text)
  }

  it('除 calendar-date.ts 的唯一类型谓词外，没有任何写法能凭空产出 CalendarDate', () => {
    const files = program.getSourceFiles().filter(relevant)
    expect(files.map((f) => relative(SRC, f.fileName))).toEqual(expect.arrayContaining([
      'lib/data-center/params.ts', 'lib/data-center/context.ts', 'export-worker/registry.ts', 'lib/calendar-date.ts',
    ]))
    const offenders = files.flatMap(escapes)
    expect(offenders).toEqual(['lib/calendar-date.ts:30 产出 brand 的类型谓词 value is CalendarDate'])
  }, 120_000)

  it('自检：各类逃逸写法（含别名 / typeof 派生）都能识别，正路写法不误报', () => {
    const dir = mkdtempSync(join(tmpdir(), 'calendar-date-guard-'))
    const files: Record<string, string> = {
      'brand.ts': `declare const calendarDateBrand: unique symbol
        export type CalendarDate = string & { readonly [calendarDateBrand]: true }
        export type TR = { preset: 'month' } | { preset: 'custom'; start: CalendarDate; end: CalendarDate }
        export function ok(v: unknown): v is CalendarDate { return typeof v === 'string' }
        export function use(t: TR) { return t }`,
      'bad.ts': `import { type CalendarDate as CD, type TR as Alias, use, ok } from './brand'
        type Derived = Parameters<typeof use>[0]
        declare const s: string
        declare const j: any
        export const a = s as CD
        export const b = { preset: 'custom', start: s, end: s } as Alias
        export const c = { preset: 'custom', start: s, end: s } as unknown as Derived
        export const d = use({ preset: 'custom', start: s as never, end: s as any })
        export const e = use(j)
        export function mint(v: unknown): v is CD { return true }
        export const good = ok(s) ? use({ preset: 'custom', start: s, end: s }) : use({ preset: 'month' })`,
    }
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
    const p = ts.createProgram([join(dir, 'brand.ts'), join(dir, 'bad.ts')], { strict: true, target: ts.ScriptTarget.ES2022, noEmit: true, skipLibCheck: true })
    expect(p.getSemanticDiagnostics(p.getSourceFile(join(dir, 'bad.ts'))!).map((d: ts.Diagnostic) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([])
    const saved = checker
    checker = p.getTypeChecker()
    try {
      const found = escapes(p.getSourceFile(join(dir, 'bad.ts'))!).map((e) => e.replace(/^.*?:(\d+) /, '$1 '))
      // a(5) / b(6) / c(7) / d(8，never 与 any 各一) / e(9) / mint(10) 行都命中；good 行（第 11 行）不应出现
      expect([...new Set(found.map((f) => Number(f.split(' ')[0])))]).toEqual([5, 6, 7, 8, 9, 10])
      expect(found.filter((f) => f.startsWith('8 ') && f.includes('宽松断言'))).toHaveLength(2)
    } finally {
      checker = saved
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
