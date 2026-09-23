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
vi.mock('@/actions/refunds', () => ({
  exportRefunds: vi.fn(),
}))
// 员工导出分支会立即查 org_nodes 建路径映射（其余分支的 rows 都是惰性的，不碰 db）
vi.mock('@/db', () => ({
  db: { select: vi.fn(() => ({ from: vi.fn().mockResolvedValue([]) })) },
}))

import { getSalesBoard } from '@/actions/data-center/sales'
import { getCustomerBoard } from '@/actions/data-center/customer'
import { getProductBoard } from '@/actions/data-center/product'
import { getEfficiencyBoard } from '@/actions/data-center/efficiency'
import { exportRefunds } from '@/actions/refunds'
import {
  DATA_CENTER_VIEW_CONFIG,
  getDataCenterBreakdownConfig,
  getDataCenterRankingConfig,
} from '@/lib/data-center/columns'
import { DATA_CENTER_EXPORT_VIEWS } from '@/lib/export-job-types'
import { createExportContent } from './registry'

function metricValue(unit: 'amount' | 'count' | 'percent'): number {
  if (unit === 'percent') return 0.125
  if (unit === 'amount') return 123.456
  return 3.6
}

function headersForBreakdown(view: (typeof DATA_CENTER_EXPORT_VIEWS)[number]): string[] {
  const config = getDataCenterBreakdownConfig(view)
  return [
    config.groupLabel,
    ...config.textColumns.map((column) => column.label),
    ...config.metricColumns.map((column) => column.unit === 'percent' ? `${column.label}(%)` : column.label),
  ]
}

function boardRow(view: (typeof DATA_CENTER_EXPORT_VIEWS)[number]) {
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
  const breakdownViews = DATA_CENTER_EXPORT_VIEWS.filter(
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

  const rankingViews = DATA_CENTER_EXPORT_VIEWS.filter(
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
