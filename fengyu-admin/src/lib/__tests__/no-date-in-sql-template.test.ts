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
 * 用来证明 drizzle 确实不代为序列化（见该文件注释）。生产代码一律不豁免。
 */
function isExempt(fileName: string): boolean {
  return /\.test\.tsx?$/.test(fileName) || fileName.includes(`${path.sep}__tests__${path.sep}`)
}

interface Hit {
  file: string
  line: number
  expr: string
  type: string
}

function scanSqlTemplatesForDate(): Hit[] {
  const configPath = path.join(ADMIN_ROOT, 'tsconfig.json')
  const cfg = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, ADMIN_ROOT)
  const srcFiles = parsed.fileNames.filter((f) => f.startsWith(path.join(ADMIN_ROOT, 'src') + path.sep))
  const program = ts.createProgram(srcFiles, parsed.options)
  const checker = program.getTypeChecker()

  const hits: Hit[] = []
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue
    if (!sf.fileName.startsWith(path.join(ADMIN_ROOT, 'src') + path.sep)) continue
    if (isExempt(sf.fileName)) continue

    const visit = (node: ts.Node): void => {
      if (
        ts.isTaggedTemplateExpression(node) &&
        node.tag.getText(sf) === 'sql' &&
        ts.isTemplateExpression(node.template)
      ) {
        for (const span of node.template.templateSpans) {
          const typeName = checker.typeToString(checker.getTypeAtLocation(span.expression))
          // 排除列引用：drizzle 的 PgColumn 泛型参数里带 dataType:"date"，字符串里也会出现 Date，
          // 但那是列不是值，`${table.updatedAt}` 渲染成列名，安全。
          if (/\bDate\b/.test(typeName) && !/PgColumn|Column</.test(typeName)) {
            hits.push({
              file: path.relative(ADMIN_ROOT, sf.fileName),
              line: sf.getLineAndCharacterOfPosition(span.expression.getStart(sf)).line + 1,
              expr: span.expression.getText(sf),
              type: typeName,
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
          `修法：改用 @/lib/db-time 的 nowTs() / beijingTs(d) / beijingBoundaryTs(dateStr, time)。`,
    ).toEqual([])
  }, 30_000)
})
