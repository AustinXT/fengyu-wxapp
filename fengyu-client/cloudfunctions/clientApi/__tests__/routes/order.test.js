/**
 * 订单路由测试
 * 覆盖：create（正常/重复待支付/10分钟超时/优惠券）、pay、offlinePay、cancel、list、detail、appointableItems、scanDetail
 */

vi.mock('../../db/pg', () => require('../mocks/pg'))
vi.mock('wx-server-sdk', () => require('../mocks/wx-server-sdk'))
vi.mock('../../middleware/auth', async (importOriginal) => {
  const original = await importOriginal()
  return {
    ...original,
    // requirePhone 在 order 模块内部直接调用，需真实逻辑
    requirePhone: original.requirePhone,
    invalidateAuthCache: original.invalidateAuthCache,
  }
})

const pg = require('../../db/pg')
const { createCtx, createBoundCtx, createMockTransactionClient } = require('../helpers')

let routes
beforeEach(() => {
  vi.clearAllMocks()
  routes = require('../../routes/order')
})

describe('order.scanDetail', () => {
  test('待支付订单返回详情 + 明细', async () => {
    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-001',
        status: '待支付',
        store_id: 's1',
        sale_order_type: '普通',
        total_amount: 100,
        sale_order_source: 'staff',
      }])
      .mockResolvedValueOnce([{
        sale_item_id: 'SI-001',
        unit_price: 100,
        quantity: 1,
        received: 100,
        product_name: '美白护理',
        sku_spec_name: '10次卡',
      }])

    const ctx = createCtx({ payload: { orderNo: 'FY-001' } })
    await routes.scanDetail(ctx)

    expect(ctx.result.order.orderNo).toBe('FY-001')
    expect(ctx.result.items).toHaveLength(1)
  })

  test('非待支付订单返回状态提示', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-002',
      status: '已支付',
      sale_order_source: 'staff',
    }])

    const ctx = createCtx({ payload: { orderNo: 'FY-002' } })
    await routes.scanDetail(ctx)

    expect(ctx.result.status).toBe('已支付')
    expect(ctx.result.statusMsg).toContain('已完成支付')
  })

  test('缺少 orderNo → INVALID_PARAMS', async () => {
    const ctx = createCtx({ payload: {} })
    await expect(routes.scanDetail(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*orderNo/)
  })

  test('订单不存在 → INVALID_PARAMS', async () => {
    pg.query.mockResolvedValueOnce([])
    const ctx = createCtx({ payload: { orderNo: 'nonexistent' } })
    await expect(routes.scanDetail(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*订单不存在/)
  })
})

describe('order.create', () => {
  test('正常创建订单', async () => {
    const txClient = createMockTransactionClient([
      { rows: [], rowCount: 0 }, // advisory lock
      { rows: [], rowCount: 0 }, // 查最大序号
      { rows: [], rowCount: 0 }, // INSERT sale_orders
      { rows: [], rowCount: 0 }, // INSERT sale_items
    ])
    pg.transaction.mockImplementation(async (cb) => cb(txClient.query.getMockImplementation ? txClient : txClient))

    // requirePhone 不抛错（ctx.auth.phone 存在）
    // 查门店
    pg.query.mockResolvedValueOnce([{ store_id: 's1', store_name: '测试店', market_name: '华东' }])
    // 清理过期订单
    pg.query.mockResolvedValueOnce([])
    // 无待支付订单
    pg.query.mockResolvedValueOnce([])
    // 生成订单号
    pg.query.mockResolvedValueOnce([])
    // 查 SKU
    pg.query.mockResolvedValueOnce([{
      sku_id: 'sku-1', product_id: 'p1', product_type: '单品',
      spec_name: '标准', price: '100', special_price: null,
      session_count: 1, product_name: '护理A', sales_category: null,
    }])
    // 查顾客姓名
    pg.query.mockResolvedValueOnce([{ name: '张三' }])

    // transaction mock
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn()
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // advisory lock
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 查最大序号
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // INSERT sale_orders
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // INSERT sale_items
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
    await expect(routes.create(ctx))
      .rejects.toThrow(/PHONE_REQUIRED/)
  })

  test('已有待支付订单 → INVALID_PARAMS + pendingOrderNo', async () => {
    // 查门店
    pg.query.mockResolvedValueOnce([{ store_id: 's1', store_name: '测试店', market_name: '华东' }])
    // 清理过期
    pg.query.mockResolvedValueOnce([])
    // 存在待支付订单
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
    await expect(routes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*参数不完整/)
  })
})

describe('order.pay', () => {
  test('正常发起微信支付', async () => {
    const now = new Date()
    // 查订单
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '待支付',
      client_user_id: 'user-001',
      total_amount: 100,
      sale_order_datetime: now.toISOString(),
      sale_order_source: 'client',
    }])
    // UPDATE
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await routes.pay(ctx)

    expect(ctx.result.mockMode).toBe(true)
    expect(ctx.result.paymentParams).toBeDefined()
    expect(ctx.result.totalAmount).toBe(100)
  })

  test('缺少 orderNo → INVALID_PARAMS', async () => {
    const ctx = createBoundCtx({})
    await expect(routes.pay(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*orderNo/)
  })

  test('非本人订单 → PERMISSION_DENIED', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '待支付',
      client_user_id: 'other-user',
      sale_order_source: 'client',
    }])

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await expect(routes.pay(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('超时订单自动关闭', async () => {
    const expiredTime = new Date(Date.now() - 11 * 60 * 1000)
    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-001',
        status: '待支付',
        client_user_id: 'user-001',
        sale_order_datetime: expiredTime.toISOString(),
        sale_order_source: 'client',
      }])
      .mockResolvedValueOnce([]) // UPDATE 关闭

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await expect(routes.pay(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*超时/)
  })
})

describe('order.offlinePay', () => {
  test('正常选择线下付款', async () => {
    const now = new Date()
    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-001',
        status: '待支付',
        client_user_id: 'user-001',
        sale_order_datetime: now.toISOString(),
        sale_order_source: 'client',
      }])
      .mockResolvedValueOnce([])

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await routes.offlinePay(ctx)

    expect(ctx.result.status).toBe('待确认收款')
  })

  test('非待支付订单 → INVALID_PARAMS', async () => {
    const now = new Date()
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '已支付',
      client_user_id: 'user-001',
      sale_order_datetime: now.toISOString(),
      sale_order_source: 'client',
    }])

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await expect(routes.offlinePay(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*状态不允许/)
  })
})

describe('order.list', () => {
  test('返回用户订单列表', async () => {
    // 懒清理
    pg.query.mockResolvedValueOnce([])
    // 订单
    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'FY-001', status: '已支付', total_amount: 100 },
    ])
    // 明细
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

    // 验证 WHERE 包含 status 条件
    const listCall = pg.query.mock.calls[1]
    expect(listCall[0]).toContain('o.status = $')
    expect(listCall[1]).toContain('已关闭')
  })
})

describe('order.detail', () => {
  test('返回订单详情', async () => {
    // 查订单
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '已支付',
      client_user_id: 'user-001',
      sale_order_datetime: new Date().toISOString(),
      preferred_employee_id: null,
      coupon_id: null,
    }])
    // 查明细
    pg.query.mockResolvedValueOnce([
      { sale_item_id: 'SI-001', product_name: 'A' },
    ])

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await routes.detail(ctx)

    expect(ctx.result.order.sale_order_id).toBe('FY-001')
    expect(ctx.result.items).toHaveLength(1)
  })

  test('缺少 orderNo → INVALID_PARAMS', async () => {
    const ctx = createBoundCtx({})
    await expect(routes.detail(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*orderNo/)
  })

  test('订单不存在 → INVALID_PARAMS', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({ orderNo: 'nonexistent' })
    await expect(routes.detail(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*订单不存在/)
  })
})

describe('order.cancel', () => {
  test('正常取消待支付订单', async () => {
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '待支付',
      client_user_id: 'user-001',
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
      sale_order_id: 'FY-001',
      status: '已支付',
      client_user_id: 'user-001',
    }])

    const ctx = createBoundCtx({ orderNo: 'FY-001' })
    await expect(routes.cancel(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*不允许取消/)
  })
})

describe('order.appointableItems', () => {
  test('返回可预约项目列表', async () => {
    pg.query.mockResolvedValueOnce([
      {
        sale_order_id: 'FY-001',
        order_status: '已支付',
        store_id: 's1',
        store_name: '测试店',
        market_name: '华东',
        preferred_employee_id: null,
        sale_item_id: 'SI-001',
        sku_id: 'sku-1',
        product_name: '护理A',
        sku_spec_name: '10次卡',
        product_type: '疗程卡',
        session_count: 10,
        remaining_sessions: 8,
        unit_price: 100,
        unit_real_price: 80,
        sale_amount: 800,
        expire_date: null,
      },
    ])

    const ctx = createBoundCtx({})
    await routes.appointableItems(ctx)

    expect(ctx.result.orders).toHaveLength(1)
    expect(ctx.result.orders[0].items).toHaveLength(1)
    expect(ctx.result.orders[0].items[0].active).toBe(true)
  })
})
