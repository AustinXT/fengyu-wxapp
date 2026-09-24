/**
 * 全仓守护：禁止把 JS `Date` 插进 drizzle 的 `` sql`` `` 模板。
 *
 * 背景（#253）：`drizzle(client)` 的 `construct()` 会把时间 OID（1184/1114/1082…）在 postgres.js
 * client 上的 **serializer** 覆盖成恒等函数，于是 `Date` 未经序列化直达 Bind writer →
 * `TypeError [ERR_INVALID_ARG_TYPE]`。读端谓词（`WHERE col >= ${d}`）与写端一样炸。
 * 正确写法是经 `lib/db-time` 的 `nowTs()` / `beijingTs(d)` / `beijingBoundaryTs(...)`。
 *
 * 为什么必须用类型检查而不是 grep / eslint：
 *   - 两次真实缺陷都藏在**看不出时间语义的标识符**后面 ——
 *     `visit-points.ts` 的 `${now}`（还算明显）、`refunds.ts` 的 `${upgradedAtThreshold}`（完全不明显，
 *     潜伏 5 个月，只在会员跌档退款时触发）。按名字 grep 必漏。
 *   - eslint 的 `no-restricted-syntax` 是 AST 规则、不感知类型，看不出某个标识符是不是 `Date`。
 *   - 单测 mock 掉 executor 时，`Date` 根本进不到绑定层，测试全绿也说明不了任何事。
 *
 * 安全的写法**不在**本守护范围内：drizzle query-builder 路径（`.values({})` / `.set({})` /
 * `eq(col, date)`）走 column 的 `mapToDriverValue`，会自行 `toISOString()`，可以放心传 Date。
 */
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import ts from 'typescript'

/** 本仓 admin 根目录（本文件位于 src/lib/__tests__/）。 */
const ADMIN_ROOT = path.resolve(__dirname, '../../..')

/**
 * 豁免：测试文件自身。`visit-points.test.ts` 的「对照组」用例**故意**把裸 Date 插进模板，
 * 用来证明 drizzle 确实不代为序列化（见该文件注释）。
 *
 * 判据是「import 了 vitest **或** 文件名是 `*.test.ts(x)`」，不按**目录**。
 * 按 `__tests__/` 目录豁免会留一个洞：有人把生产 helper 放进测试目录，它就永久免检了。
 * 两个条件都留着是因为本项目 `vitest.config.ts` 开了 `globals: true` ——
 * 测试文件可以不 import vitest 直接用 `describe/it`，只看 import 会误报。
 */
function isExempt(sf: ts.SourceFile): boolean {
  if (/\.test\.tsx?$/.test(sf.fileName)) return true
  return sf.statements.some(
    (st) =>
      ts.isImportDeclaration(st) &&
      ts.isStringLiteral(st.moduleSpecifier) &&
      st.moduleSpecifier.text === 'vitest' &&
      // `import type { Mock } from 'vitest'` 不算 —— 生产文件带个 type-only import 就免检太松
      !st.importClause?.isTypeOnly,
  )
}

interface Hit {
  file: string
  line: number
  expr: string
  type: string
}

/**
 * 这个带标签模板是不是 drizzle 的 `` sql`` ``。
 *
 * 判据是**结果类型**：展开结果的符号叫 `SQL` 且声明在 `drizzle-orm` 里。
 * 试过但不够的写法：
 *   - `node.tag.getText() === 'sql'` —— `import { sql as raw }` 和 `drizzleOrm.sql` 直接判否，
 *     **整个模板被跳过**，守护静默失效；
 *   - 解析 tag 符号再比名字 —— 堵住了 import 别名，但 `const s = sql` 这种**变量别名**
 *     符号名是 `s`，照样漏。
 * 看结果类型则与 tag 怎么拿到的无关，三种写法通吃。
 */
function isDrizzleSqlTemplate(node: ts.TaggedTemplateExpression, checker: ts.TypeChecker): boolean {
  const type = checker.getTypeAtLocation(node)
  const sym = type.getSymbol() ?? type.aliasSymbol
  if (sym?.getName() !== 'SQL') return false
  return (sym.getDeclarations() ?? []).some((d) =>
    d.getSourceFile().fileName.includes('drizzle-orm'),
  )
}

/** 全局 `Date` 实例类型（从 lib.*.d.ts 的 `interface Date` 取声明类型）。 */
function resolveGlobalDateType(program: ts.Program, checker: ts.TypeChecker): ts.Type {
  const decl = program
    .getSourceFiles()
    .filter((f) => f.isDeclarationFile && /\/lib\.[^/]*\.d\.ts$/.test(f.fileName))
    .flatMap((f) => f.statements)
    .find((st): st is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(st) && st.name.text === 'Date',
    )
  if (!decl) throw new Error('未能从 lib.d.ts 解析出全局 Date 类型，守护无法运行')
  const sym = checker.getSymbolAtLocation(decl.name)
  if (!sym) throw new Error('未能解析 Date 符号，守护无法运行')
  return checker.getDeclaredTypeOfSymbol(sym)
}

/**
 * 类型里是否含 JS `Date`。按**可赋值性**判，不按 `typeToString()` 正则、也不按符号名：
 *   - 正则：`type Clock = Date` 打印成 "Clock" 会漏；安全的 `SQL<Date>` 会被误报
 *   - 符号名：`Readonly<Date>` 的符号是 `__type`、`Date & { __brand }` 是交叉类型没有 Date 符号，
 *     两者运行时都是裸 `Date`，照样会炸，但符号名判据看不见
 * 可赋值性对这几种变体全部命中，而 `SQL<Date>` / `PgColumn<…>` / `string` 都不可赋值给 Date，
 * 天然不误报，无需维护排除名单。
 *
 * `any` / `never` 必须显式跳过：它们可赋值给任何类型，不跳会把全部 `${any}` 插值报成缺陷
 * （生产代码里确实有若干处）。这是已知盲区 —— 别在 `` sql`` `` 模板里 `as any`。
 */
function containsDateType(
  type: ts.Type,
  checker: ts.TypeChecker,
  dateType: ts.Type,
  depth = 0,
): boolean {
  const parts = type.isUnion() ? type.types : [type]
  return parts.some((p) => {
    if (p.flags & (ts.TypeFlags.Any | ts.TypeFlags.Never | ts.TypeFlags.Unknown)) return false
    if (checker.isTypeAssignableTo(p, dateType)) return true
    // 数组/元组也要看元素：`WHERE col = ANY(${dateArray})` 里 `Date[]` 不可赋值给 `Date`，
    // 但 drizzle 连数组元素级 serializer 也一并覆盖了，Bind 阶段照样出问题。
    // ⚠ 只递归数组/元组的元素类型，**不要**递归泛型实参 —— `SQL<Date>` 是安全形态，
    // 递归进去会把它误报成缺陷。
    if (depth < 3 && (checker.isArrayType(p) || checker.isTupleType(p))) {
      return checker
        .getTypeArguments(p as ts.TypeReference)
        .some((arg) => containsDateType(arg, checker, dateType, depth + 1))
    }
    return false
  })
}

function scanSqlTemplatesForDate(): Hit[] {
  const configPath = path.join(ADMIN_ROOT, 'tsconfig.json')
  const cfg = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, ADMIN_ROOT)
  const srcFiles = parsed.fileNames.filter((f) => f.startsWith(path.join(ADMIN_ROOT, 'src') + path.sep))
  const program = ts.createProgram(srcFiles, parsed.options)
  const checker = program.getTypeChecker()
  const dateType = resolveGlobalDateType(program, checker)

  const hits: Hit[] = []
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue
    if (!sf.fileName.startsWith(path.join(ADMIN_ROOT, 'src') + path.sep)) continue
    if (isExempt(sf)) continue

    const visit = (node: ts.Node): void => {
      if (
        ts.isTaggedTemplateExpression(node) &&
        ts.isTemplateExpression(node.template) &&
        isDrizzleSqlTemplate(node, checker)
      ) {
        for (const span of node.template.templateSpans) {
          const type = checker.getTypeAtLocation(span.expression)
          if (containsDateType(type, checker, dateType)) {
            hits.push({
              file: path.relative(ADMIN_ROOT, sf.fileName),
              line: sf.getLineAndCharacterOfPosition(span.expression.getStart(sf)).line + 1,
              expr: span.expression.getText(sf),
              type: checker.typeToString(type),
            })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return hits
}

describe('禁止把 JS Date 插进 drizzle sql`` 模板（#253 回归守护）', () => {
  it('src/ 下生产代码的 sql`` 模板插值中不存在 Date 类型', () => {
    const hits = scanSqlTemplatesForDate()
    const report = hits
      .map((h) => `  ${h.file}:${h.line}  \${${h.expr}}  // 类型: ${h.type}`)
      .join('\n')

    expect(
      hits,
      hits.length === 0
        ? ''
        : `发现 ${hits.length} 处把 Date 插进 sql\`\` 模板，运行时会抛 ERR_INVALID_ARG_TYPE：\n${report}\n` +
          `修法：改用 @/lib/db-time 的 nowTs()（现在）/ instantTs(d)（绝对时刻，毫秒不丢，` +
          `阈值比较必用）/ beijingTs(d)（北京墙钟，秒级）/ beijingBoundaryTs(dateStr, time)（日期边界）。`,
    ).toEqual([])
    // CI 冷缓存下建 program 比本机慢得多，超时给到 60s（本机实测约 12s）。
  }, 60_000)
})
