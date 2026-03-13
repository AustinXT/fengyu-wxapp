/**
 * 优惠券路由测试
 * 覆盖：list（过期懒清理）、available（store/category 匹配、折扣计算）
 */

vi.mock('../../db/pg', () => require('../mocks/pg'))
vi.mock('wx-server-sdk', () => require('../mocks/wx-server-sdk'))
vi.mock('../../middleware/auth', async (importOriginal) => {
  const original = await importOriginal()
  return {
    ...original,
    requirePhone: original.requirePhone,
    invalidateAuthCache: original.invalidateAuthCache,
  }
})

const pg = require('../../db/pg')
const { createBoundCtx, createCtx } = require('../helpers')

let routes
beforeEach(() => {
  vi.clearAllMocks()
  routes = require('../../routes/coupon')
})

describe('coupon.list', () => {
  test('返回用户优惠券列表', async () => {
    // 懒清扫
    pg.query.mockResolvedValueOnce([])
    // 查券
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'c1',
      status: '未使用',
      expire_at: '2025-12-31',
      used_at: null,
      created_at: '2025-01-01',
      name: '满100减10',
      coupon_type: '现金券',
      discount_value: 10,
      min_spend: 100,
      applicable_category_ids: null,
      applicable_store_ids: null,
      description: '全场通用',
    }])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    expect(ctx.result.coupons).toHaveLength(1)
    expect(ctx.result.coupons[0].name).toBe('满100减10')
    expect(ctx.result.coupons[0].couponType).toBe('现金券')
  })

  test('按状态筛选', async () => {
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({ status: '已使用' })
    await routes.list(ctx)

    const listCall = pg.query.mock.calls[1]
    expect(listCall[0]).toContain('uc.status = $')
    expect(listCall[1]).toContain('已使用')
  })

  test('懒清扫过期券', async () => {
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    // 第一个 query 应是更新过期券
    expect(pg.query.mock.calls[0][0]).toContain("SET status = '已过期'")
  })

  test('无手机号 → PHONE_REQUIRED', async () => {
    const ctx = createCtx({
      payload: {},
      auth: { phone: null },
    })
    await expect(routes.list(ctx))
      .rejects.toThrow(/PHONE_REQUIRED/)
  })

  test('带门店限定的券查询门店名称', async () => {
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'c1',
      status: '未使用',
      expire_at: '2025-12-31',
      used_at: null,
      created_at: '2025-01-01',
      name: '指定门店券',
      coupon_type: '现金券',
      discount_value: 20,
      min_spend: 0,
      applicable_category_ids: null,
      applicable_store_ids: ['store-A'],
      description: '',
    }])
    // 查门店名称
    pg.query.mockResolvedValueOnce([{ store_id: 'store-A', store_name: '凤御A店' }])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    expect(ctx.result.coupons[0].applicableStoreNames).toEqual(['凤御A店'])
  })
})

describe('coupon.available', () => {
  test('返回可用优惠券列表（含折扣金额）', async () => {
    // 懒清扫
    pg.query.mockResolvedValueOnce([])
    // 查可用券
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'c1',
      expire_at: '2025-12-31',
      template_id: 't1',
      name: '满100减10',
      coupon_type: '现金券',
      discount_value: 10,
      min_spend: 100,
      max_discount: null,
      applicable_category_ids: null,
      applicable_store_ids: null,
      description: '',
    }])
    // 查 SKU category
    pg.query.mockResolvedValueOnce([
      { sku_id: 'sku-1', category_id: 'cat-1' },
    ])

    const ctx = createBoundCtx({
      storeId: 'store-001',
      items: [{ skuId: 'sku-1', quantity: 1, amount: 200 }],
    })
    await routes.available(ctx)

    expect(ctx.result.coupons).toHaveLength(1)
    expect(ctx.result.coupons[0].discount).toBe(10)
  })

  test('门店不匹配 → 券被过滤', async () => {
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'c1',
      expire_at: '2025-12-31',
      template_id: 't1',
      name: '指定门店券',
      coupon_type: '现金券',
      discount_value: 10,
      min_spend: 0,
      max_discount: null,
      applicable_store_ids: ['other-store'],
      applicable_category_ids: null,
      description: '',
    }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({
      storeId: 'store-001',
      items: [{ skuId: 'sku-1', quantity: 1, amount: 200 }],
    })
    await routes.available(ctx)

    expect(ctx.result.coupons).toHaveLength(0)
  })

  test('品项分类不匹配 → 券被过滤', async () => {
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'c1',
      expire_at: '2025-12-31',
      template_id: 't1',
      name: '指定品项券',
      coupon_type: '现金券',
      discount_value: 10,
      min_spend: 0,
      max_discount: null,
      applicable_store_ids: null,
      applicable_category_ids: ['cat-X'],
      description: '',
    }])
    pg.query.mockResolvedValueOnce([
      { sku_id: 'sku-1', category_id: 'cat-1' },
    ])

    const ctx = createBoundCtx({
      storeId: 'store-001',
      items: [{ skuId: 'sku-1', quantity: 1, amount: 200 }],
    })
    await routes.available(ctx)

    expect(ctx.result.coupons).toHaveLength(0)
  })

  test('未满足满减门槛 → 券被过滤', async () => {
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'c1',
      expire_at: '2025-12-31',
      template_id: 't1',
      name: '满500减50',
      coupon_type: '现金券',
      discount_value: 50,
      min_spend: 500,
      max_discount: null,
      applicable_store_ids: null,
      applicable_category_ids: null,
      description: '',
    }])
    pg.query.mockResolvedValueOnce([
      { sku_id: 'sku-1', category_id: 'cat-1' },
    ])

    const ctx = createBoundCtx({
      storeId: 'store-001',
      items: [{ skuId: 'sku-1', quantity: 1, amount: 200 }],
    })
    await routes.available(ctx)

    expect(ctx.result.coupons).toHaveLength(0)
  })

  test('折扣券计算（含 max_discount 上限）', async () => {
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'c1',
      expire_at: '2025-12-31',
      template_id: 't1',
      name: '8折券',
      coupon_type: '折扣券',
      discount_value: 0.8, // 8 折
      min_spend: 0,
      max_discount: 30,
      applicable_store_ids: null,
      applicable_category_ids: null,
      description: '',
    }])
    pg.query.mockResolvedValueOnce([
      { sku_id: 'sku-1', category_id: 'cat-1' },
    ])

    const ctx = createBoundCtx({
      storeId: 'store-001',
      items: [{ skuId: 'sku-1', quantity: 1, amount: 200 }],
    })
    await routes.available(ctx)

    // 200 * (1-0.8) = 40, 但 max_discount=30
    expect(ctx.result.coupons).toHaveLength(1)
    expect(ctx.result.coupons[0].discount).toBe(30)
  })

  test('缺少 items → INVALID_PARAMS', async () => {
    const ctx = createBoundCtx({})
    await expect(routes.available(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*items/)
  })

  test('无可用券时返回空数组', async () => {
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({
      items: [{ skuId: 'sku-1', quantity: 1, amount: 100 }],
    })
    await routes.available(ctx)

    expect(ctx.result.coupons).toEqual([])
  })

  test('通过 storeName 解析 storeId', async () => {
    pg.query.mockResolvedValueOnce([{ store_id: 'store-resolved' }])
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({
      storeName: '凤御A店',
      items: [{ skuId: 'sku-1', quantity: 1, amount: 100 }],
    })
    await routes.available(ctx)

    // 第一个 query 是 storeName 解析
    expect(pg.query.mock.calls[0][0]).toContain('store_name = $1')
  })
})
