import "server-only"

import { tool } from "ai"
import { z } from "zod"
import type { AssistantChatResponse, AssistantVisualization } from "@/lib/assistant-types"
import type { AuthSession } from "@/lib/types"
import {
  getCategoryComparison,
  getMarketComparison,
  getRepurchaseCustomerList,
  getRepurchaseFilterOptions,
  getRepurchaseKpi,
  getRepurchaseTrend,
  getStoreRanking,
  type RepurchaseCustomerRow,
  type RepurchaseFilters,
  type RepurchaseRankingRow,
  type RepurchaseSeriesPoint,
} from "@/lib/repurchase"

const nullableText = z.string().min(1).nullable().optional()

const filtersSchema = z.object({
  year: z.number().int().min(2000).max(2100).nullable().optional(),
  productKind: nullableText.describe("一级品项名称，例如缦之羽、科颜美、诺纤金。为空表示全部一级品项。"),
  categoryName: nullableText.describe("二级品项名称。为空表示当前一级下全部二级品项。"),
  category: nullableText.describe("兼容旧参数，格式可为“一级品项 / 二级品项”。优先使用 productKind 和 categoryName。"),
  market: nullableText.describe("市场区域名称。为空表示当前权限内全部市场。"),
  store: nullableText.describe("门店名称。为空表示当前权限内全部门店。"),
})

const listTypeSchema = z.enum(["all", "entry_only", "repurchase"]).nullable().optional()

type AssistantFilterInput = z.infer<typeof filtersSchema>

function compactFilters(input: AssistantFilterInput): RepurchaseFilters {
  const legacy = input.category?.trim() || ""
  const [legacyProductKind, legacyCategoryName] = legacy.includes(" / ")
    ? legacy.split(" / ", 2)
    : [legacy, ""]
  return {
    year: input.year ?? undefined,
    productKind: input.productKind?.trim() || legacyProductKind || undefined,
    categoryName: input.categoryName?.trim() || legacyCategoryName || undefined,
    market: input.market?.trim() || undefined,
    store: input.store?.trim() || undefined,
  }
}

export function createRepurchaseTools(session: AuthSession) {
  return {
    queryRepurchaseRate: tool({
      description: "查询复购率 KPI，包括进入人数、复购人数、复购率和上一年对比。",
      inputSchema: filtersSchema,
      execute: async (input) => {
        const filters = compactFilters(input)
        const { threshold, kpi } = await getRepurchaseKpi(session, filters)
        return { filters, threshold, kpi }
      },
    }),
    queryRepurchaseTrend: tool({
      description: "查询月度复购率趋势，用于回答走势、近几个月、每月变化等问题。",
      inputSchema: filtersSchema.extend({
        startMonth: nullableText.describe("起始月份 YYYY-MM。"),
        endMonth: nullableText.describe("结束月份 YYYY-MM。"),
      }),
      execute: async (input) => {
        const filters = compactFilters(input)
        let rows = await getRepurchaseTrend(session, filters)
        if (input.startMonth) rows = rows.filter((row) => row.name >= input.startMonth!)
        if (input.endMonth) rows = rows.filter((row) => row.name <= input.endMonth!)
        return rows
      },
    }),
    queryCategoryComparison: tool({
      description: "查询品项复购率对比排名，用于回答哪个品项高、品项横向对比等问题。",
      inputSchema: filtersSchema.omit({ categoryName: true, category: true }),
      execute: async (input) => getCategoryComparison(session, compactFilters(input)),
    }),
    queryMarketComparison: tool({
      description: "查询各市场复购率对比排名。",
      inputSchema: filtersSchema.pick({ year: true, productKind: true, categoryName: true, category: true }),
      execute: async (input) => getMarketComparison(session, compactFilters(input)),
    }),
    queryStoreRanking: tool({
      description: "查询门店复购率排名。",
      inputSchema: filtersSchema.omit({ store: true }).extend({
        limit: z.number().int().min(1).max(50).nullable().optional(),
      }),
      execute: async (input) =>
        getStoreRanking(session, compactFilters(input), input.limit ?? undefined),
    }),
    queryCustomerList: tool({
      description: "查询进入或复购顾客实名名单。用户提到名单、哪些人、顾客列表时使用。",
      inputSchema: filtersSchema.extend({
        listType: listTypeSchema.describe("all=全部进入顾客，entry_only=进入未复购，repurchase=已复购顾客。"),
        limit: z.number().int().min(1).max(200).nullable().optional(),
      }),
      execute: async (input) =>
        getRepurchaseCustomerList(
          session,
          compactFilters(input),
          input.listType ?? "all",
          input.limit ?? 50,
        ),
    }),
    queryAvailableFilters: tool({
      description: "查询当前用户权限内可用的年份、品项、市场和门店筛选项。",
      inputSchema: z.object({
        market: nullableText.describe("指定市场时返回该市场下门店。"),
        productKind: nullableText.describe("指定一级品项时返回该一级下二级品项。"),
      }),
      execute: async (input) => getRepurchaseFilterOptions(session, input.market ?? undefined, input.productKind ?? undefined),
    }),
    resolveTimeExpression: tool({
      description: "把最近半年、上个月、去年下半年、今年等自然语言时间转成明确年份和月份。",
      inputSchema: z.object({ expression: z.string().min(1) }),
      execute: async ({ expression }) => resolveTimeExpression(expression),
    }),
  }
}

export function createAssistantSystemPrompt(): string {
  const resolved = resolveTimeExpression("今天")
  return `你是凤御经营分析智能助手，只回答和复购率、品项、市场、门店经营分析有关的问题。

当前日期：${resolved.currentDate}。

核心口径：
- 复购率 = 复购人数 / 品项进入总人数。
- 品项由一级品项 product_kind + 二级品项 category_name 共同定义。
- 进入品项：同一顾客、同一天、同门店、同一级品项、同二级品项购买合并后，净实收达到系统会员门槛，默认 1980 元。
- 复购：进入后，后续非同日达标购买；与首次进入同一天的新开卡项不算复购。
- 所有查询都已经由服务端绑定当前用户组织范围，不要要求用户提供权限范围。

回答要求：
- 必须基于工具返回数据作答，不能编造数字。
- 复购率使用百分比，保留 1 位小数。
- KPI 类回答必须包含进入人数、复购人数、复购率。
- 排名或对比类回答用简洁表格。
- 数据为空时说明当前筛选无数据，并建议调整筛选。`
}

export function resolveTimeExpression(expression: string): {
  currentDate: string
  expression: string
  year: number | null
  years: number[]
  startMonth: string | null
  endMonth: string
  description: string
} {
  const now = new Date()
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now)
  const currentYear = Number(parts.find((part) => part.type === "year")?.value ?? now.getFullYear())
  const currentMonth = Number(parts.find((part) => part.type === "month")?.value ?? now.getMonth() + 1)
  const currentDay = Number(parts.find((part) => part.type === "day")?.value ?? now.getDate())
  const currentDate = `${currentYear}-${String(currentMonth).padStart(2, "0")}-${String(currentDay).padStart(2, "0")}`

  function monthStr(year: number, month: number): string {
    return `${year}-${String(month).padStart(2, "0")}`
  }

  function monthsAgo(count: number): { year: number; month: number } {
    let year = currentYear
    let month = currentMonth - count
    while (month <= 0) {
      month += 12
      year -= 1
    }
    return { year, month }
  }

  const result = {
    currentDate,
    expression,
    year: null as number | null,
    years: [] as number[],
    startMonth: null as string | null,
    endMonth: monthStr(currentYear, currentMonth),
    description: "",
  }
  const text = expression.trim()

  if (text.includes("上个月") || text.includes("上月")) {
    const start = monthsAgo(1)
    result.year = start.year
    result.years = [start.year]
    result.startMonth = monthStr(start.year, start.month)
    result.endMonth = result.startMonth
    result.description = `${start.year}年${start.month}月`
    return result
  }

  if (text.includes("去年") && text.includes("下半年")) {
    const year = currentYear - 1
    return { ...result, year, years: [year], startMonth: `${year}-07`, endMonth: `${year}-12`, description: `${year}年下半年` }
  }

  if (text.includes("去年") && text.includes("上半年")) {
    const year = currentYear - 1
    return { ...result, year, years: [year], startMonth: `${year}-01`, endMonth: `${year}-06`, description: `${year}年上半年` }
  }

  if (text.includes("今年")) {
    result.year = currentYear
    result.years = [currentYear]
    result.startMonth = `${currentYear}-${text.includes("下半年") ? "07" : "01"}`
    result.endMonth = `${currentYear}-${text.includes("上半年") ? "06" : "12"}`
    result.description = text.includes("上半年")
      ? `${currentYear}年上半年`
      : text.includes("下半年")
        ? `${currentYear}年下半年`
        : `${currentYear}年全年`
    return result
  }

  if (text.includes("去年")) {
    const year = currentYear - 1
    return { ...result, year, years: [year], startMonth: `${year}-01`, endMonth: `${year}-12`, description: `${year}年全年` }
  }

  if (text.includes("最近") || text.includes("近") || text.includes("过去")) {
    let count = Number(text.match(/\d+/)?.[0] ?? 0)
    const cnMap: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 半: 6 }
    if (!count) {
      for (const [key, value] of Object.entries(cnMap)) {
        if (text.includes(key)) {
          count = value
          break
        }
      }
    }
    if (text.includes("半年")) count = 6
    if (text.includes("季")) count = 3
    if (text.includes("年") && !text.includes("月") && count > 0) count *= 12
    if (!count) count = 6
    const start = monthsAgo(count - 1)
    const years = Array.from(new Set(Array.from({ length: currentYear - start.year + 1 }, (_, i) => start.year + i)))
    return {
      ...result,
      year: years.length === 1 ? years[0] : null,
      years,
      startMonth: monthStr(start.year, start.month),
      endMonth: monthStr(currentYear, currentMonth),
      description: `${start.year}年${start.month}月至${currentYear}年${currentMonth}月`,
    }
  }

  const start = monthsAgo(5)
  const years = Array.from(new Set(Array.from({ length: currentYear - start.year + 1 }, (_, i) => start.year + i)))
  return {
    ...result,
    year: years.length === 1 ? years[0] : null,
    years,
    startMonth: monthStr(start.year, start.month),
    description: `${start.year}年${start.month}月至${currentYear}年${currentMonth}月`,
  }
}

function formatRate(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function formatSignedRate(value: number | null): string {
  if (value === null) return "无同比"
  const sign = value > 0 ? "+" : ""
  return `${sign}${(value * 100).toFixed(1)}pct`
}

function inferYear(question: string): number | undefined {
  const explicit = question.match(/20\d{2}/)?.[0]
  if (explicit) return Number(explicit)
  const currentYear = resolveTimeExpression("今天").year ?? new Date().getFullYear()
  if (question.includes("今年")) return currentYear
  if (question.includes("去年")) return currentYear - 1
  return undefined
}

function findMention(question: string, options: string[]): string | undefined {
  return [...options].sort((a, b) => b.length - a.length).find((value) => question.includes(value))
}

function renderRows(rows: RepurchaseRankingRow[], label: string, limit = 10): string {
  if (rows.length === 0) return "当前条件下没有可用数据。"
  const lines = [`| ${label} | 复购率 | 进入人数 | 复购人数 |`, "|---|---:|---:|---:|"]
  for (const row of rows.slice(0, limit)) {
    lines.push(`| ${row.name} | ${formatRate(row.repurchaseRate)} | ${row.entryCount} | ${row.repurchaseCount} |`)
  }
  return lines.join("\n")
}

function renderTrend(rows: RepurchaseSeriesPoint[]): string {
  if (rows.length === 0) return "当前条件下没有趋势数据。"
  const lines = ["| 月份 | 复购率 | 进入人数 | 复购人数 |", "|---|---:|---:|---:|"]
  for (const row of rows.slice(-12)) {
    lines.push(`| ${row.name} | ${formatRate(row.repurchaseRate)} | ${row.entryCount} | ${row.repurchaseCount} |`)
  }
  return lines.join("\n")
}

function buildFilterText(filters: RepurchaseFilters, period: string): string {
  return [period, filters.productKind, filters.categoryName, filters.market, filters.store].filter(Boolean).join(" · ")
}

function buildKpiVisualization(
  title: string,
  threshold: number,
  kpi: Awaited<ReturnType<typeof getRepurchaseKpi>>["kpi"],
): AssistantVisualization {
  return {
    id: "repurchase-kpi",
    kind: "metrics",
    title,
    metrics: [
      { label: "进入人数", value: `${kpi.entryCount.toLocaleString("zh-CN")} 人`, helper: `达标门槛 ${threshold.toLocaleString("zh-CN")} 元` },
      { label: "复购人数", value: `${kpi.repurchaseCount.toLocaleString("zh-CN")} 人`, helper: "后续非同日达标购买" },
      { label: "复购率", value: formatRate(kpi.repurchaseRate), helper: `同比变化 ${formatSignedRate(kpi.delta)}` },
    ],
  }
}

function buildTrendVisualization(title: string, rows: RepurchaseSeriesPoint[]): AssistantVisualization {
  return {
    id: "repurchase-trend",
    kind: "line",
    title,
    labelKey: "name",
    valueKey: "repurchaseRate",
    valueFormat: "rate",
    rows: rows.map((row) => ({
      name: row.name,
      repurchaseRate: row.repurchaseRate,
      entryCount: row.entryCount,
      repurchaseCount: row.repurchaseCount,
    })),
  }
}

function buildRankingVisualization(title: string, rows: RepurchaseRankingRow[]): AssistantVisualization {
  return {
    id: "repurchase-ranking",
    kind: "bar",
    title,
    labelKey: "name",
    valueKey: "repurchaseRate",
    valueFormat: "rate",
    rows: rows.slice(0, 12).map((row) => ({
      name: row.name,
      repurchaseRate: row.repurchaseRate,
      entryCount: row.entryCount,
      repurchaseCount: row.repurchaseCount,
      market: row.market ?? null,
    })),
  }
}

function buildCustomerTableVisualization(rows: RepurchaseCustomerRow[]): AssistantVisualization {
  return {
    id: "repurchase-customers",
    kind: "table",
    title: "顾客名单",
    columns: [
      { key: "customerName", label: "顾客" },
      { key: "productKind", label: "一级品项" },
      { key: "categoryName", label: "二级品项" },
      { key: "status", label: "状态" },
      { key: "firstDate", label: "首购日期" },
      { key: "store", label: "门店" },
    ],
    rows: rows.map((row) => ({
      customerName: row.customerName,
      productKind: row.productKind,
      categoryName: row.categoryName,
      status: row.status,
      firstDate: row.firstDate,
      store: row.store,
    })),
  }
}

export async function answerQuestionWithVisualizations(
  session: AuthSession,
  question: string,
): Promise<AssistantChatResponse> {
  const options = await getRepurchaseFilterOptions(session)
  const filters: RepurchaseFilters = {
    year: inferYear(question),
    productKind: findMention(question, options.productKinds),
    categoryName: findMention(question, options.categoryNames),
    market: findMention(question, options.markets),
    store: findMention(question, options.stores),
  }
  const period = filters.year ? `${filters.year}年` : "全部年份"
  const filterText = buildFilterText(filters, period)

  if (question.includes("名单") || question.includes("哪些人") || question.includes("顾客列表")) {
    const listType = question.includes("未复购") ? "entry_only" : question.includes("复购") ? "repurchase" : "all"
    const rows = await getRepurchaseCustomerList(session, filters, listType, 30)
    if (rows.length === 0) {
      return { content: `当前条件下没有顾客名单数据。\n\n筛选：${filterText}`, visualizations: [] }
    }
    const lines = ["| 顾客 | 一级品项 | 二级品项 | 状态 | 首购日期 | 门店 |", "|---|---|---|---|---|---|"]
    for (const row of rows) {
      lines.push(`| ${row.customerName} | ${row.productKind} | ${row.categoryName} | ${row.status} | ${row.firstDate} | ${row.store} |`)
    }
    return {
      content: `### 顾客名单\n\n筛选：${filterText}\n\n${lines.join("\n")}`,
      visualizations: [buildCustomerTableVisualization(rows)],
    }
  }

  if (question.includes("趋势") || question.includes("走势") || question.includes("月度") || question.includes("每月")) {
    const rows = await getRepurchaseTrend(session, filters)
    return {
      content: `### 复购率趋势\n\n筛选：${filterText}\n\n${renderTrend(rows)}`,
      visualizations: rows.length > 0 ? [buildTrendVisualization("复购率趋势", rows)] : [],
    }
  }

  if (question.includes("门店") && (question.includes("排名") || question.includes("最高") || question.includes("最低") || question.includes("对比"))) {
    const rows = await getStoreRanking(session, filters, 10)
    return {
      content: `### 门店复购率排名\n\n筛选：${filterText}\n\n${renderRows(rows, "门店")}`,
      visualizations: rows.length > 0 ? [buildRankingVisualization("门店复购率排名", rows)] : [],
    }
  }

  if (question.includes("市场") && (question.includes("排名") || question.includes("最高") || question.includes("最低") || question.includes("对比"))) {
    const rows = await getMarketComparison(session, { year: filters.year, productKind: filters.productKind, categoryName: filters.categoryName })
    return {
      content: `### 市场复购率对比\n\n筛选：${filterText}\n\n${renderRows(rows, "市场")}`,
      visualizations: rows.length > 0 ? [buildRankingVisualization("市场复购率对比", rows)] : [],
    }
  }

  if (question.includes("品项") && (question.includes("排名") || question.includes("最高") || question.includes("最低") || question.includes("对比"))) {
    const rows = await getCategoryComparison(session, { year: filters.year, productKind: filters.productKind, market: filters.market, store: filters.store })
    return {
      content: `### 品项复购率对比\n\n筛选：${filterText}\n\n${renderRows(rows, "品项")}`,
      visualizations: rows.length > 0 ? [buildRankingVisualization("品项复购率对比", rows)] : [],
    }
  }

  const { threshold, kpi } = await getRepurchaseKpi(session, filters)
  const target = [filters.productKind, filters.categoryName, filters.market, filters.store].filter(Boolean).join(" · ") || "当前范围"
  return {
    content: `### ${target} 复购率分析

分析周期：${period}
复购门槛：${threshold} 元

| 指标 | 数值 |
|---|---:|
| 品项进入人数 | ${kpi.entryCount} 人 |
| 复购人数 | ${kpi.repurchaseCount} 人 |
| 复购率 | ${formatRate(kpi.repurchaseRate)} |
| 同比变化 | ${formatSignedRate(kpi.delta)} |

数据解读：当前筛选下共有 ${kpi.entryCount} 个顾客品项进入记录，其中 ${kpi.repurchaseCount} 个发生后续非同日达标购买。`,
    visualizations: [buildKpiVisualization(`${target} 复购率`, threshold, kpi)],
  }
}

export async function answerQuestionLocally(session: AuthSession, question: string): Promise<string> {
  return (await answerQuestionWithVisualizations(session, question)).content
}
