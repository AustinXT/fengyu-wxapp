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
 * 2. 取数入口整段钉死：`scopeFilterSql` 在营子查询放在首位、无条件叠加（全局账号也不例外）；
 *    `scopeRangeSql` 不含在营，只给「首次」基线用（#421 拍板：新客首单 / 复购首次进入用全历史判定，
 *    否则在停用门店买过的老顾客换到在营门店会被误判成新客），调用方必须在归属门店上另叠在营条件。
 *    三个板块的 scopeFilterSql / scopeRangeSql / activeStoreCondition 调用点逐个钉死。
 * 3. 范围下拉的门店条件整段钉死：只看门店节点 `isActive`。
 * 4. 闭集：analyst 源码（含注释）不得出现 `is_closed` / `isClosed` / `closed_at` / `closedAt`；会查库的文件是闭集，
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

/**
 * 用 TypeScript parser 剥掉注释，只留代码。注释区间取自语法树每个节点 / token 的前后 trivia，
 * 不会被正则字面量（`/[/*]/`）、字符串、模板或 JSX 文本里的 `//` 带偏。
 */
function stripComments(src: string, file: string): string {
  const sf = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const ranges = new Map<number, number>()
  const collect = (list: ts.CommentRange[] | undefined) => {
    for (const range of list ?? []) ranges.set(range.pos, range.end)
  }
  const visit = (node: ts.Node) => {
    // JSX 文本不是 trivia，从它的起点扫注释会把 `http://` 之类当成注释
    if (node.kind !== ts.SyntaxKind.JsxText) {
      collect(ts.getLeadingCommentRanges(src, node.pos))
      collect(ts.getTrailingCommentRanges(src, node.end))
    }
    node.getChildren(sf).forEach(visit)
  }
  visit(sf)
  collect(ts.getLeadingCommentRanges(src, sf.endOfFileToken.pos))
  let out = ""
  let cursor = 0
  for (const [pos, end] of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (pos < cursor) continue
    out += src.slice(cursor, pos)
    cursor = end
  }
  return out + src.slice(cursor)
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : listSourceFiles(full)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : []
  })
}

/** 源码里 `name(` 的全部调用（括号配平取完整实参），排除 import / 函数声明；已排序 */
function callsOf(src: string, name: string): string[] {
  const out: string[] = []
  const re = new RegExp(`(?<![\\w])${name}\\s*\\(`, "g")
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const before = src.slice(Math.max(0, m.index - 16), m.index)
    if (/function\s+$/.test(before)) continue
    let depth = 0
    let i = m.index + name.length
    for (; i < src.length; i += 1) {
      if (src[i] === "(") depth += 1
      else if (src[i] === ")" && --depth === 0) break
    }
    if (depth !== 0) throw new Error(`${name} 调用括号不配平`)
    out.push(squeeze(src.slice(m.index, i + 1)))
  }
  return out.sort()
}

describe("在营门店口径跨端守护（#421）", () => {
  it("0. stripComments 自检：只剥注释，不被正则字面量 / 字符串 / 模板 / JSX 文本里的 // 带偏", () => {
    const src = [
      "const re = /[/*]/ // 尾注释",
      "const keep1 = 1",
      "const url = 'http://x' /* 块注释 */",
      "const tpl = `a // b ${url} /* c */`",
      "/** 文档注释 */",
      "const el = <p>http://x</p>",
      "const keep2 = 2",
    ].join("\n")
    const out = stripComments(src, "fixture.tsx")
    for (const code of ["const re = /[/*]/", "const keep1 = 1", "'http://x'", "`a // b ${url} /* c */`", "<p>http://x</p>", "const keep2 = 2"]) {
      expect(out).toContain(code)
    }
    for (const comment of ["尾注释", "块注释", "文档注释"]) expect(out).not.toContain(comment)
  })

  it("1. activeStoreCondition 三端整段等值（analyst 取实际渲染结果）", () => {
    const render = (col: ReturnType<typeof sql.raw>) => squeeze(new PgDialect().sqlToQuery(activeStoreCondition(col)).sql)
    const rendered = render(sql.raw("so.store_id"))
    expect(rendered).toBe(`so.store_id ${EXPECTED_ACTIVE}`)
    // 左操作数必须原样保留调用方传入的表达式（三个板块传的列 + 复购的聚合表达式），防 helper 写死列名
    for (const col of ["c.bound_store_id", "fo.store_id", "q.store_id", "store_id", "(ARRAY_AGG(q.store_id ORDER BY q.sale_date))[1]"]) {
      expect(render(sql.raw(col))).toBe(`${col} ${EXPECTED_ACTIVE}`)
    }

    const adminBody = extractSection(read(ADMIN_STORE_STATUS), "export function activeStoreCondition(storeCol: SQL): SQL {", "\n}\n")
    const staffBody = extractSection(read(STAFF_STORE_STATUS), "function activeStoreCondition(column) {", "\n}\n")
    expect(inner(adminBody)).toBe(EXPECTED_ACTIVE)
    expect(inner(staffBody)).toBe(EXPECTED_ACTIVE)
    expect(inner(rendered)).toBe(inner(adminBody))
  })

  it("2. 取数 scope 三段整段钉死：scopeFilterSql 首位无条件叠在营；scopeRangeSql 不含在营", () => {
    const scope = read(path.join(ANALYST_SRC, "lib/analyst-scope.ts"))
    expect(squeeze(stripComments(scope, "analyst-scope.ts"))).toContain(
      'import { activeStoreCondition } from "./store-status"',
    )
    // 先整份剥注释再定位声明：注释里包着的旧函数不会被当成实现（codex round-2 P2）
    const code = stripComments(scope, "analyst-scope.ts")
    const body = (start: string) => squeeze(extractSection(code, start, "\n}\n"))

    expect(body("export function scopeFilterSql(")).toBe(
      squeeze(`export function scopeFilterSql(
  session: AuthSession,
  scope: AnalystScope,
  storeCol = "so.store_id",
): SQL {
  const range = scopeRangeParts(session, scope, storeCol)
  if (!range) return sql\`FALSE\`
  return sql.join([activeStoreCondition(range.col), ...range.parts], sql\` AND \`)`),
    )
    expect(body("export function scopeRangeSql(")).toBe(
      squeeze(`export function scopeRangeSql(
  session: AuthSession,
  scope: AnalystScope,
  storeCol = "so.store_id",
): SQL {
  const range = scopeRangeParts(session, scope, storeCol)
  if (!range) return sql\`FALSE\`
  return range.parts.length > 0 ? sql.join(range.parts, sql\` AND \`) : sql\`TRUE\``),
    )
    expect(body("function scopeRangeParts(")).toBe(
      squeeze(`function scopeRangeParts(
  session: AuthSession,
  scope: AnalystScope,
  storeCol: string,
): { col: SQL; parts: SQL[] } | null {
  if (!VALID_COLUMN_NAME.test(storeCol)) {
    throw new Error(\`INVALID_PARAMS: invalid storeCol parameter: \${storeCol}\`)
  }
  const col = sql.raw(storeCol)
  const parts: SQL[] = []
  if (!hasGlobalAnalystScope(session)) {
    const ids = session.permissions.scopeStoreIds
    if (ids.length === 0) return null
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
  return { col, parts }`),
    )
  })

  it("2b. 板块取数调用点闭集：计入数据走 scopeFilterSql；scopeRangeSql 只用于首次基线且必配归属在营", () => {
    const calls = (file: string) => {
      const src = stripComments(read(path.join(ANALYST_SRC, file)), file)
      return {
        filter: callsOf(src, "scopeFilterSql"),
        range: callsOf(src, "scopeRangeSql"),
        active: callsOf(src, "activeStoreCondition"),
      }
    }
    // 复购：首次进入基线全历史；复购达标日 + 首次进入门店须在营；筛选项目录只列在营门店
    expect(calls("lib/repurchase.ts")).toEqual({
      filter: ['scopeFilterSql(session, scope, "so.store_id")'],
      range: ['scopeRangeSql(session, scope, "so.store_id")'],
      active: [
        'activeStoreCondition(sql.raw("q.store_id"))',
        'activeStoreCondition(sql.raw("store_id"))',
        "activeStoreCondition(sql`(ARRAY_AGG(q.store_id ORDER BY ${firstStoreOrder}))[1]`)",
      ].sort(),
    })
    // 首次进入归属：门店名 / 市场 / 在营判定三处 ARRAY_AGG 同一排序，且同日优先在营门店
    const repurchase = squeeze(stripComments(read(path.join(ANALYST_SRC, "lib/repurchase.ts")), "x.ts"))
    expect(repurchase).toContain(
      'const firstStoreOrder = sql`q.sale_date, (CASE WHEN ${activeStoreCondition(sql.raw("q.store_id"))} THEN 0 ELSE 1 END), q.min_date, q.store_id`',
    )
    expect(repurchase.match(/ARRAY_AGG\(q\.(customer_name|store|market|store_id) ORDER BY \$\{firstStoreOrder\}\)/g)).toEqual([
      "ARRAY_AGG(q.customer_name ORDER BY ${firstStoreOrder})",
      "ARRAY_AGG(q.store ORDER BY ${firstStoreOrder})",
      "ARRAY_AGG(q.market ORDER BY ${firstStoreOrder})",
      "ARRAY_AGG(q.store_id ORDER BY ${firstStoreOrder})",
    ])
    expect(repurchase).not.toMatch(/ARRAY_AGG\(q\.(customer_name|store|market|store_id) ORDER BY q\./)
    // 复购条件真的接进了 WHERE / HAVING / 达标日（GLM round-2 P2：只钉调用文本时可删接线）
    expect(repurchase.match(/WHERE \$\{\w+\}\s*\S+/g)).toEqual([
      "WHERE ${whereSql} ${range.endDate",
      "WHERE ${firstEntrySql} ),",
      "WHERE ${whereSql} ORDER",
    ])
    expect(repurchase).toContain("const whereSql = buildBaseConditions(scopeRangeSql(session, scope, \"so.store_id\"), filters)")
    expect(repurchase).toContain("const whereSql = buildBaseConditions(scopeFilterSql(session, scope, \"so.store_id\"), {})")
    expect(repurchase).toContain('WHERE repurchase_day_amount >= ${threshold} AND ${activeStoreCondition(sql.raw("store_id"))} ),')
    expect(repurchase).toContain("HAVING ${activeStoreCondition(sql`(ARRAY_AGG(q.store_id ORDER BY ${firstStoreOrder}))[1]`)} ORDER BY")
    // 渗透：条件构造器必须真的接进两条查询的 WHERE（GLM round-1 P2：只钉构造器时 `OR TRUE` 全绿）
    const penetration = squeeze(stripComments(read(path.join(ANALYST_SRC, "lib/penetration.ts")), "x.ts"))
    // 两个注入点：WHERE 后紧跟的就是收尾反引号 / 下一条 AND，中间不能夹 OR 之类的放宽
    expect(penetration.match(/WHERE \$\{\w+\}\s*\S+/g)).toEqual(["WHERE ${whereSql} `)", "WHERE ${memberWhereSql} AND"])
    expect(penetration).toContain("const whereSql = memberConditions(session, scope)")
    expect(penetration).toContain("const memberWhereSql = memberConditions(session, scope)")
    // 渗透：会员按当前绑定门店截面，无首次基线
    expect(calls("lib/penetration.ts")).toEqual({
      filter: ['scopeFilterSql(session, scope, "c.bound_store_id")'],
      range: [],
      active: [],
    })
    // 新客漏斗：首单基线全历史；首单门店须在营；转介绍 / 到店 / 入会金额 / 年贡献走 scopeFilterSql
    expect(calls("lib/new-customer-funnel.ts")).toEqual({
      filter: [
        'scopeFilterSql(session, scope, "c.bound_store_id")',
        'scopeFilterSql(session, scope, "mo.store_id")',
        'scopeFilterSql(session, scope, "svc.store_id")',
        'scopeFilterSql(session, scope, "yo.store_id")',
      ],
      range: ['scopeRangeSql(session, scope, "so.store_id")'],
      active: ['activeStoreCondition(sql.raw("fo.store_id"))', 'activeStoreCondition(sql.raw("so.store_id"))'],
    })
    const funnel = squeeze(stripComments(read(path.join(ANALYST_SRC, "lib/new-customer-funnel.ts")), "x.ts"))
    // 定义逐字钉死（GLM round-2 P2：CASE 极性反转 / NOT 包裹时调用文本不变）
    for (const decl of [
      'const firstOrderScope = scopeRangeSql(session, scope, "so.store_id")',
      'const firstOrderStoreActive = activeStoreCondition(sql.raw("fo.store_id"))',
      'const firstOrderSameDayActiveFirst = sql`(CASE WHEN ${activeStoreCondition(sql.raw("so.store_id"))} THEN 0 ELSE 1 END)`',
      'const transferScope = scopeFilterSql(session, scope, "c.bound_store_id")',
      'const serviceScope = scopeFilterSql(session, scope, "svc.store_id")',
      'const memberAmountScope = scopeFilterSql(session, scope, "mo.store_id")',
      'const annualAmountScope = scopeFilterSql(session, scope, "yo.store_id")',
    ]) {
      expect(funnel).toContain(decl)
    }
    // 每个范围条件都真的接进了 WHERE，entries 两个分支整段钉死
    expect(funnel.match(/WHERE \$\{\w+\}\s*\S+/g)).toEqual([
      "WHERE ${firstOrderScope} AND",
      "WHERE ${serviceScope} AND",
      "WHERE ${memberAmountScope} AND",
      "WHERE ${annualAmountScope} AND",
    ])
    expect(funnel).toContain(
      "WHERE ( (c.customer_source::text = ${TRANSFER_SOURCE} AND ${transferScope}) OR (c.customer_source::text IS DISTINCT FROM ${TRANSFER_SOURCE} AND fo.client_user_id IS NOT NULL AND ${firstOrderStoreActive}) ) AND",
    )
    expect(funnel).toContain(
      "ORDER BY so.client_user_id, (COALESCE(so.sale_order_datetime, so.paid_at, so.created_at) AT TIME ZONE 'Asia/Shanghai')::date ASC, ${firstOrderSameDayActiveFirst}, order_at ASC,",
    )
    // 新客漏斗的首单门店在营条件确实接进了非转介绍分支
    expect(squeeze(stripComments(read(path.join(ANALYST_SRC, "lib/new-customer-funnel.ts")), "x.ts"))).toContain(
      "OR (c.customer_source::text IS DISTINCT FROM ${TRANSFER_SOURCE} AND fo.client_user_id IS NOT NULL AND ${firstOrderStoreActive})",
    )
    // scopeRangeSql 全仓只在这两处基线出现：按标识符出现（剥注释后）判定，别名 import / 命名空间调用也会被数到
    const rangeUsers = listSourceFiles(ANALYST_SRC)
      .filter((file) => /\bscopeRangeSql\b/.test(stripComments(read(file), file)))
      .map((file) => path.relative(ANALYST_SRC, file))
      .sort()
    expect(rangeUsers).toEqual(["lib/analyst-scope.ts", "lib/new-customer-funnel.ts", "lib/repurchase.ts"])
  })

  it("2c. helper 的 import 来源与绑定名钉死（AST）：别名 import / 本地同名定义都算违规", () => {
    const EXPECTED: Record<string, string> = {
      scopeFilterSql: "@/lib/analyst-scope",
      scopeRangeSql: "@/lib/analyst-scope",
      activeStoreCondition: "@/lib/store-status",
    }
    const bindings = (file: string) => {
      const src = read(path.join(ANALYST_SRC, file))
      const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      const imported: string[] = []
      const localDecls: string[] = []
      const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const from = node.moduleSpecifier.text
          const named = node.importClause?.namedBindings
          if (named && ts.isNamedImports(named)) {
            for (const el of named.elements) {
              const local = el.name.text
              const original = el.propertyName?.text ?? local
              if (local in EXPECTED || original in EXPECTED) imported.push(`${original} as ${local} from ${from}`)
            }
          }
          if (named && ts.isNamespaceImport(named) && Object.values(EXPECTED).includes(from)) {
            imported.push(`* as ${named.name.text} from ${from}`)
          }
        }
        if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.name && ts.isIdentifier(node.name) && node.name.text in EXPECTED) {
          localDecls.push(node.name.text)
        }
        ts.forEachChild(node, visit)
      }
      visit(sf)
      return { imported: imported.sort(), localDecls }
    }
    const ok = (name: string) => `${name} as ${name} from ${EXPECTED[name]}`
    expect(bindings("lib/repurchase.ts")).toEqual({
      imported: [ok("activeStoreCondition"), ok("scopeFilterSql"), ok("scopeRangeSql")],
      localDecls: [],
    })
    expect(bindings("lib/new-customer-funnel.ts")).toEqual({
      imported: [ok("activeStoreCondition"), ok("scopeFilterSql"), ok("scopeRangeSql")],
      localDecls: [],
    })
    expect(bindings("lib/penetration.ts")).toEqual({ imported: [ok("scopeFilterSql")], localDecls: [] })
    // 定义处：analyst-scope 只从 ./store-status 取 activeStoreCondition，且 scopeFilterSql / scopeRangeSql 各定义一次
    expect(bindings("lib/analyst-scope.ts")).toEqual({
      imported: ["activeStoreCondition as activeStoreCondition from ./store-status"],
      localDecls: ["scopeFilterSql", "scopeRangeSql"],
    })
  })

  it("3. 范围下拉门店条件整段钉死：只看门店节点 isActive；门店级账号不列空市场", () => {
    const scope = read(path.join(ANALYST_SRC, "lib/analyst-scope.ts"))
    const code = stripComments(scope, "analyst-scope.ts")
    expect(squeeze(extractSection(code, "export async function getAnalystScopeOptions(", "\n}\n"))).toContain(
      'markets: topLevel === "store" ? markets.filter((market) => market.stores.length > 0) : markets,',
    )
    const where = extractSection(code, "    .innerJoin(storeNode, eq(stores.orgNodeId, storeNode.id))", "    .orderBy(asc(stores.storeName))")
    expect(squeeze(where)).toBe(
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

  it("4a. 账号可见门店不按在营过滤：scopeRangeSql 首次基线依赖它含停用门店（GLM round-2 P2）", () => {
    const perms = stripComments(read(path.join(ANALYST_SRC, "lib/permissions.ts")), "permissions.ts")
    const body = squeeze(extractSection(perms, "export async function expandScopeStoreIds(", "\n}\n"))
    expect(body.length).toBeGreaterThan(200)
    expect(body).not.toMatch(/is_?active|activeStoreCondition/i)
  })

  it("4. 闭集：源码禁关店标记；查库文件须归类", () => {
    const files = listSourceFiles(ANALYST_SRC)
    expect(files.length).toBeGreaterThan(20)

    // 扫原文（含注释）：源码里连注释都不写该字段名，闭集就不依赖注释剥离器
    const closedHits = files.filter((file) => /is_?closed|closed_?at/i.test(read(file)))
    expect(closedHits.map((file) => path.relative(ANALYST_SRC, file))).toEqual([])

    // 会查库的文件闭集：按「import 了 db 模块」判定（tx / 别名 / 解构等写法都绕不过 import），
    // 新增取数文件必须先确认经 scopeFilterSql 过滤在营门店，再加进来
    const dbFiles = files
      // 静态 import（含 @/db/* 子路径）与动态 import() / require 都算
      .filter((file) => /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)["'](?:@\/db|(?:\.\.?\/)+db)(?:\/[^"']*)?["']/.test(read(file)))
      .map((file) => path.relative(ANALYST_SRC, file))
      .sort()
    expect(dbFiles).toEqual([
      "app/api/health/route.ts", // SELECT 1 探活
      "lib/analyst-scope.ts", // 范围下拉 / 旧参数解析
      "lib/assistant-chat-store.ts", // 会话存储，无经营数据
      "lib/assistant-org-names.ts", // 助手识别不可见门店 / 市场名称（#436），不取数
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
