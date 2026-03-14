/**
 * 优惠券模块路由测试
 * 覆盖：available（顾客可用券查询）
 */



const pg = globalThis.__mocks__.pg
const { createManagerCtx } = require('../helpers')
const couponRoutes = require('../../routes/coupon')


// 通用测试数据
const baseItems = [
  { skuId: 'sku-1', quantity: 1, amount: 500 },
  { skuId: 'sku-2', quantity: 2, amount: 300 },
]

/** 设置标准 mock 链（顾客查找 → 过期清扫 → 券查询 → SKU 分类） */
function setupAvailableMocks({ clientRows, coupons, skuCats, storeRows } = {}) {
  // 1. 查找顾客
  pg.query.mockResolvedValueOnce(clientRows || [{ user_id: 'client-001' }])

  // 2. 如果需要解析 storeName → storeId
  if (storeRows) {
    pg.query.mockResolvedValueOnce(storeRows)
  }

  // 3. 懒过期清扫
  pg.query.mockResolvedValueOnce({ rows: [], rowCount: 0 })

  // 4. 券查询
  pg.query.mockResolvedValueOnce(coupons || [])

  // 5. SKU → category_id（仅在有券时触发）
  if (coupons && coupons.length > 0) {
    pg.query.mockResolvedValueOnce(skuCats || [
      { sku_id: 'sku-1', category_id: 'cat-1' },
      { sku_id: 'sku-2', category_id: 'cat-2' },
    ])
  }
}

describe('coupon.available', () => {
  test('返回可用优惠券（含折扣金额）', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      storeId: 'store-001',
      items: baseItems,
    })

    setupAvailableMocks({
      coupons: [{
        coupon_id: 'cp-1',
        expire_at: '2027-12-31',
        template_id: 'tpl-1',
        name: '50元现金券',
        coupon_type: '现金券',
        discount_value: '50',
        min_spend: '100',
        max_discount: null,
        applicable_category_ids: null,
        applicable_store_ids: null,
        description: '满100减50',
      }],
    })

    await couponRoutes.available(ctx)

    expect(ctx.result.coupons).toHaveLength(1)
    expect(ctx.result.coupons[0].couponId).toBe('cp-1')
    expect(ctx.result.coupons[0].name).toBe('50元现金券')
    expect(ctx.result.coupons[0].discount).toBe(50)
  })

  test('按 store_id 过滤（非匹配门店被过滤）', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      storeId: 'store-001',
      items: baseItems,
    })

    setupAvailableMocks({
      coupons: [{
        coupon_id: 'cp-1',
        expire_at: '2027-12-31',
        template_id: 'tpl-1',
        name: '门店专用券',
        coupon_type: '现金券',
        discount_value: '30',
        min_spend: '0',
        max_discount: null,
        applicable_category_ids: null,
        applicable_store_ids: ['store-999'], // 不匹配当前门店
        description: '',
      }],
    })

    await couponRoutes.available(ctx)

    expect(ctx.result.coupons).toEqual([])
  })

  test('按 category_id 过滤', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      storeId: 'store-001',
      items: baseItems,
    })

    setupAvailableMocks({
      coupons: [{
        coupon_id: 'cp-1',
        expire_at: '2027-12-31',
        template_id: 'tpl-1',
        name: '护理专用券',
        coupon_type: '现金券',
        discount_value: '20',
        min_spend: '0',
        max_discount: null,
        applicable_category_ids: ['cat-999'], // 不匹配任何 SKU 的分类
        applicable_store_ids: null,
        description: '',
      }],
      skuCats: [
        { sku_id: 'sku-1', category_id: 'cat-1' },
        { sku_id: 'sku-2', category_id: 'cat-2' },
      ],
    })

    await couponRoutes.available(ctx)

    expect(ctx.result.coupons).toEqual([])
  })

  test('min_spend 未满足时过滤', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      storeId: 'store-001',
      items: [{ skuId: 'sku-1', quantity: 1, amount: 50 }], // 金额不足
    })

    setupAvailableMocks({
      coupons: [{
        coupon_id: 'cp-1',
        expire_at: '2027-12-31',
        template_id: 'tpl-1',
        name: '满200减50',
        coupon_type: '现金券',
        discount_value: '50',
        min_spend: '200', // 最低消费200
        max_discount: null,
        applicable_category_ids: null,
        applicable_store_ids: null,
        description: '',
      }],
    })

    await couponRoutes.available(ctx)

    expect(ctx.result.coupons).toEqual([])
  })

  test('现金券折扣不超过 eligibleTotal', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      storeId: 'store-001',
      items: [{ skuId: 'sku-1', quantity: 1, amount: 30 }], // 金额仅30，小于券面值
    })

    setupAvailableMocks({
      coupons: [{
        coupon_id: 'cp-big',
        expire_at: '2027-12-31',
        template_id: 'tpl-1',
        name: '100元现金券',
        coupon_type: '现金券',
        discount_value: '100', // 券面值100
        min_spend: '0',
        max_discount: null,
        applicable_category_ids: null,
        applicable_store_ids: null,
        description: '',
      }],
    })

    await couponRoutes.available(ctx)

    expect(ctx.result.coupons).toHaveLength(1)
    // discount = min(100, 30) = 30
    expect(ctx.result.coupons[0].discount).toBe(30)
  })

  test('折扣券基础计算（无 max_discount）', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      storeId: 'store-001',
      items: [{ skuId: 'sku-1', quantity: 1, amount: 1000 }],
    })

    setupAvailableMocks({
      coupons: [{
        coupon_id: 'cp-disc',
        expire_at: '2027-12-31',
        template_id: 'tpl-1',
        name: '9折券',
        coupon_type: '折扣券',
        discount_value: '0.9', // 9折 → 优惠 = 1000 * (1-0.9) = 100
        min_spend: '0',
        max_discount: null, // 无封顶
        applicable_category_ids: null,
        applicable_store_ids: null,
        description: '',
      }],
    })

    await couponRoutes.available(ctx)

    expect(ctx.result.coupons).toHaveLength(1)
    expect(ctx.result.coupons[0].discount).toBe(100)
  })

  test('折扣券 max_discount 封顶', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      storeId: 'store-001',
      items: [{ skuId: 'sku-1', quantity: 1, amount: 1000 }],
    })

    setupAvailableMocks({
      coupons: [{
        coupon_id: 'cp-1',
        expire_at: '2027-12-31',
        template_id: 'tpl-1',
        name: '8折券',
        coupon_type: '折扣券',
        discount_value: '0.8', // 8折 → 优惠 = 1000 * (1-0.8) = 200
        min_spend: '0',
        max_discount: '100', // 封顶100
        applicable_category_ids: null,
        applicable_store_ids: null,
        description: '',
      }],
    })

    await couponRoutes.available(ctx)

    expect(ctx.result.coupons).toHaveLength(1)
    expect(ctx.result.coupons[0].discount).toBe(100) // 被封顶
  })

  test('缺少 clientPhone 抛出 INVALID_PARAMS', async () => {
    const ctx = createManagerCtx({
      items: baseItems,
    })

    await expect(couponRoutes.available(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*clientPhone/)
  })

  test('缺少 items 抛出 INVALID_PARAMS', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
    })

    await expect(couponRoutes.available(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*items/)
  })

  test('空 items 数组抛出 INVALID_PARAMS', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      items: [],
    })

    await expect(couponRoutes.available(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*items/)
  })

  test('无可用券返回空数组', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      storeId: 'store-001',
      items: baseItems,
    })

    setupAvailableMocks({
      coupons: [],
    })

    await couponRoutes.available(ctx)

    expect(ctx.result.coupons).toEqual([])
  })

  test('多券按 discount 降序排列', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      storeId: 'store-001',
      items: [{ skuId: 'sku-1', quantity: 1, amount: 500 }],
    })

    setupAvailableMocks({
      coupons: [
        {
          coupon_id: 'cp-small', expire_at: '2027-12-31', template_id: 'tpl-1',
          name: '10元券', coupon_type: '现金券', discount_value: '10',
          min_spend: '0', max_discount: null,
          applicable_category_ids: null, applicable_store_ids: null, description: '',
        },
        {
          coupon_id: 'cp-big', expire_at: '2027-12-31', template_id: 'tpl-2',
          name: '100元券', coupon_type: '现金券', discount_value: '100',
          min_spend: '0', max_discount: null,
          applicable_category_ids: null, applicable_store_ids: null, description: '',
        },
        {
          coupon_id: 'cp-mid', expire_at: '2027-12-31', template_id: 'tpl-3',
          name: '50元券', coupon_type: '现金券', discount_value: '50',
          min_spend: '0', max_discount: null,
          applicable_category_ids: null, applicable_store_ids: null, description: '',
        },
      ],
    })

    await couponRoutes.available(ctx)

    expect(ctx.result.coupons).toHaveLength(3)
    // 按 discount 降序
    expect(ctx.result.coupons[0].discount).toBe(100)
    expect(ctx.result.coupons[1].discount).toBe(50)
    expect(ctx.result.coupons[2].discount).toBe(10)
  })

  test('顾客不存在返回空数组', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13899990000',
      storeId: 'store-001',
      items: baseItems,
    })

    pg.query.mockResolvedValueOnce([]) // 未找到顾客

    await couponRoutes.available(ctx)

    expect(ctx.result.coupons).toEqual([])
  })

  test('通过 storeName 解析 storeId', async () => {
    const ctx = createManagerCtx(
      {
        clientPhone: '13800001111',
        storeName: '凤御测试店',
        items: baseItems,
      },
      { storeName: null } // auth 中无 storeName，强制走 payload.storeName 解析
    )
    // 不传 storeId，通过 storeName 解析
    delete ctx.event.payload.storeId

    // 1. 查找顾客
    pg.query.mockResolvedValueOnce([{ user_id: 'client-001' }])
    // 2. storeName → storeId
    pg.query.mockResolvedValueOnce([{ store_id: 'store-resolved' }])
    // 3. 懒过期清扫
    pg.query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    // 4. 券查询 — 返回门店限定券
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'cp-store',
      expire_at: '2027-12-31',
      template_id: 'tpl-1',
      name: '门店券',
      coupon_type: '现金券',
      discount_value: '10',
      min_spend: '0',
      max_discount: null,
      applicable_category_ids: null,
      applicable_store_ids: ['store-resolved'],
      description: '',
    }])
    // 5. SKU → category
    pg.query.mockResolvedValueOnce([
      { sku_id: 'sku-1', category_id: 'cat-1' },
      { sku_id: 'sku-2', category_id: 'cat-2' },
    ])

    await couponRoutes.available(ctx)

    expect(ctx.result.coupons).toHaveLength(1)
    expect(ctx.result.coupons[0].couponId).toBe('cp-store')
    // 验证查询了 stores 表
    const storeQuery = pg.query.mock.calls.find(
      call => typeof call[0] === 'string' && call[0].includes('stores') && call[0].includes('store_name')
    )
    expect(storeQuery).toBeDefined()
  })
})
