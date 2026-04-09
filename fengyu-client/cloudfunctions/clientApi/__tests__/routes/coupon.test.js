/**
 * 优惠券路由测试
 * 覆盖：list（过期懒清理）、available（store/category 匹配、折扣计算）
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

  test('带品类限定的券查询品类名称（真凶 B：文案对齐）', async () => {
    pg.query.mockResolvedValueOnce([]) // 过期清扫
    pg.query.mockResolvedValueOnce([{  // 券查询
      coupon_id: 'c1', status: '未使用', expire_at: '2025-12-31',
      used_at: null, created_at: '2025-01-01',
      name: '护理品类券', coupon_type: '品项券', discount_value: 30, min_spend: 500,
      applicable_category_ids: ['cat-care'], applicable_store_ids: null, description: '',
    }])
    // 无 store 查询（applicable_store_ids 为 null），直接品类查询
    pg.query.mockResolvedValueOnce([{ category_id: 'cat-care', category_name: '护理项目' }])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    expect(ctx.result.coupons[0].applicableCategoryNames).toEqual(['护理项目'])
    expect(ctx.result.coupons[0].applicableStoreNames).toBeNull()
  })

  test('SELECT 真实包含 schema 存在的列（防假阳性 mock）', async () => {
    // 捕获 list 真实 SELECT SQL：包含合法列、不包含 schema 不存在的列
    pg.query.mockResolvedValueOnce([]) // 过期清扫
    pg.query.mockResolvedValueOnce([]) // 券查询（返回空即可，我们关心 SQL 文本）

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    const call = pg.query.mock.calls.find(
      ([sql]) => /FROM user_coupons/i.test(sql) && /JOIN coupon_templates/i.test(sql)
    )
    expect(call).toBeDefined()
    // 正向：SELECT 必须真实包含 schema 合法列
    expect(call[0]).toMatch(/ct\.coupon_type/)
    expect(call[0]).toMatch(/ct\.discount_value/)
    expect(call[0]).toMatch(/ct\.min_spend/)
    // 反向：SELECT 不得出现 schema 不存在的列
    expect(call[0]).not.toMatch(/redeem_code/)
    expect(call[0]).not.toMatch(/max_claims/)
    expect(call[0]).not.toMatch(/claimed_count/)
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

  // ========== 满减门槛浮点边界（真凶 C：归一化到分 + +0.001 兜底）==========

  test('边界：amount=500.00 恰好等于 minSpend=500 → 可用', async () => {
    pg.query.mockResolvedValueOnce([]) // 过期清扫
    pg.query.mockResolvedValueOnce([{  // 券查询
      coupon_id: 'c-edge', expire_at: '2027-12-31', template_id: 't1',
      name: '满500减50', coupon_type: '现金券', discount_value: 50, min_spend: 500,
      max_discount: null, applicable_store_ids: null,
      applicable_category_ids: null, description: '',
    }])
    pg.query.mockResolvedValueOnce([{ sku_id: 'sku-1', category_id: 'cat-1' }])

    const ctx = createBoundCtx({
      storeId: 'store-001',
      items: [{ skuId: 'sku-1', quantity: 1, amount: 500.00 }],
    })
    await routes.available(ctx)

    expect(ctx.result.coupons).toHaveLength(1)
    expect(ctx.result.coupons[0].discount).toBe(50)
  })

  test('边界：amount=499.99 < minSpend=500 → 不可用', async () => {
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'c-edge', expire_at: '2027-12-31', template_id: 't1',
      name: '满500减50', coupon_type: '现金券', discount_value: 50, min_spend: 500,
      max_discount: null, applicable_store_ids: null,
      applicable_category_ids: null, description: '',
    }])
    pg.query.mockResolvedValueOnce([{ sku_id: 'sku-1', category_id: 'cat-1' }])

    const ctx = createBoundCtx({
      storeId: 'store-001',
      items: [{ skuId: 'sku-1', quantity: 1, amount: 499.99 }],
    })
    await routes.available(ctx)

    expect(ctx.result.coupons).toHaveLength(0)
  })

  test('浮点兜底：99.9×5=499.4999... + minSpend=499.50 → 归一化后可用', async () => {
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'c-edge', expire_at: '2027-12-31', template_id: 't1',
      name: '满499.5减10', coupon_type: '现金券', discount_value: 10, min_spend: 499.5,
      max_discount: null, applicable_store_ids: null,
      applicable_category_ids: null, description: '',
    }])
    pg.query.mockResolvedValueOnce([{ sku_id: 'sku-1', category_id: 'cat-1' }])

    const ctx = createBoundCtx({
      storeId: 'store-001',
      items: [{ skuId: 'sku-1', quantity: 5, amount: 99.9 * 5 }], // 499.49999999999994
    })
    await routes.available(ctx)

    // Math.round(499.4999... * 100) / 100 = 499.5；或 +0.001 兜底
    expect(ctx.result.coupons).toHaveLength(1)
  })

  test('多行累加浮点：3 行 99.9 + minSpend=299.70 → 可用', async () => {
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'c-edge', expire_at: '2027-12-31', template_id: 't1',
      name: '满299.7减10', coupon_type: '现金券', discount_value: 10, min_spend: 299.7,
      max_discount: null, applicable_store_ids: null,
      applicable_category_ids: null, description: '',
    }])
    pg.query.mockResolvedValueOnce([
      { sku_id: 'sku-1', category_id: 'cat-1' },
      { sku_id: 'sku-2', category_id: 'cat-2' },
      { sku_id: 'sku-3', category_id: 'cat-3' },
    ])

    const ctx = createBoundCtx({
      storeId: 'store-001',
      items: [
        { skuId: 'sku-1', quantity: 1, amount: 99.9 },
        { skuId: 'sku-2', quantity: 1, amount: 99.9 },
        { skuId: 'sku-3', quantity: 1, amount: 99.9 },
      ],
    })
    await routes.available(ctx)

    // 99.9*3 = 299.70000000000005（JS 浮点）归一化到 299.70 + 0.001 兜底 → 可用
    expect(ctx.result.coupons).toHaveLength(1)
  })

  test('SELECT 真实包含 schema 存在的列（防假阳性 mock）', async () => {
    // 捕获 available 真实 SELECT SQL：包含合法列、不包含 schema 不存在的列
    pg.query.mockResolvedValueOnce([]) // 过期清扫
    pg.query.mockResolvedValueOnce([]) // 券查询（返回空即可，early return 前 SQL 已被记录）

    const ctx = createBoundCtx({
      storeId: 'store-001',
      items: [{ skuId: 'sku-1', quantity: 1, amount: 100 }],
    })
    await routes.available(ctx)

    const call = pg.query.mock.calls.find(
      ([sql]) => /FROM user_coupons/i.test(sql) && /JOIN coupon_templates/i.test(sql)
    )
    expect(call).toBeDefined()
    // 正向：SELECT 必须真实包含 schema 合法列
    expect(call[0]).toMatch(/ct\.coupon_type/)
    expect(call[0]).toMatch(/ct\.discount_value/)
    expect(call[0]).toMatch(/ct\.min_spend/)
    // 反向：SELECT 不得出现 schema 不存在的列
    expect(call[0]).not.toMatch(/redeem_code/)
    expect(call[0]).not.toMatch(/max_claims/)
    expect(call[0]).not.toMatch(/claimed_count/)
  })
})

