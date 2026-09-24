import { lookupServiceRate, effServiceConsumeBase, computeServiceLine } from '../../packageOrder/utils/service-commission-calc'

// #379 划卡单价阈值：小程序预览须与五个写入副本同口径（选档用原始 consumeBase；消耗提成用 max(单价, 阈值)）
describe('#379 服务提成阈值保底（小程序预览）', () => {
  const rates = [
    {
      department: '美容师',
      amountMin: 0,
      amountMax: 10000000,
      serviceRates: { 自销自耗: 0.15, 他销他耗: 0.02 },
      serviceThresholds: { 自销自耗: 100, 他销他耗: null },
    },
  ]

  test('lookupServiceRate 返回命中行比例与阈值；阈值 null / 缺省 → 0', () => {
    expect(lookupServiceRate('美容师', '自销自耗', 80, rates)).toEqual({ rate: 0.15, priceThreshold: 100 })
    expect(lookupServiceRate('美容师', '他销他耗', 80, rates)).toEqual({ rate: 0.02, priceThreshold: 0 })
    expect(lookupServiceRate('养生师', '自销自耗', 80, rates)).toEqual({ rate: 0, priceThreshold: 0 })
    const legacy = [{ department: '美容师', amountMin: 0, amountMax: 10000000, serviceRates: { 自销自耗: 0.15 } }]
    expect(lookupServiceRate('美容师', '自销自耗', 80, legacy)).toEqual({ rate: 0.15, priceThreshold: 0 })
  })

  test('单价 80、2 次、两人各 50% → 分配额按真实 80，提成按 100', () => {
    const eff = effServiceConsumeBase(80, 2, 100)
    expect(eff).toBe(200)
    expect(computeServiceLine(160, 0, 0.5, 0.15, eff)).toEqual({ allocAmount: '80.00', commissionAmount: '15.00' })
  })

  test('赠送 0 元 → 按阈值；单价 ≥ 阈值 / 阈值 0 → 与改动前一致', () => {
    expect(effServiceConsumeBase(0, 1, 100)).toBe(100)
    expect(effServiceConsumeBase(150, 2, 100)).toBe(300)
    expect(effServiceConsumeBase(80, 1, 0)).toBe(80)
    expect(computeServiceLine(300, 0, 1, 0.15)).toEqual(computeServiceLine(300, 0, 1, 0.15, 300))
  })

  test('手工费叠加：fixedFee 不受阈值影响', () => {
    expect(computeServiceLine(80, 20, 1, 0.15, 100)).toEqual({ allocAmount: '80.00', commissionAmount: '35.00' })
  })
})
