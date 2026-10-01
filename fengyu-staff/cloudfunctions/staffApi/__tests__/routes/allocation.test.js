/**
 * 营业额分配路由测试
 * 覆盖：getCommissionRates（提成比例矩阵 pivot）
 * 注：旧订单级 save / deleteAllocation / pendingList / suggest 已随「按回款逐笔分配」迁移移除。
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

describe('allocation.savePayment — 同池不限人数', () => {
  const receipts = [
    { receipt_id: '101', sale_item_id: 'item-1', amount: '100.00', sales_category: '自销自耗' },
    { receipt_id: '102', sale_item_id: 'item-2', amount: '80.00', sales_category: '自销自耗' },
  ]
  const fourEmployees = ['EMP-1', 'EMP-2', 'EMP-3', 'EMP-4']
  const lines = (ratio = 0.25, roleType = '养生师') =>
    receipts.flatMap((item) => fourEmployees.map((employeeId) => ({
      saleItemId: item.sale_item_id, employeeId, roleType, allocationRatio: ratio,
    })))

  let clientQuery
  beforeEach(() => {
    pg.query.mockImplementation(async (statement, params) => {
      if (statement.includes('SELECT p.id, p.sale_order_id')) {
        return [{ sale_order_id: 'order-1', allocation_status: '待分配', store_id: 'store-001', market_name: 'M', sale_order_type: '销售单', legacy_source: null, change_type: '回款', paid_at: null }]
      }
      if (statement.includes('SELECT u.employee_id') && statement.includes('ANY($1::text[])')) {
        return params[0].map((employee_id) => ({ employee_id }))
      }
      if (statement.includes('SELECT id AS receipt_id, sale_item_id')) return receipts
      return []
    })
    clientQuery = vi.fn(async (statement) => {
      if (statement.includes('FOR NO KEY UPDATE') || statement.includes("UPDATE sale_order_payments SET allocation_status")) {
        return { rows: [{}], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })
    pg.transaction.mockImplementation(async (callback) => callback({ query: clientQuery }))
  })

  test('同 SKU 两个实例每池 4 人各 25%，逐 receipt 写入并重算金额', async () => {
    const ctx = createManagerCtx({ salePaymentId: 7, allocations: lines() })
    await allocationRoutes.savePayment(ctx)

    expect(ctx.result.allocationCount).toBe(8)
    const inserted = clientQuery.mock.calls
      .filter(([statement]) => statement.includes('INSERT INTO sale_payment_item_allocations'))
      .map(([, params]) => params)
    expect(inserted).toHaveLength(8)
    expect(inserted.filter((params) => params[0] === 101).map((params) => [params[1], params[4], params[5]])).toEqual([
      ['EMP-1', '0.250', 25], ['EMP-2', '0.250', 25], ['EMP-3', '0.250', 25], ['EMP-4', '0.250', 25],
    ])
    expect(inserted.filter((params) => params[0] === 102).map((params) => params[5])).toEqual([20, 20, 20, 20])
  })

  test.each([
    ['比例超 100%', lines(0.3), /合计不能超过 100%/],
    ['同池重复员工', [...lines(0.2), { saleItemId: 'item-1', employeeId: 'EMP-1', roleType: '养生师', allocationRatio: 0.1 }], /不能重复分配同一员工/],
    ['单行无效比例', [{ saleItemId: 'item-1', employeeId: 'EMP-1', roleType: '养生师', allocationRatio: 0 }], /allocationRatio 必须/],
  ])('%s 仍被拒绝，事务未开始', async (_name, allocations, error) => {
    const ctx = createManagerCtx({ salePaymentId: 7, allocations })
    await expect(allocationRoutes.savePayment(ctx)).rejects.toThrow(error)
    expect(pg.transaction).not.toHaveBeenCalled()
  })

  test('不同技能标签各自独立计算比例', async () => {
    const allocations = [
      ...fourEmployees.map((employeeId) => ({ saleItemId: 'item-1', employeeId, roleType: '养生师', allocationRatio: 0.25 })),
      { saleItemId: 'item-1', employeeId: 'EMP-1', roleType: '美容师', allocationRatio: 1 },
    ]
    const ctx = createManagerCtx({ salePaymentId: 7, allocations })
    await allocationRoutes.savePayment(ctx)
    expect(ctx.result.allocationCount).toBe(5)
  })
})
