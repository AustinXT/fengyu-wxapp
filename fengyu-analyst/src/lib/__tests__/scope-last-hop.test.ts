/**
 * scope 透传「最后一跳」守护（#436）：页面 / 导出路由 / 智能助手把 scope 交给取数函数的那一步。
 *
 * 取数层自带账号权限过滤，最后一跳写错不会越权，但会「所选范围错 + 界面标签不符」——
 * 例如 dashboard 把 `scope` 换成 `{ type: "all" }`，选了 S1 的市场账号会看到 S1+S2，界面仍显示 S1。
 *
 * 守法（闭集 / 最终效果，不逐条禁写法）：
 * 1. 行为：三个查询模块用**真实实现**（db 返回空行），只在导出函数外面包一层记录器；
 *    驱动页面 / 导出 / 助手，断言每一次取数调用收到的 scope 都等于校验过的那一个，且调用集合与预期一致。
 * 2. 闭集：会 import 查询模块的源码文件必须登记；助手里取数调用的 scope 实参只允许三种来源写法。
 */
import fs from "node:fs"
import path from "node:path"
import { createElement } from "react"
import ts from "typescript"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AnalystScope, AnalystScopeOptions } from "../analyst-scope"
import type { AuthSession } from "../types"

const hoisted = vi.hoisted(() => {
  const calls: Array<{ module: string; fn: string; args: unknown[] }> = []
  const validated: unknown[] = []
  const wrap = (module: string, mod: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(mod).map(([name, value]) => [
        name,
        typeof value === "function"
          ? (...args: unknown[]) => {
              calls.push({ module, fn: name, args })
              return (value as (...a: unknown[]) => unknown)(...args)
            }
          : value,
      ]),
    )
  return {
    calls,
    validated,
    wrap,
    session: { current: null as unknown },
    scopeOptions: { current: null as unknown },
    catalog: { current: { storeNames: [] as string[], marketNames: [] as string[] } },
  }
})

vi.mock("server-only", () => ({}))
vi.mock("@/db", () => ({ db: { execute: vi.fn(async () => []) } }))
vi.mock("@/lib/member-threshold", () => ({ getMemberThreshold: vi.fn(async () => 3) }))
vi.mock("@/lib/auth", () => ({ getSession: vi.fn(async () => hoisted.session.current) }))
vi.mock("@/lib/assistant-product-terms", () => ({
  getSystemProductTermOptions: vi.fn(async () => ({
    productKinds: [],
    categoryNames: [],
    categories: [],
    categoryPairs: [],
    seriesNames: [],
    products: [],
  })),
}))
vi.mock("@/lib/assistant-org-names", () => ({
  getAssistantOrgNameCatalog: vi.fn(async () => hoisted.catalog.current),
}))
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`)
  },
}))
vi.mock("@/lib/analyst-scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../analyst-scope")>()
  return {
    ...actual,
    getAnalystScopeOptions: vi.fn(async () => hoisted.scopeOptions.current),
    validateAnalystScopeWithOptions: (...args: Parameters<typeof actual.validateAnalystScopeWithOptions>) => {
      actual.validateAnalystScopeWithOptions(...args)
      hoisted.validated.push(args[1])
    },
  }
})
vi.mock("@/lib/repurchase", async (importOriginal) => hoisted.wrap("repurchase", await importOriginal()))
vi.mock("@/lib/penetration", async (importOriginal) => hoisted.wrap("penetration", await importOriginal()))
vi.mock("@/lib/new-customer-funnel", async (importOriginal) =>
  hoisted.wrap("new-customer-funnel", await importOriginal()),
)

const { default: DashboardPage } = await import("../../app/(main)/dashboard/page")
const repurchaseExport = await import("../../app/api/analyst/repurchase/export/route")
const penetrationExport = await import("../../app/api/analyst/penetration/export/route")
const { answerQuestionWithVisualizations, createRepurchaseTools, findUnavailableOrgMentions } = await import(
  "../assistant-answer"
)

const ANALYST_SRC = path.resolve(__dirname, "../..")

const marketSession: AuthSession = {
  employeeId: "e-market",
  name: "九江市场经理",
  phone: "13800000001",
  roles: [{ role: "manager", scopeType: "市场", scopeId: "M1" }],
  permissions: { actions: ["data_center:dashboard"], scopeStoreIds: ["S1", "S2"] },
}

const marketOptions: AnalystScopeOptions = {
  topLevel: "market",
  markets: [
    {
      id: "M1",
      name: "九江市场",
      stores: [
        { storeId: "S1", storeName: "九江一店" },
        { storeId: "S2", storeName: "九江二店" },
      ],
    },
  ],
}

const globalSession: AuthSession = {
  employeeId: "e-admin",
  name: "管理员",
  phone: "13800000000",
  roles: [{ role: "admin", scopeType: "总部", scopeId: "hq" }],
  permissions: { actions: ["data_center:dashboard"], scopeStoreIds: [] },
}

const globalOptions: AnalystScopeOptions = {
  topLevel: "all",
  markets: [
    ...marketOptions.markets,
    { id: "M2", name: "南昌市场", stores: [{ storeId: "S3", storeName: "南昌一店" }] },
  ],
}

/** 全部门店 / 市场名（含停用、含无权限），助手据此识别「点名了不可查看的门店或市场」 */
const fullCatalog = {
  storeNames: ["九江一店", "九江二店", "九江停用店", "南昌一店"],
  marketNames: ["九江市场", "南昌市场"],
}

const S1: AnalystScope = { type: "store", id: "S1" }
const M1: AnalystScope = { type: "market", id: "M1" }
const ALL: AnalystScope = { type: "all" }

/**
 * 查询模块里不取数的纯函数（闭集）；其余导出函数一律视为取数函数（第 2 个参数是 scope），
 * 由下方「闭集」里的 AST 断言保证两者划分与源码一致。
 */
const PURE_QUERY_EXPORTS = ["normalizeNewCustomerFunnelFilters", "normalizePenetrationFilters", "normalizeRepurchaseFilters"]
const dataCalls = () => hoisted.calls.filter((call) => !PURE_QUERY_EXPORTS.includes(call.fn))

function expectEveryDataCallScope(session: AuthSession, scope: AnalystScope) {
  const calls = dataCalls()
  expect(calls.length).toBeGreaterThan(0)
  for (const call of calls) {
    expect({ fn: call.fn, session: call.args[0] }).toEqual({ fn: call.fn, session })
    expect({ fn: call.fn, scope: call.args[1] }).toEqual({ fn: call.fn, scope })
  }
}

function useAccount(session: AuthSession, options: AnalystScopeOptions) {
  hoisted.session.current = session
  hoisted.scopeOptions.current = options
}

beforeEach(() => {
  hoisted.calls.length = 0
  hoisted.validated.length = 0
  hoisted.catalog.current = fullCatalog
  useAccount(marketSession, marketOptions)
})

/**
 * 渲染 server component：逐层调用 async 函数组件（取数都发生在这里）；同步组件不执行（客户端组件用 hooks），
 * 但会遍历它**全部** props 里的元素（children / fallback / 其它 JSX 属性），嵌套的 async 组件照样被执行。
 */
async function resolveTree(node: unknown): Promise<void> {
  if (Array.isArray(node)) {
    for (const child of node) await resolveTree(child)
    return
  }
  if (!node || typeof node !== "object" || !("props" in node)) return
  const element = node as { type: unknown; props: Record<string, unknown> }
  if (typeof element.type === "function" && element.type.constructor.name === "AsyncFunction") {
    await resolveTree(await (element.type as (props: unknown) => Promise<unknown>)(element.props))
    return
  }
  for (const value of Object.values(element.props ?? {})) await resolveTree(value)
}

async function renderDashboard(params: Record<string, string>) {
  await resolveTree(await DashboardPage({ searchParams: Promise.resolve(params) }))
}

describe("页面：dashboard 把校验过的 scope 传给每一次取数（#436）", () => {
  const EXPECTED_CALLS: Record<string, string[]> = {
    repurchase: ["getRepurchaseCascadeTree", "getRepurchaseDashboard", "getRepurchaseFilterOptions"],
    penetration: ["getPenetrationCascadeTree", "getPenetrationDashboard", "getPenetrationFilterOptions"],
    "new-customer-funnel": ["getNewCustomerFunnelDashboard", "getNewCustomerFunnelFilterOptions"],
  }

  for (const [metric, expectedFns] of Object.entries(EXPECTED_CALLS)) {
    for (const [label, params, scope] of [
      ["门店 S1", { scope: "store", scopeId: "S1" }, S1],
      ["市场 M1", { scope: "market", scopeId: "M1" }, M1],
    ] as const) {
      it(`${metric}｜市场账号选${label}：全部取数调用的 scope 都是校验过的那一个`, async () => {
        await renderDashboard({ metric, ...params })

        expect(hoisted.validated).toEqual([scope])
        expect(dataCalls().map((call) => call.fn).sort()).toEqual([...expectedFns].sort())
        expectEveryDataCallScope(marketSession, scope)
      })
    }
  }

  it("三个板块实际渲染合计 8 处取数调用（与 #436 调用点清单一致）", async () => {
    let total = 0
    for (const metric of Object.keys(EXPECTED_CALLS)) {
      hoisted.calls.length = 0
      await renderDashboard({ metric, scope: "store", scopeId: "S1" })
      total += dataCalls().length
    }
    expect(total).toBe(8)
  })

  it("resolveTree 自检：同步元素任意 props（非 children）里嵌套的 async 组件也会被执行", async () => {
    const seen: string[] = []
    const Nested = async ({ tag }: { tag: string }) => {
      seen.push(tag)
      return null
    }
    const Sync = () => null
    await resolveTree(
      createElement(Sync, { fallback: createElement(Nested, { tag: "fallback" }) }, createElement(Nested, { tag: "child" })),
    )
    expect(seen.sort()).toEqual(["child", "fallback"])
  })

  it("全局账号选「全部」：scope 为 all", async () => {
    useAccount(globalSession, globalOptions)
    await renderDashboard({ metric: "repurchase", scope: "all" })
    expect(hoisted.validated).toEqual([ALL])
    expectEveryDataCallScope(globalSession, ALL)
  })

  it("越权门店（停用 / 无权限）被校验拦下，不发生任何取数", async () => {
    await expect(renderDashboard({ metric: "repurchase", scope: "store", scopeId: "S9" })).rejects.toThrow(
      "REDIRECT:/forbidden",
    )
    expect(dataCalls()).toEqual([])
  })
})

describe("导出路由：把 withAnalystScope 校验过的 scope 传给取数（#436）", () => {
  const routes = [
    ["repurchase", repurchaseExport.GET, "getRepurchaseCustomerList"],
    ["penetration", penetrationExport.GET, "getPenetrationCustomerList"],
  ] as const

  for (const [name, GET, fn] of routes) {
    for (const [label, query, scope] of [
      ["门店 S1", "scope=store&scopeId=S1", S1],
      ["市场 M1", "scope=market&scopeId=M1", M1],
    ] as const) {
      it(`${name} 导出｜市场账号选${label}`, async () => {
        const response = await GET(new Request(`http://analyst.test/api/analyst/${name}/export?${query}`))

        expect(response.status).toBe(200)
        expect(hoisted.validated).toEqual([scope])
        expect(dataCalls().map((call) => call.fn)).toEqual([fn])
        expectEveryDataCallScope(marketSession, scope)
      })
    }

    it(`${name} 导出｜越权门店返回 403，不取数`, async () => {
      const response = await GET(new Request(`http://analyst.test/api/analyst/${name}/export?scope=store&scopeId=S9`))
      expect(response.status).toBe(403)
      expect(dataCalls()).toEqual([])
    })
  }
})

describe("智能助手工具：scope 只来自工具入参里点名的可见门店 / 市场（#436）", () => {
  type TestTool = {
    inputSchema: { parse: (input: unknown) => Record<string, unknown> }
    execute: (input: unknown, options: unknown) => Promise<unknown>
  }
  const getTools = () =>
    createRepurchaseTools(marketSession, "", new Date("2026-09-26T08:00:00Z")) as unknown as Record<string, TestTool>
  /** 与线上一致：入参先过工具自己的 inputSchema（omit 掉的字段会被剥掉），再 execute */
  const runTool = async (name: string, input: Record<string, unknown>) => {
    const tool = getTools()[name]
    return tool.execute(tool.inputSchema.parse(input), { toolCallId: "t1", messages: [] })
  }
  const acceptsStore = (name: string) => "store" in getTools()[name].inputSchema.parse({ store: "九江一店" })

  /** 不取数的工具（闭集）：其余工具全部要过下面的逐个断言，新增工具默认归为取数工具 */
  const NON_DATA_TOOLS = ["getCurrentDateTime", "resolveTimeExpression"]
  const allToolNames = Object.keys(createRepurchaseTools(marketSession))
  const toolNames = allToolNames.filter((name) => !NON_DATA_TOOLS.includes(name))

  it("工具清单：取数工具非空，不取数工具确实不取数", async () => {
    expect(toolNames.length).toBeGreaterThanOrEqual(15)
    expect(allToolNames).toEqual(expect.arrayContaining(NON_DATA_TOOLS))
    await runTool("getCurrentDateTime", { store: "九江一店" })
    await runTool("resolveTimeExpression", { expression: "上个月", store: "九江一店" })
    expect(dataCalls()).toEqual([])
  })

  const acceptsMarket = (name: string) => "market" in getTools()[name].inputSchema.parse({ market: "九江市场" })

  it("各工具 schema 接受的范围字段是闭集（线上 omit / pick 掉的字段会被剥掉）", () => {
    const shape = Object.fromEntries(
      toolNames.map((name) => [name, [acceptsStore(name) && "store", acceptsMarket(name) && "market"].filter(Boolean).join("+") || "-"]),
    )
    const counts = Object.values(shape).reduce<Record<string, number>>((acc, key) => ({ ...acc, [key]: (acc[key] ?? 0) + 1 }), {})
    expect(shape).toMatchObject({
      queryMarketComparison: "-",
      queryPenetrationMarketComparison: "-",
      queryStoreRanking: "market",
      queryPenetrationStoreRanking: "market",
      queryRepurchaseRate: "store+market",
    })
    expect(counts["store+market"]).toBeGreaterThanOrEqual(10)
  })

  /** 按工具 schema 实际保留的字段推出期望范围：门店字段优先，其次市场，都没有就是全部 */
  const expectedScope = (name: string, byStore: AnalystScope | string | null, byMarket: AnalystScope | string | null) => {
    if (byStore !== null && acceptsStore(name)) return byStore
    if (byMarket !== null && acceptsMarket(name)) return byMarket
    return ALL
  }

  for (const name of toolNames) {
    for (const [label, input, byStore, byMarket] of [
      ["门店名", { store: "九江一店" }, S1, null],
      ["门店简称（唯一模糊命中）", { store: "一店" }, S1, null],
      ["市场名", { market: "九江市场" }, null, M1],
      ["市场简称", { market: "九江" }, null, M1],
      ["市场名误放 store 字段", { store: "九江市场" }, M1, null],
      ["未点名", {}, null, null],
      ["store / market 写「全部」", { store: "全部门店", market: "全部" }, null, null],
      ["点名停用门店", { store: "九江停用店", market: "九江市场" }, "NOT_FOUND: 未找到可查看的门店「九江停用店」", M1],
      ["点名无权限市场", { market: "南昌市场" }, null, "NOT_FOUND: 未找到可查看的市场「南昌市场」"],
      ["门店简称命中多家", { store: "九江" }, "NOT_FOUND: 「九江」匹配到多个可查看的门店（九江一店、九江二店）", null],
      // 市场字段点名了不可见市场：门店字段已命中也要拒（否则按 schema 保留的字段落到市场）
      ["可见门店 + 无权限市场", { store: "九江一店", market: "南昌市场" }, "NOT_FOUND: 未找到可查看的市场「南昌市场」", "NOT_FOUND: 未找到可查看的市场「南昌市场」"],
    ] as const) {
      it(`${name}｜${label}`, async () => {
        const expected = expectedScope(name, byStore, byMarket)
        if (typeof expected === "string") {
          // 不取数、不回落成市场或全部；停用 / 无权限同一句话，多家命中报歧义
          await expect(runTool(name, input)).rejects.toThrow(expected)
          expect(dataCalls()).toEqual([])
          return
        }
        await runTool(name, input)
        expectEveryDataCallScope(marketSession, expected)
      })
    }
  }
})

describe("智能助手问答：问题里点名的范围就是取数范围（#436）", () => {
  const now = new Date("2026-09-26T08:00:00Z")
  const QUESTIONS = [
    (name: string) => `${name}2026年复购率是多少`,
    (name: string) => `${name}复购率趋势`,
    (name: string) => `${name}复购顾客名单`,
    (name: string) => `${name}普及率是多少`,
    (name: string) => `${name}普及率门店排名`,
    (name: string) => `${name}新客漏斗`,
    (name: string) => `${name}新客名单`,
    (name: string) => `${name}复购率和普及率对比`,
    (name: string) => `${name}复购率、普及率和新客转化，各门店对比`,
  ]

  for (const question of QUESTIONS) {
    for (const [label, name, scope] of [
      ["门店", "九江一店", S1],
      ["市场", "九江市场", M1],
    ] as const) {
      it(`「${question(name)}」｜${label}`, async () => {
        await answerQuestionWithVisualizations(marketSession, question(name), now)
        expectEveryDataCallScope(marketSession, scope)
      })
    }
  }

  it("未点名：按账号全部可见范围回答", async () => {
    await answerQuestionWithVisualizations(marketSession, "2026年复购率是多少", now)
    expectEveryDataCallScope(marketSession, ALL)
  })

  for (const [label, name, kind] of [
    ["停用门店", "九江停用店", "门店"],
    ["无权限门店", "南昌一店", "门店"],
    ["无权限市场", "南昌市场", "市场"],
  ] as const) {
    it(`点名${label}：明确告知未找到，不取数、不静默回落`, async () => {
      const response = await answerQuestionWithVisualizations(marketSession, `${name}2026年复购率是多少`, now)
      expect(response.content).toBe(
        `未找到可查看的${kind}「${name}」（可能已停用，或不在你的查看范围内），因此没有取数。请换成当前可查看的门店或市场再问。`,
      )
      expect(response.visualizations).toEqual([])
      expect(dataCalls()).toEqual([])
    })
  }

  it("同时点名可见门店与停用门店：也拒答", async () => {
    const response = await answerQuestionWithVisualizations(marketSession, "九江一店和九江停用店的复购率", now)
    expect(response.content).toContain("门店「九江停用店」")
    expect(dataCalls()).toEqual([])
  })
})

describe("findUnavailableOrgMentions 边界", () => {
  it("可见名称包含不可见名称时不误判；空名称不命中", () => {
    const catalog = { storeNames: ["九江一店", "一店", ""], marketNames: ["九江市场", " "] }
    expect(findUnavailableOrgMentions("九江一店复购率", marketOptions, catalog)).toEqual([])
  })

  it("不可见名包含可见名：按不可见的长名拒答，不被可见短名截走", () => {
    const catalog = { storeNames: ["九江一店", "九江一店二部"], marketNames: [] }
    expect(findUnavailableOrgMentions("九江一店二部复购率", marketOptions, catalog)).toEqual([
      { kind: "门店", name: "九江一店二部" },
    ])
  })

  it("名称首尾空白两侧同样规整：可见门店不被误拒", () => {
    const options = { ...marketOptions, markets: [{ ...marketOptions.markets[0], stores: [{ storeId: "S1", storeName: "九江一店 " }] }] }
    const catalog = { storeNames: ["九江一店 ", " 九江停用店"], marketNames: [] }
    expect(findUnavailableOrgMentions("九江一店复购率", options, catalog)).toEqual([])
    expect(findUnavailableOrgMentions("九江停用店复购率", options, catalog)).toEqual([{ kind: "门店", name: "九江停用店" }])
  })

  it("长名优先，已命中的不可见长名不再拆出短名", () => {
    const catalog = { storeNames: ["南昌一店", "昌一店"], marketNames: [] }
    expect(findUnavailableOrgMentions("南昌一店复购率", marketOptions, catalog)).toEqual([
      { kind: "门店", name: "南昌一店" },
    ])
  })
})

describe("闭集（#436）", () => {
  const QUERY_MODULE_FILES = ["lib/new-customer-funnel.ts", "lib/penetration.ts", "lib/repurchase.ts"]
  const SCOPE_MODULE_FILE = "lib/analyst-scope.ts"
  const ANALYST_ROOT = path.resolve(ANALYST_SRC, "..")

  const listSourceFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return entry.name === "__tests__" ? [] : listSourceFiles(full)
      // allowJs：.js / .jsx / .mjs / .cjs 同样可以成为取数调用方
      return /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [full] : []
    })

  const parse = (file: string) =>
    ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      /\.[cm]?jsx?$/.test(file) ? ts.ScriptKind.JSX : ts.ScriptKind.TSX,
    )

  /** 模块说明符 → 相对 src 的源文件路径（@/ 别名、baseUrl 下的 src/、相对路径）；解析不了返回 null */
  function resolveSpecifier(fromFile: string, spec: string): string | null {
    let target: string
    if (spec.startsWith("@/")) target = path.join(ANALYST_SRC, spec.slice(2))
    else if (spec.startsWith("src/")) target = path.join(ANALYST_ROOT, spec)
    else if (spec.startsWith(".")) target = path.resolve(path.dirname(fromFile), spec)
    else return null
    return path.relative(ANALYST_SRC, target).replace(/\.(tsx?|jsx?|mjs|cjs)$/, "").replace(/\/index$/, "") + ".ts"
  }

  /** 文件对 targets 的「值」引用（静态 import 非 type / export from / 动态 import() / require()），返回命中的具名绑定；命名空间、默认、动态记为 "*" */
  function valueReferences(file: string, targets: string[]): string[] {
    const found: string[] = []
    const hits = (spec: string) => {
      const resolved = resolveSpecifier(file, spec)
      return resolved !== null && targets.includes(resolved)
    }
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && hits(node.moduleSpecifier.text)) {
        const clause = node.importClause
        if (clause && !clause.isTypeOnly) {
          if (clause.name) found.push("*")
          const bindings = clause.namedBindings
          if (bindings && ts.isNamespaceImport(bindings)) found.push("*")
          if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
              if (!element.isTypeOnly) found.push((element.propertyName ?? element.name).text)
            }
          }
        }
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && hits(node.moduleSpecifier.text)) {
        if (!node.isTypeOnly) found.push("*")
      }
      if (ts.isCallExpression(node)) {
        const isDynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require"
        const [arg] = node.arguments
        // 非字面量说明符无法判断目标，一律算作引用
        if ((isDynamic || isRequire) && arg && (!ts.isStringLiteralLike(arg) || hits(arg.text))) found.push("*")
      }
      ts.forEachChild(node, visit)
    }
    visit(parse(file))
    return found
  }

  const files = listSourceFiles(ANALYST_SRC)
  const rel = (file: string) => path.relative(ANALYST_SRC, file)

  it("查询模块本身是闭集：值引用 scopeFilterSql / scopeRangeSql 的文件只有这三个", () => {
    expect(files.length).toBeGreaterThan(20)
    const users = files
      .filter((file) => rel(file) !== SCOPE_MODULE_FILE)
      .filter((file) =>
        valueReferences(file, [SCOPE_MODULE_FILE]).some((name) => name === "*" || name === "scopeFilterSql" || name === "scopeRangeSql"),
      )
      .map(rel)
      .sort()
    expect(users).toEqual(QUERY_MODULE_FILES)
  })

  it("查询模块的导出函数：除纯函数闭集外，第 2 个参数一律是 AnalystScope", () => {
    const pure: string[] = []
    const violations: string[] = []
    for (const file of QUERY_MODULE_FILES) {
      const source = parse(path.join(ANALYST_SRC, file))
      for (const statement of source.statements) {
        const exported = ts.canHaveModifiers(statement) &&
          ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
        if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) {
          if (!(ts.isExportDeclaration(statement) && statement.isTypeOnly)) violations.push(`${file}: ${statement.getText(source)}`)
          continue
        }
        if (!exported) continue
        if (ts.isFunctionDeclaration(statement) && statement.name) {
          const second = statement.parameters[1]?.type?.getText(source)
          if (second === "AnalystScope") continue
          pure.push(statement.name.text)
        } else if (ts.isVariableStatement(statement)) {
          // 导出的变量（箭头函数 / 别名）会绕开上面的形参判定，一律不许
          violations.push(`${file}: ${statement.getText(source).slice(0, 60)}`)
        }
      }
    }
    expect(violations).toEqual([])
    expect(pure.sort()).toEqual(PURE_QUERY_EXPORTS)
  })

  it("助手的门店 / 市场名单必须是全量（不看在营、不看权限），否则停用门店不再拒答、静默回落", () => {
    // 行为测试把它 mock 掉了，这里钉住实现整段：加任何过滤条件（is_active / 权限 / scope）都会红
    const source = parse(path.join(ANALYST_SRC, "lib/assistant-org-names.ts"))
    const fn = source.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "getAssistantOrgNameCatalog",
    )
    expect(fn?.body?.getText(source).replace(/\s+/g, " ")).toBe(
      '{ const [storeRows, marketRows] = await Promise.all([ db.select({ name: stores.storeName }).from(stores), db.select({ name: orgNodes.name }).from(orgNodes).where(eq(orgNodes.type, "市场")), ]) return { storeNames: storeRows.map((row) => row.name), marketNames: marketRows.map((row) => row.name), } }',
    )
  })

  it("会取数（值引用查询模块）的源码文件必须登记；新增调用方先补最后一跳守护再加进来", () => {
    const consumers = files
      .filter((file) => !QUERY_MODULE_FILES.includes(rel(file)))
      .filter((file) => valueReferences(file, QUERY_MODULE_FILES).length > 0)
      .map(rel)
      .sort()
    expect(consumers).toEqual([
      "app/(main)/dashboard/page.tsx", // 行为守护：页面
      "app/api/analyst/penetration/export/route.ts", // 行为守护：导出
      "app/api/analyst/repurchase/export/route.ts", // 行为守护：导出
      "lib/assistant-answer.ts", // 行为守护 + 下方实参闭集：助手
    ])
  })

  it("助手里每一次取数调用的 scope 实参只来自 scopeFromQuestion / scopeFromToolInput", () => {
    const file = path.join(ANALYST_SRC, "lib/assistant-answer.ts")
    const source = parse(file)
    const squeeze = (node: ts.Node) => node.getText(source).replace(/\s+/g, " ").trim()
    const violations: string[] = []

    // 只允许具名、不改名的 import：命名空间 / 默认 / 别名 import 会让调用点脱离下面的名字匹配
    const refs = valueReferences(file, QUERY_MODULE_FILES)
    expect(refs).not.toContain("*")
    const queryFns = new Set(refs.filter((name) => !PURE_QUERY_EXPORTS.includes(name)))
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
      const resolved = resolveSpecifier(file, statement.moduleSpecifier.text)
      if (!resolved || !QUERY_MODULE_FILES.includes(resolved)) continue
      const bindings = statement.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) if (element.propertyName) violations.push(`别名 import ${squeeze(element)}`)
      }
    }
    expect(queryFns.size).toBeGreaterThanOrEqual(15)

    const ALLOWED_SCOPE_ARGS = new Set(["scope", "context.scope", "await scopeFromToolInput(session, input)"])
    const ALLOWED_SCOPE_INITS = new Set([
      "scopeFromQuestion(scopeOptions, question)",
      "await scopeFromToolInput(session, input)",
    ])
    const bindsScope = (name: ts.BindingName): boolean =>
      ts.isIdentifier(name)
        ? name.text === "scope"
        : name.elements.some((element) =>
            ts.isOmittedExpression(element)
              ? false
              : bindsScope(element.name) || (element.propertyName !== undefined && ts.isIdentifier(element.propertyName) && element.propertyName.text === "scope"),
          )

    // 带 scope 形参的函数声明：形参位置 → 调用时该位置实参也要在白名单里
    const scopeParamIndex = new Map<string, number>()
    const collect = (node: ts.Node) => {
      if (ts.isFunctionLike(node)) {
        node.parameters.forEach((param, index) => {
          if (!bindsScope(param.name)) return
          if (ts.isFunctionDeclaration(node) && node.name && ts.isIdentifier(param.name)) scopeParamIndex.set(node.name.text, index)
          // 箭头 / 函数表达式 / 方法 / 解构形参：调用点无法按名字追踪，一律不许
          else violations.push(`scope 形参只许出现在具名函数声明上：${squeeze(node).slice(0, 60)}`)
        })
      }
      ts.forEachChild(node, collect)
    }
    collect(source)

    const rootIdentifier = (node: ts.Expression): string | undefined => {
      let current: ts.Expression = node
      while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current) || ts.isParenthesizedExpression(current)) {
        current = current.expression
      }
      return ts.isIdentifier(current) ? current.text : undefined
    }

    let queryCallCount = 0
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && (queryFns.has(node.text) || scopeParamIndex.has(node.text))) {
        const parent = node.parent
        const isImport = ts.isImportSpecifier(parent)
        const isDeclarationName = ts.isFunctionDeclaration(parent) && parent.name === node
        const isCallee = ts.isCallExpression(parent) && parent.expression === node
        const isTypeQuery = ts.isTypeQueryNode(parent) // `typeof getX` 只在类型位置
        // 取数函数 / 带 scope 形参的函数只许被直接调用：取别名、.call / .apply / .bind 都会脱离实参检查
        if (!isImport && !isDeclarationName && !isCallee && !isTypeQuery) violations.push(`非直接调用：${squeeze(parent).slice(0, 60)}`)
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const callee = node.expression.text
        if (queryFns.has(callee)) {
          queryCallCount += 1
          const arg = node.arguments[1]
          if (!arg || !ALLOWED_SCOPE_ARGS.has(squeeze(arg))) violations.push(`${callee}(…, ${arg ? squeeze(arg) : "<缺>"})`)
        }
        const index = scopeParamIndex.get(callee)
        if (index !== undefined) {
          const arg = node.arguments[index]
          if (!arg || !ALLOWED_SCOPE_ARGS.has(squeeze(arg))) violations.push(`${callee}(… ${arg ? squeeze(arg) : "<缺>"})`)
        }
        // Object.assign(scope, …) 之类原地改写
        const readOnlyConsumer = callee === "getAnalystScopeLabel" // 只读：生成范围标签
        if (!readOnlyConsumer && node.arguments.some((arg) => ts.isIdentifier(arg) && arg.text === "scope") && !queryFns.has(callee) && index === undefined) {
          violations.push(`scope 只许交给取数函数 / 带 scope 形参的函数：${squeeze(node).slice(0, 60)}`)
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        if (node.arguments.some((arg) => rootIdentifier(arg) === "scope" || squeeze(arg) === "context.scope")) {
          violations.push(`scope 只许交给取数函数 / 带 scope 形参的函数：${squeeze(node).slice(0, 60)}`)
        }
      }
      // 名为 scope 的变量只能由两种解析得到；解构出 scope 不许
      if (ts.isVariableDeclaration(node) && bindsScope(node.name)) {
        if (!ts.isIdentifier(node.name) || !node.initializer || !ALLOWED_SCOPE_INITS.has(squeeze(node.initializer))) {
          violations.push(`${squeeze(node).slice(0, 80)}`)
        }
      }
      // scope（及其属性）不许被任何赋值运算改写（=、??=、||=、属性写入…）
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        (rootIdentifier(node.left) === "scope" || rootIdentifier(node.left) === "context")
      ) {
        violations.push(squeeze(node))
      }
      // 对象里的 scope 字段（context.scope 的来源）只能是简写 { scope }
      if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === "scope") {
        violations.push(squeeze(node))
      }
      ts.forEachChild(node, visit)
    }
    visit(source)

    expect(violations).toEqual([])
    // #436 登记时 44 处；只许增加（新调用点同样受上面的白名单约束）
    expect(queryCallCount).toBeGreaterThanOrEqual(44)
  })
})
