/**
 * 订单路由测试
 * 覆盖：create / confirmOffline / close / resetFailed / list / detail
 * 核心约束：
 *   - 开单仅店长
 *   - 待支付订单唯一性
 *   - 订单状态单向推进
 *   - 美容师行级过滤
 */

jest.mock('../../db/pg', () => require('../mocks/pg'))
jest.mock('wx-server-sdk', () => require('../mocks/wx-server-sdk'))
jest.mock('../../utils/wxacode', () => require('../mocks/wxacode'))

const pg = require('../../db/pg')
const { createManagerCtx, createBeauticianCtx } = require('../helpers')
const orderRoutes = require('../../routes/order')

describe('order.create', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('店长开单成功 — 普通订单', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      clientName: '测试顾客',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: 'offline',
      orderType: '普通',
    })

    // 查询顾客是否已注册
    pg.query
      .mockResolvedValueOnce([]) // client_wechat_users: 未注册
      .mockResolvedValueOnce([]) // 无待支付订单（按 phone+store）
      // SKU 查询
      .mockResolvedValueOnce([{
        sku_id: 'sku-001',
        product_id: 'prod-001',
        product_type: '疗程卡',
        spec_name: '基础款',
        price: '1000.00',
        session_count: 10,
        product_name: '面部护理',
        sales_category: '自采自销',
      }])
      // generateOrderNo
      .mockResolvedValueOnce([])

    // transaction mock
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
      }
      return await cb(client)
    })

    await orderRoutes.create(ctx)

    expect(ctx.result).toBeDefined()
    expect(ctx.result.saleOrderId).toMatch(/^FY-XSD-WX-\d{6}\d{4}$/)
    expect(ctx.result.totalAmount).toBe(1000)
    expect(ctx.result.status).toBe('待支付')
    expect(ctx.result.message).toBe('开单成功')
  })

  test('非店长拒绝开单', async () => {
    const ctx = createBeauticianCtx({
      clientPhone: '138',
      clientName: 'X',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: 'offline',
    })

    await expect(orderRoutes.create(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('缺少 clientPhone 抛出 INVALID_PARAMS', async () => {
    const ctx = createManagerCtx({
      clientName: 'X',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: 'offline',
    })

    await expect(orderRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*手机号/)
  })

  test('缺少 clientName 抛出 INVALID_PARAMS', async () => {
    const ctx = createManagerCtx({
      clientPhone: '138',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: 'offline',
    })

    await expect(orderRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*姓名/)
  })

  test('空 items 抛出 INVALID_PARAMS', async () => {
    const ctx = createManagerCtx({
      clientPhone: '138',
      clientName: 'X',
      items: [],
      paymentMethod: 'offline',
    })

    await expect(orderRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*商品明细/)
  })

  test('已注册顾客有待支付订单时拒绝', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      clientName: '测试顾客',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: 'offline',
    })

    pg.query
      .mockResolvedValueOnce([{ user_id: 'client-001' }])    // 已注册
      .mockResolvedValueOnce([{ sale_order_id: 'FY-exist' }]) // 已有待支付

    await expect(orderRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*已有待支付订单/)
  })

  test('未注册顾客同店有待支付订单时拒绝', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      clientName: '测试顾客',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: 'offline',
    })

    pg.query
      .mockResolvedValueOnce([])                              // 未注册
      .mockResolvedValueOnce([{ sale_order_id: 'FY-exist' }]) // 同店已有待支付

    await expect(orderRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*已有待支付订单/)
  })

  test('无效 orderType 拒绝', async () => {
    const ctx = createManagerCtx({
      clientPhone: '138',
      clientName: 'X',
      items: [{ skuId: 'sku-001', quantity: 1 }],
      paymentMethod: 'offline',
      orderType: '非法类型',
    })

    pg.query
      .mockResolvedValueOnce([]) // 未注册
      .mockResolvedValueOnce([]) // 无待支付

    await expect(orderRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*orderType/)
  })

  test('SKU 不存在时拒绝', async () => {
    const ctx = createManagerCtx({
      clientPhone: '138',
      clientName: 'X',
      items: [{ skuId: 'sku-nonexist', quantity: 1 }],
      paymentMethod: 'offline',
    })

    pg.query
      .mockResolvedValueOnce([])  // 未注册
      .mockResolvedValueOnce([])  // 无待支付
      .mockResolvedValueOnce([])  // SKU 不存在

    await expect(orderRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*SKU.*不存在/)
  })

  test('优惠金额超过 saleAmount 时拒绝', async () => {
    const ctx = createManagerCtx({
      clientPhone: '138',
      clientName: 'X',
      items: [{ skuId: 'sku-001', quantity: 1, discount: 99999 }],
      paymentMethod: 'offline',
    })

    pg.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sku_id: 'sku-001',
        product_id: 'prod-001',
        product_type: '单品',
        spec_name: 'S',
        price: '100.00',
        session_count: 1,
        product_name: 'P',
        sales_category: null,
      }])

    await expect(orderRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*优惠金额/)
  })

  test('体验订单使用 customPrice', async () => {
    const ctx = createManagerCtx({
      clientPhone: '138',
      clientName: 'X',
      items: [{ skuId: 'sku-001', quantity: 1, customPrice: 1 }],
      paymentMethod: 'offline',
      orderType: '体验',
    })

    pg.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sku_id: 'sku-001',
        product_id: 'prod-001',
        product_type: '疗程卡',
        spec_name: 'S',
        price: '1000.00',
        session_count: 10,
        product_name: 'P',
        sales_category: null,
      }])
      .mockResolvedValueOnce([]) // generateOrderNo

    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
      }
      return await cb(client)
    })

    await orderRoutes.create(ctx)

    expect(ctx.result.totalAmount).toBe(1) // customPrice 而非原价
  })
})

describe('order.confirmOffline', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('店长确认线下收款成功', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-XSD-WX-2401010001' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-XSD-WX-2401010001',
        status: '待确认收款',
        payment_method: 'offline',
        store_id: 'store-001',
      }])
      .mockResolvedValueOnce([
        { sale_item_id: 'item-001', sku_id: 'sku-001', received: '500', product_type: '疗程卡' },
      ])

    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
      }
      return await cb(client)
    })

    await orderRoutes.confirmOffline(ctx)

    expect(ctx.result.status).toBe('已支付')
    expect(ctx.result.totalReceived).toBe(500)
    expect(pg.transaction).toHaveBeenCalled()
  })

  test('非店长拒绝确认', async () => {
    const ctx = createBeauticianCtx({ saleOrderId: 'FY-001' })

    await expect(orderRoutes.confirmOffline(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('非线下支付订单拒绝直接确认', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-001' })

    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '待支付',
      payment_method: 'wechat',
      store_id: 'store-001',
    }])

    await expect(orderRoutes.confirmOffline(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*非线下支付/)
  })

  test('已支付订单拒绝重复确认', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-001' })

    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '已支付',
      payment_method: 'offline',
      store_id: 'store-001',
    }])

    await expect(orderRoutes.confirmOffline(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*不可确认/)
  })
})

describe('order.close', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('店长可关闭待支付订单', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-001' })

    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '待支付',
      store_id: 'store-001',
      opened_by: 'emp-other',
    }])

    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [], rowCount: 1 })
          .mockResolvedValueOnce({ rows: [{ sale_item_id: 'item-1' }] })
          .mockResolvedValueOnce({ rows: [], rowCount: 1 })
          .mockResolvedValue({ rows: [], rowCount: 0 }),
      }
      return await cb(client)
    })

    await orderRoutes.close(ctx)

    expect(ctx.result.status).toBe('已关闭')
  })

  test('店长可关闭支付失败订单', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-001' })

    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '支付失败',
      store_id: 'store-001',
      opened_by: 'emp-other',
    }])

    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      }
      return await cb(client)
    })

    await orderRoutes.close(ctx)
    expect(ctx.result.status).toBe('已关闭')
  })

  test('店长不能关闭已支付订单', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-001' })

    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '已支付',
      store_id: 'store-001',
      opened_by: 'emp-other',
    }])

    await expect(orderRoutes.close(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*不允许关闭/)
  })

  test('开单人可取消自己的待支付订单', async () => {
    const ctx = createBeauticianCtx({ saleOrderId: 'FY-001' })

    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '待支付',
      store_id: 'store-001',
      opened_by: 'emp-beautician-001', // 与 beautician ctx.auth.staffWfId 匹配
    }])

    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      }
      return await cb(client)
    })

    await orderRoutes.close(ctx)
    expect(ctx.result.status).toBe('已关闭')
  })

  test('非开单人美容师不能关闭订单', async () => {
    const ctx = createBeauticianCtx({ saleOrderId: 'FY-001' })

    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '待支付',
      store_id: 'store-001',
      opened_by: 'emp-other', // 不是当前用户
    }])

    await expect(orderRoutes.close(ctx))
      .rejects.toThrow(/PERMISSION_DENIED.*无权/)
  })

  test('关闭订单时作废分配并释放优惠券', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-001' })

    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '待支付',
      store_id: 'store-001',
      opened_by: 'emp-001',
    }])

    const clientQueryMock = jest.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE sale_orders
      .mockResolvedValueOnce({ rows: [{ sale_item_id: 'item-1' }, { sale_item_id: 'item-2' }] }) // SELECT sale_items
      .mockResolvedValueOnce({ rows: [], rowCount: 2 }) // UPDATE sale_allocations
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // UPDATE user_coupons

    pg.transaction.mockImplementation(async (cb) => {
      return await cb({ query: clientQueryMock })
    })

    await orderRoutes.close(ctx)

    // 验证 sale_allocations 被作废
    expect(clientQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('sale_allocations'),
      expect.arrayContaining([['item-1', 'item-2']])
    )
    // 验证 user_coupons 被释放
    expect(clientQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('user_coupons'),
      ['FY-001']
    )
  })
})

describe('order.resetFailed', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('店长重置支付失败订单为待支付', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-001' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-001',
        status: '支付失败',
        store_id: 'store-001',
      }])
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE

    await orderRoutes.resetFailed(ctx)

    expect(ctx.result.status).toBe('待支付')
  })

  test('非支付失败状态拒绝重置', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-001' })

    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '待支付',
      store_id: 'store-001',
    }])

    await expect(orderRoutes.resetFailed(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*不是支付失败/)
  })

  test('非店长拒绝重置', async () => {
    const ctx = createBeauticianCtx({ saleOrderId: 'FY-001' })

    await expect(orderRoutes.resetFailed(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })
})

describe('order.list', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('店长查看所有订单', async () => {
    const ctx = createManagerCtx({ page: 1, pageSize: 10 })

    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'FY-001', status: '待支付' },
      { sale_order_id: 'FY-002', status: '已支付' },
    ])

    await orderRoutes.list(ctx)

    expect(ctx.result.orders).toHaveLength(2)
    // 不应有 preferred_employee_id 过滤
    const sql = pg.query.mock.calls[0][0]
    expect(sql).not.toContain('preferred_employee_id')
  })

  test('美容师只看指定自己的订单', async () => {
    const ctx = createBeauticianCtx({ page: 1 })

    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'FY-001', status: '待支付' },
    ])

    await orderRoutes.list(ctx)

    const sql = pg.query.mock.calls[0][0]
    expect(sql).toContain('preferred_employee_id')
    // 参数中应包含 staffWfId
    expect(pg.query.mock.calls[0][1]).toContain('emp-beautician-001')
  })

  test('按状态过滤', async () => {
    const ctx = createManagerCtx({ status: '已支付', page: 1 })

    pg.query.mockResolvedValueOnce([])

    await orderRoutes.list(ctx)

    const params = pg.query.mock.calls[0][1]
    expect(params).toContain('已支付')
  })
})

describe('order.detail', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('店长查看订单详情', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-001' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-001',
        status: '已支付',
        store_id: 'store-001',
        preferred_employee_id: 'emp-b1',
        client_phone: '138',
        customer_name: '顾客A',
        coupon_id: null,
      }])
      .mockResolvedValueOnce([{ name: '美容师A' }])   // preferred_staff_name
      .mockResolvedValueOnce([{ sale_item_id: 'item-1' }]) // items
      .mockResolvedValueOnce([])                       // allocations

    await orderRoutes.detail(ctx)

    expect(ctx.result.order.sale_order_id).toBe('FY-001')
    expect(ctx.result.items).toHaveLength(1)
  })

  test('美容师不能查看非指定自己的订单', async () => {
    const ctx = createBeauticianCtx({ saleOrderId: 'FY-001' })

    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '已支付',
      store_id: 'store-001',
      preferred_employee_id: 'emp-other', // 不是当前美容师
    }])

    await expect(orderRoutes.detail(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })
})
