/**
 * 营业额分配路由测试
 * 覆盖：getCommissionRates（提成比例矩阵 pivot）
 * 注：旧订单级 save / deleteAllocation / pendingList / suggest 已随「按回款逐笔分配」
 *     迁移移除（回款级 pendingPayments/suggestPayment/savePayment/deletePaymentAllocation
 *     由 e2e + 跨端 snapshot 守护）。
 */



const pg = globalThis.__mocks__.pg
const { createManagerCtx, createBeauticianCtx } = require('../helpers')
const allocationRoutes = require('../../routes/allocation')

// ============================================================
// allocation.getCommissionRates
// ============================================================
describe('allocation.getCommissionRates', () => {
  beforeEach(() => { vi.clearAllMocks() })

  test('返回提成比例矩阵（PG 扁平行 pivot 为 role_type 分组）', async () => {
    const ctx = createManagerCtx({ marketName: '华东市场' })

    // PG commission_rate_matrix 的 role_type 存储角色名（'美容师'/'养生师'/'推广师'），
    // order_type 为中文枚举 '销售单'/'服务单'
    pg.query.mockResolvedValueOnce([
      { role_type: '美容师', order_type: '销售单', sales_category: '自销自耗', amount_tier_min: '0', amount_tier_max: '5000', commission_rate: '0.3000' },
      { role_type: '美容师', order_type: '销售单', sales_category: '他销自耗', amount_tier_min: '0', amount_tier_max: '5000', commission_rate: '0.2000' },
      { role_type: '美容师', order_type: '服务单', sales_category: '自销自耗', amount_tier_min: '0', amount_tier_max: '5000', commission_rate: '0.2500' },
    ])

    await allocationRoutes.getCommissionRates(ctx)

    expect(ctx.result.rates).toHaveLength(1)
    expect(ctx.result.rates[0].department).toBe('美容师')
    expect(ctx.result.rates[0].orderRates['自销自耗']).toBe(0.3)
    expect(ctx.result.rates[0].orderRates['他销自耗']).toBe(0.2)
    expect(ctx.result.rates[0].serviceRates['自销自耗']).toBe(0.25)
    expect(ctx.result.rates[0].amountMin).toBe(0)
    expect(ctx.result.rates[0].amountMax).toBe(5000)
  })

  test('市场不存在时抛出错误', async () => {
    const ctx = createManagerCtx({ marketName: '不存在市场' })
    pg.query.mockResolvedValueOnce([])
    await expect(allocationRoutes.getCommissionRates(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*未找到市场/)
  })

  test('缺少 marketName 参数时拒绝', async () => {
    const ctx = createManagerCtx({})
    await expect(allocationRoutes.getCommissionRates(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*marketName/)
  })

  test('非店长拒绝操作', async () => {
    const ctx = createBeauticianCtx({ marketName: '华东市场' })
    await expect(allocationRoutes.getCommissionRates(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('null amount_tier_max 使用默认值', async () => {
    const ctx = createManagerCtx({ marketName: '华东市场' })

    pg.query.mockResolvedValueOnce([
      { role_type: '养生师', order_type: '销售单', sales_category: '自销自耗', amount_tier_min: null, amount_tier_max: null, commission_rate: '0' },
    ])

    await allocationRoutes.getCommissionRates(ctx)

    expect(ctx.result.rates[0].department).toBe('养生师')
    expect(ctx.result.rates[0].amountMin).toBe(-9999.9)
    expect(ctx.result.rates[0].amountMax).toBe(10000000)
    expect(ctx.result.rates[0].orderRates['自销自耗']).toBe(0)
  })

  test('美容师和养生师分别返回不同比例', async () => {
    const ctx = createManagerCtx({ marketName: '华东市场' })

    pg.query.mockResolvedValueOnce([
      { role_type: '美容师', order_type: '销售单', sales_category: '自销自耗', amount_tier_min: '0', amount_tier_max: '99999', commission_rate: '0.3000' },
      { role_type: '养生师', order_type: '销售单', sales_category: '自销自耗', amount_tier_min: '0', amount_tier_max: '99999', commission_rate: '0.2000' },
    ])

    await allocationRoutes.getCommissionRates(ctx)

    expect(ctx.result.rates).toHaveLength(2)
    const beauty = ctx.result.rates.find(r => r.department === '美容师')
    const wellness = ctx.result.rates.find(r => r.department === '养生师')
    expect(beauty.orderRates['自销自耗']).toBe(0.3)
    expect(wellness.orderRates['自销自耗']).toBe(0.2)
  })
})
