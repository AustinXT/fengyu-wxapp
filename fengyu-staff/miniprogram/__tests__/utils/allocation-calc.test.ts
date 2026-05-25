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
  // 不变量：任意场景下「分配汇总各行之和」必须恒等于「合计」
  const sumRows = (summary: Array<{ total: string }>) =>
    summary.reduce((s, r) => s + parseFloat(r.total), 0).toFixed(2)

  test('汇总多个员工分配', () => {
    const displayItems = [
      {
        allocLines: [
          { staffWfId: 'emp-1', staffName: '张三', roleType: '美容师', commissionAmount: '100.00' },
          { staffWfId: 'emp-2', staffName: '李四', roleType: '美容师', commissionAmount: '200.00' },
        ],
      },
      {
        allocLines: [
          { staffWfId: 'emp-1', staffName: '张三', roleType: '美容师', commissionAmount: '50.00' },
        ],
      },
    ]

    const { summary, grandTotal, hasUnassigned } = computeSummary(displayItems)

    expect(grandTotal).toBe('350.00')
    expect(summary).toHaveLength(2)
    expect(hasUnassigned).toBe(false)
    expect(sumRows(summary)).toBe(grandTotal)

    const emp1 = summary.find(s => s.staffName === '张三')
    expect(emp1!.total).toBe('150.00')
    expect(emp1!.department).toBe('美容师')

    const emp2 = summary.find(s => s.staffName === '李四')
    expect(emp2!.total).toBe('200.00')
  })

  test('同一员工不同技能标签分开统计', () => {
    const displayItems = [
      {
        allocLines: [
          { staffWfId: 'emp-1', staffName: '张三', roleType: '美容师', commissionAmount: '100.00' },
          { staffWfId: 'emp-1', staffName: '张三', roleType: '养生师', commissionAmount: '50.00' },
        ],
      },
    ]

    const { summary, grandTotal } = computeSummary(displayItems)
    expect(summary).toHaveLength(2)
    expect(sumRows(summary)).toBe(grandTotal)
  })

  test('空 displayItems', () => {
    const { summary, grandTotal, hasUnassigned } = computeSummary([])
    expect(summary).toHaveLength(0)
    expect(grandTotal).toBe('0.00')
    expect(hasUnassigned).toBe(false)
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
          { staffWfId: 'emp-1', staffName: '张三', roleType: '美容师', commissionAmount: 'abc' },
        ],
      },
    ]

    const { summary, grandTotal } = computeSummary(displayItems)
    expect(grandTotal).toBe('0.00')
    expect(summary[0].total).toBe('0.00')
  })

  test('未选员工的提成额不计入合计也不计入汇总，并标记 hasUnassigned', () => {
    const displayItems = [
      {
        allocLines: [
          { staffWfId: '', staffName: '', roleType: '美容师', commissionAmount: '100.00' },
          { staffWfId: 'emp-1', staffName: '张三', roleType: '美容师', commissionAmount: '200.00' },
        ],
      },
    ]

    const { summary, grandTotal, hasUnassigned } = computeSummary(displayItems)
    expect(grandTotal).toBe('200.00')
    expect(summary).toHaveLength(1)
    expect(summary[0].staffName).toBe('张三')
    expect(summary[0].total).toBe('200.00')
    expect(hasUnassigned).toBe(true)
    // 不变量：汇总各行之和 == 合计（匿名行既不入合计也不入汇总）
    expect(sumRows(summary)).toBe(grandTotal)
  })

  test('未选员工但金额为 0：不标记 hasUnassigned', () => {
    const displayItems = [
      {
        allocLines: [
          { staffWfId: '', staffName: '', roleType: '', commissionAmount: '0.00' },
          { staffWfId: 'emp-1', staffName: '张三', roleType: '美容师', commissionAmount: '120.00' },
        ],
      },
    ]

    const { summary, grandTotal, hasUnassigned } = computeSummary(displayItems)
    expect(grandTotal).toBe('120.00')
    expect(summary).toHaveLength(1)
    expect(hasUnassigned).toBe(false)
    expect(sumRows(summary)).toBe(grandTotal)
  })

  test('复现单 FY-XSD-WX-2605220006：5×净化美人(204)+私定眉毛(264) 同员工 → 合计 1284 恒等', () => {
    // 5 个净化美人 6800×3%=204，1 个私定眉毛 8800×3%=264，全部归李悦娜/美容师
    const beautician = (commissionAmount: string) => ({
      staffWfId: 'FY-260521004', staffName: '李悦娜', roleType: '美容师', commissionAmount,
    })
    const displayItems = [
      { allocLines: [beautician('204.00')] },
      { allocLines: [beautician('204.00')] },
      { allocLines: [beautician('204.00')] },
      { allocLines: [beautician('204.00')] },
      { allocLines: [beautician('204.00')] },
      { allocLines: [beautician('264.00')] },
    ]

    const { summary, grandTotal, hasUnassigned } = computeSummary(displayItems)
    expect(grandTotal).toBe('1284.00')
    expect(summary).toHaveLength(1)
    expect(summary[0].staffName).toBe('李悦娜')
    expect(summary[0].total).toBe('1284.00')
    expect(hasUnassigned).toBe(false)
    expect(sumRows(summary)).toBe(grandTotal)
  })
})
