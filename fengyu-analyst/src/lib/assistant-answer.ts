import "server-only"

import { tool } from "ai"
import { z } from "zod"
import type { AssistantChatResponse, AssistantVisualization } from "@/lib/assistant-types"
import {
  getNewCustomerFunnelCustomerList,
  getNewCustomerFunnelFilterOptions,
  getNewCustomerFunnelKpi,
  getNewCustomerFunnelSourceBreakdown,
  getNewCustomerFunnelTrend,
  getNewCustomerFunnelUnitComparison,
  type NewCustomerFunnelComparisonRow,
  type NewCustomerFunnelEntry,
  type NewCustomerFunnelFilters,
  type NewCustomerFunnelKpi,
  type NewCustomerFunnelListType,
} from "@/lib/new-customer-funnel"
import {
  getPenetrationCategoryComparison,
  getPenetrationCustomerList,
  getPenetrationFilterOptions,
  getPenetrationKpi,
  getPenetrationMarketComparison,
  getPenetrationProductComparison,
  getPenetrationStoreRanking,
  type PenetrationCustomerRow,
  type PenetrationFilters,
  type PenetrationKpi,
  type PenetrationProductOption,
  type PenetrationRankingRow,
} from "@/lib/penetration"
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
  startDate: nullableText.describe("起始日期 YYYY-MM-DD。存在时优先按日期区间计算。"),
  endDate: nullableText.describe("结束日期 YYYY-MM-DD。存在时优先按日期区间计算。"),
  productKind: nullableText.describe("一级品项名称，例如缦之羽、科颜美、诺纤金。为空表示全部一级品项。"),
  categoryName: nullableText.describe("二级品项名称。为空表示当前一级下全部二级品项。"),
  category: nullableText.describe("兼容旧参数，格式可为“一级品项 / 二级品项”。优先使用 productKind 和 categoryName。"),
  market: nullableText.describe("市场区域名称。为空表示当前权限内全部市场。"),
  store: nullableText.describe("门店名称。为空表示当前权限内全部门店。"),
})

const listTypeSchema = z.enum(["all", "entry_only", "repurchase"]).nullable().optional()

type AssistantFilterInput = z.infer<typeof filtersSchema>

const penetrationFiltersSchema = filtersSchema.omit({ year: true, startDate: true, endDate: true, category: true }).extend({
  seriesName: nullableText.describe("项目系列名称。为空表示全部系列。"),
  skuId: nullableText.describe("商品 SKU ID。为空表示全部商品。"),
})

type PenetrationFilterInput = z.infer<typeof penetrationFiltersSchema>

const newCustomerFiltersSchema = z.object({
  startMonth: nullableText.describe("起始月份 YYYY-MM。为空时按系统默认月份范围。"),
  endMonth: nullableText.describe("结束月份 YYYY-MM。为空时按系统默认月份范围。"),
  unitLevel: z.enum(["market", "store"]).nullable().optional().describe("单位层级：market=市场，store=门店。"),
  tableMode: z.enum(["months", "units"]).nullable().optional().describe("对比方式：months=多月份对比，units=多单位对比。"),
  source: nullableText.describe("新客来源渠道，例如美团、抖音、地推卡、老带新、转让店、未填写。为空表示全部来源。"),
  market: nullableText.describe("市场区域名称。为空表示当前权限内全部市场。"),
  store: nullableText.describe("门店名称。为空表示当前权限内全部门店。"),
})

const newCustomerListTypeSchema = z.enum(["all", "arrived", "not_arrived", "member"]).nullable().optional()

type NewCustomerFilterInput = z.infer<typeof newCustomerFiltersSchema>

function compactDate(value: string | null | undefined): string | undefined {
  const text = value?.trim()
  return text && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined
}

function compactFilters(input: AssistantFilterInput): RepurchaseFilters {
  const legacy = input.category?.trim() || ""
  const [legacyProductKind, legacyCategoryName] = legacy.includes(" / ")
    ? legacy.split(" / ", 2)
    : [legacy, ""]
  return {
    year: input.year ?? undefined,
    startDate: compactDate(input.startDate),
    endDate: compactDate(input.endDate),
    productKind: input.productKind?.trim() || legacyProductKind || undefined,
    categoryName: input.categoryName?.trim() || legacyCategoryName || undefined,
    market: input.market?.trim() || undefined,
    store: input.store?.trim() || undefined,
  }
}

function compactPenetrationFilters(input: PenetrationFilterInput): PenetrationFilters {
  return {
    productKind: input.productKind?.trim() || undefined,
    categoryName: input.categoryName?.trim() || undefined,
    seriesName: input.seriesName?.trim() || undefined,
    skuId: input.skuId?.trim() || undefined,
    market: input.market?.trim() || undefined,
    store: input.store?.trim() || undefined,
  }
}

function compactNewCustomerFilters(input: NewCustomerFilterInput): NewCustomerFunnelFilters {
  return {
    startMonth: input.startMonth?.trim() || undefined,
    endMonth: input.endMonth?.trim() || undefined,
    unitLevel: input.unitLevel ?? undefined,
    tableMode: input.tableMode ?? undefined,
    source: input.source?.trim() || undefined,
    market: input.market?.trim() || undefined,
    store: input.store?.trim() || undefined,
  }
}

export function createRepurchaseTools(session: AuthSession, question = "") {
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
      inputSchema: filtersSchema.pick({ year: true, startDate: true, endDate: true, productKind: true, categoryName: true, category: true }),
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
    queryPenetrationRate: tool({
      description: "查询普及率 KPI，包括持卡会员数、总会员数、普及率和剩余疗程次数。",
      inputSchema: penetrationFiltersSchema,
      execute: async (input) => {
        const filters = compactPenetrationFilters(input)
        const kpi = await getPenetrationKpi(session, filters)
        return { filters, kpi }
      },
    }),
    queryPenetrationCategoryComparison: tool({
      description: "查询一级/二级品项普及率对比排名。",
      inputSchema: penetrationFiltersSchema.omit({ categoryName: true, seriesName: true, skuId: true }),
      execute: async (input) => getPenetrationCategoryComparison(session, compactPenetrationFilters(input)),
    }),
    queryPenetrationProductComparison: tool({
      description: "查询商品普及率排名。商品按 sale_items.sku_id 合并，展示名优先使用 product_skus.spec_name 当前名称。",
      inputSchema: penetrationFiltersSchema.omit({ skuId: true }),
      execute: async (input) => getPenetrationProductComparison(session, compactPenetrationFilters(input)),
    }),
    queryPenetrationMarketComparison: tool({
      description: "查询各市场普及率对比排名。",
      inputSchema: penetrationFiltersSchema.pick({ productKind: true, categoryName: true, seriesName: true, skuId: true }),
      execute: async (input) => getPenetrationMarketComparison(session, compactPenetrationFilters(input)),
    }),
    queryPenetrationStoreRanking: tool({
      description: "查询门店普及率排名。",
      inputSchema: penetrationFiltersSchema.omit({ store: true }).extend({
        limit: z.number().int().min(1).max(50).nullable().optional(),
      }),
      execute: async (input) =>
        getPenetrationStoreRanking(session, compactPenetrationFilters(input), input.limit ?? undefined),
    }),
    queryPenetrationCustomerList: tool({
      description: "查询当前仍有剩余疗程次数的持卡会员名单。",
      inputSchema: penetrationFiltersSchema.extend({
        limit: z.number().int().min(1).max(200).nullable().optional(),
      }),
      execute: async (input) =>
        getPenetrationCustomerList(session, compactPenetrationFilters(input), input.limit ?? 50),
    }),
    queryPenetrationAvailableFilters: tool({
      description: "查询当前用户权限内普及率可用的品项、系列、商品、市场和门店筛选项。",
      inputSchema: z.object({
        market: nullableText.describe("指定市场时返回该市场下门店。"),
        productKind: nullableText.describe("指定一级品项时返回该一级下二级品项。"),
        categoryName: nullableText.describe("指定二级品项时返回该二级下系列和商品。"),
        seriesName: nullableText.describe("指定系列时返回该系列下商品。"),
      }),
      execute: async (input) =>
        getPenetrationFilterOptions(
          session,
          input.market ?? undefined,
          input.productKind ?? undefined,
          input.categoryName ?? undefined,
          input.seriesName ?? undefined,
        ),
    }),
    queryNewCustomerFunnelKpi: tool({
      description: "查询新客漏斗 KPI，包括新客总人数、到店人数、到店率、会员客户数、会员成交率、首单金额和年度贡献。",
      inputSchema: newCustomerFiltersSchema,
      execute: async (input) => getNewCustomerFunnelKpi(session, compactNewCustomerFilters(input)),
    }),
    queryNewCustomerFunnelTrend: tool({
      description: "查询新客漏斗多月份对比，用于回答月度趋势、近几个月、新客到店率走势等问题。",
      inputSchema: newCustomerFiltersSchema,
      execute: async (input) => getNewCustomerFunnelTrend(session, compactNewCustomerFilters(input)),
    }),
    queryNewCustomerFunnelUnitComparison: tool({
      description: "查询新客漏斗多单位对比。unitLevel=market 返回市场对比，unitLevel=store 返回门店对比。",
      inputSchema: newCustomerFiltersSchema,
      execute: async (input) => getNewCustomerFunnelUnitComparison(session, compactNewCustomerFilters(input)),
    }),
    queryNewCustomerFunnelSourceBreakdown: tool({
      description: "查询新客漏斗来源渠道拆分，来源按系统 customer_source 枚举全部展开。",
      inputSchema: newCustomerFiltersSchema,
      execute: async (input) => getNewCustomerFunnelSourceBreakdown(session, compactNewCustomerFilters(input)),
    }),
    queryNewCustomerFunnelCustomerList: tool({
      description: "查询新客漏斗顾客名单。listType: all=全部新客，arrived=到店新客，not_arrived=未到店新客，member=会员新客。",
      inputSchema: newCustomerFiltersSchema.extend({
        listType: newCustomerListTypeSchema.describe("名单类型。到店新客用 arrived，会员新客用 member，未到店新客用 not_arrived。"),
        limit: z.number().int().min(1).max(200).nullable().optional(),
      }),
      execute: async (input) =>
        getNewCustomerFunnelCustomerList(
          session,
          compactNewCustomerFilters(input),
          input.limit ?? 50,
          input.listType ?? inferNewCustomerListType(question),
        ),
    }),
    queryNewCustomerFunnelAvailableFilters: tool({
      description: "查询当前用户权限内新客漏斗可用的月份、来源、市场和门店筛选项。",
      inputSchema: z.object({
        market: nullableText.describe("指定市场时返回该市场下门店。"),
      }),
      execute: async (input) => getNewCustomerFunnelFilterOptions(session, input.market ?? undefined),
    }),
    resolveTimeExpression: tool({
      description: "把最近半年、上个月、去年下半年、2025年至2026年等自然语言时间转成明确年份、月份和日期区间。",
      inputSchema: z.object({ expression: z.string().min(1) }),
      execute: async ({ expression }) => resolveTimeExpression(expression),
    }),
  }
}

export function createAssistantSystemPrompt(): string {
  const resolved = resolveTimeExpression("今天")
  return `你是凤御经营分析智能助手，只回答和复购率、普及率、新客漏斗、品项、市场、门店经营分析有关的问题。

当前日期：${resolved.currentDate}。

核心口径：
- 复购率 = 复购人数 / 品项进入总人数。
- 品项由一级品项 product_kind + 二级品项 category_name 共同定义。
- 金额口径：直接使用 sale_items.received 累计净实收；received 达到门槛即计入，和订单是否已支付无关，部分支付订单也可能达标。
- 时间口径：按订单消费日期归属，优先 sale_order_datetime，缺失时才用 paid_at。
- 进入品项：同一顾客、同一天、同门店、同一级品项、同二级品项购买合并后，received 达到系统会员门槛，默认 1980 元。
- 复购：筛选日期区间内首次进入后，后续非同日达标购买；与首次进入同一天的新开卡项不算复购。
- 普及率 = 当前仍有剩余疗程卡次数的会员数 / 总会员数。
- 普及率按顾客绑定门店和市场归属；商品维度按 sale_items.sku_id 合并，展示名优先使用 product_skus.spec_name 当前名称，sale_items.product_name 仅作为历史名称。
- 新客漏斗新客基数：非“转让店”来源必须有已支付销售单/转换单才计入，归属月取首笔有效订单时间；“转让店”只要有顾客档案即可计入，归属月取顾客档案创建时间。
- 新客漏斗来源按当前系统 customer_source 枚举全部展开，包括美团、抖音、小程序、推带新、地推卡、拓客卡、老带新、转让店、自进店、内部员工或家属、未填写。
- 新客漏斗到店：入漏斗后 T+90 内首次完成服务，T+30、T+60、T+90 互斥；漏斗图只展示新客总人数、合计到店人数、会员客户数。
- 新客漏斗会员客户：必须来自 T+90 已到店人群且已成为会员；不要求 became_member_at 晚于首次服务日。
- 所有查询都已经由服务端绑定当前用户组织范围，不要要求用户提供权限范围。

回答要求：
- 必须基于工具返回数据作答，不能编造数字。
- 复购率、普及率使用百分比，保留 1 位小数。
- 复购率 KPI 类回答必须包含进入人数、复购人数、复购率。
- 普及率 KPI 类回答必须包含持卡会员数、总会员数、普及率。
- 新客漏斗 KPI 类回答必须包含新客总人数、合计到店人数、到店率、会员客户数、会员成交率。
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
  startDate: string | null
  endDate: string | null
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

  function monthEndStr(year: number, month: number): string {
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
    return `${monthStr(year, month)}-${String(lastDay).padStart(2, "0")}`
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
    startDate: null as string | null,
    endDate: currentDate as string | null,
    description: "",
  }
  const text = expression.trim()

  const explicitYears = Array.from(text.matchAll(/20\d{2}/g), (match) => Number(match[0]))
  if (explicitYears.length >= 2) {
    const startYear = Math.min(explicitYears[0], explicitYears[1])
    const endYear = Math.max(explicitYears[0], explicitYears[1])
    const years = Array.from({ length: endYear - startYear + 1 }, (_, i) => startYear + i)
    return {
      ...result,
      year: null,
      years,
      startMonth: `${startYear}-01`,
      endMonth: `${endYear}-12`,
      startDate: `${startYear}-01-01`,
      endDate: `${endYear}-12-31`,
      description: `${startYear}年至${endYear}年`,
    }
  }

  if (explicitYears.length === 1) {
    const year = explicitYears[0]
    const isFirstHalf = text.includes("上半年")
    const isSecondHalf = text.includes("下半年")
    return {
      ...result,
      year,
      years: [year],
      startMonth: `${year}-${isSecondHalf ? "07" : "01"}`,
      endMonth: `${year}-${isFirstHalf ? "06" : "12"}`,
      startDate: `${year}-${isSecondHalf ? "07" : "01"}-01`,
      endDate: isFirstHalf ? `${year}-06-30` : `${year}-12-31`,
      description: isFirstHalf ? `${year}年上半年` : isSecondHalf ? `${year}年下半年` : `${year}年全年`,
    }
  }

  if (text.includes("上个月") || text.includes("上月")) {
    const start = monthsAgo(1)
    result.year = start.year
    result.years = [start.year]
    result.startMonth = monthStr(start.year, start.month)
    result.endMonth = result.startMonth
    result.startDate = `${result.startMonth}-01`
    result.endDate = monthEndStr(start.year, start.month)
    result.description = `${start.year}年${start.month}月`
    return result
  }

  if (text.includes("去年") && text.includes("下半年")) {
    const year = currentYear - 1
    return { ...result, year, years: [year], startMonth: `${year}-07`, endMonth: `${year}-12`, startDate: `${year}-07-01`, endDate: `${year}-12-31`, description: `${year}年下半年` }
  }

  if (text.includes("去年") && text.includes("上半年")) {
    const year = currentYear - 1
    return { ...result, year, years: [year], startMonth: `${year}-01`, endMonth: `${year}-06`, startDate: `${year}-01-01`, endDate: `${year}-06-30`, description: `${year}年上半年` }
  }

  if (text.includes("今年")) {
    result.year = currentYear
    result.years = [currentYear]
    result.startMonth = `${currentYear}-${text.includes("下半年") ? "07" : "01"}`
    result.endMonth = `${currentYear}-${text.includes("上半年") ? "06" : "12"}`
    result.startDate = `${result.startMonth}-01`
    result.endDate = text.includes("上半年") ? `${currentYear}-06-30` : `${currentYear}-12-31`
    result.description = text.includes("上半年")
      ? `${currentYear}年上半年`
      : text.includes("下半年")
        ? `${currentYear}年下半年`
        : `${currentYear}年全年`
    return result
  }

  if (text.includes("去年")) {
    const year = currentYear - 1
    return { ...result, year, years: [year], startMonth: `${year}-01`, endMonth: `${year}-12`, startDate: `${year}-01-01`, endDate: `${year}-12-31`, description: `${year}年全年` }
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
      startDate: `${monthStr(start.year, start.month)}-01`,
      endDate: currentDate,
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
    startDate: `${monthStr(start.year, start.month)}-01`,
    endDate: currentDate,
    description: `${start.year}年${start.month}月至${currentYear}年${currentMonth}月`,
  }
}

function formatRate(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function formatMoney(value: number): string {
  return value.toLocaleString("zh-CN", {
    style: "currency",
    currency: "CNY",
    maximumFractionDigits: 0,
  })
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

function inferTimeFilters(question: string): Pick<RepurchaseFilters, "year" | "startDate" | "endDate"> {
  const years = Array.from(question.matchAll(/20\d{2}/g), (match) => Number(match[0]))
  if (years.length >= 2) {
    const startYear = Math.min(years[0], years[1])
    const endYear = Math.max(years[0], years[1])
    return { startDate: `${startYear}-01-01`, endDate: `${endYear}-12-31` }
  }
  const needsDateRange = /(最近|近|过去|上个月|上月|上半年|下半年|至今|到现在|到当前|截至当前)/.test(question)
  if (needsDateRange) {
    const resolved = resolveTimeExpression(question)
    return {
      year: resolved.startDate || resolved.endDate ? undefined : resolved.year ?? undefined,
      startDate: resolved.startDate ?? undefined,
      endDate: resolved.endDate ?? undefined,
    }
  }
  if (years.length === 1) {
    return { year: years[0] }
  }
  return { year: inferYear(question) }
}

function findMention(question: string, options: string[]): string | undefined {
  return [...options].sort((a, b) => b.length - a.length).find((value) => question.includes(value))
}

function findProductMention(question: string, options: PenetrationProductOption[]): string | undefined {
  return [...options]
    .flatMap((option) => [option.skuId, option.productName, ...option.productNames].map((name) => ({ name, skuId: option.skuId })))
    .filter((item) => item.name)
    .sort((a, b) => b.name.length - a.name.length)
    .find((item) => question.includes(item.name))?.skuId
}

function isPenetrationQuestion(question: string): boolean {
  return ["普及率", "持卡", "剩余次数", "剩余疗程", "余次", "未用完"].some((keyword) => question.includes(keyword))
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

function renderPenetrationRows(rows: PenetrationRankingRow[], label: string, limit = 10): string {
  if (rows.length === 0) return "当前条件下没有可用数据。"
  const lines = [`| ${label} | 普及率 | 持卡会员 | 总会员 | 剩余次数 |`, "|---|---:|---:|---:|---:|"]
  for (const row of rows.slice(0, limit)) {
    lines.push(`| ${row.name} | ${formatRate(row.penetrationRate)} | ${row.cardHolderCount} | ${row.memberCount} | ${row.remainingSessions} |`)
  }
  return lines.join("\n")
}

function buildFilterText(filters: RepurchaseFilters, period: string): string {
  return [period, filters.productKind, filters.categoryName, filters.market, filters.store].filter(Boolean).join(" · ")
}

function formatPeriodText(filters: RepurchaseFilters): string {
  if (filters.startDate && filters.endDate) return `${filters.startDate} 至 ${filters.endDate}`
  if (filters.startDate) return `${filters.startDate} 起`
  if (filters.endDate) return `截至 ${filters.endDate}`
  return filters.year ? `${filters.year}年` : "全部年份"
}

function buildPenetrationFilterText(filters: PenetrationFilters): string {
  return [filters.productKind, filters.categoryName, filters.seriesName, filters.skuId, filters.market, filters.store]
    .filter(Boolean)
    .join(" · ") || "当前范围"
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
      { label: "复购人数", value: `${kpi.repurchaseCount.toLocaleString("zh-CN")} 人`, helper: "进入后的后续达标购买" },
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

function buildPenetrationKpiVisualization(title: string, kpi: PenetrationKpi): AssistantVisualization {
  return {
    id: "penetration-kpi",
    kind: "metrics",
    title,
    metrics: [
      { label: "持卡会员", value: `${kpi.cardHolderCount.toLocaleString("zh-CN")} 人`, helper: "当前剩余次数 > 0" },
      { label: "总会员", value: `${kpi.memberCount.toLocaleString("zh-CN")} 人`, helper: "按顾客绑定门店归属" },
      { label: "普及率", value: formatRate(kpi.penetrationRate), helper: `剩余 ${kpi.remainingSessions.toLocaleString("zh-CN")} 次` },
    ],
  }
}

function buildPenetrationRankingVisualization(title: string, rows: PenetrationRankingRow[]): AssistantVisualization {
  return {
    id: "penetration-ranking",
    kind: "bar",
    title,
    labelKey: "name",
    valueKey: "penetrationRate",
    valueFormat: "rate",
    rows: rows.slice(0, 12).map((row) => ({
      name: row.name,
      penetrationRate: row.penetrationRate,
      cardHolderCount: row.cardHolderCount,
      memberCount: row.memberCount,
      remainingSessions: row.remainingSessions,
      market: row.market ?? null,
      skuId: row.skuId ?? null,
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

function buildPenetrationCustomerTableVisualization(rows: PenetrationCustomerRow[]): AssistantVisualization {
  return {
    id: "penetration-customers",
    kind: "table",
    title: "持卡会员名单",
    columns: [
      { key: "customerName", label: "顾客" },
      { key: "store", label: "门店" },
      { key: "productKind", label: "一级品项" },
      { key: "categoryName", label: "二级品项" },
      { key: "seriesName", label: "系列" },
      { key: "productName", label: "商品" },
      { key: "remainingSessions", label: "剩余次数", align: "right" },
    ],
    rows: rows.map((row) => ({
      customerName: row.customerName,
      store: row.store,
      productKind: row.productKind,
      categoryName: row.categoryName,
      seriesName: row.seriesName,
      productName: row.productName,
      remainingSessions: row.remainingSessions,
    })),
  }
}

function isNewCustomerFunnelQuestion(question: string): boolean {
  return ["新客", "新客户", "新顾客", "漏斗", "到店率", "会员成交率", "首单金额", "年度贡献"].some((keyword) =>
    question.includes(keyword),
  )
}

function isNewCustomerListQuestion(question: string): boolean {
  return ["名单", "哪些人", "哪些新客", "顾客列表", "有哪些"].some((keyword) => question.includes(keyword))
}

function inferNewCustomerListType(question: string): NewCustomerFunnelListType {
  if (question.includes("未到店") || question.includes("没到店") || question.includes("未服务")) return "not_arrived"
  if (
    question.includes("会员新客") ||
    question.includes("新客会员") ||
    question.includes("会员客户") ||
    question.includes("成交会员") ||
    question.includes("会员名单")
  ) {
    return "member"
  }
  if (question.includes("到店")) return "arrived"
  return "all"
}

function newCustomerListTitle(listType: NewCustomerFunnelListType): string {
  if (listType === "arrived") return "到店新客名单"
  if (listType === "not_arrived") return "未到店新客名单"
  if (listType === "member") return "会员新客名单"
  return "新客名单"
}

function inferNewCustomerTimeFilters(question: string): Pick<NewCustomerFunnelFilters, "startMonth" | "endMonth"> {
  const explicitMonths = Array.from(
    question.matchAll(/(20\d{2})[-年](0?[1-9]|1[0-2])月?/g),
    (match) => `${match[1]}-${String(Number(match[2])).padStart(2, "0")}`,
  )
  if (explicitMonths.length >= 2) {
    const sorted = explicitMonths.sort()
    return { startMonth: sorted[0], endMonth: sorted[sorted.length - 1] }
  }
  if (explicitMonths.length === 1) return { startMonth: explicitMonths[0], endMonth: explicitMonths[0] }
  const resolved = resolveTimeExpression(question)
  return {
    startMonth: resolved.startMonth ?? undefined,
    endMonth: resolved.endMonth,
  }
}

function buildNewCustomerFilterText(filters: NewCustomerFunnelFilters): string {
  return [
    filters.startMonth && filters.endMonth ? `${filters.startMonth} 至 ${filters.endMonth}` : undefined,
    filters.source,
    filters.market,
    filters.store,
  ].filter(Boolean).join(" · ") || "当前范围"
}

function renderNewCustomerRows(rows: NewCustomerFunnelComparisonRow[], label: string, limit = 12): string {
  if (rows.length === 0) return "当前条件下没有可用数据。"
  const lines = [
    `| ${label} | 新客 | 合计到店 | 到店率 | 会员客户 | 会员成交率 | 首单金额 | 年度贡献 |`,
    "|---|---:|---:|---:|---:|---:|---:|---:|",
  ]
  for (const row of rows.slice(0, limit)) {
    lines.push(
      `| ${row.name} | ${row.newCustomerCount} | ${row.arrivedCount} | ${formatRate(row.arrivalRate)} | ${row.memberCustomerCount} | ${formatRate(row.memberConversionRate)} | ${formatMoney(row.firstMembershipAmount)} | ${formatMoney(row.annualContributionAmount)} |`,
    )
  }
  return lines.join("\n")
}

function buildNewCustomerKpiVisualization(title: string, kpi: NewCustomerFunnelKpi): AssistantVisualization {
  return {
    id: "new-customer-kpi",
    kind: "metrics",
    title,
    metrics: [
      { label: "新客总人数", value: `${kpi.newCustomerCount.toLocaleString("zh-CN")} 人` },
      { label: "合计到店人数", value: `${kpi.arrivedCount.toLocaleString("zh-CN")} 人`, helper: `到店率 ${formatRate(kpi.arrivalRate)}` },
      { label: "会员客户数", value: `${kpi.memberCustomerCount.toLocaleString("zh-CN")} 人`, helper: `会员成交率 ${formatRate(kpi.memberConversionRate)}` },
      { label: "年度贡献", value: formatMoney(kpi.annualContributionAmount), helper: `人均 ${formatMoney(kpi.annualContributionAverage)}` },
    ],
  }
}

function buildNewCustomerFunnelVisualization(title: string, kpi: NewCustomerFunnelKpi): AssistantVisualization {
  return {
    id: "new-customer-funnel",
    kind: "funnel",
    title,
    labelKey: "name",
    valueKey: "value",
    valueFormat: "number",
    rows: [
      { name: "新客总人数", value: kpi.newCustomerCount },
      { name: "合计到店人数", value: kpi.arrivedCount },
      { name: "会员客户数", value: kpi.memberCustomerCount },
    ],
  }
}

function buildNewCustomerRankingVisualization(title: string, rows: NewCustomerFunnelComparisonRow[]): AssistantVisualization {
  return {
    id: "new-customer-ranking",
    kind: "bar",
    title,
    labelKey: "name",
    valueKey: "newCustomerCount",
    valueFormat: "number",
    rows: rows.slice(0, 12).map((row) => ({
      name: row.name,
      newCustomerCount: row.newCustomerCount,
      arrivedCount: row.arrivedCount,
      arrivalRate: row.arrivalRate,
      memberCustomerCount: row.memberCustomerCount,
      memberConversionRate: row.memberConversionRate,
    })),
  }
}

function buildNewCustomerTableVisualization(title: string, rows: NewCustomerFunnelComparisonRow[]): AssistantVisualization {
  return {
    id: "new-customer-table",
    kind: "table",
    title,
    columns: [
      { key: "name", label: "对象" },
      { key: "newCustomerCount", label: "新客", align: "right" },
      { key: "arrivedCount", label: "到店", align: "right" },
      { key: "arrivalRateText", label: "到店率", align: "right" },
      { key: "memberCustomerCount", label: "会员客户", align: "right" },
      { key: "memberConversionRateText", label: "会员成交率", align: "right" },
    ],
    rows: rows.slice(0, 20).map((row) => ({
      name: row.name,
      newCustomerCount: row.newCustomerCount,
      arrivedCount: row.arrivedCount,
      arrivalRateText: formatRate(row.arrivalRate),
      memberCustomerCount: row.memberCustomerCount,
      memberConversionRateText: formatRate(row.memberConversionRate),
    })),
  }
}

function buildNewCustomerCustomerTableVisualization(
  rows: NewCustomerFunnelEntry[],
  title = "新客名单",
): AssistantVisualization {
  return {
    id: "new-customer-customers",
    kind: "table",
    title,
    columns: [
      { key: "customerName", label: "顾客" },
      { key: "source", label: "来源" },
      { key: "entryDate", label: "入漏斗日期" },
      { key: "firstServiceDate", label: "首次到店" },
      { key: "market", label: "市场" },
      { key: "store", label: "门店" },
    ],
    rows: rows.map((row) => ({
      customerName: row.customerName,
      source: row.source,
      entryDate: row.entryDate,
      firstServiceDate: row.firstServiceDate ?? "-",
      market: row.market,
      store: row.store,
    })),
  }
}

async function answerNewCustomerFunnelQuestion(session: AuthSession, question: string): Promise<AssistantChatResponse> {
  const options = await getNewCustomerFunnelFilterOptions(session)
  const timeFilters = inferNewCustomerTimeFilters(question)
  const filters: NewCustomerFunnelFilters = {
    ...timeFilters,
    unitLevel: question.includes("门店") ? "store" : "market",
    tableMode: question.includes("月") || question.includes("趋势") || question.includes("走势") ? "months" : "units",
    source: findMention(question, options.sources),
    market: findMention(question, options.markets),
    store: findMention(question, options.stores),
  }
  const filterText = buildNewCustomerFilterText(filters)

  if (isNewCustomerListQuestion(question)) {
    const listType = inferNewCustomerListType(question)
    const listTitle = newCustomerListTitle(listType)
    const rows = await getNewCustomerFunnelCustomerList(session, filters, 30, listType)
    if (rows.length === 0) {
      return { content: `当前条件下没有${listTitle}数据。\n\n筛选：${filterText}`, visualizations: [] }
    }
    const lines = ["| 顾客 | 来源 | 入漏斗日期 | 首次到店 | 市场 | 门店 |", "|---|---|---|---|---|---|"]
    for (const row of rows) {
      lines.push(`| ${row.customerName} | ${row.source} | ${row.entryDate} | ${row.firstServiceDate ?? "-"} | ${row.market} | ${row.store} |`)
    }
    return {
      content: `### ${listTitle}\n\n筛选：${filterText}\n\n${lines.join("\n")}`,
      visualizations: [buildNewCustomerCustomerTableVisualization(rows, listTitle)],
    }
  }

  if (question.includes("来源") || question.includes("渠道")) {
    const rows = await getNewCustomerFunnelSourceBreakdown(session, filters)
    return {
      content: `### 新客来源拆分\n\n筛选：${filterText}\n\n${renderNewCustomerRows(rows, "来源")}`,
      visualizations: [
        buildNewCustomerRankingVisualization("来源新客人数", rows),
        buildNewCustomerTableVisualization("来源明细", rows),
      ],
    }
  }

  if (question.includes("趋势") || question.includes("走势") || question.includes("月度") || question.includes("每月")) {
    const rows = await getNewCustomerFunnelTrend(session, filters)
    return {
      content: `### 新客漏斗月度趋势\n\n筛选：${filterText}\n\n${renderNewCustomerRows(rows, "月份")}`,
      visualizations: rows.length > 0 ? [buildNewCustomerRankingVisualization("月度新客人数", rows)] : [],
    }
  }

  if (question.includes("门店") || question.includes("市场") || question.includes("排名") || question.includes("对比")) {
    const rows = await getNewCustomerFunnelUnitComparison(session, filters)
    const label = filters.unitLevel === "store" ? "门店" : "市场"
    return {
      content: `### 新客漏斗${label}对比\n\n筛选：${filterText}\n\n${renderNewCustomerRows(rows, label)}`,
      visualizations: rows.length > 0 ? [buildNewCustomerRankingVisualization(`新客漏斗${label}对比`, rows)] : [],
    }
  }

  const { kpi } = await getNewCustomerFunnelKpi(session, filters)
  return {
    content: `### 新客漏斗分析

筛选：${filterText}

| 指标 | 数值 |
|---|---:|
| 新客总人数 | ${kpi.newCustomerCount} 人 |
| T+30 到店人数 | ${kpi.serviceT30Count} 人 |
| T+60 到店人数 | ${kpi.serviceT60Count} 人 |
| T+90 到店人数 | ${kpi.serviceT90Count} 人 |
| 合计到店人数 | ${kpi.arrivedCount} 人 |
| 到店率 | ${formatRate(kpi.arrivalRate)} |
| 会员客户数 | ${kpi.memberCustomerCount} 人 |
| 会员成交率 | ${formatRate(kpi.memberConversionRate)} |
| 新会员首单金额 | ${formatMoney(kpi.firstMembershipAmount)} |
| 新会员首单客单价 | ${formatMoney(kpi.firstMembershipAverage)} |
| 会员年度贡献金额 | ${formatMoney(kpi.annualContributionAmount)} |
| 会员年度贡献人均金额 | ${formatMoney(kpi.annualContributionAverage)} |`,
    visualizations: [
      buildNewCustomerKpiVisualization("新客漏斗 KPI", kpi),
      buildNewCustomerFunnelVisualization("新客转化漏斗", kpi),
    ],
  }
}

async function answerPenetrationQuestion(session: AuthSession, question: string): Promise<AssistantChatResponse> {
  const options = await getPenetrationFilterOptions(session)
  const filters: PenetrationFilters = {
    productKind: findMention(question, options.productKinds),
    categoryName: findMention(question, options.categoryNames),
    seriesName: findMention(question, options.seriesNames),
    skuId: findProductMention(question, options.products),
    market: findMention(question, options.markets),
    store: findMention(question, options.stores),
  }
  const filterText = buildPenetrationFilterText(filters)

  if (question.includes("名单") || question.includes("哪些人") || question.includes("顾客列表")) {
    const rows = await getPenetrationCustomerList(session, filters, 30)
    if (rows.length === 0) {
      return { content: `当前条件下没有持卡会员名单数据。\n\n筛选：${filterText}`, visualizations: [] }
    }
    const lines = ["| 顾客 | 门店 | 一级品项 | 二级品项 | 系列 | 商品 | 剩余次数 |", "|---|---|---|---|---|---|---:|"]
    for (const row of rows) {
      lines.push(`| ${row.customerName} | ${row.store} | ${row.productKind} | ${row.categoryName} | ${row.seriesName} | ${row.productName} | ${row.remainingSessions} |`)
    }
    return {
      content: `### 持卡会员名单\n\n筛选：${filterText}\n\n${lines.join("\n")}`,
      visualizations: [buildPenetrationCustomerTableVisualization(rows)],
    }
  }

  if (question.includes("门店") && (question.includes("排名") || question.includes("最高") || question.includes("最低") || question.includes("对比"))) {
    const rows = await getPenetrationStoreRanking(session, filters, 10)
    return {
      content: `### 门店普及率排名\n\n筛选：${filterText}\n\n${renderPenetrationRows(rows, "门店")}`,
      visualizations: rows.length > 0 ? [buildPenetrationRankingVisualization("门店普及率排名", rows)] : [],
    }
  }

  if (question.includes("市场") && (question.includes("排名") || question.includes("最高") || question.includes("最低") || question.includes("对比"))) {
    const rows = await getPenetrationMarketComparison(session, {
      productKind: filters.productKind,
      categoryName: filters.categoryName,
      seriesName: filters.seriesName,
      skuId: filters.skuId,
    })
    return {
      content: `### 市场普及率对比\n\n筛选：${filterText}\n\n${renderPenetrationRows(rows, "市场")}`,
      visualizations: rows.length > 0 ? [buildPenetrationRankingVisualization("市场普及率对比", rows)] : [],
    }
  }

  if ((question.includes("商品") || filters.skuId) && (question.includes("排名") || question.includes("最高") || question.includes("最低") || question.includes("对比"))) {
    const rows = await getPenetrationProductComparison(session, {
      productKind: filters.productKind,
      categoryName: filters.categoryName,
      seriesName: filters.seriesName,
      market: filters.market,
      store: filters.store,
    })
    return {
      content: `### 商品普及率对比\n\n筛选：${filterText}\n\n${renderPenetrationRows(rows, "商品")}`,
      visualizations: rows.length > 0 ? [buildPenetrationRankingVisualization("商品普及率对比", rows)] : [],
    }
  }

  if (question.includes("品项") && (question.includes("排名") || question.includes("最高") || question.includes("最低") || question.includes("对比"))) {
    const rows = await getPenetrationCategoryComparison(session, {
      productKind: filters.productKind,
      market: filters.market,
      store: filters.store,
    })
    return {
      content: `### 品项普及率对比\n\n筛选：${filterText}\n\n${renderPenetrationRows(rows, "品项")}`,
      visualizations: rows.length > 0 ? [buildPenetrationRankingVisualization("品项普及率对比", rows)] : [],
    }
  }

  const kpi = await getPenetrationKpi(session, filters)
  return {
    content: `### ${filterText} 普及率分析

| 指标 | 数值 |
|---|---:|
| 持卡会员数 | ${kpi.cardHolderCount} 人 |
| 总会员数 | ${kpi.memberCount} 人 |
| 普及率 | ${formatRate(kpi.penetrationRate)} |
| 剩余总次数 | ${kpi.remainingSessions} 次 |

数据解读：当前筛选下共有 ${kpi.cardHolderCount} 个会员仍持有未用完疗程卡，总会员数为 ${kpi.memberCount} 人。`,
    visualizations: [buildPenetrationKpiVisualization(`${filterText} 普及率`, kpi)],
  }
}

export async function answerQuestionWithVisualizations(
  session: AuthSession,
  question: string,
): Promise<AssistantChatResponse> {
  if (isNewCustomerFunnelQuestion(question)) {
    return answerNewCustomerFunnelQuestion(session, question)
  }

  if (isPenetrationQuestion(question)) {
    return answerPenetrationQuestion(session, question)
  }

  const options = await getRepurchaseFilterOptions(session)
  const timeFilters = inferTimeFilters(question)
  const filters: RepurchaseFilters = {
    ...timeFilters,
    productKind: findMention(question, options.productKinds),
    categoryName: findMention(question, options.categoryNames),
    market: findMention(question, options.markets),
    store: findMention(question, options.stores),
  }
  const period = formatPeriodText(filters)
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
    const rows = await getMarketComparison(session, {
      year: filters.year,
      startDate: filters.startDate,
      endDate: filters.endDate,
      productKind: filters.productKind,
      categoryName: filters.categoryName,
    })
    return {
      content: `### 市场复购率对比\n\n筛选：${filterText}\n\n${renderRows(rows, "市场")}`,
      visualizations: rows.length > 0 ? [buildRankingVisualization("市场复购率对比", rows)] : [],
    }
  }

  if (question.includes("品项") && (question.includes("排名") || question.includes("最高") || question.includes("最低") || question.includes("对比"))) {
    const rows = await getCategoryComparison(session, {
      year: filters.year,
      startDate: filters.startDate,
      endDate: filters.endDate,
      productKind: filters.productKind,
      market: filters.market,
      store: filters.store,
    })
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

数据解读：当前筛选下共有 ${kpi.entryCount} 个顾客品项进入记录，其中 ${kpi.repurchaseCount} 个发生进入后的后续达标购买。`,
    visualizations: [buildKpiVisualization(`${target} 复购率`, threshold, kpi)],
  }
}

export async function answerQuestionLocally(session: AuthSession, question: string): Promise<string> {
  return (await answerQuestionWithVisualizations(session, question)).content
}
