import { beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import ts from 'typescript'
import { dirname, join, relative, resolve } from 'node:path'
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

  /**
   * 类型结构里（联合 / 交叉成员、属性类型、索引签名、类型实参）是否出现 calendarDateBrand 键。
   * 每次查询做一遍带 visited 的 DFS（对环精确）；只缓存根结论与已确认的 true。不遍历函数签名（逆变位置由 requiresBrand 处理）。
   * 递归深度触顶（泛型无限实例化）直接抛错——fail-closed，不把「没看完」当成「没有」。
   */
  const DEPTH_CAP = 40
  const brandTrue = new Set<ts.Type>()
  const brandRoot = new Map<ts.Type, boolean>()
  // 取声明合并后的类型（interface 合并 / extends 下逐声明取会漏）
  const typeOfSymbol = (sym: ts.Symbol): ts.Type | undefined => checker.getTypeOfSymbol(sym)
  // 原始类型是叶子：不走其包装对象（String.prototype 等）的方法，brand 只可能挂在交叉类型的对象成员上
  const LEAF = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike |
    ts.TypeFlags.ESSymbolLike | ts.TypeFlags.EnumLike | ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Null |
    ts.TypeFlags.Never | ts.TypeFlags.Any | ts.TypeFlags.Unknown
  /**
   * 标准库 / node_modules 里声明的类型：brand 只在本仓 src 定义，这些类型要携带它只能经**类型实参**带进来，
   * 所以只走类型实参（与联合 / 交叉成员），不展开其属性与签名——否则 Array / Iterator 的方法链会无限实例化。
   */
  const libTypeCache = new Map<ts.Type, boolean>()
  function isLibType(type: ts.Type): boolean {
    let v = libTypeCache.get(type)
    if (v === undefined) {
      // 按类型**自身**的 symbol 判（不看 aliasSymbol）：`ReturnType<typeof f>` 解析出的用户对象类型别名虽来自 lib，结构仍须展开
      const sym = type.getSymbol()
      const decls = sym?.declarations ?? []
      v = decls.length > 0 && decls.every((d) => {
        const f = d.getSourceFile()
        return isTsStandardLib(f) || f.fileName.includes('/node_modules/') // 按路径，不信可伪造的 no-default-lib 标记
      })
      libTypeCache.set(type, v)
    }
    return v
  }
  function structuralChildren(type: ts.Type): ts.Type[] {
    const out: ts.Type[] = []
    if (type.flags & LEAF) return out
    // 联合 / 交叉只走成员：TS 给它们合成的属性（如 `A[] | B[]` 的数组方法）都来自成员，顺着合成属性走会无限实例化
    if (type.isUnionOrIntersection()) return [...type.types]
    const isTuple = !!(type.flags & ts.TypeFlags.Object && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference &&
      (type as ts.TypeReference).target.objectFlags & ts.ObjectFlags.Tuple)
    if (isTuple || isLibType(type)) { // 元组的属性是 Array 方法，同样只看元素类型
      if (type.flags & ts.TypeFlags.Object && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) {
        out.push(...checker.getTypeArguments(type as ts.TypeReference))
      }
      out.push(...(type.aliasTypeArguments ?? []))
      return out
    }
    for (const prop of type.getProperties()) {
      const t = typeOfSymbol(prop)
      if (t) out.push(t)
    }
    for (const info of checker.getIndexInfosOfType(type)) out.push(info.type)
    if (type.flags & ts.TypeFlags.Object && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) {
      out.push(...checker.getTypeArguments(type as ts.TypeReference))
    }
    out.push(...(type.aliasTypeArguments ?? []))
    return out
  }
  const hasBrandKey = (type: ts.Type) => type.getProperties().some((p) => p.escapedName.toString().startsWith('__@calendarDateBrand'))
  function carriesBrand(root: ts.Type): boolean {
    const cached = brandRoot.get(root)
    if (cached !== undefined) return cached
    const visited = new Set<ts.Type>()
    const dfs = (type: ts.Type, depth: number): boolean => {
      if (brandTrue.has(type)) return true
      if (visited.has(type)) return false
      if (depth > DEPTH_CAP) throw new Error(`类型结构深度超过 ${DEPTH_CAP}，守护无法判定（fail-closed）：${checker.typeToString(root)}`)
      visited.add(type)
      const hit = hasBrandKey(type) || structuralChildren(type).some((t) => dfs(t, depth + 1))
      if (hit) brandTrue.add(type)
      return hit
    }
    const result = dfs(root, 0)
    brandRoot.set(root, result)
    return result
  }

  /**
   * 「产出」方向：在 carriesBrand 的结构边之外，再沿调用 / 构造签名的**返回值**走——`interface Factory { mint(): CalendarDate }`
   * 这类类型本身不带 brand，但调用它能得到 brand。用于断言目标、声明、泛型比较，也用作上下文位置洗白判定的 ctx 门槛
   * （只对 ctx 类型调用、expr 侧不遍历签名；库类型只看类型实参 + 原始类型为叶，实测整条扫描十余秒，不会 OOM）。
   */
  const producesRoot = new Map<ts.Type, boolean>()
  const producesTrue = new Set<ts.Type>() // 中间命中跨根复用（产出方向的真值，不混进 carriesBrand 的 brandTrue）
  function producesBrand(root: ts.Type): boolean {
    const cached = producesRoot.get(root)
    if (cached !== undefined) return cached
    const visited = new Set<ts.Type>()
    const stack: ts.Type[] = []
    const dfs = (type: ts.Type, depth: number): boolean => {
      if (brandTrue.has(type) || producesTrue.has(type)) return true
      if (visited.has(type)) return false
      if (depth > DEPTH_CAP) throw new Error(`类型结构深度超过 ${DEPTH_CAP}，守护无法判定（fail-closed）：${checker.typeToString(root)}\n最后几层：\n${stack.slice(-8).map((t) => checker.typeToString(t).slice(0, 160)).join('\n')}`)
      visited.add(type)
      stack.push(type)
      try {
      const returns = type.flags & LEAF || type.isUnionOrIntersection() || isLibType(type) ? [] : [...type.getCallSignatures(), ...type.getConstructSignatures()].map((sig) => sig.getReturnType())
      const hit = hasBrandKey(type) || [...structuralChildren(type), ...returns].some((t) => dfs(t, depth + 1))
      if (hit) producesTrue.add(type)
      return hit
      } finally {
        stack.pop()
      }
    }
    const result = dfs(root, 0)
    producesRoot.set(root, result)
    return result
  }

  /**
   * 类型是否「要求调用方提供 brand」：结构里（carriesBrand 的边 + 签名返回值）任何一处可调用 / 可构造、且某参数携带 brand。
   * 把这种东西断言成不要求 brand 的类型，就能再喂原始串——逆变位置是断言剥 brand 唯一有害的方向
   * （把带 brand 的值断言成普通类型只是丢了信息，造不出 brand）。
   */
  const requiresRoot = new Map<ts.Type, boolean>()
  function requiresBrand(root: ts.Type): boolean {
    const cached = requiresRoot.get(root)
    if (cached !== undefined) return cached
    const visited = new Set<ts.Type>()
    const dfs = (type: ts.Type, depth: number): boolean => {
      if (visited.has(type)) return false
      if (depth > DEPTH_CAP) throw new Error(`类型结构深度超过 ${DEPTH_CAP}，守护无法判定（fail-closed）：${checker.typeToString(root)}`)
      visited.add(type)
      const sigs = type.flags & LEAF || type.isUnionOrIntersection() || isLibType(type) ? [] : [...type.getCallSignatures(), ...type.getConstructSignatures()]
      const paramsCarry = sigs.some((sig) =>
        sig.getParameters().some((p) => { const t = typeOfSymbol(p); return !!t && carriesBrand(t) }),
      )
      // 返回值也要走：「返回一个要求 CalendarDate 的函数」再剥类型，同样能喂原始串
      return paramsCarry || [...structuralChildren(type), ...sigs.map((sig) => sig.getReturnType())].some((t) => dfs(t, depth + 1))
    }
    const result = dfs(root, 0)
    requiresRoot.set(root, result)
    return result
  }

  /**
   * 洗白判定：上下文类型 ctx 产出 brand 时，沿 ctx 里通向 brand 的路径（属性、索引签名、类型实参、签名返回值）并行看表达式类型 expr，
   * 路径上任何一处 expr 是 any / never 即为洗白（`const o = { start: j }; use(o)`、接口方法的实现省略返回注解而 return any，都是这样漏进来的）。
   * 其余位置 tsc 已校验过可赋值，expr 在 brand 处必然也是 CalendarDate。
   */
  const LAUNDERED = ts.TypeFlags.Any | ts.TypeFlags.Never
  function launders(ctx: ts.Type, expr: ts.Type, depth = 0, seen = new Set<string>()): boolean {
    if (expr.flags & LAUNDERED) return producesBrand(ctx)
    if (!producesBrand(ctx) || hasBrandKey(ctx)) return false
    const key = `${(ctx as { id?: number }).id}:${(expr as { id?: number }).id}`
    if (seen.has(key)) return false
    if (depth > DEPTH_CAP) throw new Error(`洗白判定深度超过 ${DEPTH_CAP}（fail-closed）：${checker.typeToString(ctx)}`)
    seen.add(key)
    const next = (c: ts.Type, e: ts.Type) => launders(c, e, depth + 1, seen)
    if (expr.isUnion()) return expr.types.some((e) => next(ctx, e))
    if (ctx.isUnionOrIntersection()) return ctx.types.some((c) => next(c, expr))
    for (const prop of ctx.getProperties()) {
      const c = typeOfSymbol(prop)
      const eProp = checker.getPropertyOfType(expr, prop.escapedName.toString())
      const e = eProp && typeOfSymbol(eProp)
      if (c && e && next(c, e)) return true
    }
    for (const info of checker.getIndexInfosOfType(ctx)) {
      for (const eProp of expr.getProperties()) {
        const e = typeOfSymbol(eProp)
        if (e && next(info.type, e)) return true
      }
      for (const eInfo of checker.getIndexInfosOfType(expr)) if (next(info.type, eInfo.type)) return true
    }
    // 签名镜像：ctx 可调用 / 可构造且返回值产出 brand，而 expr 对应签名的返回是 any / never（如实现省略返回注解、实际 return JSON.parse(…)）
    const pairs: Array<[readonly ts.Signature[], readonly ts.Signature[]]> = [
      [ctx.getCallSignatures(), expr.getCallSignatures()],
      [ctx.getConstructSignatures(), expr.getConstructSignatures()],
    ]
    for (const [cs, es] of pairs) {
      for (const c of cs) {
        const cr = c.getReturnType()
        if (producesBrand(cr) && es.some((e) => next(cr, e.getReturnType()))) return true
      }
    }
    const isRef = (t: ts.Type) => !!(t.flags & ts.TypeFlags.Object && (t as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference)
    if (isRef(ctx) && isRef(expr)) {
      const ca = checker.getTypeArguments(ctx as ts.TypeReference)
      const ea = checker.getTypeArguments(expr as ts.TypeReference)
      if (ca.some((c, i) => ea[i] && next(c, ea[i]))) return true
    }
    return false
  }

  const LOOSE = ts.TypeFlags.Any | ts.TypeFlags.Never | ts.TypeFlags.Unknown

  interface Escape { file: string; line: number; kind: string; text: string }

  /**
   * 表达式是否处在「上下文类型位置」（TS 只在这些位置给表达式上下文类型，闭集）：变量 / 参数 / 属性初始化器、
   * 调用与 new 的实参、return、赋值右侧、数组元素、对象属性值（含简写与展开）、JSX 属性与子节点、条件 / 逻辑运算分支、
   * 箭头函数表达式体、`satisfies`、await / yield 操作数、括号内。只在这些位置取类型，避免对每个节点都做类型计算。
   */
  function inContextualPosition(node: ts.Expression): boolean {
    const p = node.parent
    if (ts.isParenthesizedExpression(node)) return false // 看里面那层
    if (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isPropertyDeclaration(p) || ts.isBindingElement(p)) return p.initializer === node
    if (ts.isCallExpression(p) || ts.isNewExpression(p)) return !!p.arguments?.includes(node)
    if (ts.isReturnStatement(p) || ts.isAwaitExpression(p) || ts.isYieldExpression(p) || ts.isSpreadElement(p) || ts.isSpreadAssignment(p)) return true
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind
      return (op === ts.SyntaxKind.EqualsToken && p.right === node) ||
        op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.AmpersandAmpersandToken
    }
    if (ts.isArrayLiteralExpression(p) || ts.isParenthesizedExpression(p) || ts.isSatisfiesExpression(p)) return true
    if (ts.isPropertyAssignment(p)) return p.initializer === node
    if (ts.isShorthandPropertyAssignment(p)) return p.name === node
    if (ts.isConditionalExpression(p)) return p.whenTrue === node || p.whenFalse === node
    if (ts.isArrowFunction(p)) return p.body === node
    if (ts.isJsxExpression(p)) return true
    return false
  }

  /**
   * 已知安全的泛型（白名单，fail-closed：不在表里的泛型一律按规则判）：React 的 state 容器只经受检的初始值与 setter 写入 T，
   * `useState<TimeRangeInput>({ preset: 'month' })` 读出的 TR 不可能凭空带 brand。新增条目须说明「T 的值只能从受检入口进入」。
   * 边界：`useRef<CalendarDate>()` 无参重载读出的是 `CalendarDate | undefined`、值恒为 undefined（没有值进入，靠收窄兜底）——
   * 这是「零输入但不产出值」，不能据此类推放行真正零输入就返回 T 的 API。
   */
  /*
   * 登记写法：npm 包写 `{ pkg: 'react', members: [...] }`（匹配 node_modules/<pkg>/ 与 node_modules/@types/<pkg>/；
   * scoped 包写 `@scope/pkg`，其 @types 形态 `@types/scope__pkg` 自动换算）；
   * 本仓文件写 `{ file: join(SRC, 'lib/foo.ts'), members: [...] }`（与 program 内绝对路径严格相等，相对路径不会匹配）。
   * members 按 declIdentity 精确到「词法容器链 + 成员」；同一身份覆盖其**全部**重载声明，登记前须逐个重载自查。
   * 对象字面量方法、接口调用签名（`interface Fn { <T>(): T }`）没有可登记的身份——需要时改成具名函数再登记。
   */
  const SOUND_GENERICS: Array<{ pkg?: string; file?: string; members: readonly string[] }> = [
    // @types/react 是 `export = React; declare namespace React { function useState… }`，身份带命名空间（有断言锁住已安装声明）
    { pkg: 'react', members: ['React>useState', 'React>useReducer', 'React>useRef', 'React>createContext', 'React>useContext', 'React>useMemo', 'React>useCallback'] },
  ]
  // 类成员作为容器时的编码：static / constructor / get / set 与实例方法区分开
  function memberLabel(m: ts.Node): string | undefined {
    if (!ts.isClassLike(m.parent) && !ts.isInterfaceDeclaration(m.parent)) return undefined
    if (ts.isConstructorDeclaration(m)) return 'constructor'
    if (ts.isClassStaticBlockDeclaration(m)) return `static{@${m.pos}}`
    const isStatic = ts.canHaveModifiers(m) && !!ts.getModifiers(m)?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword)
    const kind = ts.isGetAccessor(m) ? 'get:' : ts.isSetAccessor(m) ? 'set:' : ''
    const name = ts.getNameOfDeclaration(m as ts.Declaration)?.getText() ?? `<anon@${m.pos}>`
    return `${isStatic ? 'static:' : ''}${kind}${name}`
  }
  // 会形成词法作用域、却没有名字的节点：代码块（非函数体）、switch 的 case 块、各类循环头、catch、类静态块
  const isAnonScope = (m: ts.Node) =>
    (ts.isBlock(m) && !ts.isFunctionLike(m.parent) && !ts.isClassStaticBlockDeclaration(m.parent)) || ts.isCaseBlock(m) ||
    ts.isForStatement(m) || ts.isForInStatement(m) || ts.isForOfStatement(m) || ts.isCatchClause(m)
  /**
   * 声明的精确身份：完整词法容器链 + 自身名，用 `>` 连接。容器 = 外层函数 / 类 / 命名空间 / 非函数体代码块；
   * 类成员区分静态（`Class.static:m`）与实例（`Class.m`），构造器为 `Class.constructor`；`const f = <T,>() => …` 取变量名。
   * 匿名容器按位置记为 `<anon@pos>` / 代码块 `{@pos}`——无法稳定登记，等于不可放行（fail-closed）。
   * 例：顶层登记 `identity` 不会放行某函数体内新写的同名 `identity`（后者身份是 `outer>identity`）。
   */
  function declIdentity(decl: ts.Declaration): string | undefined {
    // 对象字面量 / 类型字面量的成员是匿名容器里的东西：不可登记（返回 undefined 即不放行）
    for (let a: ts.Node | undefined = decl.parent; a; a = a.parent) {
      if (ts.isObjectLiteralExpression(a) || ts.isTypeLiteralNode(a)) return undefined
    }
    const own = (() => {
      if (ts.isClassLike(decl.parent) || ts.isInterfaceDeclaration(decl.parent)) return memberLabel(decl)
      if ((ts.isArrowFunction(decl) || ts.isFunctionExpression(decl)) && ts.isVariableDeclaration(decl.parent)) return decl.parent.name.getText()
      return ts.getNameOfDeclaration(decl)?.getText()
    })()
    if (!own) return undefined
    const chain: string[] = []
    // 起点：类成员从类本身开始；变量持有的函数从变量声明的外层开始；其余从自身外层开始
    const inType = ts.isClassLike(decl.parent) || ts.isInterfaceDeclaration(decl.parent)
    let n: ts.Node | undefined = inType ? decl.parent : ts.isVariableDeclaration(decl.parent) ? decl.parent.parent : decl.parent
    for (; n && !ts.isSourceFile(n); n = n.parent) {
      const member = memberLabel(n)
      if (member) {
        const owner = n.parent as ts.ClassLikeDeclaration | ts.InterfaceDeclaration
        chain.unshift(`${owner.name?.text ?? `<anon@${owner.pos}>`}.${member}`) // 类成员容器与所属类用 `.` 相连
        n = owner // 所属类已计入，跳过
      } else if (ts.isClassLike(n) || ts.isInterfaceDeclaration(n)) chain.unshift(n.name?.text ?? `<anon@${n.pos}>`)
      else if (ts.isModuleDeclaration(n)) chain.unshift(n.name.getText())
      else if (ts.isFunctionLike(n)) {
        const name = ts.isVariableDeclaration(n.parent) ? n.parent.name.getText() : n.name?.getText()
        chain.unshift(name ?? `<anon@${n.pos}>`)
      } else if (isAnonScope(n)) chain.unshift(`{@${n.pos}}`)
    }
    const cls = inType
    const head = cls ? chain.slice(0, -1) : chain
    const container = cls ? `${chain[chain.length - 1]}.` : ''
    return [...head, `${container}${own}`].join('>')
  }
  /** 匿名容器的身份串（`<anon@…>` / `{@…}`）不稳定，登记了也不认（整条条目作废，另有断言要求白名单里不出现） */
  const ANON_ID = /<anon|\{@/
  const toTypesName = (pkg: string) => (pkg.startsWith('@') ? pkg.slice(1).replace('/', '__') : pkg)
  function isSoundGeneric(decl: ts.Declaration): boolean {
    const file = decl.getSourceFile().fileName.replace(/\\/g, '/') // 统一分隔符后按路径段字面量比较
    const id = declIdentity(decl)
    return !!id && SOUND_GENERICS.some((entry) =>
      entry.members.every((m) => !ANON_ID.test(m)) &&
      (entry.pkg ? file.includes(`/node_modules/${entry.pkg}/`) || file.includes(`/node_modules/@types/${toTypesName(entry.pkg)}/`)
        : entry.file?.replace(/\\/g, '/') === file) &&
      entry.members.includes(id))
  }
  /**
   * TS 安装目录下的标准库声明文件：路径 **且** 编译器认定为默认库，双条件（`/// <reference no-default-lib>` 只能伪造后者，
   * 路径钉到当前运行的 TS 安装目录，仓内另造 `node_modules/typescript/lib/lib.x.d.ts` 连前者都伪造不了）。
   * 残余面：往真实 TS 安装目录里放文件——那已是篡改依赖本身。
   */
  const TS_LIB_DIR = dirname(ts.getDefaultLibFilePath({})).replace(/\\/g, '/') // 当前运行的 TS 安装目录，钉死而非任意同名路径
  const isTsStandardLib = (f: ts.SourceFile) =>
    dirname(f.fileName).replace(/\\/g, '/') === TS_LIB_DIR && /^lib\.[^/]*\.d\.ts$/.test(f.fileName.split(/[\\/]/).pop() ?? '') &&
    program.isSourceFileDefaultLibrary(f)

  /**
   * 泛型实例化后返回值带 brand 时，是否放行（闭集，fail-closed）：
   *   - TS 标准库（路径 且 编译器认定为默认库，双条件，见 isTsStandardLib）：ES 标准库泛型实现健全，
   *     输入里带 brand 即视为透传（`dates.filter(...)`、`Promise.resolve(d)`）
   *   - 其余（本仓 src、node_modules）一律只认 SOUND_GENERICS 白名单——TS 本身不健全（数组协变写入、`x!`、无实现声明…），
   *     逐条审计实现体是开放集合，追不完；白名单条目须在评审中说明「T 的值只能从受检入口进入」
   */
  function genericPassesThrough(node: ts.Node, decl: ts.SignatureDeclaration | ts.JSDocSignature): boolean {
    if (isTsStandardLib(decl.getSourceFile())) return brandFromInputs(node)
    return isSoundGeneric(decl as ts.Declaration)
  }

  /** 调用的输入（实参、方法接收者、tagged template 插值与接收者）里是否已带 brand——**仅用于 TS 标准库泛型**的透传判定 */
  function brandFromInputs(node: ts.Node): boolean {
    const inputs: ts.Expression[] = []
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      inputs.push(...(node.arguments ?? []))
      const callee = node.expression
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) inputs.push(callee.expression)
    } else if (ts.isTaggedTemplateExpression(node)) {
      if (ts.isTemplateExpression(node.template)) inputs.push(...node.template.templateSpans.map((span) => span.expression))
      if (ts.isPropertyAccessExpression(node.tag) || ts.isElementAccessExpression(node.tag)) inputs.push(node.tag.expression)
    }
    return inputs.some((e) => producesBrand(checker.getTypeAtLocation(e)))
  }

  /** 编译器解析出的 @ts-check / @ts-nocheck pragma（公开类型里未暴露但运行时存在；自检锁住这个字段仍在） */
  const checkJsDirectiveOf = (sf: ts.SourceFile) =>
    (sf as ts.SourceFile & { checkJsDirective?: { enabled: boolean; pos: number } }).checkJsDirective

  /** 自身或任一祖先带 `declare` 修饰（`declare namespace N { const d: … }` 的内层声明自身没有修饰，靠祖先判） */
  function inAmbientContext(node: ts.Node): boolean {
    for (let n: ts.Node | undefined = node; n; n = n.parent) {
      if (ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) return true
    }
    return false
  }

  /** 源码里真实的注释区间（AST 收集，字符串字面量里的同形文本不算） */
  function commentRanges(sf: ts.SourceFile): ts.CommentRange[] {
    const seen = new Map<number, ts.CommentRange>()
    const add = (ranges: ts.CommentRange[] | undefined) => ranges?.forEach((r) => seen.set(r.pos, r))
    const visit = (node: ts.Node) => {
      add(ts.getLeadingCommentRanges(sf.text, node.pos))
      add(ts.getTrailingCommentRanges(sf.text, node.end))
      ts.forEachChild(node, visit)
    }
    visit(sf)
    add(ts.getLeadingCommentRanges(sf.text, sf.endOfFileToken.pos))
    return [...seen.values()]
  }

  function escapes(sf: ts.SourceFile): Escape[] {
    const out: Escape[] = []
    const at = (node: ts.Node, kind: string, text = node.getText(sf).slice(0, 80)) => {
      out.push({ file: relative(SRC, sf.fileName), line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, kind, text })
    }
    // ⑥ 抑制注释：@ts-ignore / @ts-expect-error / @ts-nocheck 能让任意值落进 branded 位置而 tsc 不报
    // 逐字镜像 TS 编译器的判定（typescript.js 的 commentDirectiveRegExSingleLine / MultiLine：前缀匹配、**无尾部边界**，
    // 所以 `// @ts-ignorex` 同样生效）：`//` 注释整段匹配；块注释只取最后一行
    for (const r of commentRanges(sf)) {
      const raw = sf.text.slice(r.pos, r.end)
      let m: RegExpExecArray | null = null
      // appendIfCommentDirective 对两种注释都先 trimStart() 再匹配（`   * @ts-ignore */` 这种 JSDoc 式末行同样生效）
      if (r.kind === ts.SyntaxKind.SingleLineCommentTrivia) m = /^\/\/\/?\s*@(ts-expect-error|ts-ignore)/.exec(raw.trimStart())
      else m = /^(?:\/|\*)*\s*@(ts-expect-error|ts-ignore)/.exec(raw.slice(raw.lastIndexOf('\n') + 1).trimStart())
      if (m) out.push({ file: relative(SRC, sf.fileName), line: sf.getLineAndCharacterOfPosition(r.pos).line + 1, kind: '类型检查抑制注释', text: `@${m[1]}` })
    }
    // @ts-nocheck 直接读编译器自己解析出的 pragma 结果（大小写、块注释不认、`-foo` 后缀、多条以最后一条为准，都由 TS 决定）
    const directive = checkJsDirectiveOf(sf)
    if (directive && !directive.enabled) {
      out.push({ file: relative(SRC, sf.fileName), line: sf.getLineAndCharacterOfPosition(directive.pos).line + 1, kind: '类型检查抑制注释', text: '@ts-nocheck' })
    }
    const declaredTypeCarries = (node: ts.Node) => {
      const name = ts.getNameOfDeclaration(node as ts.Declaration)
      const sym = name && checker.getSymbolAtLocation(name)
      const t = sym ? typeOfSymbol(sym) : undefined
      return !!t && producesBrand(t)
    }
    const visit = (node: ts.Node) => {
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        const target = checker.getTypeFromTypeNode(node.type)
        if (producesBrand(target)) at(node, '断言成携带 brand 的类型')
        else if (target.flags & LOOSE && (() => { const ctx = checker.getContextualType(node); return !!ctx && carriesBrand(ctx) })()) {
          at(node, '宽松断言落在要求 brand 的上下文')
        } else if (requiresBrand(checker.getTypeAtLocation(node.expression)) && !requiresBrand(target)) {
          // 反方向（逆变位置）：把「参数要求 brand」的函数 / 方法断言成不要求的，再喂原始串
          at(node, '断言剥掉 brand 要求')
        }
      } else if (ts.isExpression(node) && inContextualPosition(node)) {
        const ctx = checker.getContextualType(node)
        if (ctx && producesBrand(ctx) && launders(ctx, checker.getTypeAtLocation(node))) at(node, 'any / never 值落在要求 brand 的上下文')
      }
      // ⑤ 泛型实例化带出 brand：解析出的签名是实例化产物（≠ 声明签名，涵盖函数级与类级泛型），
      //    声明返回类型本身不产出 brand、实例化后却产出（`mint<CalendarDate>(raw)`、推断、别名、元素访问、`new Box<CalendarDate>()` 同理）
      if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node) || ts.isDecorator(node)) {
        const sig = checker.getResolvedSignature(node as ts.CallLikeExpression)
        const decl = sig?.getDeclaration()
        const declared = decl && checker.getSignatureFromDeclaration(decl)
        if (sig && declared && sig !== declared && producesBrand(sig.getReturnType()) && !producesBrand(declared.getReturnType()) &&
          !genericPassesThrough(node, decl)) {
          at(node, '泛型实例化带出 brand')
        }
      }
      // ⑦ 不受实现检查的声明：无函数体的签名（重载 / declare）、环境声明、`!` 明确赋值断言——类型里带 brand 就等于凭空认定
      const bodiless = (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && !node.body
      const ambient = (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isClassDeclaration(node) ||
        ts.isMethodDeclaration(node)) && (sf.isDeclarationFile || inAmbientContext(node))
      const definite = (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && !!node.exclamationToken
      if ((bodiless || ambient || definite) && declaredTypeCarries(node)) at(node, '无实现检查的声明携带 brand')
      if (ts.isTypePredicateNode(node) && node.type && carriesBrand(checker.getTypeFromTypeNode(node.type))) {
        at(node, '产出 brand 的类型谓词')
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    return out
  }

  const scanned = (p: ts.Program, root: string) =>
    p.getSourceFiles().filter((sf) => {
      const rel = relative(root, sf.fileName)
      return !rel.startsWith('..') && !/\.(?:test|spec)\.tsx?$/.test(rel) && !rel.includes('__tests__')
    })

  /**
   * 预筛（为了速度，且可靠）：`CalendarDate` 只在 calendar-date.ts 声明（导出闭集 + unique symbol），任何携带 brand 的类型都源自它；
   * 一个文件要接触到这类类型，必须沿 import / re-export / import type / 动态 import 链传递地引用到它。
   * 所以只查它的**反向依赖闭包**（当前约 400 个文件）。
   */
  function reverseClosure(p: ts.Program, rootFile: string): Set<string> | { all: string[] } {
    const c = p.getTypeChecker()
    const importers = new Map<string, string[]>()
    const addEdge = (target: string, from: string) => {
      const list = importers.get(target) ?? []
      list.push(from)
      importers.set(target, list)
    }
    for (const sf of p.getSourceFiles()) {
      for (const ref of sf.referencedFiles) addEdge(resolve(dirname(sf.fileName), ref.fileName), sf.fileName) // /// <reference path>
      const specs: ts.Expression[] = []
      const collect = (node: ts.Node) => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) specs.push(node.moduleSpecifier)
        else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specs.push(node.argument.literal)
        else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0]) specs.push(node.arguments[0])
        ts.forEachChild(node, collect)
      }
      collect(sf)
      for (const spec of specs) {
        const target = c.getSymbolAtLocation(spec)?.valueDeclaration
        if (target && ts.isSourceFile(target)) addEdge(target.fileName, sf.fileName)
      }
    }
    const seen = new Set([rootFile])
    for (const queue = [rootFile]; queue.length; ) {
      for (const f of importers.get(queue.pop()!) ?? []) if (!seen.has(f)) (seen.add(f), queue.push(f))
    }
    // 闭包里若有全局增强（`declare global`）、模块增强（`declare module 'x'`）或全局脚本（非模块文件），
    // brand 可能经全局名 / 被增强的模块暴露给不 import calendar-date 链上任何文件的消费者，
    // 反向闭包的前提失效 → 退回全量扫描
    const leaksGlobally = [...seen].filter((f) => {
      const sf = p.getSourceFile(f)
      // 全局脚本、`declare global`、字符串名模块增强（`declare module 'pkg'` 可把 brand 合并进第三方模块类型）
      return !!sf && (!ts.isExternalModule(sf) || sf.statements.some((st) => ts.isModuleDeclaration(st) &&
        (!!(st.flags & ts.NodeFlags.GlobalAugmentation) || ts.isStringLiteral(st.name))))
    })
    return leaksGlobally.length ? { all: leaksGlobally } : seen
  }

  it('全 src 非测试源码里，能产出 CalendarDate 的只有 calendar-date.ts 那一个类型谓词', () => {
    const files = scanned(program, SRC)
    expect(files.length, '扫描范围异常缩小').toBeGreaterThan(500)
    const closure = reverseClosure(program, join(SRC, 'lib/calendar-date.ts'))
    const checkedFiles = closure instanceof Set ? files.filter((f) => closure.has(f.fileName)) : files
    expect(checkedFiles.map((f) => relative(SRC, f.fileName))).toEqual(expect.arrayContaining([
      'lib/data-center/params.ts', 'lib/data-center/context.ts', 'export-worker/registry.ts', 'lib/calendar-date.ts',
      'actions/data-center/sales.ts', 'app/(main)/(analytics)/data-center/_components/sales/sales-board.tsx',
    ]))
    // 期望按 AST 身份比对（行号只用于失败时定位，不进期望值）
    const offenders = checkedFiles.flatMap((sf) => {
      try {
        return escapes(sf)
      } catch (e) {
        throw new Error(`${relative(SRC, sf.fileName)}: ${(e as Error).message}`)
      }
    })
    const why = closure instanceof Set ? '' : `\n（已退回全量扫描，触发文件：${closure.all.map((f) => relative(SRC, f)).join(', ')}）`
    expect(offenders.map(({ file, kind, text }) => ({ file, kind, text })), JSON.stringify(offenders, null, 2) + why).toEqual([
      { file: 'lib/calendar-date.ts', kind: '产出 brand 的类型谓词', text: 'value is CalendarDate' },
    ])
  }, 180_000)

  it('白名单条目不含匿名身份串（`<anon@…>` / `{@…}` 随位置漂移，不可稳定登记）', () => {
    for (const entry of SOUND_GENERICS) expect(entry.members.filter((m) => ANON_ID.test(m)), JSON.stringify(entry)).toEqual([])
  })

  it('白名单不过期：已安装 @types/react 里登记的 hook 声明，身份仍与 SOUND_GENERICS 一致', () => {
    const reactTypes = program.getSourceFiles().find((f) => /[\\/]node_modules[\\/]@types[\\/]react[\\/]index\.d\.ts$/.test(f.fileName))
    expect(reactTypes, '主 Program 里找不到 @types/react').toBeDefined()
    const registered = SOUND_GENERICS.find((e) => e.pkg === 'react')!.members
    const found = new Set<string>()
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name && registered.some((m) => m.endsWith(`>${node.name!.text}`))) {
        const id = declIdentity(node)
        if (id) found.add(id)
        expect(isSoundGeneric(node), id).toBe(true)
      }
      ts.forEachChild(node, visit)
    }
    visit(reactTypes!)
    expect([...found].sort()).toEqual([...registered].sort())
  })

  it('自检：闭包里出现全局增强 / 模块增强时退回全量扫描；三斜线引用进闭包', () => {
    const dir = mkdtempSync(join(tmpdir(), 'calendar-date-global-'))
    try {
      writeFileSync(join(dir, 'brand.ts'), `declare const b: unique symbol\nexport type CalendarDate = string & { readonly [b]: true }`)
      writeFileSync(join(dir, 'glob.d.ts'), `import type { CalendarDate } from './brand'\ndeclare global { type GlobalDate = CalendarDate }\nexport {}`)
      writeFileSync(join(dir, 'consumer.ts'), `declare const g: GlobalDate\nexport const x = g`)
      const p = ts.createProgram([join(dir, 'brand.ts'), join(dir, 'glob.d.ts'), join(dir, 'consumer.ts')], { strict: true, noEmit: true, skipLibCheck: true })
      expect(reverseClosure(p, join(dir, 'brand.ts'))).toEqual({ all: [join(dir, 'glob.d.ts')] })

      // 模块增强：增强文件 import brand，把 CalendarDate 合并进 './lib' 的接口；消费者只 import './lib'
      writeFileSync(join(dir, 'lib.ts'), `export interface Opts { x?: number }`)
      writeFileSync(join(dir, 'aug.ts'), `import type { CalendarDate } from './brand'\ndeclare module './lib' { interface Opts { d: CalendarDate } }\nexport {}`)
      writeFileSync(join(dir, 'user.ts'), `import type { Opts } from './lib'\nexport const o = {} as Opts`)
      const p2 = ts.createProgram([join(dir, 'brand.ts'), join(dir, 'lib.ts'), join(dir, 'aug.ts'), join(dir, 'user.ts')], { strict: true, noEmit: true, skipLibCheck: true })
      expect(reverseClosure(p2, join(dir, 'brand.ts'))).toEqual({ all: [join(dir, 'aug.ts')] })

      // 三斜线引用也是依赖边：只靠 `/// <reference path>` 接触 brand 的文件必须进闭包
      writeFileSync(join(dir, 'ref.ts'), `/// <reference path="./brand.ts" />\nexport const r = 1`)
      const p3 = ts.createProgram([join(dir, 'brand.ts'), join(dir, 'ref.ts')], { strict: true, noEmit: true, skipLibCheck: true })
      const c3 = reverseClosure(p3, join(dir, 'brand.ts'))
      expect(c3 instanceof Set ? [...c3].map((f) => relative(dir, f)).sort() : c3).toEqual(['brand.ts', 'ref.ts'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('自检：@ts-nocheck 以编译器解析结果为准（大小写不敏感、块注释不认、带后缀不认、多条以最后一条为准）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'calendar-date-nocheck-'))
    const cases: Record<string, [string, boolean]> = {
      'plain.ts': ['// @ts-nocheck\nexport const a = 1', true],
      'upper.ts': ['// @TS-NOCHECK\nexport const a = 1', true],
      'block.ts': ['/* @ts-nocheck */\nexport const a = 1', false],
      'suffix.ts': ['// @ts-nocheck-foo\nexport const a = 1', false],
      'last-wins.ts': ['// @ts-nocheck\n// @ts-check\nexport const a = 1', false],
    }
    try {
      for (const [name, [text]] of Object.entries(cases)) writeFileSync(join(dir, name), text)
      const p = ts.createProgram(Object.keys(cases).map((n) => join(dir, n)), { strict: true, noEmit: true, skipLibCheck: true })
      // 依赖的内部字段必须仍在（TS 升级改了实现时这里先红，而不是守护静默失效）
      expect(checkJsDirectiveOf(p.getSourceFile(join(dir, 'plain.ts'))!)).toMatchObject({ enabled: false })
      const saved = [program, checker] as const
      program = p
      checker = p.getTypeChecker()
      try {
        for (const [name, [, flagged]] of Object.entries(cases)) {
          const hits = escapes(p.getSourceFile(join(dir, name))!).filter((e) => e.text === '@ts-nocheck')
          expect(hits.length, name).toBe(flagged ? 1 : 0)
        }
      } finally {
        ;[program, checker] = saved
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('自检：各类逃逸写法（别名 / 派生 / 泛型铸造含别名与元素访问 / 洗白含中间对象 / 重载与环境声明 / 中性 re-export / 抑制注释）都能识别，正路不误报', () => {
    const dir = mkdtempSync(join(tmpdir(), 'calendar-date-guard-'))
    const files: Record<string, string> = {
      'brand.ts': `declare const calendarDateBrand: unique symbol
        export type CalendarDate = string & { readonly [calendarDateBrand]: true }
        export type TR = { preset: 'month' } | { preset: 'custom'; start: CalendarDate; end: CalendarDate }
        export function ok(v: unknown): v is CalendarDate { return typeof v === 'string' }
        export function use(t: TR) { return t }`,
      'neutral.ts': `export { use as run } from './brand'`,
      'decl.d.ts': `import type { CalendarDate } from './brand'\nexport declare const dd: CalendarDate`,
      // 伪造「默认库」的 .d.ts：编译器认它为默认库，但不在 TS 安装路径下（路径=false, 编译器=true）
      'fakelib.d.ts': `/// <reference no-default-lib="true"/>\nimport type { CalendarDate } from './brand'\nexport declare function fakeMint<T>(witness: T): T\nexport interface FakeBox { d: CalendarDate }`,
      // 伪造「默认库」：no-default-lib 标记不能让它获得标准库的信任
      'spoof.ts': `/// <reference no-default-lib="true"/>\nimport type { CalendarDate } from './brand'\nexport function spoofSmuggle<T>(raw: unknown, witness: T): T { void witness; return raw as T }\nexport interface SpoofBox { d: CalendarDate }`,
      'bad.ts': [
        `import { type CalendarDate as CD, type TR as Alias, use, ok } from './brand'`,
        `import { run } from './neutral'`,
        `import { useState } from 'react'`,
        `import { spoofSmuggle, type SpoofBox } from './spoof'`,
        `import { make as typedOnlyMake } from 'typed-only'`,
        `import { mint as libSpoofMint } from 'typescript/lib/lib.spoof'`,
        `import { fakeMint, type FakeBox } from './fakelib'`,
        `import { mint as bothMint } from 'typescript/lib/lib.both'`,
        `import { mint as evilMint } from 'evil'`,
        `type Derived = Parameters<typeof use>[0]`,
        `declare const s: string`,
        `declare const j: any`,
        `function mintG<T>(raw: unknown): T { return raw as T }`,
        `const n = j as never`,
        `function makeRange(a: CD) { return { start: a } }`,
        `interface Factory { mint(): CD }`,
        `class Box<T> { value!: T; constructor() {} get(): T { return this.value } }`,
        `export const a = s as CD // @alias-assert`,
        `export const b = { preset: 'custom', start: s, end: s } as Alias // @alias-assert2`,
        `export const c = { preset: 'custom', start: s, end: s } as unknown as Derived // @derived`,
        `export const d = use({ preset: 'custom', start: s as never, end: s as any }) // @loose`,
        `export const e = use(j) // @any-arg`,
        `export function mint(v: unknown): v is CD { return true } // @predicate`,
        `export const f = use({ preset: 'custom', start: mintG<CD>(s), end: mintG(s) }) // @generic`,
        `export const g = use({ preset: 'custom', start: n, end: n }) // @never-flow`,
        `export const h = run({ preset: 'custom', start: s as never, end: s as never }) // @reexport`,
        `// @ts-expect-error`,
        `export const i = use({ preset: 'custom', start: 1, end: 2 }) // @after-suppress`,
        `export const k = (use as (t: unknown) => unknown)({ preset: 'custom', start: s, end: s }) // @strip`,
        `const alias = mintG; export const l = use({ preset: 'custom', start: alias(s), end: alias(s) }) // @generic-alias`,
        `const box = { mint: mintG }; export const m = use({ preset: 'custom', start: box['mint'](s), end: box['mint'](s) }) // @generic-elem`,
        `const id = <T,>(): T => null as T; export const o = use({ preset: 'custom', start: id(), end: id() }) // @generic-arrow`,
        `function over(): CD; function over() { return JSON.parse('1') } // @overload`,
        `declare const amb: CD // @ambient`,
        `const lo = { preset: 'custom' as const, start: j, end: j }; export const q = use(lo) // @via-object`,
        `class Holder { d!: CD } // @definite`,
        `declare const fac: Factory // @ambient-factory`,
        `export const fac2 = {} as Factory // @assert-factory`,
        `export const bx = new Box<CD>() // @class-generic`,
        `export const bg = new Box<CD>().get() // @class-generic2`,
        `declare namespace NS { const d: CD } // @namespace`,
        `export const rt2 = {} as ReturnType<typeof makeRange> // @returntype`,
        `export const rec = {} as Partial<Record<'x', CD>> // @mapped`,
        `export const txt = '@ts-ignore 字符串里不算' // @string`,
        `/** 说明：这里历史上用过 @ts-ignore，已去掉 */ export const doc = 1 // @doc-mention`,
        `interface P { get(): CD }`,
        `class Impl implements P { get() { return JSON.parse('x') } }`,
        `export const pImpl: P = new Impl() // @impl-any`,
        `export const pLit: P = { get() { return JSON.parse('x') } } // @literal-any`,
        `declare class DC { d: CD } // @declare-class`,
        `class SafeBox<T> { constructor(public v: T) {} get(): T { return this.v } mint<U>(): U { return null as U } }`,
        `const identity = <T,>(v: T): T => v`,
        `export const safe = ok(s) ? [new SafeBox(s), new SafeBox(s).get(), identity(s)] : [] // @safe-generic`,
        `export const unsafeMember = ok(s) ? new SafeBox(s).mint<CD>() : null // @listed-class-new-method`,
        `export const ev = evilMint<CD>() // @unlisted-npm`,
        `export const libNoInput = [Array.of<CD>(), new Array<CD>()] // @lib-no-input`,
        `export const sb: SpoofBox = j // @spoof-libtype`,
        `export const to = typedOnlyMake<CD>() // @types-pkg`,
        `export const lsm = ok(s) ? libSpoofMint<CD>(s) : null // @spoof-lib-path`,
        `export const fkm = ok(s) ? fakeMint<CD>(s) : null // @fake-default-lib`,
        `export const bm = ok(s) ? bothMint<CD>(s) : null // @spoof-both`,
        `export const fkb: FakeBox = j // @fake-default-libtype`,
        `export function outer() { const identity = <T,>(): T => null as T; return identity<CD>() } // @nested-same-name`,
        // 以下三种都在**模块顶层**：与顶层登记的 `identity` 同名，若作用域节点漏识别就会撞上白名单
        `switch (Number('1')) { case 1: const identity = <T,>(): T => null as T; void identity<CD>() } // @case-block`,
        `for (const identity = <T,>(): T => null as T; ;) { void identity<CD>(); break } // @loop-scope`,
        `{ const identity = <T,>(): T => null as T; void identity<CD>() } // @block-scope`,
        `try { void 0 } catch { const identity = <T,>(): T => null as T; void identity<CD>() } // @catch-scope`,
        `class Twin { static get<T>(): T { return null as T } get<T>(): T { return null as T } constructor() { const identity = <T,>(): T => null as T; void identity<CD>() } } // @ctor-nested`,
        `export const tw = Twin.get<CD>() // @static-twin`,
        `export const twi = new Twin().get<CD>() // @twin-instance`,
        `const objM = { identity<T>(raw: unknown): T { return raw as T } }`,
        `export const om = objM.identity<CD>(s) // @object-literal-method`,
        `interface IdentityHolder { identity<T>(raw: unknown): T }`,
        `declare const ih: IdentityHolder`,
        `export const imh = ih.identity<CD>(s) // @interface-method-same-name`,
        `export const st8 = useState<Alias>({ preset: 'month' }) // @sound-lib`,
        `function smuggle<T>(raw: unknown, witness: T): T { void witness; return raw as T }`,
        `export const smug = ok(s) ? smuggle<CD>('invalid', s) : null // @smuggle-witness`,
        `class SafeTag<T> { constructor(public v: T) {} tag(_s: TemplateStringsArray, ..._x: unknown[]): T { return this.v } }`,
        `export const tg = ok(s) ? [new SafeTag(s).tag\`\`, new SafeTag(s).tag\`\${1}\`] : [] // @safe-tag`,
        `function mintTag<T>(_s: TemplateStringsArray): T { return null as T }`,
        `export const mt = mintTag<CD>\`\` // @mint-tag`,
        `export const dates = ok(s) ? [s].filter(Boolean).map((d) => d) : [] // @lib-passthrough`,
        `declare function mintD<T>(): T`,
        `export const md = mintD<CD>() // @declared-generic`,
        `function covariant<T>(xs: T[], raw: unknown): T { (xs as unknown[]).push(raw); return xs[xs.length - 1] }`,
        `export const cov = ok(s) ? covariant([s], 'invalid') : null // @covariant`,
        `function nonNull<T>(o?: T): T { return o! }`,
        `export const nn = nonNull<CD>() // @non-null`,
        `export const sp = ok(s) ? spoofSmuggle<CD>('invalid', s) : null // @spoof-lib`,
        `interface Minter { mint<T>(): T }`,
        `declare const minter: Minter`,
        `export const mm = minter.mint<CD>() // @interface-generic`,
        `function ovG<T>(): T; function ovG() { return null }`,
        `export const og = ovG<CD>() // @overload-generic`,
        `// 文件中部的 @ts-nocheck 不生效`,
        `export const mid = 1 // @ts-nocheck @mid-nocheck`,
        `// @ts-ignorex`,
        `export const sfx = use({ preset: 'custom', start: 5, end: 6 }) // @after-suffix`,
        `/* @ts-ignore 在块注释非末行不生效`,
        `   说明 */ export const blk = 1 // @block-nonlast`,
        `/* 块注释末行才生效`,
        `   @ts-ignore */`,
        `export const blk2 = use({ preset: 'custom', start: 3, end: 4 }) // @block-last`,
        `/* JSDoc 风格：末行是「空白 + 星号 + 指令」`,
        `   * @ts-ignore */`,
        `export const blk3 = use({ preset: 'custom', start: 7, end: 8 }) // @block-star`,
        `export const good = ok(s) ? use({ preset: 'custom', start: s, end: s }) : use({ preset: 'month' }) // @good`,
      ].join('\n'),
    }
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
    // 仿 react 类型包：验证白名单按「包 + 名字」放行
    mkdirSync(join(dir, 'node_modules/react'), { recursive: true })
    writeFileSync(join(dir, 'node_modules/react/package.json'), '{"name":"react","types":"index.d.ts"}')
    // 结构照搬 @types/react：`export = React` + `declare namespace React { function useState… }`
    writeFileSync(join(dir, 'node_modules/react/index.d.ts'), 'export = React\ndeclare namespace React { function useState<S>(initial: S): [S, (v: S) => void] }')
    // 未登记的 npm 包：其泛型不因「来自 node_modules」获得信任
    mkdirSync(join(dir, 'node_modules/evil'), { recursive: true })
    writeFileSync(join(dir, 'node_modules/evil/package.json'), '{"name":"evil","types":"index.d.ts"}')
    writeFileSync(join(dir, 'node_modules/evil/index.d.ts'), 'export declare function mint<T>(): T')
    // 伪造「标准库路径」：放在 node_modules/typescript/lib/lib.*.d.ts，但编译器并不认它为默认库
    mkdirSync(join(dir, 'node_modules/typescript/lib'), { recursive: true })
    writeFileSync(join(dir, 'node_modules/typescript/lib/lib.spoof.d.ts'), 'export declare function mint<T>(witness: T): T')
    // 两个条件同时伪造（同名路径 + no-default-lib）：只有「路径钉到当前运行的 TS 安装目录」能拦下
    writeFileSync(join(dir, 'node_modules/typescript/lib/lib.both.d.ts'), '/// <reference no-default-lib="true"/>\nexport declare function mint<T>(witness: T): T')
    mkdirSync(join(dir, 'node_modules/@types/typed-only'), { recursive: true })
    writeFileSync(join(dir, 'node_modules/@types/typed-only/index.d.ts'), 'export declare function make<T>(): T')
    const p = ts.createProgram([join(dir, 'brand.ts'), join(dir, 'neutral.ts'), join(dir, 'decl.d.ts'), join(dir, 'fakelib.d.ts'), join(dir, 'spoof.ts'), join(dir, 'bad.ts')], {
      strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, noEmit: true, skipLibCheck: true,
    })
    expect(p.getSemanticDiagnostics(p.getSourceFile(join(dir, 'bad.ts'))!).map((d: ts.Diagnostic) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([])
    // 中性 re-export 也必须进反向闭包（守护的预筛环节）
    const closure = reverseClosure(p, join(dir, 'brand.ts'))
    expect(closure instanceof Set ? [...closure].map((f) => relative(dir, f)).sort() : closure).toEqual(['bad.ts', 'brand.ts', 'decl.d.ts', 'fakelib.d.ts', 'neutral.ts', 'spoof.ts'])
    // 临时 Program 确实带着真实标准库（no-default-lib 夹具不得把整个 Program 的默认库关掉），且两个伪库夹具的编译器认定各自如预期
    expect(p.getSourceFiles().some((f) => /[\\/]node_modules[\\/]typescript[\\/]lib[\\/]lib\.es5\.d\.ts$/.test(f.fileName))).toBe(true)
    expect(p.isSourceFileDefaultLibrary(p.getSourceFile(join(dir, 'fakelib.d.ts'))!)).toBe(true)
    const libSpoof = p.getSourceFiles().find((f) => f.fileName.endsWith('node_modules/typescript/lib/lib.spoof.d.ts'))
    expect(libSpoof && p.isSourceFileDefaultLibrary(libSpoof)).toBe(false)
    // .d.ts 进入 scanned（守护的扫描集）
    expect(scanned(p, dir).map((f) => relative(dir, f.fileName))).toContain('decl.d.ts')
    const saved = [program, checker] as const
    program = p
    checker = p.getTypeChecker()
    // 安全泛型须显式登记（白名单语义）；自检用临时条目，结束后移除
    // `Twin.get` 只登记实例方法：同名静态方法 `Twin.static:get` 不得蹭到
    const fixtureEntry = { file: join(dir, 'bad.ts'), members: ['SafeBox.constructor', 'SafeBox.get', 'SafeTag.constructor', 'SafeTag.tag', 'Twin.get'] }
    // 按文件登记时路径分隔符两侧都归一：用反斜杠形态登记 `identity` 也必须命中
    const backslashEntry = { file: join(dir, 'bad.ts').replace(/\//g, '\\'), members: ['identity'] }
    // 只有 @types 包的白名单条目（锁住 node_modules/@types/<pkg>/ 分支）
    const typesOnlyEntry = { pkg: 'typed-only', members: ['make'] }
    SOUND_GENERICS.push(fixtureEntry, typesOnlyEntry, backslashEntry)
    try {
      const found = escapes(p.getSourceFile(join(dir, 'bad.ts'))!)
      const text = files['bad.ts'].split('\n')
      const lineOf = (mark: string) => text.findIndex((l) => l.includes(`// @${mark}`)) + 1
      const markOf = (e: Escape) => text[e.line - 1].match(/\/\/ @([\w-]+)/)?.[1] ?? `L${e.line}`
      // 精确多重集（种类|标记 → 次数）：同一行多个逃逸点任一失效都会让计数变化
      // 注：`class-generic2` 内外层都命中——Box 有 `value!: T`（实现不健全），src 泛型不因接收者带 brand 豁免；
      //     `loose` / `never-flow` / `reexport` / `literal-any` 行的对象字面量整体另计一次（镜像判出其中含 any/never）
      const tally = found.filter((e) => e.kind !== '类型检查抑制注释').map((e) => `${e.kind}|${markOf(e)}`).sort()
      expect(tally).toEqual([
        "any / never 值落在要求 brand 的上下文|any-arg",
        "any / never 值落在要求 brand 的上下文|impl-any",
        "any / never 值落在要求 brand 的上下文|literal-any",
        "any / never 值落在要求 brand 的上下文|literal-any",
        "any / never 值落在要求 brand 的上下文|loose",
        "any / never 值落在要求 brand 的上下文|never-flow",
        "any / never 值落在要求 brand 的上下文|never-flow",
        "any / never 值落在要求 brand 的上下文|never-flow",
        "any / never 值落在要求 brand 的上下文|reexport",
        "any / never 值落在要求 brand 的上下文|via-object",
        "产出 brand 的类型谓词|predicate",
        "宽松断言落在要求 brand 的上下文|derived",
        "宽松断言落在要求 brand 的上下文|loose",
        "宽松断言落在要求 brand 的上下文|loose",
        "宽松断言落在要求 brand 的上下文|reexport",
        "宽松断言落在要求 brand 的上下文|reexport",
        "断言剥掉 brand 要求|strip",
        "断言成携带 brand 的类型|alias-assert",
        "断言成携带 brand 的类型|alias-assert2",
        "断言成携带 brand 的类型|assert-factory",
        "断言成携带 brand 的类型|derived",
        "断言成携带 brand 的类型|mapped",
        "断言成携带 brand 的类型|returntype",
        "无实现检查的声明携带 brand|ambient",
        "无实现检查的声明携带 brand|ambient-factory",
        "无实现检查的声明携带 brand|declare-class",
        "无实现检查的声明携带 brand|declare-class",
        "无实现检查的声明携带 brand|definite",
        "无实现检查的声明携带 brand|namespace",
        "无实现检查的声明携带 brand|overload",
        "泛型实例化带出 brand|class-generic",
        "泛型实例化带出 brand|class-generic2",
        "泛型实例化带出 brand|class-generic2",
        "泛型实例化带出 brand|generic",
        "泛型实例化带出 brand|generic",
        "泛型实例化带出 brand|generic-alias",
        "泛型实例化带出 brand|generic-alias",
        "泛型实例化带出 brand|generic-arrow",
        "泛型实例化带出 brand|generic-arrow",
        "泛型实例化带出 brand|generic-elem",
        "泛型实例化带出 brand|mint-tag",
        "泛型实例化带出 brand|declared-generic",
        "泛型实例化带出 brand|covariant",
        "泛型实例化带出 brand|non-null",
        "泛型实例化带出 brand|spoof-lib",
        "泛型实例化带出 brand|interface-generic",
        "泛型实例化带出 brand|overload-generic",
        "泛型实例化带出 brand|listed-class-new-method",
        "泛型实例化带出 brand|unlisted-npm",
        "泛型实例化带出 brand|lib-no-input",
        "泛型实例化带出 brand|lib-no-input",
        "any / never 值落在要求 brand 的上下文|spoof-libtype",
        "泛型实例化带出 brand|spoof-lib-path",
        "泛型实例化带出 brand|fake-default-lib",
        "泛型实例化带出 brand|spoof-both",
        "any / never 值落在要求 brand 的上下文|fake-default-libtype",
        "泛型实例化带出 brand|nested-same-name",
        "泛型实例化带出 brand|case-block",
        "泛型实例化带出 brand|loop-scope",
        "泛型实例化带出 brand|block-scope",
        "泛型实例化带出 brand|catch-scope",
        "泛型实例化带出 brand|ctor-nested",
        "泛型实例化带出 brand|static-twin",
        "泛型实例化带出 brand|object-literal-method",
        "泛型实例化带出 brand|interface-method-same-name",
        "泛型实例化带出 brand|smuggle-witness",
        "泛型实例化带出 brand|generic-elem"
      ].sort())
      // 抑制注释：`//` 行首的 @ts-expect-error、块注释末行的 @ts-ignore；文件中部 @ts-nocheck、块注释非末行不算
      expect(found.filter((e) => e.kind === '类型检查抑制注释').map((e) => e.line)).toEqual([
        lineOf('after-suppress') - 1, lineOf('after-suffix') - 1, lineOf('block-last') - 2, lineOf('block-star') - 2,
      ])
      // 安全泛型传递、字符串 / JSDoc 句中提及、正路都不误报
      expect(found.filter((e) => ['safe-generic', 'sound-lib', 'safe-tag', 'lib-passthrough', 'types-pkg', 'twin-instance', 'string', 'doc-mention', 'good', 'mid-nocheck', 'block-nonlast'].some((m) => e.line === lineOf(m)))).toEqual([])
      // .d.ts 里的值声明
      const inDecl = escapes(p.getSourceFile(join(dir, 'decl.d.ts'))!)
      expect(inDecl.map((e) => e.kind)).toEqual(['无实现检查的声明携带 brand'])
    } finally {
      for (const entry of [fixtureEntry, typesOnlyEntry, backslashEntry]) {
        const at = SOUND_GENERICS.indexOf(entry)
        if (at >= 0) SOUND_GENERICS.splice(at, 1)
      }
      ;[program, checker] = saved
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
