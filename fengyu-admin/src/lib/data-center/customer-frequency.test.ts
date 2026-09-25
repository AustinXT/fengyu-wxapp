import { describe, expect, it } from 'vitest'
import type { CustomerFrequencySourceRow } from './customer-frequency-query'
import {
  CUSTOMER_FREQUENCY_TIERS,
  buildCustomerFrequencyRows,
  displaySearchTerm,
  filterCustomerFrequencyRows,
  normalizePhone,
  customerFrequencyColumnSpecs,
  frequencyCellHint,
  frequencyExportColumnSpecs,
  parseCustomerFrequencyParams,
  sortCustomerFrequencyRows,
  summarizeCustomerFrequency,
  tierOf,
} from './customer-frequency'

function src(clientUserId: string, day: string | null, patch: Partial<CustomerFrequencySourceRow> = {}): CustomerFrequencySourceRow {
  return {
    clientUserId,
    customerName: `顾客${clientUserId}`,
    phone: '13812345678',
    memberLevel: null,
    customerType: '流量客',
    storeName: '蓝莱店',
    day,
    visited: day != null,
    amount: null,
    consume: null,
    items: [],
    stores: [],
    ...patch,
  }
}

describe('分档阈值（☆ 常量，按到店天数）', () => {
  it('1~2 / 3~4 / ≥5；0 天不入任何一档', () => {
    expect(CUSTOMER_FREQUENCY_TIERS.map((tier) => [tier.min, tier.max])).toEqual([[1, 2], [3, 4], [5, null]])
    expect([0, 1, 2, 3, 4, 5, 31].map(tierOf)).toEqual([null, 'low', 'low', 'mid', 'mid', 'high', 'high'])
  })
})

describe('行模型', () => {
  it('会员等级为空时显示顾客类型；手机号脱敏；按分累加金额（无浮点误差）', () => {
    const [row] = buildCustomerFrequencyRows([
      src('U1', '2026-08-01', { amount: '0.10' }),
      src('U1', '2026-08-02', { amount: '0.20' }),
    ])
    expect(row.level).toBe('流量客')
    expect(row.phoneMasked).toBe('138****5678')
    expect(row.amount).toBe(0.3)
    expect(Object.keys(row.days)).toEqual(['1', '2'])
  })

  it('没到店、只有退款的日子：不计到店次数，负金额计入行合计', () => {
    const [row] = buildCustomerFrequencyRows([
      src('U1', '2026-08-01', { amount: '120.00', consume: '80.00' }),
      src('U1', '2026-08-03', { visited: false, amount: '-50.00' }),
    ])
    expect(row.visitDays).toBe(1)
    expect(row.amount).toBe(70)
    expect(row.consume).toBe(80)
    expect(row.days['3']).toMatchObject({ visited: false, amount: -50 })
  })

  it('本月 0 次到店的顾客照样出一行（统计顾客数含 0 次）', () => {
    const rows = buildCustomerFrequencyRows([src('U1', null), src('U2', '2026-08-05')])
    expect(rows.map((row) => [row.clientUserId, row.visitDays])).toEqual([['U1', 0], ['U2', 1]])
    const summary = summarizeCustomerFrequency(rows)
    expect(summary).toMatchObject({ customerCount: 2, visitedCount: 1, visitRate: 0.5, visitTotal: 1, visitsPerVisitor: 1 })
  })

  it('消费合计 ≤ 0 时消耗 / 消费比为空，不给出负比例', () => {
    const summary = summarizeCustomerFrequency(buildCustomerFrequencyRows([
      src('U1', '2026-08-01', { visited: false, amount: '-10.00' }),
      src('U2', '2026-08-01', { consume: '30.00' }),
    ]))
    expect(summary.amountTotal).toBe(-10)
    expect(summary.consumeRatio).toBeNull()
  })
})

describe('排序', () => {
  const rows = buildCustomerFrequencyRows([
    src('U3', '2026-08-01', { amount: '100.00' }),
    src('U1', '2026-08-01', { amount: '100.00' }),
    src('U2', '2026-08-01', { amount: '300.00' }),
    src('U4', '2026-08-01'),
    src('U4', '2026-08-02'),
  ])

  it('默认：到店次数降序 → 消费降序 → 顾客 id 升序', () => {
    const { sort } = parseCustomerFrequencyParams({})
    expect(sortCustomerFrequencyRows(rows, sort).map((row) => row.clientUserId)).toEqual(['U4', 'U2', 'U1', 'U3'])
  })

  it('按消费升序：同额按到店次数降序，再按 id；非法排序键回落默认', () => {
    const { sort } = parseCustomerFrequencyParams({ sort: 'amount', dir: 'asc' })
    expect(sortCustomerFrequencyRows(rows, sort).map((row) => row.clientUserId)).toEqual(['U4', 'U1', 'U3', 'U2'])
    expect(parseCustomerFrequencyParams({ sort: 'phone', dir: 'asc' }).sort).toEqual({ key: 'visitDays', direction: 'desc' })
  })
})

describe('参数', () => {
  it('单月型：默认上月，晚于本月回落默认，早于 2026-07 照常解析（页面显示空表 + 起点提示）', () => {
    expect(parseCustomerFrequencyParams({}, '2026-09-25').period.month).toBe('2026-08')
    expect(parseCustomerFrequencyParams({ month: '2026-12' }, '2026-09-25').period.month).toBe('2026-08')
    expect(parseCustomerFrequencyParams({ month: '2026-05' }, '2026-09-25').period.current).toEqual({ start: '2026-05-01', end: '2026-05-31' })
    expect(parseCustomerFrequencyParams({ show: 'visited', q: '  张 ' })).toMatchObject({ show: 'visited', q: '张' })
  })
})

describe('搜索与入参健壮性', () => {
  it('手机号脏格式（空格 / 连字符 / +86）归一后能按完整号码搜到；部分号码不做模糊匹配', () => {
    expect(['138 1234 5678', '138-1234-5678', '+8613812345678', '8613812345678'].map(normalizePhone))
      .toEqual(Array(4).fill('13812345678'))
    const rows = buildCustomerFrequencyRows([src('U1', null, { phone: '+86 138-1234-5678' }), src('U2', null, { phone: '13900000000' })])
    expect(filterCustomerFrequencyRows(rows, { q: '13812345678', show: 'all' }).map((row) => row.clientUserId)).toEqual(['U1'])
    expect(filterCustomerFrequencyRows(rows, { q: '1234', show: 'all' })).toHaveLength(0)
    // 搜索词带 +86 / 空格也按完整号码匹配；展示的脱敏号码同样先归一
    expect(filterCustomerFrequencyRows(rows, { q: '+86 138 1234 5678', show: 'all' }).map((row) => row.clientUserId)).toEqual(['U1'])
    expect(rows[0].phoneMasked).toBe('138****5678')
  })

  it('导出说明回显的搜索词：完整手机号脱敏，姓名原样', () => {
    expect(displaySearchTerm('13812345678')).toBe('138****5678')
    // 粘贴的脏格式同样是完整手机号：先归一再脱敏，不原样回显
    for (const pasted of ['+8613812345678', '008613812345678', '138 1234 5678', '138-1234-5678']) {
      expect(displaySearchTerm(pasted), pasted).toBe('138****5678')
    }
    expect(displaySearchTerm('张三')).toBe('张三')
  })

  it('非字符串入参当缺省；搜索截断 50 字；每页条数只认白名单', () => {
    const parsed = parseCustomerFrequencyParams({ q: 42, month: ['2026-07'], sort: {}, size: '37' } as never, '2026-09-25')
    expect(parsed).toMatchObject({ q: '', sort: { key: 'visitDays', direction: 'desc' }, pageSize: 50 })
    expect(parsed.period.month).toBe('2026-08')
    expect(parseCustomerFrequencyParams({ q: '张'.repeat(80) }).q).toHaveLength(50)
    expect(parseCustomerFrequencyParams({ size: '100' }).pageSize).toBe(100)
  })
})

describe('单元格与列', () => {
  it('悬停提示：当日消耗、服务项目、发生门店；没到店的格注明', () => {
    expect(frequencyCellHint({ visited: true, amount: 0, consume: 80, items: ['面部', '肩颈'], stores: ['蓝莱店', '万达店'] }))
      .toBe('当日消耗 ¥80.00；服务项目：面部、肩颈；发生门店：蓝莱店、万达店')
    expect(frequencyCellHint({ visited: false, amount: -50, consume: null, items: [], stores: ['蓝莱店'] }))
      .toBe('当日未到店（仅有款项归属到这一天）；当日消费 ¥-50.00；发生门店：蓝莱店')
    expect(frequencyCellHint(undefined)).toBeNull()
    // 没到店且款项相抵为 0：页面是空格，悬停也不出提示
    expect(frequencyCellHint({ visited: false, amount: 0, consume: null, items: [], stores: ['蓝莱店'] })).toBeNull()
  })

  it('横轴天数随月份变化；周末列标记；左 4 列冻结、右 2 列汇总冻结', () => {
    const feb = customerFrequencyColumnSpecs('2026-02')
    const days = feb.filter((spec) => spec.day)
    expect(days).toHaveLength(28)
    expect(customerFrequencyColumnSpecs('2028-02').filter((spec) => spec.day)).toHaveLength(29)
    expect(customerFrequencyColumnSpecs('2026-08').filter((spec) => spec.day)).toHaveLength(31)
    // 2026-02-01 是周日
    expect(days[0].day).toMatchObject({ day: 1, weekend: true })
    expect(feb.filter((spec) => spec.freeze === 'left').map((spec) => spec.header)).toEqual(['姓名', '电话', '会员等级', '所属门店'])
    expect(feb.filter((spec) => spec.freeze === 'right').map((spec) => spec.header)).toEqual(['到店次数', '消费合计'])
  })

  it('导出形态 ②：每日拆「到店 / 金额」两列，金额为 0 的到店格保留 ✓，没到店只写金额', () => {
    const [row] = buildCustomerFrequencyRows([
      src('U1', '2026-02-01', { amount: '0.00' }),
      src('U1', '2026-02-02', { visited: false, amount: '-50.00' }),
      src('U1', '2026-02-03', { amount: '120.00' }),
    ])
    const specs = frequencyExportColumnSpecs('2026-02')
    expect(specs).toHaveLength(4 + 28 * 2 + 2)
    const cells = specs.slice(4, 10).map((spec) => (spec.exportValue ? spec.exportValue(row) : spec.value!(row)))
    expect(cells).toEqual(['✓', null, '', -50, '✓', 120])
    expect(specs.slice(4, 6).map((spec) => spec.group)).toEqual([
      { key: 'day-1', header: '1日' },
      { key: 'day-1', header: '1日' },
    ])
  })
})
