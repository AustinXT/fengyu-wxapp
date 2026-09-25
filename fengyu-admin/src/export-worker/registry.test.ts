import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/actions/data-center/sales', () => ({
  getSalesBoard: vi.fn(),
}))
vi.mock('@/actions/data-center/customer', () => ({
  getCustomerBoard: vi.fn(),
}))
vi.mock('@/actions/data-center/product', () => ({
  getProductBoard: vi.fn(),
}))
vi.mock('@/actions/data-center/efficiency', () => ({
  getEfficiencyBoard: vi.fn(),
}))
vi.mock('@/actions/data-center/operating-master', () => ({
  getOperatingMaster: vi.fn(),
}))
vi.mock('@/actions/data-center/daily-overview', () => ({
  getDailyOverview: vi.fn(),
}))
vi.mock('@/actions/refunds', () => ({
  exportRefunds: vi.fn(),
}))
vi.mock('@/actions/pickup-records', () => ({
  exportPickupRecords: vi.fn(),
}))
vi.mock('@/actions/data-center/customer-frequency', () => ({
  // 缺省返回空结果：「报表视图分发」用例会遍历全部报表视图
  exportCustomerFrequencyReport: vi.fn(async () => ({
    rows: [], totals: { visitDays: 0, amount: 0 },
    params: {
      scope: { type: 'all' }, searchLabel: '', show: 'all',
      month: '2026-08', monthLabel: '2026年8月', range: { start: '2026-08-01', end: '2026-08-31' },
    },
  })),
}))
vi.mock('@/actions/data-center/remaining-cards', () => ({
  // 缺省返回空结果：「报表视图分发」用例会遍历全部报表视图
  exportRemainingCardsReport: vi.fn(async () => ({
    columns: [], rows: [], totals: { remaining: 0 },
    params: { scope: { type: 'all' }, q: '', show: 'all' }, asOf: '2026-09-25',
  })),
}))
// 员工提成日报 / 明细（#375）：缺省返回空结果，「报表视图分发」用例会遍历全部报表视图
vi.mock('@/actions/data-center/commission', () => ({
  getCommissionDaily: vi.fn(async () => ({
    month: '2026-08', scopeName: '全部', isAllScope: true,
    options: { view: 'total', group: 'employee', merge: false, search: '', hideZero: false },
    grain: 'employee-store', sort: { key: 'total', direction: 'desc' }, rows: [],
    totals: { days: {}, total: { sale: 0, service: 0, orders: 0 }, employeeCount: 0, rowCount: 0 },
  })),
  exportCommissionDetail: vi.fn(async () => ({
    rows: [], truncated: false, hasMore: false, summary: null, scopeName: '全部', month: '2026-08',
    filters: { employeeId: null, storeId: null, date: null, source: null },
  })),
}))
// 员工导出分支会立即查 org_nodes 建路径映射（其余分支的 rows 都是惰性的，不碰 db）
vi.mock('@/db', () => ({
  db: { select: vi.fn(() => ({ from: vi.fn().mockResolvedValue([]) })) },
}))

import { getSalesBoard } from '@/actions/data-center/sales'
import { getCustomerBoard } from '@/actions/data-center/customer'
import { getProductBoard } from '@/actions/data-center/product'
import { getEfficiencyBoard } from '@/actions/data-center/efficiency'
import { getOperatingMaster } from '@/actions/data-center/operating-master'
import { exportRefunds } from '@/actions/refunds'
import { exportPickupRecords } from '@/actions/pickup-records'
import { exportRemainingCardsReport } from '@/actions/data-center/remaining-cards'
import { getDailyOverview } from '@/actions/data-center/daily-overview'
import { buildDailyOverview } from '@/lib/data-center/daily-overview'
import { exportCustomerFrequencyReport } from '@/actions/data-center/customer-frequency'
import {
  DATA_CENTER_VIEW_CONFIG,
  getDataCenterBreakdownConfig,
  getDataCenterRankingConfig,
} from '@/lib/data-center/columns'
import {
  DATA_CENTER_BOARD_EXPORT_VIEWS,
  DATA_CENTER_EXPORT_VIEWS,
  DATA_CENTER_REPORT_EXPORT_VIEWS,
  DATA_CENTER_REPORT_VIEW_PREFIX,
  type DataCenterBoardExportView,
} from '@/lib/export-job-types'
import { buildOperatingMasterTable } from '@/lib/data-center/operating-master'
import { DATA_CENTER_VIEW_REQUIRED_ACTIONS } from '@/lib/export-job-types'
import { DATA_CENTER_STAFF_COMMISSION_ACTIONS } from '@/lib/data-center/reports'
import { exportCommissionDetail, getCommissionDaily } from '@/actions/data-center/commission'
import { createExportContent } from './registry'

function metricValue(unit: 'amount' | 'count' | 'percent'): number {
  if (unit === 'percent') return 0.125
  if (unit === 'amount') return 123.456
  return 3.6
}

function headersForBreakdown(view: DataCenterBoardExportView): string[] {
  const config = getDataCenterBreakdownConfig(view)
  return [
    config.groupLabel,
    ...config.textColumns.map((column) => column.label),
    ...config.metricColumns.map((column) => column.unit === 'percent' ? `${column.label}(%)` : column.label),
  ]
}

function boardRow(view: DataCenterBoardExportView) {
  const config = DATA_CENTER_VIEW_CONFIG[view]
  if (config.kind !== 'breakdown') throw new Error(`预期明细视图: ${view}`)
  return {
    groupId: 'group-1',
    groupName: '测试分组',
    marketName: '测试市场',
    labels: { store: '测试门店', position: '测试职级' },
    metrics: Object.fromEntries(config.metricColumns.map((column) => [column.key, metricValue(column.unit)])),
  }
}

const rankingRow = {
  rank: 1,
  id: 'rank-1',
  name: '测试对象',
  marketName: '测试市场',
  value: 123.456,
}

beforeEach(() => {
  vi.clearAllMocks()
  const sales = boardRow('sales-market')
  const customer = boardRow('customer-market-reg')
  const product = boardRow('product-market')
  const efficiency = boardRow('efficiency-market')
  const staff = boardRow('efficiency-staff')
  const storeRankingMetrics = getDataCenterRankingConfig('efficiency-store-ranking').metrics
  const staffRankingMetrics = getDataCenterRankingConfig('efficiency-staff-ranking').metrics

  vi.mocked(getSalesBoard).mockResolvedValue({ byMarket: [sales], byStore: [sales] } as never)
  vi.mocked(getCustomerBoard).mockResolvedValue({ byMarket: [customer], byStore: [customer] } as never)
  vi.mocked(getProductBoard).mockResolvedValue({ byMarket: [product], byStore: [product] } as never)
  vi.mocked(getEfficiencyBoard).mockResolvedValue({
    byMarket: [efficiency],
    byStaff: [staff],
    storeRankings: Object.fromEntries(storeRankingMetrics.map((metric) => [metric.key, [rankingRow]])),
    staffRankings: Object.fromEntries(staffRankingMetrics.map((metric) => [metric.key, [rankingRow]])),
  } as never)
})

describe('服务单导出列', () => {
  it('消耗数量仅输出数值，不拼接单位', async () => {
    const content = await createExportContent('services', {})
    const column = content.columns.find((item) => item.header === '消耗数量')

    expect(column?.value({ sessionUsed: 2, unit: '次' })).toBe(2)
    expect(column?.value({ sessionUsed: '3.5', unit: '疗程' })).toBe(3.5)
    expect(column?.value({ sessionUsed: null, unit: '次' })).toBe('')
  })
})

describe('顾客/员工导出日期列', () => {
  it('顾客新增两列追加在「生日」之后，表头是「建档日期」而非「注册日期」', async () => {
    const content = await createExportContent('customers', {})
    const headers = content.columns.map((column) => column.header)

    expect(headers.slice(-3)).toEqual(['生日', '建档日期', '成为会员日期'])
    // 「注册」在 data-center 专指 became_member_at（会员注册），顾客导出不得再占用这个词
    expect(headers).not.toContain('注册日期')
  })

  it('顾客两列对 action 侧已格式化的串幂等，对 Date 也能兜住，空值输出空串', async () => {
    const content = await createExportContent('customers', {})
    const createdAt = content.columns.find((column) => column.header === '建档日期')
    const becameMemberAt = content.columns.find((column) => column.header === '成为会员日期')

    // action 已 fmtDate → 列侧 fmtDate 幂等（无 T 直接 slice），不会二次偏移
    expect(createdAt?.value({ createdAt: '2026-01-15' })).toBe('2026-01-15')
    expect(becameMemberAt?.value({ becameMemberAt: '2026-03-02' })).toBe('2026-03-02')
    // 双保险：万一上游改成透传 Date（或 schema 改 mode:'string'），列侧仍还原北京日期，
    // 而不是把 "Wed Jan 14 2026 ... GMT+0000" 整串写进单元格
    expect(createdAt?.value({ createdAt: new Date('2026-01-14T17:30:00.000Z') })).toBe('2026-01-15')
    expect(createdAt?.value({ createdAt: null })).toBe('')
    expect(becameMemberAt?.value({ becameMemberAt: null })).toBe('')
  })

  it('员工「入职日期」插在「职位」之后，走列侧 fmtDate，空值输出空串', async () => {
    const content = await createExportContent('employees', {})
    const headers = content.columns.map((column) => column.header)

    // 先钉住锚点列存在，否则 indexOf 返回 -1 时 slice 会给出 [] 这种看不出真因的失败信息
    expect(headers).toContain('职位')
    expect(headers.slice(headers.indexOf('职位'), headers.indexOf('职位') + 3)).toEqual(['职位', '入职日期', '生日'])

    const hiredAt = content.columns.find((column) => column.header === '入职日期')
    // hired_at 是 drizzle date() 列 → string 模式，fmtDate 走 slice 分支不做时区换算
    expect(hiredAt?.value({ hiredAt: '2024-03-01' })).toBe('2024-03-01')
    expect(hiredAt?.value({ hiredAt: null })).toBe('')
  })
})

describe('退款导出', () => {
  it('透传筛选条件并输出业务状态与负数退款金额', async () => {
    vi.mocked(exportRefunds).mockResolvedValue({
      rows: [{
        refundPaymentId: 211783,
        refSaleOrderId: 'FY-XSD-WX-2608040106',
        amount: '-500.00',
        status: '已支付',
        paymentMethod: '微信',
      }],
      truncated: false,
      hasMore: false,
    } as never)

    const content = await createExportContent('refunds', { status: '已支付', q: '冯桂仙' })
    const iterator = content.rows[Symbol.asyncIterator]()
    const first = await iterator.next()
    const columns = Object.fromEntries(content.columns.map((column) => [column.header, column]))

    expect(exportRefunds).toHaveBeenCalledWith(
      { status: '已支付', q: '冯桂仙' },
      { limit: 500 },
    )
    expect(content.sheetName).toBe('退款明细')
    expect(columns['退款单号']?.value(first.value!)).toBe('#211783')
    expect(columns['退款金额']?.value(first.value!)).toBe(-500)
    expect(columns['状态']?.value(first.value!)).toBe('已通过')
    expect(columns['退款方式']?.value(first.value!)).toBe('微信支付')
  })
})

describe('提货记录导出（#341）', () => {
  it('透传筛选条件；列齐全且顺序固定；金额输出数值，历史行（未冻结）留空而不是 0', async () => {
    vi.mocked(exportPickupRecords).mockResolvedValue({
      rows: [
        {
          createdAt: '2026-09-25T02:03:04.000Z', storeName: '一店', clientName: '顾客A',
          saleOrderId: 'FY-XSD-WX-2609250001', productName: '家居A', pickupQuantity: 2,
          pickupUnitPrice: '88.50', pickupAmount: '177.00',
        },
        {
          createdAt: '2026-08-01T02:03:04.000Z', storeName: '一店', clientName: '顾客B',
          saleOrderId: 'FY-XSD-WX-2608010001', productName: '家居B', pickupQuantity: 1,
          pickupUnitPrice: null, pickupAmount: null,
        },
      ],
      truncated: false,
      hasMore: false,
    } as never)

    const content = await createExportContent('pickup-records', { store: 'store-1', from: '2026-09-01', to: '2026-09-30' })
    const iterator = content.rows[Symbol.asyncIterator]()
    const frozen = (await iterator.next()).value!
    const legacy = (await iterator.next()).value!
    const columns = Object.fromEntries(content.columns.map((column) => [column.header, column]))

    expect(exportPickupRecords).toHaveBeenCalledWith(
      { store: 'store-1', from: '2026-09-01', to: '2026-09-30' },
      { limit: 500 },
    )
    expect(content.sheetName).toBe('提货记录')
    expect(content.columns.map((column) => column.header)).toEqual([
      '提货时间', '门店', '顾客', '销售单号', '商品', '数量', '顾客实际单价', '出库金额',
    ])
    expect(columns['数量']?.value(frozen)).toBe(2)
    expect(columns['顾客实际单价']?.value(frozen)).toBe(88.5)
    expect(columns['出库金额']?.value(frozen)).toBe(177)
    expect(columns['顾客实际单价']?.value(legacy)).toBe('')
    expect(columns['出库金额']?.value(legacy)).toBe('')
    expect(columns['销售单号']?.value(frozen)).toBe('FY-XSD-WX-2609250001')
  })
})

describe('疗程卡导出列', () => {
  it('剩余、已付、总量与剩余零头均独立输出数值', async () => {
    const content = await createExportContent('cards', {})
    const remaining = content.columns.find((item) => item.header === '剩余')
    const paid = content.columns.find((item) => item.header === '已付')
    const total = content.columns.find((item) => item.header === '总量')
    const remainder = content.columns.find((item) => item.header === '剩余零头')

    expect(remaining?.value({ remaining: 2, unit: '次' })).toBe(2)
    expect(paid?.value({ paidSessions: 3, unit: '次' })).toBe(3)
    expect(total?.value({ totalSessions: 5, unit: '次' })).toBe(5)
    expect(remainder?.value({ remainingRemainder: 214, unit: '次' })).toBe(214)
    expect(remaining?.value({ remaining: null, unit: '疗程' })).toBe('')
  })
})

describe('商城商品导出列', () => {
  it('输出商城分类、商品类型、价格和展示状态', async () => {
    const content = await createExportContent('mall-products', {})
    const columns = Object.fromEntries(content.columns.map((column) => [column.header, column]))
    const row = {
      categoryGroup: '居家护理',
      categoryName: '面膜',
      isBundle: true,
      price: '299.00',
      specialPrice: null,
      isVisible: false,
      skuCount: 3,
    }

    expect(content.sheetName).toBe('商城商品')
    expect(columns['商城分类']?.value(row)).toBe('居家护理 / 面膜')
    expect(columns['商品类型']?.value(row)).toBe('套餐')
    expect(columns['标价']?.value(row)).toBe(299)
    expect(columns['会员价']?.value(row)).toBe('')
    expect(columns['展示状态']?.value(row)).toBe('未展示')
    expect(columns['规格数']?.value(row)).toBe(3)
  })
})

describe('数据中心客量门店导出列', () => {
  const board = {
    kpis: {},
    byMarket: [],
    byStore: [{
      groupName: '测试门店',
      marketName: '测试市场',
      metrics: {
        registered: 12,
        bucketD: 1,
        convRate: 0.125,
        consumePerVisit: 367.05,
      },
    }],
    scope: { type: 'all', id: null, name: '全部' },
    timeRange: { start: '2026-08-01', end: '2026-08-31', presetLabel: '本月' },
  }

  it('门店消费经营导出完整指标列及原始数值', async () => {
    vi.mocked(getCustomerBoard).mockResolvedValue(board as never)

    const content = await createExportContent('data-center', {
      view: 'customer-store-ops',
      params: {},
    })
    const columns = Object.fromEntries(content.columns.map((column) => [column.header, column]))

    expect(content.columns.map((column) => column.header)).toEqual([
      '门店', '所属市场', '<1990', '≥1990', '≥1万', '≥3万', '≥6万', '≥10万',
      // #284：「流量客」→「成交率分母」。新口径恰恰不含 customer_type='流量客'，
      // 且与同表「流量人次」不同口径（见 columns.ts:85 注释）
      '被经营总数', '会员新增', '成交率分母', '成交率(%)', '会员客单', '新客客单',
      '流量人次', '会员人次', '项目数', '单次客耗',
    ])
    expect(columns['<1990']?.value(board.byStore[0])).toBe(1)
    expect(columns['成交率(%)']?.value(board.byStore[0])).toBe(12.5)
    expect(columns['单次客耗']?.value(board.byStore[0])).toBe(367.05)
  })

  it('门店注册客活导出完整指标列', async () => {
    vi.mocked(getCustomerBoard).mockResolvedValue(board as never)

    const content = await createExportContent('data-center', {
      view: 'customer-store-reg',
      params: {},
    })

    expect(content.columns.map((column) => column.header)).toEqual([
      '门店', '所属市场', '会员注册', '保有会员', '回店1次', '1次达成率(%)',
      // #294：三档状态人数是 customer_status 截面快照，与紧邻的「激活 X」区间统计不同时态，
      // 表头带 (截面) 角标；改动此处必须同步 columns.ts 的 customerRegistrationMetricColumns
      '回店2次', '2次达成率(%)', '沉睡(截面·仅会员客)', '激活沉睡', '冰冻(截面)', '激活冰冻',
      '休眠(截面)', '激活休眠',
    ])
    expect(content.columns.find((column) => column.header === '会员注册')?.value(board.byStore[0])).toBe(12)
  })

  // #294：市场维度此前只被 `it.each(breakdownViews)` 那条通用测试覆盖，而它的 expected
  // 是用 headersForBreakdown() 从**被测对象** columns.ts 现读的 —— 重言式，label 打错字也照样绿。
  // market 与 store 共享同一个 customerRegistrationMetricColumns 数组引用，
  // 于是市场维度的「正确」一直是蒙对的、没有守护。这里补一条硬编码字面量断言钉死。
  it('市场注册客活导出表头与门店维度一致（字面量钉死，防重言式漏检）', async () => {
    vi.mocked(getCustomerBoard).mockResolvedValue(board as never)

    const content = await createExportContent('data-center', {
      view: 'customer-market-reg',
      params: {},
    })

    expect(content.columns.map((column) => column.header)).toEqual([
      '市场', '会员注册', '保有会员', '回店1次', '1次达成率(%)',
      '回店2次', '2次达成率(%)', '沉睡(截面·仅会员客)', '激活沉睡', '冰冻(截面)', '激活冰冻',
      '休眠(截面)', '激活休眠',
    ])
  })
})

describe('数据中心全部导出视图', () => {
  const breakdownViews = DATA_CENTER_BOARD_EXPORT_VIEWS.filter(
    (view) => DATA_CENTER_VIEW_CONFIG[view].kind === 'breakdown',
  )

  it.each(breakdownViews)('%s 完整输出配置中的维度列与指标列', async (view) => {
    const config = getDataCenterBreakdownConfig(view)
    const content = await createExportContent('data-center', { view, params: {} })
    const row = boardRow(view)

    expect(content.columns.map((column) => column.header)).toEqual(headersForBreakdown(view))
    for (const metric of config.metricColumns) {
      const column = content.columns.find(
        (item) => item.header === (metric.unit === 'percent' ? `${metric.label}(%)` : metric.label),
      )
      const expected = metric.unit === 'percent' ? 12.5 : metric.unit === 'amount' ? 123.46 : 4
      expect(column?.value(row)).toBe(expected)
    }
  })

  const rankingViews = DATA_CENTER_BOARD_EXPORT_VIEWS.filter(
    (view) => DATA_CENTER_VIEW_CONFIG[view].kind === 'ranking',
  )

  it.each(rankingViews)('%s 的每个排名指标均可导出', async (view) => {
    const config = getDataCenterRankingConfig(view)
    for (const metric of config.metrics) {
      const content = await createExportContent('data-center', {
        view,
        params: {},
        metric: metric.key,
      })

      expect(content.columns.map((column) => column.header)).toEqual([
        '排名', '名称', '所属市场', metric.unit === 'percent' ? `${metric.label}(%)` : metric.label,
      ])
      expect(content.columns[3]?.value(rankingRow)).toBe(metric.unit === 'amount' ? 123.46 : 123)
    }
  })
})

/**
 * 报表视图分发守护（#372）。queryDataCenter 对旧板块按视图名前缀分发，且历史上把「其余一切」兜底派给人效板：
 * 新视图撞前缀或漏登记分发时会静默导出别的板块的内容、任务照样成功。这里从两头钉住：
 *   1. 命名：报表视图一律 `report-` 前缀，且不以任何板块前缀开头
 *   2. 行为：每个报表视图导出时一个板块取数函数都不调用
 */
describe('数据中心导出 · 报表视图分发', () => {
  const BOARD_PREFIXES = Array.from(new Set(DATA_CENTER_BOARD_EXPORT_VIEWS.map((view) => view.split('-')[0] + '-')))

  it('报表视图名一律 report- 前缀，不撞任何板块前缀；板块视图也不占用 report- 前缀', () => {
    expect(BOARD_PREFIXES).toEqual(['sales-', 'customer-', 'product-', 'efficiency-'])
    for (const view of DATA_CENTER_REPORT_EXPORT_VIEWS) {
      expect(view.startsWith(DATA_CENTER_REPORT_VIEW_PREFIX), view).toBe(true)
      for (const prefix of BOARD_PREFIXES) expect(view.startsWith(prefix), `${view} 撞前缀 ${prefix}`).toBe(false)
    }
    for (const view of DATA_CENTER_BOARD_EXPORT_VIEWS) {
      expect(view.startsWith(DATA_CENTER_REPORT_VIEW_PREFIX), view).toBe(false)
    }
    expect(DATA_CENTER_EXPORT_VIEWS).toEqual([...DATA_CENTER_BOARD_EXPORT_VIEWS, ...DATA_CENTER_REPORT_EXPORT_VIEWS])
    // 等式两边同源拼接，重复登记照样相等：单独钉住「没有重复视图」
    expect(new Set(DATA_CENTER_EXPORT_VIEWS).size).toBe(DATA_CENTER_EXPORT_VIEWS.length)
  })

  it.each(DATA_CENTER_REPORT_EXPORT_VIEWS)('%s 导出不调用任何板块取数', async (view) => {
    vi.mocked(getOperatingMaster).mockResolvedValue({
      month: '2026-08',
      range: { start: '2026-08-01', end: '2026-08-31' },
      ytd: { start: '2026-01-01', end: '2026-08-31' },
      scopeName: '全部',
      ...buildOperatingMasterTable([], new Map()),
    } as never)
    vi.mocked(getDailyOverview).mockResolvedValue({
      data: buildDailyOverview({ stores: [], categories: [], performanceParts: [], performanceTotals: [], recharge: [], service: [] }),
      kpis: {} as never,
      storeCount: 0,
      period: { label: '上月', current: { start: '2026-08-01', end: '2026-08-31' }, previous: { start: '2026-07-01', end: '2026-07-31' } },
      scope: { type: 'all', name: '全部' },
    })
    vi.mocked(getSalesBoard).mockClear()
    vi.mocked(getCustomerBoard).mockClear()
    vi.mocked(getProductBoard).mockClear()
    vi.mocked(getEfficiencyBoard).mockClear()

    await createExportContent('data-center', { view, params: { month: '2026-08' } })

    for (const fetcher of [getSalesBoard, getCustomerBoard, getProductBoard, getEfficiencyBoard]) {
      expect(fetcher).not.toHaveBeenCalled()
    }
  })

  it('未登记的视图名抛错，不再兜底派给人效板', async () => {
    vi.mocked(getEfficiencyBoard).mockClear()
    await expect(
      createExportContent('data-center', { view: 'daily-overview' as never, params: {} }),
    ).rejects.toThrow('INVALID_PARAMS')
    expect(getEfficiencyBoard).not.toHaveBeenCalled()
  })
})

describe('数据中心导出 · 员工提成日报 / 提成明细（#375）', () => {
  it.each([
    ['report-commission-daily', getCommissionDaily],
    ['report-commission-detail', exportCommissionDetail],
  ] as const)('%s 走提成取数 action，URL 参数原样透传；权限 = dashboard + staff_commission', async (view, action) => {
    vi.mocked(action).mockClear()
    const params = { month: '2026-08', scope: 'market', scopeId: 'M1', view: 'split' }
    await createExportContent('data-center', { view, params })
    expect(action).toHaveBeenCalledWith(params, ...(view === 'report-commission-detail' ? [{ limit: expect.any(Number) }] : []))
    expect(DATA_CENTER_VIEW_REQUIRED_ACTIONS[view]).toBe(DATA_CENTER_STAFF_COMMISSION_ACTIONS)
  })
})

describe('数据中心导出 · 经营数据主表', () => {
  const stores = [
    { storeId: 'S1', storeName: '汇东店', marketId: 'M1', marketName: '自贡' },
    { storeId: 'S2', storeName: '南湖店', marketId: 'M1', marketName: '自贡' },
    { storeId: 'S3', storeName: '蓝莱店', marketId: 'M2', marketName: '南昌凤御' },
  ]
  const metrics = new Map([
    ['S1', { beauticianCount: 4, monthRevenue: 91182, ytdRevenue: 156152, shengmeiProjectCount: 298, monthConsume: 100.5, shengmeiConsume: 60.25,
      retainedMembers: 100, returnOnceHeads: 80, managedYearCustomers: 30 }],
    ['S2', { beauticianCount: 3, monthRevenue: 1000, ytdRevenue: 2000, shengmeiProjectCount: 2, monthConsume: 10, shengmeiConsume: 5,
      retainedMembers: 60, returnOnceHeads: 12, managedYearCustomers: 10 }],
    ['S3', { beauticianCount: 5, monthRevenue: -20, ytdRevenue: 30, shengmeiProjectCount: 0, monthConsume: 0, shengmeiConsume: 0 }],
  ])

  beforeEach(() => {
    vi.mocked(getOperatingMaster).mockResolvedValue({
      month: '2026-08',
      range: { start: '2026-08-01', end: '2026-08-31' },
      ytd: { start: '2026-01-01', end: '2026-08-31' },
      asOf: '2026-08-31',
      scopeName: '全部',
      ...buildOperatingMasterTable(stores, metrics),
    } as never)
  })

  it('按页面生效的范围与月份取数；缺月份直接失败，不按默认月出数', async () => {
    await createExportContent('data-center', {
      view: 'report-operating-master',
      params: { scope: 'market', scopeId: 'M1', month: '2026-08' },
    })
    expect(getOperatingMaster).toHaveBeenLastCalledWith({ scope: { type: 'market', id: 'M1' }, month: '2026-08' })

    await expect(
      createExportContent('data-center', { view: 'report-operating-master', params: {} }),
    ).rejects.toThrow('INVALID_PARAMS')
  })

  it('范围参数 fail-closed：声明了市场 / 门店却缺 scopeId、未知 scope 都拒绝，不回落成全集团', async () => {
    vi.mocked(getOperatingMaster).mockClear()
    const cases: Record<string, string>[] = [
      { month: '2026-08', scope: 'market' },
      { month: '2026-08', scope: 'store', scopeId: '' },
      { month: '2026-08', scope: 'everything' },
      { month: '2026-08', scopeId: 'M1' },
      { month: '2026-08', scope: 'authorized', scopeId: 'M1' },
    ]
    for (const params of cases) {
      await expect(
        createExportContent('data-center', { view: 'report-operating-master', params }),
        JSON.stringify(params),
      ).rejects.toThrow('INVALID_PARAMS')
    }
    expect(getOperatingMaster).not.toHaveBeenCalled()
  })

  it('元信息的范围带类型：市场 · 名称', async () => {
    const content = await createExportContent('data-center', {
      view: 'report-operating-master',
      params: { scope: 'market', scopeId: 'M1', month: '2026-08' },
    })
    expect(content.meta?.scope).toBe('市场 · 全部')
  })

  it('两行分组表头 + 冻结市场门店 + 小计加粗 + 总计行，占位列数据与合计都写「—」', async () => {
    const content = await createExportContent('data-center', {
      view: 'report-operating-master',
      params: { month: '2026-08' },
    })
    const rows: Record<string, unknown>[] = []
    for await (const row of content.rows) rows.push(row)

    expect(content.columns).toHaveLength(24) // B~Y
    expect(content.columns[0]).toMatchObject({ header: '市场', group: { header: '' } })
    // B–D 上方空白表头在导出里是同一个分组 → 合并成一整块（模板 B2:D2）；页面因冻结边界才拆开
    expect(new Set(content.columns.slice(0, 3).map((column) => column.group?.key)).size).toBe(1)
    expect(content.columns[3].group?.key).not.toBe(content.columns[0].group?.key)
    expect(content.columns[3].group?.header).toMatch(/^保有会员（售前不算）\n会员标准/)
    expect(content.frozenColumns).toBe(2)
    expect(content.totalsLabel).toBe('总计')
    expect(content.meta).toMatchObject({ period: '2026-08-01 ~ 2026-08-31', scope: '全部' })

    // 门店 2 + 小计 + 门店 1 + 小计
    expect(rows.map((row) => content.isEmphasisRow?.(row))).toEqual([false, false, true, false, true])
    const header = (name: string) => content.columns.find((column) => column.header === name)!
    const revenue = header('当月\n完成')
    expect(rows.map((row) => revenue.value(row))).toEqual([91182, 1000, 92182, -20, -20])
    expect(revenue.total).toBe(92162)
    expect(header('美容师\n人数').total).toBe(12)

    // 比率列：导出写百分数，小计 / 总计用合计后的分子分母重算（(80 + 12) / (100 + 60) = 57.5%）
    const managedRate = header('被经营率\n年度标准60%(%)')
    expect(rows.map((row) => managedRate.value(row))).toEqual([30, 16.67, 25, '', ''])
    expect(managedRate.total).toBe(25)
    const returnOnceRate = header('回店1次\n达成率(%)')
    expect(returnOnceRate.total).toBe(57.5)
    expect(header('保有会员\n近90天到店人头').total).toBe(160)

    const pending = header('被经营顾客\n年度目标')
    expect(rows.map((row) => pending.value(row))).toEqual(['—', '—', '—', '—', '—'])
    expect(pending.total).toBe('—')
    expect(header('年度销售\n业绩目标').total).toBe('—')
    expect(content.meta?.extra).toEqual(expect.arrayContaining([
      { label: '统计时点', value: '2026-08-31（保有会员截至这一天近 90 天到店）' },
    ]))
  })
})

describe('数据中心导出 · 顾客剩余卡项清单（#371）', () => {
  it('report-remaining-cards 走报表取数，不触碰任何旧板块取数函数；URL 参数原样透传', async () => {
    vi.clearAllMocks()
    vi.mocked(exportRemainingCardsReport).mockResolvedValue({
      columns: [{ categoryId: 'C1', categoryName: '招牌', kind: '招牌', kindSort: 1, sort: 1 }],
      rows: [{
        key: 'U1:S1', clientUserId: 'U1', storeId: 'S1', storeName: '蓝莱店', customerName: '张三',
        phoneMasked: '138****2222', level: '会员客', remaining: 3,
        cells: { C1: { state: 'remaining', remaining: 3, unpaid: 0, served: 1, convertedOut: 0, deposit: true, frozen: false } },
      }],
      totals: { remaining: 3, 'cat:C1': 3 },
      params: { scope: { type: 'all' }, q: '', show: 'all' },
      asOf: '2026-09-25',
    })
    const params = { q: '张', show: 'remaining', tab: 'x' }
    const content = await createExportContent('data-center', { view: 'report-remaining-cards', params })

    expect(exportRemainingCardsReport).toHaveBeenCalledWith(params)
    for (const board of [getSalesBoard, getCustomerBoard, getProductBoard, getEfficiencyBoard]) {
      expect(board).not.toHaveBeenCalled()
    }
    expect(content.columns.map((column) => column.header)).toEqual(['门店', '顾客', '会员等级', '招牌', '剩余次数'])
    expect(content.columns.map((column) => column.total ?? null)).toEqual([null, null, null, 3, 3])
    expect(content.frozenColumns).toBe(3)
    expect(content.totalsLabel).toBe('合计')
    expect(content.meta).toMatchObject({ period: null, scope: '全部' })
    const rows: Record<string, unknown>[] = []
    for await (const row of content.rows) rows.push(row)
    expect(content.columns.map((column) => column.value(rows[0]))).toEqual(['蓝莱店', '张三 138****2222', '会员客', 3, 3])
  })
})

describe('日常数据一览表导出（#369）', () => {
  const data = buildDailyOverview({
    stores: [
      { storeId: 'S1', storeName: '蓝莱店', marketId: 'M1', marketName: '南昌凤御' },
      { storeId: 'S2', storeName: '自贡一店', marketId: 'M2', marketName: '自贡凤御' },
    ],
    categories: [
      { categoryId: 'P1', categoryName: '招牌', productKind: null, sortOrder: 1, isValid: true },
      { categoryId: 'C1', categoryName: '绝对招牌', productKind: '招牌', sortOrder: 1, isValid: true },
    ],
    performanceTotals: [{ storeId: 'S1', amount: '100.00' }],
    performanceParts: [{ storeId: 'S1', salesCategory: '自销自耗', categoryId: 'C1', amount: '100' }],
    recharge: [{ storeId: 'S2', amount: '20.00' }],
    service: [{ storeId: 'S1', salesCategory: '他销他耗', amount: '30.00' }],
  })

  beforeEach(() => {
    vi.mocked(getDailyOverview).mockResolvedValue({
      data,
      kpis: {} as never,
      storeCount: 2,
      period: {
        label: '上月（2026年8月）',
        current: { start: '2026-08-01', end: '2026-08-31' },
        previous: { start: '2026-07-01', end: '2026-07-31' },
      },
      scope: { type: 'market', name: '南昌凤御' },
    })
  })

  it('派给一览表取数函数（不是板块），参数原样透传', async () => {
    const params = { scope: 'market', scopeId: 'M1', period: 'lastMonth', tab: 'secondary' }
    await createExportContent('data-center', { view: 'report-daily-overview', params })
    expect(getDailyOverview).toHaveBeenCalledWith(params)
    expect(getSalesBoard).not.toHaveBeenCalled()
  })

  it('☆ 只导当前页签：视角③带两行合并表头的分组，合计行取服务端 totals，元信息写明期间 / 范围 / 视角', async () => {
    const content = await createExportContent('data-center', { view: 'report-daily-overview', params: { tab: 'secondary' } })
    expect(content.sheetName).toBe('二级品项汇总')
    expect(content.columns.map((column) => column.header)).toEqual(['门店', '所属市场', '绝对招牌', '充值', '品项业绩合计'])
    expect(content.columns[2].group).toEqual({ key: 'P1', header: '招牌' })
    expect(content.columns.map((column) => column.total)).toEqual([undefined, undefined, 100, 20, 120])
    expect(content.frozenColumns).toBe(2)
    expect(content.totalsLabel).toBe('合计')
    expect(content.meta).toEqual({
      period: '2026-08-01 ~ 2026-08-31',
      scope: '市场 · 南昌凤御',
      extra: [{ label: '视角', value: '二级品项汇总' }],
    })
  })

  it('缺省 / 非法 tab 导出经营类型视角', async () => {
    const content = await createExportContent('data-center', { view: 'report-daily-overview', params: { tab: 'bogus' } })
    expect(content.sheetName).toBe('经营类型汇总')
    expect(content.columns.map((column) => column.header)).toContain('业绩合计')
    expect(content.columns.map((column) => column.header)).toContain('服务合计')
  })
})

describe('数据中心导出 · 顾客频率表', () => {
  it('report-customer-frequency 走报表取数，不触碰任何旧板块取数函数；日期格拆「到店 / 金额」两列', async () => {
    vi.clearAllMocks()
    const day = (visited: boolean, amount: number | null) => ({ visited, amount, consume: null, items: [], stores: [] })
    vi.mocked(exportCustomerFrequencyReport).mockResolvedValue({
      rows: [{
        clientUserId: 'U1', customerName: '张三', phoneMasked: '138****2222', level: '金卡', storeName: '蓝莱店',
        // 1 日：到店有消费；2 日：到店消费为 0；3 日：只有退款（没到店）
        days: { 1: day(true, 120), 2: day(true, 0), 3: day(false, -50) },
        visitDays: 2, amount: 70, consume: 0,
      }],
      totals: { visitDays: 2, amount: 70 },
      params: {
        scope: { type: 'all' }, searchLabel: '138****5678', show: 'visited',
        month: '2026-02', monthLabel: '2026年2月', range: { start: '2026-02-01', end: '2026-02-28' },
      },
    })
    const params = { month: '2026-02', show: 'visited', sort: 'amount' }
    const content = await createExportContent('data-center', { view: 'report-customer-frequency', params })

    expect(exportCustomerFrequencyReport).toHaveBeenCalledWith(params)
    for (const board of [getSalesBoard, getCustomerBoard, getProductBoard, getEfficiencyBoard]) {
      expect(board).not.toHaveBeenCalled()
    }
    const headers = content.columns.map((column) => column.header)
    // 4 列顾客信息 + 28 天 × 2 + 2 列汇总；2 月横轴 28 天
    expect(headers).toHaveLength(4 + 28 * 2 + 2)
    expect(headers.slice(0, 6)).toEqual(['姓名', '电话', '会员等级', '所属门店', '到店', '金额'])
    expect(headers.slice(-2)).toEqual(['到店次数', '消费合计'])
    expect(content.columns[4].group).toEqual({ key: 'day-1', header: '1日' })
    expect(content.columns.at(-1)?.total).toBe(70)
    expect(content.columns.at(-2)?.total).toBe(2)
    expect(content.frozenColumns).toBe(4)
    expect(content.totalsLabel).toBe('合计')
    expect(content.meta).toMatchObject({ period: '2026-02-01 ~ 2026-02-28（2026年2月）', scope: '全部' })
    // 按完整手机号搜索后导出：导出说明里的搜索词是 action 给出的脱敏值
    expect(content.meta?.extra).toContainEqual({ label: '顾客搜索', value: '138****5678' })
    expect(JSON.stringify(content.meta)).not.toMatch(/1\d{10}/)
    const rows: Record<string, unknown>[] = []
    for await (const row of content.rows) rows.push(row)
    const values = content.columns.map((column) => column.value(rows[0]))
    expect(values.slice(0, 4)).toEqual(['张三', '138****2222', '金卡', '蓝莱店'])
    // 到店有金额：✓ + 数值；到店金额为 0：保留 ✓、金额空；没到店只有退款：到店空、金额负数
    expect(values.slice(4, 10)).toEqual(['✓', 120, '✓', '', '', -50])
    expect(values.slice(10, 12)).toEqual(['', ''])
    expect(values.slice(-2)).toEqual([2, 70])
    expect(JSON.stringify(values)).not.toMatch(/1\d{10}/)
  })

  it('缺统计月份 / 格式非法 / 未来月份都直接失败，不按执行当天的默认月出数', async () => {
    vi.mocked(exportCustomerFrequencyReport).mockClear()
    for (const params of [{}, { month: '2026-13' }, { month: '2026/08' }, { month: '2099-01' }] as Record<string, string>[]) {
      await expect(
        createExportContent('data-center', { view: 'report-customer-frequency', params }),
        JSON.stringify(params),
      ).rejects.toThrow('INVALID_PARAMS')
    }
    expect(exportCustomerFrequencyReport).not.toHaveBeenCalled()
  })
})
