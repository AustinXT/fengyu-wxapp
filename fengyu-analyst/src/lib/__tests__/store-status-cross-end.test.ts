import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { sql } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { activeStoreCondition } from "../store-status"

/**
 * 经营分析「在营门店」口径的跨端字面量守护（#421，跟随数据中心 #401）。
 *
 * analyst 是独立部署的站点，`src/lib/store-status.ts` 是 admin `lib/store-status.ts` 的**独立副本**
 * （根 CLAUDE.md：禁止跨端共享代码目录）。跨站点没法 import，只能读对端源文件比对。
 *
 * ## 守什么
 *
 * 1. analyst `activeStoreCondition` **实际渲染出的 SQL** ≡ admin / staff 源码里的同名片段（整段等值），
 *    且三者都等于下面的固定字面量——只改一端必红；三端一起改也必须显式改这里。
 * 2. 取数入口 `scopeFilterSql` 整段钉死：在营子查询放在首位、无条件叠加（全局账号也不例外）。
 *    三个板块（复购 / 渗透 / 新客漏斗）全部经它取数，调用点逐个钉死。
 * 3. 范围下拉的门店条件整段钉死：只看门店节点 `isActive`。
 * 4. 闭集：analyst 源码（剥掉注释后）不得出现 `is_closed` / `isClosed`；会查库的文件是闭集，
 *    新增取数文件必须在这里归类（否则可能绕过 scopeFilterSql）。
 *
 * ⚠️ analyst 的 vitest 不在 CI 里跑（#382）：改动 analyst 取数时须本地跑本文件。
 */

const ANALYST_SRC = path.resolve(__dirname, "../..")
const REPO = path.resolve(ANALYST_SRC, "../..")
const ADMIN_STORE_STATUS = path.join(REPO, "fengyu-admin/src/lib/store-status.ts")
const STAFF_STORE_STATUS = path.join(REPO, "fengyu-staff/cloudfunctions/staffApi/utils/store-status.js")

const read = (file: string) => readFileSync(file, "utf8")
const squeeze = (text: string) => text.replace(/\s+/g, " ").trim()

/** 抽出 `start` 到其后第一个 `end` 之间的源码片段（end 不含）；找不到直接抛错，避免空断言 */
function extractSection(src: string, start: string, end: string): string {
  const from = src.indexOf(start)
  if (from < 0) throw new Error(`未找到源码片段起点：${start}`)
  if (src.indexOf(start, from + start.length) >= 0) throw new Error(`源码片段起点不唯一：${start}`)
  const to = src.indexOf(end, from + start.length)
  if (to < 0) throw new Error(`未找到源码片段终点：${end}`)
  return src.slice(from, to)
}

/** 函数体里 `IN (` 到最后一个 `)` 的在营子查询 */
const inner = (body: string) => squeeze(body.slice(body.indexOf("IN ("), body.lastIndexOf(")") + 1))

const EXPECTED_ACTIVE =
  "IN ( SELECT active_store.store_id FROM stores active_store JOIN org_nodes active_node ON active_store.org_node_id = active_node.id WHERE active_node.type = '门店' AND active_node.is_active = TRUE )"

/** 用 TypeScript 扫描器剥掉注释，只留代码 token（比正则剥注释可靠：不会误伤字符串 / 模板里的 `//`） */
function stripComments(src: string, file: string): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    file.endsWith(".tsx") ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard,
    src,
  )
  const parts: string[] = []
  // 模板 `${` 内的花括号深度栈：遇到收尾的 `}` 须 reScanTemplateToken，否则模板剩余文本会被当成代码扫
  const templateBraces: number[] = []
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.CloseBraceToken && templateBraces.length > 0) {
      if (templateBraces[templateBraces.length - 1] === 0) {
        kind = scanner.reScanTemplateToken(false)
        templateBraces.pop()
      } else {
        templateBraces[templateBraces.length - 1] -= 1
      }
    } else if (kind === ts.SyntaxKind.OpenBraceToken && templateBraces.length > 0) {
      templateBraces[templateBraces.length - 1] += 1
    }
    if (kind === ts.SyntaxKind.TemplateHead || kind === ts.SyntaxKind.TemplateMiddle) templateBraces.push(0)
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) continue
    parts.push(scanner.getTokenText())
  }
  const out = parts.join("")
  // 自检：剥注释只会让文本变短，且去掉空白后必须是原文去空白后的子序列前缀一致（防扫描器吞字符）
  if (out.length > src.length) throw new Error(`stripComments 输出比原文长：${file}`)
  return out
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : listSourceFiles(full)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : []
  })
}

describe("在营门店口径跨端守护（#421）", () => {
  it("1. activeStoreCondition 三端整段等值（analyst 取实际渲染结果）", () => {
    const rendered = new PgDialect().sqlToQuery(activeStoreCondition(sql.raw("so.store_id"))).sql
    expect(squeeze(rendered)).toBe(`so.store_id ${EXPECTED_ACTIVE}`)

    const adminBody = extractSection(read(ADMIN_STORE_STATUS), "export function activeStoreCondition(storeCol: SQL): SQL {", "\n}\n")
    const staffBody = extractSection(read(STAFF_STORE_STATUS), "function activeStoreCondition(column) {", "\n}\n")
    expect(inner(adminBody)).toBe(EXPECTED_ACTIVE)
    expect(inner(staffBody)).toBe(EXPECTED_ACTIVE)
    expect(inner(rendered)).toBe(inner(adminBody))
  })

  it("2. scopeFilterSql 整段钉死：在营子查询首位、无条件叠加", () => {
    const scope = read(path.join(ANALYST_SRC, "lib/analyst-scope.ts"))
    expect(squeeze(stripComments(scope, "analyst-scope.ts"))).toContain(
      'import { activeStoreCondition } from "./store-status"',
    )
    const body = squeeze(stripComments(extractSection(scope, "export function scopeFilterSql(", "\n}\n"), "x.ts"))
    expect(body).toBe(
      squeeze(`export function scopeFilterSql(
  session: AuthSession,
  scope: AnalystScope,
  storeCol = "so.store_id",
): SQL {
  if (!VALID_COLUMN_NAME.test(storeCol)) {
    throw new Error(\`INVALID_PARAMS: invalid storeCol parameter: \${storeCol}\`)
  }
  const col = sql.raw(storeCol)
  const parts: SQL[] = [activeStoreCondition(col)]
  if (!hasGlobalAnalystScope(session)) {
    const ids = session.permissions.scopeStoreIds
    if (ids.length === 0) return sql\`FALSE\`
    parts.push(sql\`\${col} IN (\${sql.join(ids.map((id) => sql\`\${id}\`), sql\`, \`)})\`)
  }
  if (scope.type === "store") {
    parts.push(sql\`\${col} = \${scope.id}\`)
  } else if (scope.type === "market") {
    parts.push(sql\`\${col} IN (
      SELECT s.store_id
      FROM stores s
      JOIN org_nodes o ON o.id = s.org_node_id
      WHERE o.type = '门店'
        AND o.parent_id = \${scope.id}
    )\`)
  }
  return sql.join(parts, sql\` AND \`)`),
    )
  })

  it("2b. 三个板块的 store 维度过滤全部经 scopeFilterSql（调用点闭集）", () => {
    const calls = (file: string) =>
      (stripComments(read(path.join(ANALYST_SRC, file)), file).match(/scopeFilterSql\(session, scope, "[a-z_.]+"\)/g) ?? []).sort()
    expect(calls("lib/repurchase.ts")).toEqual(['scopeFilterSql(session, scope, "so.store_id")'])
    expect(calls("lib/penetration.ts")).toEqual(['scopeFilterSql(session, scope, "c.bound_store_id")'])
    expect(calls("lib/new-customer-funnel.ts")).toEqual([
      'scopeFilterSql(session, scope, "c.bound_store_id")',
      'scopeFilterSql(session, scope, "mo.store_id")',
      'scopeFilterSql(session, scope, "so.store_id")',
      'scopeFilterSql(session, scope, "svc.store_id")',
      'scopeFilterSql(session, scope, "yo.store_id")',
    ])
  })

  it("3. 范围下拉门店条件整段钉死：只看门店节点 isActive", () => {
    const scope = read(path.join(ANALYST_SRC, "lib/analyst-scope.ts"))
    const where = extractSection(scope, "    .innerJoin(storeNode, eq(stores.orgNodeId, storeNode.id))", "    .orderBy(asc(stores.storeName))")
    expect(squeeze(stripComments(where, "x.ts"))).toBe(
      squeeze(`.innerJoin(storeNode, eq(stores.orgNodeId, storeNode.id))
    .where(
      and(
        eq(storeNode.type, "门店"),
        eq(storeNode.isActive, true),
        seeAll
          ? undefined
          : session.permissions.scopeStoreIds.length > 0
            ? inArray(stores.storeId, session.permissions.scopeStoreIds)
            : eq(stores.storeId, "__none__"),
      ),
    )`),
    )
  })

  it("4. 闭集：源码禁关店标记；查库文件须归类", () => {
    const files = listSourceFiles(ANALYST_SRC)
    expect(files.length).toBeGreaterThan(20)

    const closedHits = files.filter((file) => /is_closed|isClosed/.test(stripComments(read(file), file)))
    expect(closedHits.map((file) => path.relative(ANALYST_SRC, file))).toEqual([])

    // 会查库的文件闭集：新增取数文件必须先确认经 scopeFilterSql 过滤在营门店，再加进来
    const dbFiles = files
      .filter((file) => /\bdb\s*\.\s*(execute|select|insert|update|delete)\b/.test(stripComments(read(file), file)))
      .map((file) => path.relative(ANALYST_SRC, file))
      .sort()
    expect(dbFiles).toEqual([
      "app/api/health/route.ts", // SELECT 1 探活
      "lib/analyst-scope.ts", // 范围下拉 / 旧参数解析
      "lib/assistant-chat-store.ts", // 会话存储，无经营数据
      "lib/assistant-product-terms.ts", // 品项字典，无门店维度
      "lib/auth.ts", // 登录鉴权：员工 / 角色
      "lib/member-threshold.ts", // system_configs 阈值
      "lib/new-customer-funnel.ts", // 经营数据 → scopeFilterSql
      "lib/operation-log.ts", // 写操作日志
      "lib/penetration.ts", // 经营数据 → scopeFilterSql
      "lib/permissions.ts", // 权限展开
      "lib/repurchase.ts", // 经营数据 → scopeFilterSql
    ])
  })
})
