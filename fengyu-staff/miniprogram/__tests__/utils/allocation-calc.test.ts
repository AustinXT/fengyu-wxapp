import { lookupRate, computeSummary } from '../../packageOrder/utils/allocation-calc'

describe('lookupRate', () => {
  // P2-14：beautyRates 键改为 roleType（与 cloudfn ratesByRole 一致）
  const beautyRates = {
    '美容师': { '自采自销': 0.3, '配合销售': 0.15 },
    '养生师': { '自采自销': 0.25 },
  }

  const rates = [
    {
      department: '市场部',
      amountMin: 0,
      amountMax: 5000,
      orderRates: { '自采自销': 0.1, '配合销售': 0.05 },
    },
    {
      department: '市场部',
      amountMin: 5001,
      amountMax: 10000,
      orderRates: { '自采自销': 0.12, '配合销售': 0.06 },
    },
  ]

  test('美容师使用 beautyRates', () => {
    const result = lookupRate('美容师', '自采自销', 1000, beautyRates, rates, 3000)
    expect(result.commissionRate).toBe(0.3)
    expect(result.amount).toBe('300.00')
  })

  test('美容师 — 配合销售比例', () => {
    const result = lookupRate('美容师', '配合销售', 2000, beautyRates, rates, 3000)
    expect(result.commissionRate).toBe(0.15)
    expect(result.amount).toBe('300.00')
  })

  test('养生师使用 beautyRates', () => {
    const result = lookupRate('养生师', '自采自销', 1000, beautyRates, rates, 3000)
    expect(result.commissionRate).toBe(0.25)
    expect(result.amount).toBe('250.00')
  })

  test('养生师 — 未配置的销售分类返回 0', () => {
    const result = lookupRate('养生师', '配合销售', 1000, beautyRates, rates, 3000)
    expect(result.commissionRate).toBe(0)
    expect(result.amount).toBe('0.00')
  })

  test('其他角色按金额范围匹配 — 低区间', () => {
    const result = lookupRate('市场部', '自采自销', 1000, beautyRates, rates, 3000)
    expect(result.commissionRate).toBe(0.1)
    expect(result.amount).toBe('100.00')
  })

  test('其他角色按金额范围匹配 — 高区间', () => {
    const result = lookupRate('市场部', '自采自销', 1000, beautyRates, rates, 6000)
    expect(result.commissionRate).toBe(0.12)
    expect(result.amount).toBe('120.00')
  })

  test('其他角色无匹配范围返回 0', () => {
    const result = lookupRate('市场部', '自采自销', 1000, beautyRates, rates, 20000)
    expect(result.commissionRate).toBe(0)
    expect(result.amount).toBe('0.00')
  })

  test('未知角色返回 0', () => {
    const result = lookupRate('行政部', '自采自销', 1000, beautyRates, rates, 3000)
    expect(result.commissionRate).toBe(0)
    expect(result.amount).toBe('0.00')
  })
})

describe('computeSummary', () => {
  test('汇总多个员工分配', () => {
    const displayItems = [
      {
        allocLines: [
          { staffWfId: 'emp-1', staffName: '张三', department: '美容部', amount: '100.00' },
          { staffWfId: 'emp-2', staffName: '李四', department: '美容部', amount: '200.00' },
        ],
      },
      {
        allocLines: [
          { staffWfId: 'emp-1', staffName: '张三', department: '美容部', amount: '50.00' },
        ],
      },
    ]

    const { summary, grandTotal } = computeSummary(displayItems)

    expect(grandTotal).toBe('350.00')
    expect(summary).toHaveLength(2)

    const emp1 = summary.find(s => s.staffName === '张三')
    expect(emp1!.total).toBe('150.00')
    expect(emp1!.department).toBe('美容部')

    const emp2 = summary.find(s => s.staffName === '李四')
    expect(emp2!.total).toBe('200.00')
  })

  test('同一员工不同部门分开统计', () => {
    const displayItems = [
      {
        allocLines: [
          { staffWfId: 'emp-1', staffName: '张三', department: '美容部', amount: '100.00' },
          { staffWfId: 'emp-1', staffName: '张三', department: '市场部', amount: '50.00' },
        ],
      },
    ]

    const { summary } = computeSummary(displayItems)
    expect(summary).toHaveLength(2)
  })

  test('空 displayItems', () => {
    const { summary, grandTotal } = computeSummary([])
    expect(summary).toHaveLength(0)
    expect(grandTotal).toBe('0.00')
  })

  test('空 allocLines', () => {
    const { summary, grandTotal } = computeSummary([{ allocLines: [] }])
    expect(summary).toHaveLength(0)
    expect(grandTotal).toBe('0.00')
  })

  test('无效金额被视为 0', () => {
    const displayItems = [
      {
        allocLines: [
          { staffWfId: 'emp-1', staffName: '张三', department: '美容部', amount: 'abc' },
        ],
      },
    ]

    const { summary, grandTotal } = computeSummary(displayItems)
    expect(grandTotal).toBe('0.00')
    expect(summary[0].total).toBe('0.00')
  })

  test('无 staffWfId 的行计入总额但不计入汇总', () => {
    const displayItems = [
      {
        allocLines: [
          { staffWfId: '', staffName: '', department: '美容部', amount: '100.00' },
          { staffWfId: 'emp-1', staffName: '张三', department: '美容部', amount: '200.00' },
        ],
      },
    ]

    const { summary, grandTotal } = computeSummary(displayItems)
    expect(grandTotal).toBe('300.00')
    expect(summary).toHaveLength(1)
    expect(summary[0].total).toBe('200.00')
  })
})
