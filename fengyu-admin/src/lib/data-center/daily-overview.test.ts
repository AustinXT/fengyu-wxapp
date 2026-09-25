import { describe, expect, it } from 'vitest'
import { buildMatrixHeaderLayout, computeFrozenPositions } from './matrix'
import { toWorkerExportColumns } from './matrix-export'
import {
  DAILY_OVERVIEW_KEYS as K,
  DAILY_OVERVIEW_SALES_CATEGORY_ORDER,
  absorbRounding,
  buildDailyOverview,
  buildDailyOverviewColumns,
  computeDailyOverviewKpis,
  parseDailyOverviewTab,
  toCents,
  type DailyOverviewData,
  type DailyOverviewInput,
  type DailyOverviewRow,
} from './daily-overview'

/**
 * 日常数据一览表纯逻辑（#369）：逐店勾稽（公式断言）+ 字面量快照 + 未分类兜底 + 尾差吸收。
 * 夹具是手写的小样本，不写死任何当月数字——prod 基准数的核对记录在 PR 描述里。
 */

const categories: DailyOverviewInput['categories'] = [
  { categoryId: 'P-zhaopai', categoryName: '招牌', productKind: null, sortOrder: 1, isValid: true },
  { categoryId: 'P-wangpai', categoryName: '王牌', productKind: null, sortOrder: 2, isValid: true },
  { categoryId: 'P-jiaxiang', categoryName: '加项', productKind: null, sortOrder: 4, isValid: true },
  { categoryId: 'P-old', categoryName: '已停用一级', productKind: null, sortOrder: 9, isValid: false },
  // 与一级同名的二级（prod 真有：一级「招牌」下的二级「招牌」）——必须按 category_id 区分
  { categoryId: 'S-zhaopai', categoryName: '招牌', productKind: '招牌', sortOrder: 1, isValid: true },
  { categoryId: 'S-juedui', categoryName: '绝对招牌', productKind: '招牌', sortOrder: 2, isValid: true },
  { categoryId: 'S-anjili', categoryName: '安吉丽(自销)', productKind: '王牌', sortOrder: 1, isValid: true },
  // 停用但期间有数 → 仍显示
  { categoryId: 'S-stopped-used', categoryName: '停用有数', productKind: '王牌', sortOrder: 7, isValid: false },
  // 停用且期间无数 → 隐藏
  { categoryId: 'S-stopped-empty', categoryName: '停用无数', productKind: '王牌', sortOrder: 8, isValid: false },
  // 新增的有效二级，期间无数 → 照样出列（不改代码刷新即出现）
  { categoryId: 'S-new', categoryName: '新增二级', productKind: '加项', sortOrder: 3, isValid: true },
  { categoryId: 'S-shenjiu', categoryName: '中华神灸', productKind: '加项', sortOrder: 1, isValid: true },
  // 找不到一级的二级 → 未挂接，进未分类
  { categoryId: 'S-orphan', categoryName: '孤儿二级', productKind: '不存在的一级', sortOrder: 1, isValid: true },
]

const stores: DailyOverviewInput['stores'] = [
  { storeId: 'st-b', storeName: '绿湖店', marketId: 'm1', marketName: '南昌凤御' },
  { storeId: 'st-a', storeName: '蓝莱店', marketId: 'm1', marketName: '南昌凤御' },
  { storeId: 'st-z', storeName: '零业绩店', marketId: 'm2', marketName: '自贡凤御' },
]

function fixture(): DailyOverviewInput {
  return {
    stores,
    categories,
    performanceTotals: [
      { storeId: 'st-a', amount: '1000.00' },
      { storeId: 'st-b', amount: '-50.00' },
    ],
    performanceParts: [
      { storeId: 'st-a', salesCategory: '自销自耗', categoryId: 'S-zhaopai', amount: '400' },
      { storeId: 'st-a', salesCategory: '他销他耗', categoryId: 'S-juedui', amount: '200' },
      { storeId: 'st-a', salesCategory: '他销自耗', categoryId: 'S-anjili', amount: '150' },
      { storeId: 'st-a', salesCategory: '生态合作', categoryId: 'S-stopped-used', amount: '50' },
      // sales_category 为空 → 经营类型未分类（品项照常归到二级）
      { storeId: 'st-a', salesCategory: null, categoryId: 'S-shenjiu', amount: '30' },
      // SKU 挂在一级上 → 品项未分类（经营类型照常）
      { storeId: 'st-a', salesCategory: '自销自耗', categoryId: 'P-wangpai', amount: '40' },
      // 二级找不到一级 → 品项未分类
      { storeId: 'st-a', salesCategory: '自销自耗', categoryId: 'S-orphan', amount: '20' },
      // sku_id 为空 → 品项未分类
      { storeId: 'st-a', salesCategory: '自销自耗', categoryId: null, amount: '60' },
      // 款项无 receipts / 分母为 0：SQL 整笔以 (null, null) 送来 → 两边都进未分类
      { storeId: 'st-a', salesCategory: null, categoryId: null, amount: '50' },
      // 退款冲销：负数原样保留
      { storeId: 'st-b', salesCategory: '自销自耗', categoryId: 'S-shenjiu', amount: '-50' },
    ],
    recharge: [
      { storeId: 'st-a', amount: '300.00' },
      { storeId: 'st-b', amount: '0.00' },
    ],
    service: [
      { storeId: 'st-a', salesCategory: '自销自耗', amount: '120.50' },
      { storeId: 'st-a', salesCategory: '他销他耗', amount: '80.00' },
      { storeId: 'st-a', salesCategory: null, amount: '9.50' },
      { storeId: 'st-b', salesCategory: '生态合作', amount: '33.33' },
    ],
  }
}

const cents = (value: number | undefined) => Math.round((value ?? 0) * 100)
const sumCents = (row: DailyOverviewRow, keys: string[]) => keys.reduce((sum, key) => sum + cents(row.values[key]), 0)

function assertReconciles(data: DailyOverviewData) {
  const businessKeys = [...DAILY_OVERVIEW_SALES_CATEGORY_ORDER.map((c) => K.performance(c)), K.performanceUnclassified, K.recharge]
  const serviceKeys = [...DAILY_OVERVIEW_SALES_CATEGORY_ORDER.map((c) => K.service(c)), K.serviceUnclassified]
  const allPrimaryIds = categories.filter((c) => c.productKind === null).map((c) => c.categoryId)
  const allSecondaryIds = categories.filter((c) => c.productKind !== null).map((c) => c.categoryId)
  const rowsAndTotal: DailyOverviewRow[] = [...data.rows, { ...data.rows[0], storeId: 'TOTAL', values: data.totals }]
  for (const row of rowsAndTotal) {
    const total = cents(row.values[K.performanceTotal])
    // 视角①：4 类 + 未分类 + 充值 = 业绩合计
    expect(sumCents(row, businessKeys), `${row.storeId} 视角①`).toBe(total)
    // 视角①：4 类服务 + 未分类 = 服务合计
    expect(sumCents(row, serviceKeys), `${row.storeId} 服务`).toBe(cents(row.values[K.serviceTotal]))
    // 视角②：∑一级 + 未分类 + 充值 = 业绩合计
    expect(sumCents(row, [...allPrimaryIds.map(K.primary), K.itemUnclassified, K.recharge]), `${row.storeId} 视角②`).toBe(total)
    // 视角③：∑二级 + 未分类 + 充值 = 业绩合计
    expect(sumCents(row, [...allSecondaryIds.map(K.secondary), K.itemUnclassified, K.recharge]), `${row.storeId} 视角③`).toBe(total)
  }
  // 视角③：每个一级组内 ∑二级 = 该一级（逐店 + 表尾）
  for (const row of rowsAndTotal) {
    for (const primary of categories.filter((c) => c.productKind === null)) {
      const children = categories.filter((c) => c.productKind === primary.categoryName).map((c) => K.secondary(c.categoryId))
      expect(sumCents(row, children), `${row.storeId} ${primary.categoryName}`).toBe(cents(row.values[K.primary(primary.categoryId)]))
    }
  }
  // 表尾 = 逐店之和
  for (const key of Object.keys(data.totals)) {
    expect(data.rows.reduce((sum, row) => sum + cents(row.values[key]), 0), key).toBe(cents(data.totals[key]))
  }
}

describe('buildDailyOverview · 勾稽', () => {
  it('逐店与表尾：三视角互相勾稽，业绩合计 = 款项精确合计 + 充值', () => {
    const data = buildDailyOverview(fixture())
    assertReconciles(data)
    expect(data.totals[K.performanceTotal]).toBe(1000 + 300 - 50)
    expect(data.totals[K.serviceTotal]).toBe(243.33)
  })

  it('字面量快照：蓝莱店各格', () => {
    const row = buildDailyOverview(fixture()).rows.find((r) => r.storeId === 'st-a')!
    expect(row.values).toMatchObject({
      [K.performance('自销自耗')]: 520,
      [K.performance('他销他耗')]: 200,
      [K.performance('他销自耗')]: 150,
      [K.performance('生态合作')]: 50,
      [K.performanceUnclassified]: 80,
      [K.recharge]: 300,
      [K.performanceTotal]: 1300,
      [K.secondary('S-zhaopai')]: 400,
      [K.secondary('S-juedui')]: 200,
      [K.secondary('S-anjili')]: 150,
      [K.secondary('S-stopped-used')]: 50,
      [K.secondary('S-shenjiu')]: 30,
      [K.itemUnclassified]: 170,
      [K.primary('P-zhaopai')]: 600,
      [K.primary('P-wangpai')]: 200,
      [K.primary('P-jiaxiang')]: 30,
      [K.service('自销自耗')]: 120.5,
      [K.service('他销他耗')]: 80,
      [K.serviceUnclassified]: 9.5,
      [K.serviceTotal]: 210,
    })
  })

  it('负数原样保留，不截断为 0', () => {
    const row = buildDailyOverview(fixture()).rows.find((r) => r.storeId === 'st-b')!
    expect(row.values[K.performance('自销自耗')]).toBe(-50)
    expect(row.values[K.primary('P-jiaxiang')]).toBe(-50)
    expect(row.values[K.performanceTotal]).toBe(-50)
  })

  it('零业绩门店也出行（全 0），n 含零业绩门店', () => {
    const data = buildDailyOverview(fixture())
    const zero = data.rows.find((r) => r.storeId === 'st-z')!
    expect(zero.values[K.performanceTotal]).toBe(0)
    expect(zero.values[K.serviceTotal]).toBe(0)
    expect(computeDailyOverviewKpis(data).storeCount).toBe(3)
  })

  it('门店顺序：市场名 → 门店名（拼音）→ store_id', () => {
    expect(buildDailyOverview(fixture()).rows.map((r) => r.storeId)).toEqual(['st-a', 'st-b', 'st-z'])
  })
})

describe('buildDailyOverview · 未分类兜底（合计不丢钱）', () => {
  const base = (parts: DailyOverviewInput['performanceParts'], total: string): DailyOverviewInput => ({
    stores: [stores[1]],
    categories,
    performanceTotals: [{ storeId: 'st-a', amount: total }],
    performanceParts: parts,
    recharge: [],
    service: [],
  })

  it.each([
    ['sales_category 为空', { salesCategory: null, categoryId: 'S-anjili' }, { business: true, item: false }],
    ['SKU 挂在一级上', { salesCategory: '自销自耗', categoryId: 'P-wangpai' }, { business: false, item: true }],
    ['二级找不到所属一级', { salesCategory: '自销自耗', categoryId: 'S-orphan' }, { business: false, item: true }],
    ['sku_id 为空', { salesCategory: '自销自耗', categoryId: null }, { business: false, item: true }],
    ['款项无 receipts / 分母为 0（SQL 整笔送 null,null）', { salesCategory: null, categoryId: null }, { business: true, item: true }],
    ['sales_category 不在枚举内', { salesCategory: '自销他耗', categoryId: 'S-anjili' }, { business: true, item: false }],
  ])('%s', (_label, part, expected) => {
    const data = buildDailyOverview(base([{ storeId: 'st-a', amount: '88.8', ...part }], '88.80'))
    const row = data.rows[0]
    expect(row.values[K.performanceUnclassified]).toBe(expected.business ? 88.8 : 0)
    expect(row.values[K.itemUnclassified]).toBe(expected.item ? 88.8 : 0)
    expect(data.showUnclassified.performance).toBe(expected.business)
    expect(data.showUnclassified.item).toBe(expected.item)
    expect(row.values[K.performanceTotal]).toBe(88.8)
  })

  it('只有精确合计、没有任何拆分片段：差额整笔进未分类', () => {
    const row = buildDailyOverview(base([], '12.34')).rows[0]
    expect(row.values[K.performanceUnclassified]).toBe(12.34)
    expect(row.values[K.itemUnclassified]).toBe(12.34)
  })

  it('服务 sales_category 为空 → 服务未分类列显示', () => {
    const data = buildDailyOverview(fixture())
    expect(data.showUnclassified.service).toBe(true)
  })

  it('没有未分类数据时隐藏兜底列', () => {
    const input = base([{ storeId: 'st-a', salesCategory: '自销自耗', categoryId: 'S-anjili', amount: '10' }], '10.00')
    const data = buildDailyOverview(input)
    expect(data.showUnclassified).toEqual({ performance: false, service: false, item: false })
    const headers = buildDailyOverviewColumns('business', data).map((c) => c.header)
    expect(headers).not.toContain('未分类业绩')
    expect(headers).not.toContain('未分类服务')
  })
})

describe('尾差吸收', () => {
  it('按比例缩放的三等分：各格舍入到分，差额并入绝对值最大的一格，∑ 精确等于款项', () => {
    const third = 100 / 3
    const input: DailyOverviewInput = {
      stores: [stores[1]],
      categories,
      performanceTotals: [{ storeId: 'st-a', amount: '100.00' }],
      performanceParts: [
        { storeId: 'st-a', salesCategory: '自销自耗', categoryId: 'S-zhaopai', amount: third + 0.001 },
        { storeId: 'st-a', salesCategory: '他销他耗', categoryId: 'S-juedui', amount: third },
        { storeId: 'st-a', salesCategory: '他销自耗', categoryId: 'S-anjili', amount: third - 0.001 },
      ],
      recharge: [],
      service: [],
    }
    const row = buildDailyOverview(input).rows[0]
    expect(row.values[K.performance('自销自耗')]).toBe(33.34)
    expect(row.values[K.performance('他销他耗')]).toBe(33.33)
    expect(row.values[K.performance('他销自耗')]).toBe(33.33)
    expect(row.values[K.secondary('S-zhaopai')]).toBe(33.34)
    expect(row.values[K.performanceTotal]).toBe(100)
  })

  it('absorbRounding：并列取展示顺序靠前者；全为 0 时并入兜底格', () => {
    expect([...absorbRounding(new Map([['a', 1.004], ['b', 1.004]]), 201, ['a', 'b'], 'u')]).toEqual([['a', 101], ['b', 100]])
    expect([...absorbRounding(new Map(), 7, ['a', 'b', 'u'], 'u')]).toEqual([['a', 0], ['b', 0], ['u', 7]])
  })

  it('各格舍入后全为 0：差额并入原始值绝对值最大的格，不让不足一分的正常拆分冒成「未分类」', () => {
    const input: DailyOverviewInput = {
      stores: [stores[1]],
      categories,
      performanceTotals: [{ storeId: 'st-a', amount: '0.01' }],
      performanceParts: [
        { storeId: 'st-a', salesCategory: '自销自耗', categoryId: 'S-zhaopai', amount: 0.004 },
        { storeId: 'st-a', salesCategory: '他销他耗', categoryId: 'S-juedui', amount: 0.003 },
        { storeId: 'st-a', salesCategory: '他销自耗', categoryId: 'S-anjili', amount: 0.003 },
      ],
      recharge: [],
      service: [],
    }
    const data = buildDailyOverview(input)
    expect(data.rows[0].values[K.performance('自销自耗')]).toBe(0.01)
    expect(data.rows[0].values[K.secondary('S-zhaopai')]).toBe(0.01)
    expect(data.showUnclassified).toEqual({ performance: false, service: false, item: false })
  })

  it('正负抵消后不出现 -0（否则显示成「-0.00」）', () => {
    const input: DailyOverviewInput = {
      stores: [stores[1]],
      categories,
      performanceTotals: [{ storeId: 'st-a', amount: '10.00' }],
      performanceParts: [
        { storeId: 'st-a', salesCategory: '自销自耗', categoryId: 'S-zhaopai', amount: 10 },
        { storeId: 'st-a', salesCategory: '他销他耗', categoryId: 'S-juedui', amount: 0.3 - 0.1 - 0.2 },
      ],
      recharge: [],
      service: [],
    }
    const value = buildDailyOverview(input).rows[0].values[K.performance('他销他耗')]
    expect(Object.is(value, -0)).toBe(false)
    expect(value).toBe(0)
  })

  it('toCents 对 PG numeric 字符串精确到分', () => {
    expect(toCents('0.29')).toBe(29)
    expect(toCents('-5610.00')).toBe(-561000)
    expect(toCents('abc')).toBe(0)
  })
})

describe('品项列', () => {
  it('二级按 category_id 区分，按（一级 sort_order，二级 sort_order）排；停用无数的隐藏、停用有数与新增有效的显示', () => {
    const data = buildDailyOverview(fixture())
    expect(data.secondaryGroups.map((g) => [g.name, g.children.map((c) => c.name)])).toEqual([
      ['招牌', ['招牌', '绝对招牌']],
      ['王牌', ['安吉丽(自销)', '停用有数']],
      ['加项', ['中华神灸', '新增二级']],
    ])
    // 停用的一级期间无数 → 视角②也隐藏
    expect(data.primaries.map((p) => p.name)).toEqual(['招牌', '王牌', '加项'])
  })

  it('停用一级期间无数、但下面有显示中的二级：视角②也出这一列（与视角③的分组对齐）', () => {
    const data = buildDailyOverview({
      ...fixture(),
      categories: [
        ...categories,
        { categoryId: 'S-under-old', categoryName: '停用一级下的有效二级', productKind: '已停用一级', sortOrder: 1, isValid: true },
      ],
    })
    expect(data.secondaryGroups.map((g) => g.name)).toContain('已停用一级')
    expect(data.primaries.map((p) => p.name)).toContain('已停用一级')
  })

  it('视角③：两行合并表头，一级打组；门店 / 未分类 / 充值 / 合计纵向合并', () => {
    const data = buildDailyOverview(fixture())
    const columns = buildDailyOverviewColumns('secondary', data)
    const layout = buildMatrixHeaderLayout(columns)
    expect(layout.depth).toBe(2)
    expect(layout.rows[0].map((cell) => (cell.groupKey ? `[${columns[cell.firstLeafIndex].group!.header}×${cell.colSpan}]` : columns[cell.firstLeafIndex].header))).toEqual([
      '门店', '所属市场', '[招牌×2]', '[王牌×2]', '[加项×2]', '未分类', '充值', '品项业绩合计',
    ])
    // 冻结列合法（门店 + 所属市场左冻结）
    expect([...computeFrozenPositions(columns).keys()]).toEqual([K.store, K.market])
  })

  it('视角①列序按原型；服务列浅绿底；视角② 单行表头', () => {
    const data = buildDailyOverview(fixture())
    const business = buildDailyOverviewColumns('business', data)
    expect(business.map((c) => c.header)).toEqual([
      '门店', '所属市场',
      '自销自耗业绩', '他销他耗业绩', '他销自耗业绩', '生态合作业绩', '未分类业绩', '充值', '业绩合计',
      '自销自耗服务', '他销他耗服务', '他销自耗服务', '生态合作服务', '未分类服务', '服务合计',
    ])
    expect(business.filter((c) => c.band === 'service').map((c) => c.header)).toEqual([
      '自销自耗服务', '他销他耗服务', '他销自耗服务', '生态合作服务', '未分类服务', '服务合计',
    ])
    const primary = buildDailyOverviewColumns('primary', data)
    expect(primary.map((c) => c.header)).toEqual(['门店', '所属市场', '招牌', '王牌', '加项', '未分类', '充值', '品项业绩合计'])
    expect(buildMatrixHeaderLayout(primary).depth).toBe(1)
  })

  it('单市场范围不出「所属市场」列', () => {
    const data = buildDailyOverview({ ...fixture(), stores: stores.filter((s) => s.marketId === 'm1') })
    expect(data.multiMarket).toBe(false)
    expect(buildDailyOverviewColumns('business', data).map((c) => c.header)).not.toContain('所属市场')
  })

  it('导出列：与页面同一份列定义，带分组、合计取服务端 totals，门店列写文本', () => {
    const data = buildDailyOverview(fixture())
    const exported = toWorkerExportColumns(buildDailyOverviewColumns('secondary', data), data.totals)
    expect(exported[0].value(data.rows[0])).toBe('蓝莱店')
    expect(exported[2].group).toEqual({ key: 'P-zhaopai', header: '招牌' })
    const total = exported.find((c) => c.header === '品项业绩合计')!
    expect(total.total).toBe(1250)
  })
})

describe('指标卡', () => {
  it('☆ 占比分母 = 含充值的业绩合计；平均单店业绩按门店行数（含零业绩门店）', () => {
    const kpis = computeDailyOverviewKpis(buildDailyOverview(fixture()))
    expect(kpis.performanceTotal).toBe(1250)
    expect(kpis.selfShare).toBeCloseTo((520 - 50) / 1250, 10)
    expect(kpis.ecoShare).toBeCloseTo(50 / 1250, 10)
    expect(kpis.averagePerStore).toBeCloseTo(1250 / 3, 10)
  })

  it('负数照常计算（验收）：业绩合计为负时占比照算，只有分母为 0 才出 null；平均单店业绩照常算出负数', () => {
    const input = { ...fixture(), recharge: [], performanceTotals: [{ storeId: 'st-b', amount: '-50.00' }] }
    input.performanceParts = input.performanceParts.filter((p) => p.storeId === 'st-b')
    const kpis = computeDailyOverviewKpis(buildDailyOverview(input))
    expect(kpis.selfShare).toBe(1) // 自销自耗 −50 ÷ 合计 −50
    expect(kpis.ecoShare).toBe(0)
    expect(kpis.averagePerStore).toBeCloseTo(-50 / 3, 10)

    const zero = computeDailyOverviewKpis(buildDailyOverview({ ...fixture(), performanceParts: [], performanceTotals: [], recharge: [] }))
    expect(zero.selfShare).toBeNull()
  })
})

describe('经营类型展示顺序', () => {
  it('按原型：自销自耗 / 他销他耗 / 他销自耗 / 生态合作（与 SALES_CATEGORIES 集合相等、顺序有意不同）', () => {
    expect([...DAILY_OVERVIEW_SALES_CATEGORY_ORDER]).toEqual(['自销自耗', '他销他耗', '他销自耗', '生态合作'])
  })
})

describe('视角参数', () => {
  it('tab 参数非法回落经营类型', () => {
    expect(parseDailyOverviewTab('secondary')).toBe('secondary')
    expect(parseDailyOverviewTab('xxx')).toBe('business')
    expect(parseDailyOverviewTab(null)).toBe('business')
  })
})
