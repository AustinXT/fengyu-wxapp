import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AuthSession } from "../types"

const mocks = vi.hoisted(() => ({
  getAnalystScopeOptions: vi.fn(),
  getAnalystScopeLabel: vi.fn(),
  getSystemProductTermOptions: vi.fn(),
  getRepurchaseKpi: vi.fn(),
  getRepurchaseTrend: vi.fn(),
  getCategoryComparison: vi.fn(),
  getMarketComparison: vi.fn(),
  getStoreRanking: vi.fn(),
  getRepurchaseCustomerList: vi.fn(),
  getRepurchaseFilterOptions: vi.fn(),
  getPenetrationKpi: vi.fn(),
  getPenetrationCategoryComparison: vi.fn(),
  getPenetrationProductComparison: vi.fn(),
  getPenetrationMarketComparison: vi.fn(),
  getPenetrationStoreRanking: vi.fn(),
  getPenetrationCustomerList: vi.fn(),
  getPenetrationFilterOptions: vi.fn(),
  getNewCustomerFunnelKpi: vi.fn(),
  getNewCustomerFunnelTrend: vi.fn(),
  getNewCustomerFunnelUnitComparison: vi.fn(),
  getNewCustomerFunnelSourceBreakdown: vi.fn(),
  getNewCustomerFunnelCustomerList: vi.fn(),
  getNewCustomerFunnelFilterOptions: vi.fn(),
}))

vi.mock("server-only", () => ({}))

vi.mock("@/lib/analyst-scope", () => ({
  getAnalystScopeOptions: mocks.getAnalystScopeOptions,
  getAnalystScopeLabel: mocks.getAnalystScopeLabel,
}))

vi.mock("@/lib/assistant-product-terms", () => ({
  getSystemProductTermOptions: mocks.getSystemProductTermOptions,
}))

vi.mock("@/lib/repurchase", () => ({
  getRepurchaseKpi: mocks.getRepurchaseKpi,
  getRepurchaseTrend: mocks.getRepurchaseTrend,
  getCategoryComparison: mocks.getCategoryComparison,
  getMarketComparison: mocks.getMarketComparison,
  getStoreRanking: mocks.getStoreRanking,
  getRepurchaseCustomerList: mocks.getRepurchaseCustomerList,
  getRepurchaseFilterOptions: mocks.getRepurchaseFilterOptions,
}))

vi.mock("@/lib/penetration", () => ({
  getPenetrationKpi: mocks.getPenetrationKpi,
  getPenetrationCategoryComparison: mocks.getPenetrationCategoryComparison,
  getPenetrationProductComparison: mocks.getPenetrationProductComparison,
  getPenetrationMarketComparison: mocks.getPenetrationMarketComparison,
  getPenetrationStoreRanking: mocks.getPenetrationStoreRanking,
  getPenetrationCustomerList: mocks.getPenetrationCustomerList,
  getPenetrationFilterOptions: mocks.getPenetrationFilterOptions,
}))

vi.mock("@/lib/new-customer-funnel", () => ({
  getNewCustomerFunnelKpi: mocks.getNewCustomerFunnelKpi,
  getNewCustomerFunnelTrend: mocks.getNewCustomerFunnelTrend,
  getNewCustomerFunnelUnitComparison: mocks.getNewCustomerFunnelUnitComparison,
  getNewCustomerFunnelSourceBreakdown: mocks.getNewCustomerFunnelSourceBreakdown,
  getNewCustomerFunnelCustomerList: mocks.getNewCustomerFunnelCustomerList,
  getNewCustomerFunnelFilterOptions: mocks.getNewCustomerFunnelFilterOptions,
}))

const {
  answerQuestionWithVisualizations,
  buildAssistantDataContext,
  classifyAssistantQuestion,
  detectAssistantMetricIntents,
  getShanghaiCurrentTime,
  normalizeAssistantResponseForDisplay,
  resolveTimeExpression,
} = await import("../assistant-answer")

const session: AuthSession = {
  employeeId: "e-admin",
  name: "管理员",
  phone: "13800000000",
  roles: [{ role: "admin", scopeId: "hq", scopeType: "总部" }],
  permissions: {
    actions: ["data_center:dashboard"],
    scopeStoreIds: ["store-nc-1", "store-gz-1"],
  },
}

const scopeOptions = {
  topLevel: "all" as const,
  markets: [
    {
      id: "market-nc",
      name: "南昌市场",
      stores: [{ storeId: "store-nc-1", storeName: "南昌一店" }],
    },
    {
      id: "market-gz",
      name: "赣州市场",
      stores: [{ storeId: "store-gz-1", storeName: "赣州一店" }],
    },
  ],
}

const productTerms = {
  productKinds: ["明星", "王牌"],
  categoryNames: ["科颜美", "安吉丽", "功能养生"],
  categories: ["明星 / 科颜美", "王牌 / 安吉丽", "王牌 / 功能养生"],
  categoryPairs: [
    { productKind: "明星", categoryName: "科颜美" },
    { productKind: "王牌", categoryName: "安吉丽" },
    { productKind: "王牌", categoryName: "功能养生" },
  ],
  seriesNames: ["美学类(面部)", "健康类(身体)"],
  products: [
    {
      skuId: "SKU-KYM-001",
      productName: "科颜美水光护理10次卡",
      productNames: ["科颜美水光护理十次卡"],
      productKind: "明星",
      categoryName: "科颜美",
      seriesName: "美学类(面部)",
    },
  ],
}

const newCustomerKpi = {
  newCustomerCount: 90,
  serviceT30Count: 25,
  serviceT60Count: 18,
  serviceT90Count: 11,
  arrivedCount: 54,
  arrivalRate: 0.6,
  memberCustomerCount: 24,
  memberConversionRate: 0.4444,
  firstMembershipAmount: 72000,
  firstMembershipAverage: 3000,
  annualContributionAmount: 168000,
  annualContributionAverage: 7000,
}

const marketNewCustomerRows = [
  {
    name: "南昌市场",
    newCustomerCount: 60,
    arrivedCount: 42,
    arrivalRate: 0.7,
    memberCustomerCount: 20,
    memberConversionRate: 0.4762,
    firstMembershipAmount: 60000,
    annualContributionAmount: 120000,
  },
  {
    name: "赣州市场",
    newCustomerCount: 30,
    arrivedCount: 12,
    arrivalRate: 0.4,
    memberCustomerCount: 4,
    memberConversionRate: 0.3333,
    firstMembershipAmount: 12000,
    annualContributionAmount: 48000,
  },
]

const storeNewCustomerRows = [
  {
    name: "南昌一店",
    newCustomerCount: 60,
    arrivedCount: 42,
    arrivalRate: 0.7,
    memberCustomerCount: 20,
    memberConversionRate: 0.4762,
    firstMembershipAmount: 60000,
    annualContributionAmount: 120000,
  },
]

function repurchaseKpiFor(filters: { categoryName?: string }) {
  const isKym = filters.categoryName === "科颜美"
  return {
    threshold: 1980,
    kpi: {
      entryCount: isKym ? 100 : 200,
      repurchaseCount: isKym ? 42 : 76,
      repurchaseRate: isKym ? 0.42 : 0.38,
      prevYearRate: 0.31,
      delta: isKym ? 0.11 : 0.07,
    },
  }
}

function penetrationKpiFor(filters: { categoryName?: string }) {
  const isKym = filters.categoryName === "科颜美"
  return {
    memberCount: isKym ? 250 : 500,
    cardHolderCount: isKym ? 80 : 120,
    penetrationRate: isKym ? 0.32 : 0.24,
    remainingSessions: isKym ? 420 : 680,
  }
}

beforeEach(() => {
  vi.clearAllMocks()

  mocks.getAnalystScopeOptions.mockResolvedValue(scopeOptions)
  mocks.getAnalystScopeLabel.mockImplementation((scope) => {
    if (scope.type === "market") return scope.id === "market-nc" ? "南昌市场" : "赣州市场"
    if (scope.type === "store") return scope.id === "store-nc-1" ? "南昌一店" : "赣州一店"
    return "全部"
  })
  mocks.getSystemProductTermOptions.mockResolvedValue(productTerms)

  mocks.getRepurchaseFilterOptions.mockResolvedValue({
    years: [2026, 2025],
    productKinds: productTerms.productKinds,
    categoryNames: productTerms.categoryNames,
    categories: productTerms.categories,
  })
  mocks.getRepurchaseKpi.mockImplementation(async (_session, _scope, filters) => repurchaseKpiFor(filters))
  mocks.getRepurchaseTrend.mockResolvedValue([
    { name: "2026-03", repurchaseRate: 0.3, entryCount: 30, repurchaseCount: 9 },
    { name: "2026-04", repurchaseRate: 0.4, entryCount: 35, repurchaseCount: 14 },
  ])
  mocks.getCategoryComparison.mockResolvedValue([
    { name: "明星 / 科颜美", productKind: "明星", categoryName: "科颜美", repurchaseRate: 0.42, entryCount: 100, repurchaseCount: 42 },
    { name: "王牌 / 安吉丽", productKind: "王牌", categoryName: "安吉丽", repurchaseRate: 0.28, entryCount: 80, repurchaseCount: 22 },
  ])
  mocks.getMarketComparison.mockResolvedValue([
    { name: "南昌市场", repurchaseRate: 0.44, entryCount: 120, repurchaseCount: 53 },
    { name: "赣州市场", repurchaseRate: 0.25, entryCount: 80, repurchaseCount: 20 },
  ])
  mocks.getStoreRanking.mockResolvedValue([
    { name: "南昌一店", market: "南昌市场", repurchaseRate: 0.44, entryCount: 120, repurchaseCount: 53 },
  ])
  mocks.getRepurchaseCustomerList.mockImplementation(async (_session, _scope, _filters, listType) => {
    if (listType === "repurchase") {
      return [
        { customerId: "C002", customerName: "顾客乙", productKind: "明星", categoryName: "科颜美", category: "明星 / 科颜美", status: "复购", firstDate: "2026-04-02", store: "南昌一店", market: "南昌市场" },
      ]
    }
    if (listType === "entry_only") {
      return [
        { customerId: "C001", customerName: "顾客甲", productKind: "明星", categoryName: "科颜美", category: "明星 / 科颜美", status: "进入", firstDate: "2026-04-01", store: "南昌一店", market: "南昌市场" },
      ]
    }
    return [
      { customerId: "C001", customerName: "顾客甲", productKind: "明星", categoryName: "科颜美", category: "明星 / 科颜美", status: "进入", firstDate: "2026-04-01", store: "南昌一店", market: "南昌市场" },
      { customerId: "C002", customerName: "顾客乙", productKind: "明星", categoryName: "科颜美", category: "明星 / 科颜美", status: "复购", firstDate: "2026-04-02", store: "南昌一店", market: "南昌市场" },
    ]
  })

  mocks.getPenetrationFilterOptions.mockResolvedValue({
    productKinds: productTerms.productKinds,
    categoryNames: productTerms.categoryNames,
    seriesNames: productTerms.seriesNames,
    products: productTerms.products,
  })
  mocks.getPenetrationKpi.mockImplementation(async (_session, _scope, filters) => penetrationKpiFor(filters))
  mocks.getPenetrationCategoryComparison.mockResolvedValue([
    { id: "明星 / 科颜美", name: "明星 / 科颜美", productKind: "明星", categoryName: "科颜美", penetrationRate: 0.32, cardHolderCount: 80, memberCount: 250, remainingSessions: 420 },
    { id: "王牌 / 功能养生", name: "王牌 / 功能养生", productKind: "王牌", categoryName: "功能养生", penetrationRate: 0.2, cardHolderCount: 50, memberCount: 250, remainingSessions: 260 },
  ])
  mocks.getPenetrationProductComparison.mockResolvedValue([
    { id: "SKU-KYM-001", name: "科颜美水光护理10次卡", productKind: "明星", categoryName: "科颜美", seriesName: "美学类(面部)", skuId: "SKU-KYM-001", penetrationRate: 0.18, cardHolderCount: 45, memberCount: 250, remainingSessions: 120 },
  ])
  mocks.getPenetrationMarketComparison.mockResolvedValue([
    { id: "南昌市场", name: "南昌市场", market: "南昌市场", penetrationRate: 0.35, cardHolderCount: 90, memberCount: 260, remainingSessions: 450 },
    { id: "赣州市场", name: "赣州市场", market: "赣州市场", penetrationRate: 0.16, cardHolderCount: 30, memberCount: 190, remainingSessions: 230 },
  ])
  mocks.getPenetrationStoreRanking.mockResolvedValue([
    { id: "南昌一店", name: "南昌一店", market: "南昌市场", penetrationRate: 0.35, cardHolderCount: 90, memberCount: 260, remainingSessions: 450 },
  ])
  mocks.getPenetrationCustomerList.mockResolvedValue([
    { customerId: "u-1", customerCode: "C001", customerName: "顾客甲", market: "南昌市场", store: "南昌一店", productKind: "明星", categoryName: "科颜美", seriesName: "美学类(面部)", skuId: "SKU-KYM-001", productName: "科颜美水光护理10次卡", productNames: ["科颜美水光护理10次卡"], remainingSessions: 6 },
    { customerId: "u-3", customerCode: "C003", customerName: "顾客丙", market: "南昌市场", store: "南昌一店", productKind: "王牌", categoryName: "功能养生", seriesName: "健康类(身体)", skuId: "SKU-GNYS-001", productName: "功能养生10次卡", productNames: ["功能养生10次卡"], remainingSessions: 3 },
  ])

  mocks.getNewCustomerFunnelFilterOptions.mockResolvedValue({
    months: ["2026-08", "2026-07", "2026-06"],
    sources: ["美团", "抖音", "老带新", "未填写"],
  })
  mocks.getNewCustomerFunnelKpi.mockResolvedValue({ filters: {}, kpi: newCustomerKpi })
  mocks.getNewCustomerFunnelTrend.mockResolvedValue(marketNewCustomerRows.map((row, index) => ({
    ...row,
    name: index === 0 ? "2026-07" : "2026-08",
  })))
  mocks.getNewCustomerFunnelUnitComparison.mockImplementation(async (_session, _scope, filters) =>
    filters.unitLevel === "store" ? storeNewCustomerRows : marketNewCustomerRows,
  )
  mocks.getNewCustomerFunnelSourceBreakdown.mockResolvedValue([
    { ...marketNewCustomerRows[0], name: "美团" },
    { ...marketNewCustomerRows[1], name: "抖音" },
  ])
  mocks.getNewCustomerFunnelCustomerList.mockResolvedValue([
    { customerId: "u-1", customerCode: "C001", customerName: "顾客甲", source: "美团", month: "2026-04", entryDate: "2026-04-01", market: "南昌市场", store: "南昌一店", firstServiceDate: "2026-04-10", serviceBucket: "t30", becameMemberAt: "2026-04-12T00:00:00.000Z", firstMembershipAmount: 3000, annualContributionAmount: 7000 },
    { customerId: "u-2", customerCode: "C002", customerName: "顾客乙", source: "抖音", month: "2026-04", entryDate: "2026-04-02", market: "南昌市场", store: "南昌一店", firstServiceDate: "2026-04-20", serviceBucket: "t30", becameMemberAt: "2026-04-21T00:00:00.000Z", firstMembershipAmount: 3000, annualContributionAmount: 7000 },
  ])
})

const assistantEvaluationCases = [
  { id: "Q01", difficulty: "易", question: "今年复购率是多少？", expected: ["复购率分析", "品项进入人数", "复购人数"] },
  { id: "Q02", difficulty: "易", question: "今年科颜美复购率是多少？", expected: ["科颜美", "复购率"] },
  { id: "Q03", difficulty: "中", question: "今年各品项复购率对比，哪个最高？", expected: ["品项复购率对比", "明星 / 科颜美"] },
  { id: "Q04", difficulty: "中", question: "最近半年复购率趋势怎么样？", expected: ["复购率趋势", "2026-03"] },
  { id: "Q05", difficulty: "难", question: "今年科颜美进入但未复购的顾客名单", expected: ["顾客名单", "顾客甲"] },
  { id: "Q06", difficulty: "易", question: "科颜美普及率是多少？", expected: ["普及率分析", "持卡会员数", "剩余总次数"] },
  { id: "Q07", difficulty: "中", question: "功能养生各门店普及率排名", expected: ["门店普及率排名", "南昌一店"] },
  { id: "Q08", difficulty: "中", question: "SKU-KYM-001 的商品普及率排名", expected: ["商品普及率对比", "科颜美水光护理10次卡"] },
  { id: "Q09", difficulty: "难", question: "哪些会员还有科颜美疗程余次？", expected: ["持卡会员名单", "剩余次数"] },
  { id: "Q10", difficulty: "中", question: "各市场普及率对比，哪里最低？", expected: ["市场普及率对比", "赣州市场"] },
  { id: "Q11", difficulty: "易", question: "今年新客漏斗表现怎么样？", expected: ["新客漏斗分析", "新客总人数", "会员成交率"] },
  { id: "Q12", difficulty: "中", question: "最近半年新客到店率趋势", expected: ["新客漏斗月度趋势", "2026-07"] },
  { id: "Q13", difficulty: "中", question: "美团来源新客漏斗怎么样？", expected: ["新客漏斗分析", "美团"] },
  { id: "Q14", difficulty: "中", question: "各市场新客漏斗对比", expected: ["新客漏斗市场对比", "南昌市场"] },
  { id: "Q15", difficulty: "中", question: "今年复购率和普及率一起看", expected: ["多指标联动概览", "复购率", "普及率"] },
  { id: "Q16", difficulty: "难", question: "科颜美复购率和普及率是否匹配？", expected: ["多指标联动概览", "科颜美", "说明"] },
  { id: "Q17", difficulty: "难", question: "今年新客漏斗和复购率一起看", expected: ["多指标联动概览", "新客漏斗", "复购率"] },
  { id: "Q18", difficulty: "难", question: "美团新客漏斗和整体复购率、普及率一起看", expected: ["多指标联动概览", "新客来源 美团", "来源筛选只应用于新客漏斗"] },
  { id: "Q19", difficulty: "难", question: "哪些新客同时持卡且未复购？", expected: ["交叉顾客名单", "未复购", "持卡品项"] },
  { id: "Q20", difficulty: "难", question: "三个指标按市场综合看，哪个市场最需要关注？", expected: ["多指标市场联动对比", "复购率", "会员成交率"] },
]

describe("assistant answer 20-question evaluation", () => {
  it("uses a complete Shanghai clock across the UTC date boundary", () => {
    const now = new Date("2026-08-31T16:05:06.000Z")

    expect(getShanghaiCurrentTime(now)).toEqual({
      timeZone: "Asia/Shanghai",
      utcOffset: "+08:00",
      date: "2026-09-01",
      time: "00:05:06",
      dateTime: "2026-09-01 00:05:06",
      year: 2026,
      month: 9,
      day: 1,
      weekday: "星期二",
    })
    expect(resolveTimeExpression("今年", now)).toMatchObject({
      currentDate: "2026-09-01",
      year: 2026,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    })
  })

  it.each(["今年是哪年", "现在几点", "今天星期几"])("answers time question without querying business data: %s", async (question) => {
    const response = await answerQuestionWithVisualizations(
      session,
      question,
      new Date("2026-08-31T16:05:06.000Z"),
    )

    expect(classifyAssistantQuestion(question)).toBe("time")
    expect(response.content).toBe("当前上海时间是 2026-09-01 00:05:06（星期二），今年是 2026 年。")
    expect(response.visualizations).toEqual([])
    expect(mocks.getAnalystScopeOptions).not.toHaveBeenCalled()
    expect(mocks.getRepurchaseKpi).not.toHaveBeenCalled()
    expect(mocks.getPenetrationKpi).not.toHaveBeenCalled()
    expect(mocks.getNewCustomerFunnelKpi).not.toHaveBeenCalled()
  })

  it("falls back to repurchase KPI for vague business questions, keeping legacy answerability", async () => {
    const response = await answerQuestionWithVisualizations(session, "科颜美怎么样？")

    expect(classifyAssistantQuestion("科颜美怎么样？")).toBe("business")
    expect(response.content).toContain("复购率分析")
    expect(response.content).toContain("科颜美")
    expect(response.visualizations.length).toBeGreaterThan(0)
    expect(mocks.getRepurchaseKpi).toHaveBeenCalled()
  })

  it.each([
    "现在哪个门店年卡卖得最好",
    "当前门店客流时间分布",
    "现在还有多少个会员是2025年办的卡",
  ])("keeps time-flavored business questions out of the time bucket: %s", async (question) => {
    const response = await answerQuestionWithVisualizations(session, question)

    expect(classifyAssistantQuestion(question)).toBe("business")
    expect(response.content).not.toContain("当前上海时间")
  })

  it("does not treat 'Shanghai time caliber' phrasing as a time question", () => {
    expect(classifyAssistantQuestion("按上海时间口径统计的数据准吗")).not.toBe("time")
    expect(classifyAssistantQuestion("按上海时间口径统计的数据准吗")).toBe("business")
  })

  it.each([
    "现在几点",
    "现在几点了",
    "现在几点了？",
    "北京时间几点",
  ])("still answers direct clock questions: %s", (question) => {
    expect(classifyAssistantQuestion(question)).toBe("time")
  })

  it("answers store-comparison questions via ranking instead of asking for clarification", async () => {
    const response = await answerQuestionWithVisualizations(session, "各门店对比一下怎么样")

    expect(classifyAssistantQuestion("各门店对比一下怎么样")).toBe("business")
    expect(response.content).toContain("门店复购率排名")
    expect(response.visualizations.length).toBeGreaterThan(0)
    expect(mocks.getStoreRanking).toHaveBeenCalled()
  })

  it("renders 同比 via metric-delta so AI answers can't drift from the dashboard (#314)", async () => {
    // formatSignedRate 曾是 formatPointDelta 的逐字复制品，吃同一个 kpi.delta 却各自判零：
    // delta = 0.0001（repurchase.ts 的 round4 最小非零值）在看板出「持平」、在这里出 "+0.0pct"。
    // 现已收敛到 metric-delta 的无前缀内核 formatPointDeltaValue，两条路径不可能再分叉。
    mocks.getRepurchaseKpi.mockResolvedValue({
      threshold: 1980,
      kpi: { entryCount: 200, repurchaseCount: 76, repurchaseRate: 0.38, prevYearRate: 0.3799, delta: 0.0001 },
    })
    const response = await answerQuestionWithVisualizations(session, "今年复购率怎么样")

    expect(response.content).toContain("持平")
    expect(response.content).not.toContain("0.0pct")
  })

  it("never renders NaNpct when the upstream delta goes non-finite (#314 / #317)", async () => {
    // round4 不挡 NaN，只靠更上游 rate() 的 entryCount > 0 守卫兜着。护栏一旦被动，
    // 旧实现会把 "NaNpct" 拼进一句读起来通顺的话里——比看板徽章更难被发现。
    mocks.getRepurchaseKpi.mockResolvedValue({
      threshold: 1980,
      kpi: { entryCount: 200, repurchaseCount: 76, repurchaseRate: 0.38, prevYearRate: 0.31, delta: Number.NaN },
    })
    const response = await answerQuestionWithVisualizations(session, "今年复购率怎么样")

    expect(response.content).not.toContain("NaN")
    expect(response.content).toContain("无同比")
  })

  it("answers customer-list questions instead of asking for clarification", async () => {
    const response = await answerQuestionWithVisualizations(session, "顾客名单有哪些")

    expect(classifyAssistantQuestion("顾客名单有哪些")).toBe("business")
    expect(response.content).toContain("顾客名单")
    expect(response.visualizations.some((visualization) => visualization.kind === "table")).toBe(true)
    expect(mocks.getRepurchaseCustomerList).toHaveBeenCalledWith(
      session,
      expect.anything(),
      expect.anything(),
      "all",
      30,
    )
  })

  it("routes monthly-trend synonyms to the repurchase trend answer", async () => {
    const response = await answerQuestionWithVisualizations(session, "看下今年的月度走势")

    expect(classifyAssistantQuestion("看下今年的月度走势")).toBe("business")
    expect(response.content).toContain("复购率趋势")
    expect(mocks.getRepurchaseTrend).toHaveBeenCalled()
    expect(response.visualizations.length).toBeGreaterThan(0)
  })

  it.each(["明天天气怎么样？", "量子纠缠综合分析"])("states when a question is unsupported: %s", async (question) => {
    const response = await answerQuestionWithVisualizations(session, question)

    expect(classifyAssistantQuestion(question)).toBe("unsupported")
    expect(response.content).toBe("这个问题超出当前经营分析助手的能力范围，我无法给出可靠答案。当前仅支持上海时间、复购率、普及率和新客漏斗。")
    expect(response.visualizations).toEqual([])
    expect(mocks.getAnalystScopeOptions).not.toHaveBeenCalled()
  })

  it("classifies multi-metric cross questions before single-metric routes", () => {
    expect(detectAssistantMetricIntents("今年复购率和普及率一起看")).toEqual(["repurchase", "penetration"])
    expect(detectAssistantMetricIntents("三个指标按市场综合看")).toEqual([
      "repurchase",
      "penetration",
      "newCustomerFunnel",
    ])
  })

  it.each(assistantEvaluationCases)("$id $difficulty $question", async ({ question, expected }) => {
    const response = await answerQuestionWithVisualizations(session, question)

    for (const text of expected) {
      expect(response.content).toContain(text)
    }
    expect(response.content).not.toContain("没有可用数据")
    expect(response.visualizations.length).toBeGreaterThan(0)
  })

  it("keeps list data in visualization without duplicating the markdown table", async () => {
    const raw = await answerQuestionWithVisualizations(session, "今年科颜美进入但未复购的顾客名单")
    const response = normalizeAssistantResponseForDisplay(raw)

    expect(raw.content).toContain("| 顾客 |")
    expect(response.content).not.toContain("| 顾客 |")
    expect(response.content).toContain("顾客名单")
    expect(response.visualizations.some((visualization) => visualization.kind === "table")).toBe(true)
  })

  it("builds AI context from deterministic query results and visualization rows", async () => {
    const response = normalizeAssistantResponseForDisplay(
      await answerQuestionWithVisualizations(session, "今年复购率和普及率一起看"),
    )
    const context = buildAssistantDataContext("今年复购率和普及率一起看", response)

    expect(context.toolResult).toContain("复购率")
    expect(context.toolResult).toContain("普及率")
    expect(context.toolResult).toContain("visualizations")
    expect(context.visualizations.length).toBeGreaterThan(0)
  })

  it("answers a specific new-customer source with KPI instead of source breakdown", async () => {
    const response = await answerQuestionWithVisualizations(session, "美团来源新客漏斗怎么样？")

    expect(response.content).toContain("新客漏斗分析")
    expect(response.content).toContain("美团")
    expect(mocks.getNewCustomerFunnelKpi).toHaveBeenCalled()
    expect(mocks.getNewCustomerFunnelSourceBreakdown).not.toHaveBeenCalled()
  })

  it("queries multiple metric sources for screenshot regression questions", async () => {
    await answerQuestionWithVisualizations(session, "今年新客漏斗和复购率一起看")
    expect(mocks.getNewCustomerFunnelKpi).toHaveBeenCalled()
    expect(mocks.getRepurchaseKpi).toHaveBeenCalled()

    vi.clearAllMocks()
    mocks.getAnalystScopeOptions.mockResolvedValue(scopeOptions)
    mocks.getAnalystScopeLabel.mockImplementation((scope) => (scope.type === "all" ? "全部" : "南昌市场"))
    mocks.getSystemProductTermOptions.mockResolvedValue(productTerms)
    mocks.getRepurchaseFilterOptions.mockResolvedValue({
      years: [2026, 2025],
      productKinds: productTerms.productKinds,
      categoryNames: productTerms.categoryNames,
      categories: productTerms.categories,
    })
    mocks.getPenetrationFilterOptions.mockResolvedValue({
      productKinds: productTerms.productKinds,
      categoryNames: productTerms.categoryNames,
      seriesNames: productTerms.seriesNames,
      products: productTerms.products,
    })
    mocks.getNewCustomerFunnelFilterOptions.mockResolvedValue({
      months: ["2026-08", "2026-07", "2026-06"],
      sources: ["美团", "抖音", "老带新", "未填写"],
    })
    mocks.getMarketComparison.mockResolvedValue([])
    mocks.getPenetrationMarketComparison.mockResolvedValue([])
    mocks.getNewCustomerFunnelUnitComparison.mockResolvedValue([])

    await answerQuestionWithVisualizations(session, "三个指标按市场综合看，哪个市场最需要关注？")
    expect(mocks.getMarketComparison).toHaveBeenCalled()
    expect(mocks.getPenetrationMarketComparison).toHaveBeenCalled()
    expect(mocks.getNewCustomerFunnelUnitComparison).toHaveBeenCalled()
  })
})
