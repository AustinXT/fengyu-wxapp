import { lookupRate, computeSummary } from '../../packageOrder/utils/allocation-calc'

describe('lookupRate', () => {
  // beautyRates 仅作向后兼容 fallback（cloudfn 老版本只下发 ratesByRole 时用）；
  // 新代码路径 rates 数组覆盖所有 role 时优先走 rates + tier。
  const beautyRates = {
    '美容师': { '自销自耗': 0.3, '配合销售': 0.15 },
    '养生师': { '自销自耗': 0.25 },
  }

  const rates = [
    {
      department: '市场部',
      amountMin: 0,
      amountMax: 5000,
      orderRates: { '自销自耗': 0.1, '配合销售': 0.05 },
    },
    {
      department: '市场部',
      amountMin: 5001,
      amountMax: 10000,
      orderRates: { '自销自耗': 0.12, '配合销售': 0.06 },
    },
  ]

  test('美容师 fallback beautyRates（rates 中无 美容师 规则）', () => {
    const result = lookupRate('美容师', '自销自耗', 1000, beautyRates, rates, 3000)
    expect(result.commissionRate).toBe(0.3)
    expect(result.amount).toBe('300.00')
  })

  test('美容师 — 配合销售比例 fallback', () => {
    const result = lookupRate('美容师', '配合销售', 2000, beautyRates, rates, 3000)
    expect(result.commissionRate).toBe(0.15)
    expect(result.amount).toBe('300.00')
  })

  test('养生师 fallback beautyRates', () => {
    const result = lookupRate('养生师', '自销自耗', 1000, beautyRates, rates, 3000)
    expect(result.commissionRate).toBe(0.25)
    expect(result.amount).toBe('250.00')
  })

  test('养生师 — 未配置的销售分类返回 0', () => {
    const result = lookupRate('养生师', '配合销售', 1000, beautyRates, rates, 3000)
    expect(result.commissionRate).toBe(0)
    expect(result.amount).toBe('0.00')
  })

  test('其他角色按金额范围匹配 — 低区间', () => {
    const result = lookupRate('市场部', '自销自耗', 1000, beautyRates, rates, 3000)
    expect(result.commissionRate).toBe(0.1)
    expect(result.amount).toBe('100.00')
  })

  test('其他角色按金额范围匹配 — 高区间', () => {
    const result = lookupRate('市场部', '自销自耗', 1000, beautyRates, rates, 6000)
    expect(result.commissionRate).toBe(0.12)
    expect(result.amount).toBe('120.00')
  })

  test('其他角色无匹配范围返回 0', () => {
    const result = lookupRate('市场部', '自销自耗', 1000, beautyRates, rates, 20000)
    expect(result.commissionRate).toBe(0)
    expect(result.amount).toBe('0.00')
  })

  test('未知角色返回 0', () => {
    const result = lookupRate('行政部', '自销自耗', 1000, beautyRates, rates, 3000)
    expect(result.commissionRate).toBe(0)
    expect(result.amount).toBe('0.00')
  })

  // ── tier 切换：美容师在 rates 数组里有 tier 规则时，按 totalAmount 切换 ──
  describe('tier 阶梯算法', () => {
    const tieredRates = [
      {
        department: '美容师',
        amountMin: 0,
        amountMax: 5000,
        orderRates: { '自销自耗': 0.08, '他销自耗': 0.06 },
      },
      {
        department: '美容师',
        amountMin: 5000,
        amountMax: 10000000,
        orderRates: { '自销自耗': 0.10, '他销自耗': 0.06 },
      },
    ]

    test('美容师 — totalAmount=3000 命中 tier1 自销自耗 0.08', () => {
      const result = lookupRate('美容师', '自销自耗', 1000, beautyRates, tieredRates, 3000)
      expect(result.commissionRate).toBe(0.08)
      expect(result.amount).toBe('80.00')
    })

    test('美容师 — totalAmount=8000 命中 tier2 自销自耗 0.10', () => {
      const result = lookupRate('美容师', '自销自耗', 1000, beautyRates, tieredRates, 8000)
      expect(result.commissionRate).toBe(0.10)
      expect(result.amount).toBe('100.00')
    })

    test('美容师 — totalAmount=5000 边界（两 tier 同时含 5000，取高 tier）', () => {
      const result = lookupRate('美容师', '自销自耗', 1000, beautyRates, tieredRates, 5000)
      // amountMin 最大者优先 → tier2 (amountMin=5000) 命中
      expect(result.commissionRate).toBe(0.10)
    })

    test('美容师 — rates 命中优先于 beautyRates fallback', () => {
      // beautyRates['美容师']['自销自耗']=0.3 但 rates 的 tier1=0.08 优先
      const result = lookupRate('美容师', '自销自耗', 1000, beautyRates, tieredRates, 3000)
      expect(result.commissionRate).toBe(0.08)
    })
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
