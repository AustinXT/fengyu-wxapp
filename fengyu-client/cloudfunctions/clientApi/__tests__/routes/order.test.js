/**
 * 订单路由测试
 * 覆盖：create（正常/重复待支付/10分钟超时/优惠券）、pay、offlinePay、cancel、list、detail、appointableItems、scanDetail
 */

const pg = globalThis.__mocks__.pg
const { createCtx, createBoundCtx, createMockTransactionClient } = require('../helpers')

let routes
beforeEach(() => {
  vi.clearAllMocks()
  // 清除路由和 auth 缓存
  Object.keys(require.cache).forEach(key => {
    if (key.includes('/routes/order') || key.includes('/middleware/auth')) {
      delete require.cache[key]
    }
  })
  routes = require('../../routes/order')
})

describe('order.scanDetail', () => {
  test('待支付订单返回详情 + 明细', async () => {
    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-001', status: '待支付', store_id: 's1',
        sale_order_type: '普通', total_amount: 100, sale_order_source: 'staff',
      }])
      .mockResolvedValueOnce([{
        sale_item_id: 'SI-001', unit_price: 100, quantity: 1, received: 100,
        product_name: '美白护理', sku_spec_name: '10次卡',
      }])

    const ctx = createCtx({ payload: { orderNo: 'FY-001' } })
    await routes.scanDetail(ctx)

    expect(ctx.result.order.orderNo).toBe('FY-001')
    expect(ctx.result.items).toHaveLength(1)
  })

  test('非待支付订单返回状态提示', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-002', status: '已支付', sale_order_source: 'staff',
    }])

    const ctx = createCtx({ payload: { orderNo: 'FY-002' } })
    await routes.scanDetail(ctx)

    expect(ctx.result.status).toBe('已支付')
    expect(ctx.result.statusMsg).toContain('已完成支付')
  })

  test('缺少 saleOrderId → INVALID_PARAMS', async () => {
    const ctx = createCtx({ payload: {} })
    await expect(routes.scanDetail(ctx)).rejects.toThrow(/INVALID_PARAMS.*saleOrderId/)
  })

  test('订单不存在 → INVALID_PARAMS', async () => {
    pg.query.mockResolvedValueOnce([])
    const ctx = createCtx({ payload: { orderNo: 'nonexistent' } })
    await expect(routes.scanDetail(ctx)).rejects.toThrow(/INVALID_PARAMS.*订单不存在/)
  })
})

describe('order.create', () => {
  test('正常创建订单', async () => {
    pg.query.mockResolvedValueOnce([{ store_id: 's1', store_name: '测试店', market_name: '华东' }])
    pg.query.mockResolvedValueOnce([])  // closeExpiredOrdersByUser
    pg.query.mockResolvedValueOnce([])  // check pending
    pg.query.mockResolvedValueOnce([{   // SKU query
      sku_id: 'sku-1', product_id: 'p1', product_type: '单品',
      spec_name: '标准', price: '100', special_price: null,
      session_count: 1, product_name: '护理A', sales_category: null,
    }])

    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn()
          .mockResolvedValueOnce({ rows: [], rowCount: 0 })
          .mockResolvedValueOnce({ rows: [], rowCount: 0 })
          .mockResolvedValueOnce({ rows: [], rowCount: 0 })
          .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      }
      return cb(client)
    })

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: 'wechat',
    })
    await routes.create(ctx)

    expect(ctx.result.orderNo).toMatch(/^FY-XSD-WX-/)
    expect(ctx.result.totalAmount).toBe(100)
    expect(ctx.result.status).toBe('待支付')
  })

  test('无手机号 → PHONE_REQUIRED', async () => {
    const ctx = createCtx({
      payload: { storeId: 's1', items: [{ skuId: 'sku-1' }], paymentMethod: 'wechat' },
      auth: { phone: null },
    })
    await expect(routes.create(ctx)).rejects.toThrow(/PHONE_REQUIRED/)
  })

  test('已有待支付订单 → INVALID_PARAMS + pendingOrderNo', async () => {
    pg.query.mockResolvedValueOnce([{ store_id: 's1', store_name: '测试店', market_name: '华东' }])
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([{ sale_order_id: 'FY-PENDING-001' }])

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: 'wechat',
    })

    try {
      await routes.create(ctx)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err.message).toContain('INVALID_PARAMS')
      expect(err.data.pendingOrderNo).toBe('FY-PENDING-001')
    }
  })

  test('参数不完整 → INVALID_PARAMS', async () => {
    const ctx = createBoundCtx({ storeId: 's1' })
    await expect(routes.create(ctx)).rejects.toThrow(/INVALID_PARAMS.*参数不完整/)
  })

  // ========== 优惠券抵扣路径 ==========

  function mockBaseCreateQueries(skuOverrides = {}) {
    // mock 1: 门店
    pg.query.mockResolvedValueOnce([{ store_id: 's1', store_name: '测试店', market_name: '华东' }])
    // mock 2: closeExpiredOrdersByUser
    pg.query.mockResolvedValueOnce([])
    // mock 3: check pending
    pg.query.mockResolvedValueOnce([])
    // mock 4: SKU 信息
    pg.query.mockResolvedValueOnce([{
      sku_id: 'sku-1', product_id: 'p1', product_type: '单品',
      spec_name: '标准', price: '200', special_price: null,
      session_count: 1, product_name: '护理A', sales_category: null,
      ...skuOverrides,
    }])
  }

  function mockCreateTransaction() {
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn()
          .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // advisory lock
          .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // order seq
          .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // item seq
          .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // coupon claim
          .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // INSERT order
          .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // INSERT item
      }
      return cb(client)
    })
  }

  test('优惠券抵扣：现金券 ¥50 减免', async () => {
    mockBaseCreateQueries()
    // mock 5: 优惠券验证
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'cpn-1', user_id: 'user-001', expire_at: new Date(Date.now() + 86400000),
      coupon_type: '现金券', discount_value: 50, min_spend: 0,
      applicable_category_ids: null, applicable_store_ids: null,
    }])
    // mock 6: SKU 品项分类
    pg.query.mockResolvedValueOnce([{ sku_id: 'sku-1', category_id: 'cat-1' }])
    // mock 7: 顾客名称
    pg.query.mockResolvedValueOnce([{ name: '张三' }])
    mockCreateTransaction()

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: 'wechat',
      couponId: 'cpn-1',
    })
    await routes.create(ctx)

    expect(ctx.result.totalAmount).toBe(150)  // 200 - 50
    expect(ctx.result.status).toBe('待支付')
  })

  test('优惠券抵扣不超过商品金额', async () => {
    mockBaseCreateQueries({ price: '30' })
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'cpn-2', user_id: 'user-001', expire_at: new Date(Date.now() + 86400000),
      coupon_type: '现金券', discount_value: 50, min_spend: 0,
      applicable_category_ids: null, applicable_store_ids: null,
    }])
    pg.query.mockResolvedValueOnce([{ sku_id: 'sku-1', category_id: 'cat-1' }])
    pg.query.mockResolvedValueOnce([{ name: '张三' }])
    mockCreateTransaction()

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: 'wechat',
      couponId: 'cpn-2',
    })
    await routes.create(ctx)

    // discount capped at saleAmount ¥30, not ¥50
    expect(ctx.result.totalAmount).toBe(0)
  })

  test('优惠券已失效 → INVALID_PARAMS', async () => {
    mockBaseCreateQueries()
    // 优惠券不存在或已过期
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: 'wechat',
      couponId: 'cpn-expired',
    })
    await expect(routes.create(ctx)).rejects.toThrow(/INVALID_PARAMS.*优惠券已失效/)
  })

  test('优惠券门店不匹配 → INVALID_PARAMS', async () => {
    mockBaseCreateQueries()
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'cpn-3', user_id: 'user-001', expire_at: new Date(Date.now() + 86400000),
      coupon_type: '现金券', discount_value: 20, min_spend: 0,
      applicable_category_ids: null,
      applicable_store_ids: ['store-other'],  // 不包含 's1'
    }])

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: 'wechat',
      couponId: 'cpn-3',
    })
    await expect(routes.create(ctx)).rejects.toThrow(/INVALID_PARAMS.*不适用于此门店/)
  })

  test('优惠券品项分类不匹配 → INVALID_PARAMS', async () => {
    mockBaseCreateQueries()
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'cpn-4', user_id: 'user-001', expire_at: new Date(Date.now() + 86400000),
      coupon_type: '项目券', discount_value: 30, min_spend: 0,
      applicable_category_ids: ['cat-special'],  // 限定分类
      applicable_store_ids: null,
    }])
    // SKU 的 category_id 不在 applicable_category_ids 中
    pg.query.mockResolvedValueOnce([{ sku_id: 'sku-1', category_id: 'cat-other' }])

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: 'wechat',
      couponId: 'cpn-4',
    })
    await expect(routes.create(ctx)).rejects.toThrow(/INVALID_PARAMS.*不适用于当前商品/)
  })

  test('优惠券未满足满减条件 → INVALID_PARAMS', async () => {
    mockBaseCreateQueries({ price: '80' })
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'cpn-5', user_id: 'user-001', expire_at: new Date(Date.now() + 86400000),
      coupon_type: '现金券', discount_value: 20, min_spend: 100,  // 满100可用
      applicable_category_ids: null, applicable_store_ids: null,
    }])
    pg.query.mockResolvedValueOnce([{ sku_id: 'sku-1', category_id: 'cat-1' }])

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-1', quantity: 1 }],
      paymentMethod: 'wechat',
      couponId: 'cpn-5',
    })
    // 商品 ¥80 < 满减门槛 ¥100
    await expect(routes.create(ctx)).rejects.toThrow(/INVALID_PARAMS.*未满足使用条件/)
  })

  test('多商品订单优惠券按比例分摊', async () => {
    // mock 1: 门店
    pg.query.mockResolvedValueOnce([{ store_id: 's1', store_name: '测试店', market_name: '华东' }])
    // mock 2: closeExpired
    pg.query.mockResolvedValueOnce([])
    // mock 3: check pending
    pg.query.mockResolvedValueOnce([])
    // mock 4: SKU 信息（2个 SKU）
    pg.query.mockResolvedValueOnce([
      { sku_id: 'sku-a', product_id: 'pa', product_type: '单品', spec_name: '标准', price: '300', special_price: null, session_count: 1, product_name: '护理A', sales_category: null },
      { sku_id: 'sku-b', product_id: 'pb', product_type: '疗程卡', spec_name: '5次卡', price: '200', special_price: null, session_count: 5, product_name: '护理B', sales_category: null },
    ])
    // mock 5: 优惠券
    pg.query.mockResolvedValueOnce([{
      coupon_id: 'cpn-multi', user_id: 'user-001', expire_at: new Date(Date.now() + 86400000),
      coupon_type: '现金券', discount_value: 100, min_spend: 0,
      applicable_category_ids: null, applicable_store_ids: null,
    }])
    // mock 6: 品项分类
    pg.query.mockResolvedValueOnce([
      { sku_id: 'sku-a', category_id: 'cat-1' },
      { sku_id: 'sku-b', category_id: 'cat-2' },
    ])
    // mock 7: 顾客名
    pg.query.mockResolvedValueOnce([{ name: '李四' }])

    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn()
          .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // advisory lock
          .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // order seq
          .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // item seq
          .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // coupon claim
          .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // INSERT order
          .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // INSERT item A
          .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // INSERT item B
      }
      return cb(client)
    })

    const ctx = createBoundCtx({
      storeId: 's1',
      items: [{ skuId: 'sku-a', quantity: 1 }, { skuId: 'sku-b', quantity: 1 }],
      paymentMethod: 'offline',
      couponId: 'cpn-multi',
    })
    await routes.create(ctx)

    // 总价 500-100=400
    expect(ctx.result.totalAmount).toBe(400)
  })
})

describe('order.pay', () => {
  test('正常发起微信支付', async () => {
    const now = new Date()
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001', status: '待支付',
      client_user_id: 'user-001', total_amount: 100,
      sale_order_datetime: now.toISOString(), sale_order_source: 'client',
    }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await routes.pay(ctx)

    expect(ctx.result.mockMode).toBe(true)
    expect(ctx.result.paymentParams).toBeDefined()
  })

  test('缺少 saleOrderId → INVALID_PARAMS', async () => {
    const ctx = createBoundCtx({})
    await expect(routes.pay(ctx)).rejects.toThrow(/INVALID_PARAMS.*saleOrderId/)
  })

  test('非本人订单 → PERMISSION_DENIED', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001', status: '待支付',
      client_user_id: 'other-user', sale_order_source: 'client',
    }])

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await expect(routes.pay(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('超时订单自动关闭', async () => {
    const expiredTime = new Date(Date.now() - 11 * 60 * 1000)
    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-001', status: '待支付',
        client_user_id: 'user-001', sale_order_source: 'client',
        sale_order_datetime: expiredTime.toISOString(),
      }])
      .mockResolvedValueOnce([])

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await expect(routes.pay(ctx)).rejects.toThrow(/INVALID_PARAMS.*超时/)
  })
})

describe('order.offlinePay', () => {
  test('正常选择线下付款', async () => {
    const now = new Date()
    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-001', status: '待支付',
        client_user_id: 'user-001', sale_order_source: 'client',
        sale_order_datetime: now.toISOString(),
      }])
      .mockResolvedValueOnce([])

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await routes.offlinePay(ctx)

    expect(ctx.result.status).toBe('待确认收款')
  })

  test('非待支付订单 → INVALID_PARAMS', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001', status: '已支付',
      client_user_id: 'user-001', sale_order_source: 'client',
      sale_order_datetime: new Date().toISOString(),
    }])

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await expect(routes.offlinePay(ctx)).rejects.toThrow(/INVALID_PARAMS.*状态不允许/)
  })
})

describe('order.list', () => {
  test('返回用户订单列表', async () => {
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'FY-001', status: '已支付', total_amount: 100 },
    ])
    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'FY-001', sale_item_id: 'SI-001', product_name: 'A' },
    ])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    expect(ctx.result.orders).toHaveLength(1)
    expect(ctx.result.orders[0].items).toHaveLength(1)
  })

  test('按状态筛选', async () => {
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({ status: '已关闭' })
    await routes.list(ctx)

    const listCall = pg.query.mock.calls[1]
    expect(listCall[0]).toContain('o.status = $')
    expect(listCall[1]).toContain('已关闭')
  })
})

describe('order.detail', () => {
  test('返回订单详情', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001', status: '已支付',
      client_user_id: 'user-001',
      sale_order_datetime: new Date().toISOString(),
      preferred_employee_id: null, coupon_id: null,
    }])
    pg.query.mockResolvedValueOnce([{ sale_item_id: 'SI-001', product_name: 'A' }])

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await routes.detail(ctx)

    expect(ctx.result.order.sale_order_id).toBe('FY-001')
    expect(ctx.result.items).toHaveLength(1)
  })

  test('缺少 saleOrderId → INVALID_PARAMS', async () => {
    const ctx = createBoundCtx({})
    await expect(routes.detail(ctx)).rejects.toThrow(/INVALID_PARAMS.*saleOrderId/)
  })

  test('订单不存在 → INVALID_PARAMS', async () => {
    pg.query.mockResolvedValueOnce([])
    const ctx = createBoundCtx({ orderNo: 'nonexistent' })
    await expect(routes.detail(ctx)).rejects.toThrow(/INVALID_PARAMS.*订单不存在/)
  })
})

describe('order.cancel', () => {
  test('正常取消待支付订单', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001', status: '待支付', client_user_id: 'user-001',
    }])
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn()
          .mockResolvedValueOnce({ rows: [], rowCount: 1 })
          .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      }
      return cb(client)
    })

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await routes.cancel(ctx)

    expect(ctx.result.status).toBe('已关闭')
  })

  test('非待支付订单不允许取消', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001', status: '已支付', client_user_id: 'user-001',
    }])

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await expect(routes.cancel(ctx)).rejects.toThrow(/INVALID_PARAMS.*不允许取消/)
  })
})

describe('order.appointableItems', () => {
  test('返回可预约项目列表', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001', order_status: '已支付',
      store_id: 's1', store_name: '测试店', market_name: '华东',
      preferred_employee_id: null, sale_item_id: 'SI-001',
      sku_id: 'sku-1', product_name: '护理A', sku_spec_name: '10次卡',
      product_type: '疗程卡', session_count: 10, remaining_sessions: 8,
      unit_price: 100, unit_real_price: 80, sale_amount: 800, expire_date: null,
    }])

    const ctx = createBoundCtx({})
    await routes.appointableItems(ctx)

    expect(ctx.result.orders).toHaveLength(1)
    expect(ctx.result.orders[0].items).toHaveLength(1)
    expect(ctx.result.orders[0].items[0].active).toBe(true)
  })
})
