/**
 * 优惠券路由测试
 * 覆盖：list（过期懒清理）、available（store/category 匹配、折扣计算）、redeem（兑换码全路径）
 */

const pg = globalThis.__mocks__.pg
const { createBoundCtx, createCtx } = require('../helpers')

let routes
beforeEach(() => {
  vi.clearAllMocks()
  Object.keys(require.cache).forEach(key => {
    if (key.includes('/routes/coupon') || key.includes('/middleware/auth')) {
      delete require.cache[key]
    }
  })
  routes = require('../../routes/coupon')
})

describe('coupon.list', () => {
  test('返回用户优惠券列表', async () => {
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'c1', status: '未使用', expire_at: '2025-12-31',
      used_at: null, created_at: '2025-01-01',
      name: '满100减10', coupon_type: '现金券', discount_value: 10, min_spend: 100,
      applicable_category_ids: null, applicable_store_ids: null, description: '全场通用',
    }])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    expect(ctx.result.coupons).toHaveLength(1)
    expect(ctx.result.coupons[0].name).toBe('满100减10')
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

    expect(pg.query.mock.calls[0][0]).toContain("SET status = '已过期'")
  })

  test('无手机号 → PHONE_REQUIRED', async () => {
    const ctx = createCtx({ payload: {}, auth: { phone: null } })
    await expect(routes.list(ctx)).rejects.toThrow(/PHONE_REQUIRED/)
  })

  test('带门店限定的券查询门店名称', async () => {
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'c1', status: '未使用', expire_at: '2025-12-31',
      used_at: null, created_at: '2025-01-01',
      name: '指定门店券', coupon_type: '现金券', discount_value: 20, min_spend: 0,
      applicable_category_ids: null, applicable_store_ids: ['store-A'], description: '',
    }])
    pg.query.mockResolvedValueOnce([{ store_id: 'store-A', store_name: '凤御A店' }])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    expect(ctx.result.coupons[0].applicableStoreNames).toEqual(['凤御A店'])
  })
})

describe('coupon.available', () => {
  test('返回可用优惠券列表（含折扣金额）', async () => {
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'c1', expire_at: '2025-12-31', template_id: 't1',
      name: '满100减10', coupon_type: '现金券', discount_value: 10,
      min_spend: 100, max_discount: null,
      applicable_category_ids: null, applicable_store_ids: null, description: '',
    }])
    pg.query.mockResolvedValueOnce([{ sku_id: 'sku-1', category_id: 'cat-1' }])

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
      coupon_id: 'c1', expire_at: '2025-12-31', template_id: 't1',
      name: '指定门店券', coupon_type: '现金券', discount_value: 10, min_spend: 0,
      max_discount: null, applicable_store_ids: ['other-store'],
      applicable_category_ids: null, description: '',
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
      coupon_id: 'c1', expire_at: '2025-12-31', template_id: 't1',
      name: '指定品项券', coupon_type: '现金券', discount_value: 10, min_spend: 0,
      max_discount: null, applicable_store_ids: null,
      applicable_category_ids: ['cat-X'], description: '',
    }])
    pg.query.mockResolvedValueOnce([{ sku_id: 'sku-1', category_id: 'cat-1' }])

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
      coupon_id: 'c1', expire_at: '2025-12-31', template_id: 't1',
      name: '满500减50', coupon_type: '现金券', discount_value: 50, min_spend: 500,
      max_discount: null, applicable_store_ids: null,
      applicable_category_ids: null, description: '',
    }])
    pg.query.mockResolvedValueOnce([{ sku_id: 'sku-1', category_id: 'cat-1' }])

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
      coupon_id: 'c1', expire_at: '2025-12-31', template_id: 't1',
      name: '8折券', coupon_type: '折扣券', discount_value: 0.8,
      min_spend: 0, max_discount: 30,
      applicable_store_ids: null, applicable_category_ids: null, description: '',
    }])
    pg.query.mockResolvedValueOnce([{ sku_id: 'sku-1', category_id: 'cat-1' }])

    const ctx = createBoundCtx({
      storeId: 'store-001',
      items: [{ skuId: 'sku-1', quantity: 1, amount: 200 }],
    })
    await routes.available(ctx)

    expect(ctx.result.coupons).toHaveLength(1)
    expect(ctx.result.coupons[0].discount).toBe(30)
  })

  test('缺少 items → INVALID_PARAMS', async () => {
    const ctx = createBoundCtx({})
    await expect(routes.available(ctx)).rejects.toThrow(/INVALID_PARAMS.*items/)
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

    expect(pg.query.mock.calls[0][0]).toContain('store_name = $1')
  })
})

describe('coupon.redeem', () => {
  // 共用的有效模板数据
  const validTemplate = {
    template_id: 'tpl-1',
    name: '新人专享券',
    coupon_type: '现金券',
    discount_value: 20,
    min_spend: 0,
    max_discount: null,
    applicable_category_ids: null,
    applicable_store_ids: null,
    valid_days: 30,
    template_expire_at: null,
    max_claims: null,
    claimed_count: 0,
    description: '新用户专属',
    is_active: true,
  }

  test('正常兑换（valid_days 计算有效期）', async () => {
    pg.query
      .mockResolvedValueOnce([validTemplate])   // 查找模板
      .mockResolvedValueOnce([])                // 检查用户是否已兑换

    pg.transaction.mockImplementation(async (cb) => {
      const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) }
      return cb(client)
    })

    const ctx = createBoundCtx({ code: 'NEWUSER2025' })
    await routes.redeem(ctx)

    expect(ctx.result.name).toBe('新人专享券')
    expect(ctx.result.couponType).toBe('现金券')
    expect(ctx.result.discountValue).toBe(20)
    expect(ctx.result.couponId).toMatch(/^cpn_/)
    // 有效期约 30 天后
    const diffDays = (new Date(ctx.result.expireAt) - new Date()) / (24 * 60 * 60 * 1000)
    expect(diffDays).toBeGreaterThan(29)
    expect(diffDays).toBeLessThan(31)
  })

  test('正常兑换（使用 template_expire_at 作为有效期）', async () => {
    const futureDate = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000) // 60天后
    const tpl = { ...validTemplate, valid_days: null, template_expire_at: futureDate.toISOString() }

    pg.query
      .mockResolvedValueOnce([tpl])
      .mockResolvedValueOnce([])

    pg.transaction.mockImplementation(async (cb) => {
      const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) }
      return cb(client)
    })

    const ctx = createBoundCtx({ code: 'SEASONAL' })
    await routes.redeem(ctx)

    expect(new Date(ctx.result.expireAt).getTime()).toBeCloseTo(futureDate.getTime(), -3)
  })

  test('正常兑换（无 valid_days 也无 template_expire_at → 默认30天）', async () => {
    const tpl = { ...validTemplate, valid_days: null, template_expire_at: null }

    pg.query
      .mockResolvedValueOnce([tpl])
      .mockResolvedValueOnce([])

    pg.transaction.mockImplementation(async (cb) => {
      const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) }
      return cb(client)
    })

    const ctx = createBoundCtx({ code: 'DEFAULT30' })
    await routes.redeem(ctx)

    const diffDays = (new Date(ctx.result.expireAt) - new Date()) / (24 * 60 * 60 * 1000)
    expect(diffDays).toBeGreaterThan(29)
    expect(diffDays).toBeLessThan(31)
  })

  test('事务正确执行：INSERT user_coupons + UPDATE claimed_count', async () => {
    pg.query
      .mockResolvedValueOnce([validTemplate])
      .mockResolvedValueOnce([])

    let capturedClient = null
    pg.transaction.mockImplementation(async (cb) => {
      const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) }
      capturedClient = client
      return cb(client)
    })

    const ctx = createBoundCtx({ code: 'TXTEST' })
    await routes.redeem(ctx)

    expect(capturedClient.query).toHaveBeenCalledTimes(2)
    const [firstSql] = capturedClient.query.mock.calls[0]
    const [secondSql] = capturedClient.query.mock.calls[1]
    expect(firstSql).toContain('INSERT INTO user_coupons')
    expect(secondSql).toContain('claimed_count = claimed_count + 1')
  })

  test('缺少兑换码 → INVALID_PARAMS', async () => {
    const ctx = createBoundCtx({})
    await expect(routes.redeem(ctx)).rejects.toThrow(/INVALID_PARAMS.*兑换码/)
  })

  test('空字符串兑换码 → INVALID_PARAMS', async () => {
    const ctx = createBoundCtx({ code: '   ' })
    await expect(routes.redeem(ctx)).rejects.toThrow(/INVALID_PARAMS.*兑换码/)
  })

  test('兑换码无效（模板不存在）→ INVALID_PARAMS', async () => {
    pg.query.mockResolvedValueOnce([])  // 模板不存在

    const ctx = createBoundCtx({ code: 'NOTEXIST' })
    await expect(routes.redeem(ctx)).rejects.toThrow(/INVALID_PARAMS.*兑换码无效/)
  })

  test('模板已失效 → INVALID_PARAMS', async () => {
    pg.query.mockResolvedValueOnce([{ ...validTemplate, is_active: false }])

    const ctx = createBoundCtx({ code: 'INACTIVE' })
    await expect(routes.redeem(ctx)).rejects.toThrow(/INVALID_PARAMS.*已失效/)
  })

  test('模板级过期 → INVALID_PARAMS', async () => {
    const expiredDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    pg.query.mockResolvedValueOnce([{
      ...validTemplate, valid_days: null, template_expire_at: expiredDate,
    }])

    const ctx = createBoundCtx({ code: 'EXPIRED' })
    await expect(routes.redeem(ctx)).rejects.toThrow(/INVALID_PARAMS.*已过期/)
  })

  test('达到领取上限 → INVALID_PARAMS', async () => {
    pg.query.mockResolvedValueOnce([{
      ...validTemplate, max_claims: 100, claimed_count: 100,
    }])

    const ctx = createBoundCtx({ code: 'MAXOUT' })
    await expect(routes.redeem(ctx)).rejects.toThrow(/INVALID_PARAMS.*已被领完/)
  })

  test('用户已兑换过同一券 → INVALID_PARAMS', async () => {
    pg.query
      .mockResolvedValueOnce([validTemplate])
      .mockResolvedValueOnce([{ coupon_id: 'cpn_existing' }])  // 已兑换

    const ctx = createBoundCtx({ code: 'DUPLICATE' })
    await expect(routes.redeem(ctx)).rejects.toThrow(/INVALID_PARAMS.*已兑换过/)
  })

  test('无手机号 → PHONE_REQUIRED', async () => {
    const ctx = createCtx({ payload: { code: 'TEST' }, auth: { phone: null } })
    await expect(routes.redeem(ctx)).rejects.toThrow(/PHONE_REQUIRED/)
  })
})
