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

  /**
   * 类型结构里（联合 / 交叉成员、属性类型、索引签名、类型实参）是否出现 calendarDateBrand 键。
   * 每次查询做一遍带 visited 的 DFS（对环精确）；只缓存根结论与已确认的 true。不遍历函数签名（逆变位置由 requiresBrand 处理）。
   * 递归深度触顶（泛型无限实例化）直接抛错——fail-closed，不把「没看完」当成「没有」。
   */
  const DEPTH_CAP = 40
  const brandTrue = new Set<ts.Type>()
  const brandRoot = new Map<ts.Type, boolean>()
  const typeOfSymbol = (sym: ts.Symbol) => {
    const decl = sym.valueDeclaration ?? sym.declarations?.[0]
    return decl ? checker.getTypeOfSymbolAtLocation(sym, decl) : undefined
  }
  function structuralChildren(type: ts.Type): ts.Type[] {
    const out: ts.Type[] = []
    if (type.isUnionOrIntersection()) out.push(...type.types)
    for (const prop of type.getProperties()) {
      const t = typeOfSymbol(prop)
      if (t) out.push(t)
    }
    for (const info of checker.getIndexInfosOfType(type)) out.push(info.type)
    if (type.flags & ts.TypeFlags.Object && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) {
      out.push(...checker.getTypeArguments(type as ts.TypeReference))
    }
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
   * 类型是否「要求调用方提供 brand」：结构里（同 carriesBrand 的边）任何一处可调用 / 可构造、且某参数携带 brand。
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
      const paramsCarry = [...type.getCallSignatures(), ...type.getConstructSignatures()].some((sig) =>
        sig.getParameters().some((p) => { const t = typeOfSymbol(p); return !!t && carriesBrand(t) }),
      )
      return paramsCarry || structuralChildren(type).some((t) => dfs(t, depth + 1))
    }
    const result = dfs(root, 0)
    requiresRoot.set(root, result)
    return result
  }

  /**
   * 洗白判定：上下文类型 ctx 携带 brand 时，沿 ctx 里通向 brand 的路径并行看表达式类型 expr，
   * 路径上任何一处 expr 是 any / never 即为洗白（`const o = { start: j }; use(o)` 里 j:any 就是这样漏进来的）。
   * 其余位置 tsc 已校验过可赋值，expr 在 brand 处必然也是 CalendarDate。
   */
  const LAUNDERED = ts.TypeFlags.Any | ts.TypeFlags.Never
  function launders(ctx: ts.Type, expr: ts.Type, depth = 0, seen = new Set<string>()): boolean {
    if (expr.flags & LAUNDERED) return carriesBrand(ctx)
    if (!carriesBrand(ctx) || hasBrandKey(ctx)) return false
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
    for (const r of commentRanges(sf)) {
      const m = /@ts-(?:ignore|expect-error|nocheck)\b/.exec(sf.text.slice(r.pos, r.end))
      if (m) out.push({ file: relative(SRC, sf.fileName), line: sf.getLineAndCharacterOfPosition(r.pos).line + 1, kind: '类型检查抑制注释', text: m[0] })
    }
    const declaredTypeCarries = (node: ts.Node) => {
      const name = ts.getNameOfDeclaration(node as ts.Declaration)
      const sym = name && checker.getSymbolAtLocation(name)
      const t = sym ? typeOfSymbol(sym) : undefined
      return !!t && (carriesBrand(t) || [...t.getCallSignatures()].some((sig) => carriesBrand(sig.getReturnType())))
    }
    const visit = (node: ts.Node) => {
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        const target = checker.getTypeFromTypeNode(node.type)
        if (carriesBrand(target)) at(node, '断言成携带 brand 的类型')
        else if (target.flags & LOOSE && (() => { const ctx = checker.getContextualType(node); return !!ctx && carriesBrand(ctx) })()) {
          at(node, '宽松断言落在要求 brand 的上下文')
        } else if (requiresBrand(checker.getTypeAtLocation(node.expression)) && !requiresBrand(target)) {
          // 反方向（逆变位置）：把「参数要求 brand」的函数 / 方法断言成不要求的，再喂原始串
          at(node, '断言剥掉 brand 要求')
        }
      } else if (ts.isExpression(node) && inContextualPosition(node)) {
        const ctx = checker.getContextualType(node)
        if (ctx && carriesBrand(ctx) && launders(ctx, checker.getTypeAtLocation(node))) at(node, 'any / never 值落在要求 brand 的上下文')
      }
      // ⑤ 泛型实例化带出 brand：声明的返回类型本身不带 brand，实例化后却带了（`mint<CalendarDate>(raw)`、推断、别名、元素访问同理）
      if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) {
        const sig = checker.getResolvedSignature(node)
        const decl = sig?.getDeclaration()
        if (sig && decl && decl.typeParameters?.length && carriesBrand(sig.getReturnType())) {
          const declared = checker.getSignatureFromDeclaration(decl)
          if (declared && !carriesBrand(declared.getReturnType())) at(node, '泛型实例化带出 brand')
        }
      }
      // ⑦ 不受实现检查的声明：无函数体的签名（重载 / declare）、环境声明、`!` 明确赋值断言——类型里带 brand 就等于凭空认定
      const bodiless = (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && !node.body
      const ambient = (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isClassDeclaration(node)) &&
        (sf.isDeclarationFile || !!(ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Ambient))
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
  function reverseClosure(p: ts.Program, rootFile: string): Set<string> {
    const c = p.getTypeChecker()
    const importers = new Map<string, string[]>()
    for (const sf of p.getSourceFiles()) {
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
        if (target && ts.isSourceFile(target)) {
          const list = importers.get(target.fileName) ?? []
          list.push(sf.fileName)
          importers.set(target.fileName, list)
        }
      }
    }
    const seen = new Set([rootFile])
    for (const queue = [rootFile]; queue.length; ) {
      for (const f of importers.get(queue.pop()!) ?? []) if (!seen.has(f)) (seen.add(f), queue.push(f))
    }
    return seen
  }

  it('全 src 非测试源码里，能产出 CalendarDate 的只有 calendar-date.ts 那一个类型谓词', () => {
    const files = scanned(program, SRC)
    expect(files.length, '扫描范围异常缩小').toBeGreaterThan(500)
    const closure = reverseClosure(program, join(SRC, 'lib/calendar-date.ts'))
    const checkedFiles = files.filter((f) => closure.has(f.fileName))
    expect(checkedFiles.map((f) => relative(SRC, f.fileName))).toEqual(expect.arrayContaining([
      'lib/data-center/params.ts', 'lib/data-center/context.ts', 'export-worker/registry.ts', 'lib/calendar-date.ts',
      'actions/data-center/sales.ts', 'app/(main)/(analytics)/data-center/_components/sales/sales-board.tsx',
    ]))
    // 期望按 AST 身份比对（行号只用于失败时定位，不进期望值）
    const offenders = checkedFiles.flatMap(escapes)
    expect(offenders.map(({ file, kind, text }) => ({ file, kind, text })), JSON.stringify(offenders, null, 2)).toEqual([
      { file: 'lib/calendar-date.ts', kind: '产出 brand 的类型谓词', text: 'value is CalendarDate' },
    ])
  }, 180_000)

  it('自检：各类逃逸写法（别名 / 派生 / 泛型铸造含别名与元素访问 / 洗白含中间对象 / 重载与环境声明 / 中性 re-export / 抑制注释）都能识别，正路不误报', () => {
    const dir = mkdtempSync(join(tmpdir(), 'calendar-date-guard-'))
    const files: Record<string, string> = {
      'brand.ts': `declare const calendarDateBrand: unique symbol
        export type CalendarDate = string & { readonly [calendarDateBrand]: true }
        export type TR = { preset: 'month' } | { preset: 'custom'; start: CalendarDate; end: CalendarDate }
        export function ok(v: unknown): v is CalendarDate { return typeof v === 'string' }
        export function use(t: TR) { return t }`,
      'neutral.ts': `export { use as run } from './brand'`,
      'bad.ts': [
        `import { type CalendarDate as CD, type TR as Alias, use, ok } from './brand'`,
        `import { run } from './neutral'`,
        `type Derived = Parameters<typeof use>[0]`,
        `declare const s: string`,
        `declare const j: any`,
        `function mintG<T>(raw: unknown): T { return raw as T }`,
        `const n = j as never`,
        `export const a = s as CD`, // 8 断言（别名）
        `export const b = { preset: 'custom', start: s, end: s } as Alias`, // 9 断言（别名）
        `export const c = { preset: 'custom', start: s, end: s } as unknown as Derived`, // 10 断言（typeof 派生）
        `export const d = use({ preset: 'custom', start: s as never, end: s as any })`, // 11 宽松断言 ×2
        `export const e = use(j)`, // 12 any 值
        `export function mint(v: unknown): v is CD { return true }`, // 13 类型谓词
        `export const f = use({ preset: 'custom', start: mintG<CD>(s), end: mintG(s) })`, // 14 泛型实例化（显式 + 推断）
        `export const g = use({ preset: 'custom', start: n, end: n })`, // 15 any→never 洗白后流入
        `export const h = run({ preset: 'custom', start: s as never, end: s as never })`, // 16 经中性路径 re-export
        `// @ts-expect-error`, // 17 抑制注释
        `export const i = use({ preset: 'custom', start: 1, end: 2 })`,
        `export const k = (use as (t: unknown) => unknown)({ preset: 'custom', start: s, end: s })`, // 19 逆变剥 brand
        `const alias = mintG; export const l = use({ preset: 'custom', start: alias(s), end: alias(s) })`, // 20 泛型经别名
        `const box = { mint: mintG }; export const m = use({ preset: 'custom', start: box['mint'](s), end: box['mint'](s) })`, // 21 泛型经元素访问
        `const id = <T,>(): T => null as T; export const o = use({ preset: 'custom', start: id(), end: id() })`, // 22 箭头 const 泛型
        `function over(): CD; function over() { return JSON.parse('1') }`, // 23 重载签名
        `declare const amb: CD`, // 24 环境声明
        `const lo = { preset: 'custom' as const, start: j, end: j }; export const q = use(lo)`, // 25 经中间对象洗白
        `class Holder { d!: CD }`, // 26 明确赋值断言
        `export const txt = '@ts-ignore 字符串里不算'`, // 27 非注释
        `export const good = ok(s) ? use({ preset: 'custom', start: s, end: s }) : use({ preset: 'month' })`, // 28 正路
      ].join('\n'),
    }
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
    const p = ts.createProgram([join(dir, 'brand.ts'), join(dir, 'neutral.ts'), join(dir, 'bad.ts')], { strict: true, target: ts.ScriptTarget.ES2022, noEmit: true, skipLibCheck: true })
    expect(p.getSemanticDiagnostics(p.getSourceFile(join(dir, 'bad.ts'))!).map((d: ts.Diagnostic) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([])
    // 中性 re-export 也必须进反向闭包（守护的预筛环节）
    const closure = reverseClosure(p, join(dir, 'brand.ts'))
    expect([...closure].map((f) => relative(dir, f)).sort()).toEqual(['bad.ts', 'brand.ts', 'neutral.ts'])
    const saved = checker
    checker = p.getTypeChecker()
    try {
      const found = escapes(p.getSourceFile(join(dir, 'bad.ts'))!)
      const lines = (kind: string) => found.filter((e) => e.kind === kind).map((e) => e.line)
      expect(lines('断言成携带 brand 的类型')).toEqual([8, 9, 10])
      expect(lines('宽松断言落在要求 brand 的上下文')).toEqual([10, 11, 11, 16, 16])
      // 11 / 15 / 16 另有一条命中的是整个对象字面量实参（镜像遍历判出其中含 never），与逐值命中并存
      expect(lines('any / never 值落在要求 brand 的上下文')).toEqual([11, 12, 15, 15, 15, 16, 25])
      expect(lines('产出 brand 的类型谓词')).toEqual([13])
      expect(lines('泛型实例化带出 brand')).toEqual([14, 14, 20, 20, 21, 21, 22, 22])
      expect(lines('类型检查抑制注释')).toEqual([17])
      expect(lines('断言剥掉 brand 要求')).toEqual([19])
      expect(lines('无实现检查的声明携带 brand')).toEqual([23, 24, 26])
      expect(found.filter((e) => e.line === 27 || e.line === 28)).toEqual([]) // 字符串里的同形文本、正路都不误报
    } finally {
      checker = saved
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
