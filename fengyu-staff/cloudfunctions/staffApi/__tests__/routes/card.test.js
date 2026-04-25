/**
 * 充值卡路由测试
 * 覆盖：rechargeSkus / recharge / matchTier
 *
 * 核心约束：
 *   - 仅店长可调用
 *   - skuId 与 customAmount 互斥
 *   - 真实 SKU 必须 product_kind='充值卡'
 *   - 自定义金额走 matchTier 校验 + 虚拟 SKU 写入
 */

const pg = globalThis.__mocks__.pg
const { createManagerCtx, createBeauticianCtx } = require('../helpers')
const cardRoutes = require('../../routes/card')
const rechargeUtils = require('../../utils/recharge')

describe('card.rechargeSkus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('返回档位列表 + customConfig（字段完整）', async () => {
    const ctx = createManagerCtx({})

    pg.query.mockResolvedValueOnce([
      {
        sku_id: 'sku-cz-500',
        spec_name: '充值 500 元',
        price: '500.00',
        special_price: '495.00',
        sort_order: 0,
        product_type: '家居产品',
        category_id: 'cat-cz-01',
        category_name: '储值卡',
      },
      {
        sku_id: 'sku-cz-1000',
        spec_name: '充值 1000 元',
        price: '1000.00',
        special_price: null,
        sort_order: 1,
        product_type: '家居产品',
        category_id: 'cat-cz-01',
        category_name: '储值卡',
      },
    ])

    await cardRoutes.rechargeSkus(ctx)

    expect(ctx.result.tiers).toHaveLength(2)
    expect(ctx.result.tiers[0]).toMatchObject({
      skuId: 'sku-cz-500',
      faceValue: 500,
      payAmount: 495,
      bonus: 5,
      specName: '充值 500 元',
    })
    // special_price=null → 实付=面值、bonus=0
    expect(ctx.result.tiers[1]).toMatchObject({
      skuId: 'sku-cz-1000',
      faceValue: 1000,
      payAmount: 1000,
      bonus: 0,
    })

    expect(ctx.result.customConfig).toMatchObject({
      minAmount: 500,
      maxAmount: 100000,
    })
    expect(ctx.result.customConfig.tierBreakpoints).toHaveLength(3)
    expect(ctx.result.customConfig.tierBreakpoints[0]).toMatchObject({ faceValue: 500, discount: 0.99 })
  })

  test('非店长拒绝', async () => {
    const ctx = createBeauticianCtx({})
    await expect(cardRoutes.rechargeSkus(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('SQL 排除虚拟 SKU', async () => {
    const ctx = createManagerCtx({})
    pg.query.mockResolvedValueOnce([])
    await cardRoutes.rechargeSkus(ctx)
    expect(pg.query).toHaveBeenCalledTimes(1)
    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).toMatch(/sk\.sku_id\s*<>\s*\$1/)
    expect(params).toEqual(['sku-recharge-virtual'])
  })
})

describe('card.recharge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('档位 SKU 路径：成功建单，status=待确认收款（线下）', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'u-001',
      skuId: 'sku-cz-500',
      paymentMethod: '线下',
    })

    pg.query
      // SKU 查询
      .mockResolvedValueOnce([{
        sku_id: 'sku-cz-500',
        spec_name: '充值 500 元',
        price: '500.00',
        special_price: '495.00',
        product_type: '家居产品',
        product_kind: '充值卡',
        sales_category: '自销自耗',
      }])
      // 顾客查询
      .mockResolvedValueOnce([{ user_id: 'u-001', phone: '13800001111', name: '张三', customer_type: '会员客' }])
      // 待支付查询
      .mockResolvedValueOnce([])

    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
      }
      return await cb(client)
    })

    await cardRoutes.recharge(ctx)

    expect(ctx.result).toMatchObject({
      skuId: 'sku-cz-500',
      faceValue: 500,
      payAmount: 495,
      paymentMethod: '线下',
      status: '待确认收款',
    })
    expect(ctx.result.saleOrderId).toMatch(/^FY-XSD-WX-\d{6}\d{4}$/)
  })

  test('自定义金额路径：虚拟 SKU + matchTier 折算（微信）', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'u-001',
      customAmount: 1000,
      paymentMethod: '微信',
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'u-001', phone: '13800001111', name: '李四', customer_type: '流量客' }])
      .mockResolvedValueOnce([])

    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
      }
      return await cb(client)
    })

    await cardRoutes.recharge(ctx)

    expect(ctx.result).toMatchObject({
      skuId: 'sku-recharge-virtual',
      faceValue: 1000,
      payAmount: 980,            // 1000 * 0.98
      paymentMethod: '微信',
      status: '待支付',
    })
  })

  test('非店长拒绝', async () => {
    const ctx = createBeauticianCtx({
      clientUserId: 'u-001',
      skuId: 'sku-cz-500',
      paymentMethod: '线下',
    })
    await expect(cardRoutes.recharge(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('缺少 clientUserId 拒绝', async () => {
    const ctx = createManagerCtx({ skuId: 'sku-cz-500', paymentMethod: '线下' })
    await expect(cardRoutes.recharge(ctx)).rejects.toThrow(/INVALID_PARAMS.*clientUserId/)
  })

  test('缺少 paymentMethod 拒绝', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u-001', skuId: 'sku-cz-500' })
    await expect(cardRoutes.recharge(ctx)).rejects.toThrow(/INVALID_PARAMS.*paymentMethod/)
  })

  test('非法支付方式拒绝', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'u-001',
      skuId: 'sku-cz-500',
      paymentMethod: '支付宝',
    })
    await expect(cardRoutes.recharge(ctx)).rejects.toThrow(/INVALID_PARAMS.*支付方式/)
  })

  test('skuId 与 customAmount 都未传拒绝', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u-001', paymentMethod: '线下' })
    await expect(cardRoutes.recharge(ctx)).rejects.toThrow(/INVALID_PARAMS.*档位或输入自定义金额/)
  })

  test('skuId 与 customAmount 同时传拒绝', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'u-001',
      skuId: 'sku-cz-500',
      customAmount: 1000,
      paymentMethod: '线下',
    })
    await expect(cardRoutes.recharge(ctx)).rejects.toThrow(/INVALID_PARAMS.*二选一/)
  })

  test('SKU 不是充值卡时拒绝', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'u-001',
      skuId: 'sku-careitem-001',
      paymentMethod: '线下',
    })

    pg.query.mockResolvedValueOnce([{
      sku_id: 'sku-careitem-001',
      spec_name: '护理项目',
      price: '300.00',
      special_price: null,
      product_type: '疗程卡',
      product_kind: '护理项目',
      sales_category: '自销自耗',
    }])

    await expect(cardRoutes.recharge(ctx)).rejects.toThrow(/INVALID_PARAMS.*不是充值卡/)
  })

  test('SKU 不存在时拒绝', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'u-001',
      skuId: 'sku-nonexist',
      paymentMethod: '线下',
    })
    pg.query.mockResolvedValueOnce([])  // SKU 查询空
    await expect(cardRoutes.recharge(ctx)).rejects.toThrow(/INVALID_PARAMS.*SKU 不存在/)
  })

  test('显式传虚拟 SKU 但无 customAmount 拒绝', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'u-001',
      skuId: 'sku-recharge-virtual',
      paymentMethod: '线下',
    })
    await expect(cardRoutes.recharge(ctx)).rejects.toThrow(/INVALID_PARAMS.*虚拟 SKU/)
  })

  test('自定义金额低于下限拒绝', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'u-001',
      customAmount: 300,
      paymentMethod: '线下',
    })
    await expect(cardRoutes.recharge(ctx)).rejects.toThrow(/INVALID_PARAMS.*最低充值金额/)
  })

  test('自定义金额超过上限拒绝', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'u-001',
      customAmount: 200000,
      paymentMethod: '线下',
    })
    await expect(cardRoutes.recharge(ctx)).rejects.toThrow(/INVALID_PARAMS.*单次充值上限/)
  })

  test('顾客不存在拒绝', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'u-ghost',
      skuId: 'sku-cz-500',
      paymentMethod: '线下',
    })

    pg.query
      .mockResolvedValueOnce([{
        sku_id: 'sku-cz-500', spec_name: '充值 500', price: '500.00', special_price: null,
        product_type: '家居产品', product_kind: '充值卡', sales_category: null,
      }])
      .mockResolvedValueOnce([])   // 顾客不存在

    await expect(cardRoutes.recharge(ctx)).rejects.toThrow(/INVALID_PARAMS.*顾客不存在/)
  })

  test('顾客已有待支付订单拒绝并返回 pendingOrderNo', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'u-001',
      skuId: 'sku-cz-500',
      paymentMethod: '线下',
    })

    pg.query
      .mockResolvedValueOnce([{
        sku_id: 'sku-cz-500', spec_name: '充值 500', price: '500.00', special_price: null,
        product_type: '家居产品', product_kind: '充值卡', sales_category: null,
      }])
      .mockResolvedValueOnce([{ user_id: 'u-001', phone: '138', name: 'X', customer_type: '流量客' }])
      .mockResolvedValueOnce([{ sale_order_id: 'FY-XSD-WX-2604160001' }])

    try {
      await cardRoutes.recharge(ctx)
      throw new Error('应该抛出')
    } catch (err) {
      expect(err.message).toMatch(/INVALID_PARAMS.*已有待支付订单/)
      expect(err.data?.pendingOrderNo).toBe('FY-XSD-WX-2604160001')
    }
  })

  test('无门店信息拒绝（auth.storeId = null）', async () => {
    const ctx = createManagerCtx(
      { clientUserId: 'u-001', skuId: 'sku-cz-500', paymentMethod: '线下' },
      { storeId: null }
    )
    await expect(cardRoutes.recharge(ctx)).rejects.toThrow(/INVALID_PARAMS.*门店/)
  })
})

describe('utils.matchTier', () => {
  test('500 → 9.9 折', () => {
    expect(rechargeUtils.matchTier(500)).toEqual({ discount: 0.99, payAmount: 495 })
  })
  test('999 → 9.9 折', () => {
    expect(rechargeUtils.matchTier(999)).toEqual({ discount: 0.99, payAmount: 989.01 })
  })
  test('1000 → 9.8 折', () => {
    expect(rechargeUtils.matchTier(1000)).toEqual({ discount: 0.98, payAmount: 980 })
  })
  test('4999 → 9.8 折', () => {
    expect(rechargeUtils.matchTier(4999)).toEqual({ discount: 0.98, payAmount: 4899.02 })
  })
  test('5000 → 9.5 折', () => {
    expect(rechargeUtils.matchTier(5000)).toEqual({ discount: 0.95, payAmount: 4750 })
  })
  test('100000 → 9.5 折', () => {
    expect(rechargeUtils.matchTier(100000)).toEqual({ discount: 0.95, payAmount: 95000 })
  })
  test('499 抛下限错', () => {
    expect(() => rechargeUtils.matchTier(499)).toThrow(/INVALID_PARAMS.*最低/)
  })
  test('100001 抛上限错', () => {
    expect(() => rechargeUtils.matchTier(100001)).toThrow(/INVALID_PARAMS.*上限/)
  })
  test('500.123 抛小数位错', () => {
    expect(() => rechargeUtils.matchTier(500.123)).toThrow(/INVALID_PARAMS.*2 位小数/)
  })
  test('NaN 抛格式错', () => {
    expect(() => rechargeUtils.matchTier(NaN)).toThrow(/INVALID_PARAMS.*格式错误/)
  })
})
