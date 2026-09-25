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

/** 取数调用：查询模块里名字以 get 开头的导出（第 2 个参数是 scope）；normalize* 等纯函数不计 */
const dataCalls = () => hoisted.calls.filter((call) => call.fn.startsWith("get"))

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

/** 渲染 server component：逐层调用 async 函数组件（取数都发生在这里），客户端组件不执行 */
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
  await resolveTree(element.props.children)
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
        expect(dataCalls().map((call) => call.fn).sort()).toEqual(expectedFns)
        expectEveryDataCallScope(marketSession, scope)
      })
    }
  }

  it("三个板块合计 8 处取数调用都被覆盖（与 #436 调用点清单一致）", () => {
    expect(Object.values(EXPECTED_CALLS).flat()).toHaveLength(8)
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
  const runTool = async (name: string, input: Record<string, unknown>) => {
    const tools = createRepurchaseTools(marketSession, "", new Date("2026-09-26T08:00:00Z")) as unknown as Record<
      string,
      { execute: (input: unknown, options: unknown) => Promise<unknown> }
    >
    return tools[name].execute(input, { toolCallId: "t1", messages: [] })
  }

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

  for (const name of toolNames) {
    for (const [label, input, scope] of [
      ["门店名", { store: "九江一店" }, S1],
      ["市场名", { market: "九江市场" }, M1],
      ["未点名", {}, ALL],
    ] as const) {
      it(`${name}｜${label}`, async () => {
        await runTool(name, input)
        expectEveryDataCallScope(marketSession, scope)
      })
    }

    it(`${name}｜点名停用门店：报 NOT_FOUND，不取数、不回落成市场或全部`, async () => {
      await expect(runTool(name, { store: "九江停用店", market: "九江市场" })).rejects.toThrow(
        /NOT_FOUND: 未找到可查看的门店「九江停用店」/,
      )
      expect(dataCalls()).toEqual([])
    })

    it(`${name}｜点名无权限市场：报 NOT_FOUND，不取数`, async () => {
      await expect(runTool(name, { market: "南昌市场" })).rejects.toThrow(/NOT_FOUND: 未找到可查看的市场「南昌市场」/)
      expect(dataCalls()).toEqual([])
    })
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

  it("长名优先，已命中的不可见长名不再拆出短名", () => {
    const catalog = { storeNames: ["南昌一店", "昌一店"], marketNames: [] }
    expect(findUnavailableOrgMentions("南昌一店复购率", marketOptions, catalog)).toEqual([
      { kind: "门店", name: "南昌一店" },
    ])
  })
})

describe("闭集（#436）", () => {
  const QUERY_MODULES = ["repurchase", "penetration", "new-customer-funnel"]
  const isQueryModule = (spec: string) =>
    QUERY_MODULES.some((name) => spec === `@/lib/${name}` || new RegExp(`^(\\.{1,2}/)+(lib/)?${name}$`).test(spec))

  const listSourceFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return entry.name === "__tests__" ? [] : listSourceFiles(full)
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : []
    })

  const parse = (file: string) =>
    ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

  /** 文件对查询模块的「值」引用：静态 import（非 import type）/ export from / 动态 import() / require() */
  function valueImportsOfQueryModules(file: string): string[] {
    const found: string[] = []
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && isQueryModule(node.moduleSpecifier.text)) {
        const clause = node.importClause
        const typeOnly =
          clause?.isTypeOnly ||
          (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.every((element) => element.isTypeOnly))
        if (!typeOnly) found.push(node.moduleSpecifier.text)
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && isQueryModule(node.moduleSpecifier.text)) {
        if (!node.isTypeOnly) found.push(node.moduleSpecifier.text)
      }
      if (ts.isCallExpression(node)) {
        const isDynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require"
        const [arg] = node.arguments
        if ((isDynamic || isRequire) && arg) {
          // 非字面量说明符无法判断目标，一律算作引用
          if (!ts.isStringLiteralLike(arg) || isQueryModule(arg.text)) found.push(arg.getText())
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(parse(file))
    return found
  }

  it("会取数（值引用查询模块）的源码文件必须登记；新增调用方先补最后一跳守护再加进来", () => {
    const files = listSourceFiles(ANALYST_SRC)
    expect(files.length).toBeGreaterThan(20)
    const consumers = files
      .filter((file) => !QUERY_MODULES.some((name) => file.endsWith(`/lib/${name}.ts`)))
      .filter((file) => valueImportsOfQueryModules(file).length > 0)
      .map((file) => path.relative(ANALYST_SRC, file))
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

    const queryFns = new Set<string>()
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
      if (!isQueryModule(statement.moduleSpecifier.text)) continue
      const bindings = statement.importClause?.namedBindings
      // 只允许具名 import：命名空间 / 默认 import 会让调用点脱离下面的名字匹配
      expect(bindings && ts.isNamedImports(bindings) && !statement.importClause?.name).toBe(true)
      if (!bindings || !ts.isNamedImports(bindings)) continue
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue
        // 别名 import 同理
        expect(element.propertyName).toBeUndefined()
        queryFns.add(element.name.text)
      }
    }
    expect(queryFns.size).toBeGreaterThanOrEqual(15)

    const ALLOWED_SCOPE_ARGS = new Set(["scope", "context.scope", "await scopeFromToolInput(session, input)"])
    const ALLOWED_SCOPE_INITS = new Set([
      "scopeFromQuestion(scopeOptions, question)",
      "await scopeFromToolInput(session, input)",
    ])

    // 本文件里带 scope 形参的函数：形参位置 → 调用时该位置实参也要在白名单里
    const scopeParamIndex = new Map<string, number>()
    const collect = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        const index = node.parameters.findIndex((param) => ts.isIdentifier(param.name) && param.name.text === "scope")
        if (index >= 0) scopeParamIndex.set(node.name.text, index)
      }
      ts.forEachChild(node, collect)
    }
    collect(source)

    const violations: string[] = []
    let queryCallCount = 0
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const callee = node.expression.text
        if (queryFns.has(callee) && callee.startsWith("get")) {
          queryCallCount += 1
          const arg = node.arguments[1]
          if (!arg || !ALLOWED_SCOPE_ARGS.has(squeeze(arg))) violations.push(`${callee}(…, ${arg ? squeeze(arg) : "<缺>"})`)
        }
        const index = scopeParamIndex.get(callee)
        if (index !== undefined) {
          const arg = node.arguments[index]
          if (!arg || !ALLOWED_SCOPE_ARGS.has(squeeze(arg))) violations.push(`${callee}(… ${arg ? squeeze(arg) : "<缺>"})`)
        }
      }
      // 名为 scope 的变量只能由两种解析得到
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "scope") {
        if (!node.initializer || !ALLOWED_SCOPE_INITS.has(squeeze(node.initializer))) {
          violations.push(`const scope = ${node.initializer ? squeeze(node.initializer) : "<无>"}`)
        }
      }
      // scope 不许被重新赋值
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && squeeze(node.left) === "scope") {
        violations.push(squeeze(node))
      }
      // 对象里的 scope 字段（context.scope 的来源）只能是简写 { scope }
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "scope") {
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
