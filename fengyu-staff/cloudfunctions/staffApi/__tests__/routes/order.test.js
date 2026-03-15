/**
 * 订单路由测试
 * 覆盖：create / confirmOffline / close / resetFailed / list / detail
 * 核心约束：
 *   - 开单仅店长
 *   - 待支付订单唯一性
 *   - 订单状态单向推进
 *   - 美容师行级过滤
 */



const pg = globalThis.__mocks__.pg
const { createManagerCtx, createBeauticianCtx } = require('../helpers')
const orderRoutes = require('../../routes/order')

describe('order.create', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
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
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
      }
      return await cb(client)
    })

    await orderRoutes.create(ctx)

    expect(ctx.result.totalAmount).toBe(1) // customPrice 而非原价
  })
})

describe('order.confirmOffline', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
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
    vi.clearAllMocks()
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
        query: vi.fn()
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
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
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
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
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

    const clientQueryMock = vi.fn()
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
    vi.clearAllMocks()
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
    vi.clearAllMocks()
  })

  test('店长查看所有订单', async () => {
    const ctx = createManagerCtx({ page: 1, pageSize: 10 })

    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'FY-001', status: '待支付' },
      { sale_order_id: 'FY-002', status: '已支付' },
    ])

    await orderRoutes.list(ctx)

    expect(ctx.result.orders).toHaveLength(2)
    // 不应有 preferred_employee_id WHERE 过滤（SELECT 列包含该字段是正常的）
    const sql = pg.query.mock.calls[0][0]
    expect(sql).not.toContain('AND o.preferred_employee_id')
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
    vi.clearAllMocks()
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

// ============================================================
// order.qrcode
// ============================================================
describe('order.qrcode', () => {
  const wxacode = globalThis.__mocks__.wxacode

  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('待支付订单返回二维码', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-QR-001' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-QR-001', status: '待支付', sale_order_type: '普通',
        client_phone: '138', customer_name: '张三', payment_method: 'offline',
        paid_at: null, store_id: 'store-001', opened_by: 'emp-001',
      }])
      .mockResolvedValueOnce([
        { sale_item_id: 'item-1', received: '500', product_name: '面部护理', sku_spec_name: '基础款' },
      ])

    await orderRoutes.qrcode(ctx)

    expect(ctx.result.saleOrderId).toBe('FY-QR-001')
    expect(ctx.result.qrCodeStatus).toBe('待扫码')
    expect(ctx.result.qrcodeUrl).toBe('cloud://mock-file-id/wxacode.png')
    expect(ctx.result.qrcodeError).toBe('')
    expect(ctx.result.totalAmount).toBe(500)
    expect(ctx.result.items).toHaveLength(1)
    expect(wxacode.generateWxacode).toHaveBeenCalledWith('FY-QR-001', expect.any(String))
  })

  test('已支付订单不生成二维码', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-QR-002' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-QR-002', status: '已支付', sale_order_type: '普通',
        client_phone: '138', customer_name: '张三', payment_method: 'offline',
        paid_at: '2024-06-15', store_id: 'store-001', opened_by: 'emp-001',
      }])
      .mockResolvedValueOnce([
        { sale_item_id: 'item-1', received: '1000', product_name: 'P1', sku_spec_name: 'S1' },
      ])

    await orderRoutes.qrcode(ctx)

    expect(ctx.result.qrCodeStatus).toBe('已支付')
    expect(ctx.result.qrcodeUrl).toBe('')
    expect(wxacode.generateWxacode).not.toHaveBeenCalled()
  })

  test('待确认收款状态映射', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-QR-003' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-QR-003', status: '待确认收款', sale_order_type: '普通',
        client_phone: '138', customer_name: '张三', payment_method: 'wechat',
        paid_at: null, store_id: 'store-001', opened_by: 'emp-001',
      }])
      .mockResolvedValueOnce([])

    await orderRoutes.qrcode(ctx)

    expect(ctx.result.qrCodeStatus).toBe('待确认收款')
  })

  test('订单不存在时拒绝', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-NONEXIST' })
    pg.query.mockResolvedValueOnce([])

    await expect(orderRoutes.qrcode(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*订单不存在/)
  })

  test('缺少 saleOrderId 时拒绝', async () => {
    const ctx = createManagerCtx({})
    await expect(orderRoutes.qrcode(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*saleOrderId/)
  })

  test('二维码生成失败时设置 qrcodeError', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-QR-ERR' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-QR-ERR', status: '待支付', sale_order_type: '普通',
        client_phone: '138', customer_name: '张三', payment_method: 'offline',
        paid_at: null, store_id: 'store-001', opened_by: 'emp-001',
      }])
      .mockResolvedValueOnce([])

    wxacode.generateWxacode.mockRejectedValueOnce(new Error('生成失败'))

    await orderRoutes.qrcode(ctx)

    expect(ctx.result.qrcodeUrl).toBe('')
    expect(ctx.result.qrcodeError).toBe('生成小程序码失败')
  })

  test('非本店美容师不能查看', async () => {
    const ctx = createBeauticianCtx({ saleOrderId: 'FY-QR-004' })

    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-QR-004', status: '待支付', sale_order_type: '普通',
      client_phone: '138', customer_name: '张三', payment_method: 'offline',
      paid_at: null, store_id: 'store-other', opened_by: 'emp-001',
    }])

    await expect(orderRoutes.qrcode(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('支持 orderNo 兼容参数', async () => {
    const ctx = createManagerCtx({})
    ctx.event.payload = { orderNo: 'FY-COMPAT-001' }

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-COMPAT-001', status: '已支付', sale_order_type: '普通',
        client_phone: '138', customer_name: '张三', payment_method: 'offline',
        paid_at: '2024-06-15', store_id: 'store-001', opened_by: 'emp-001',
      }])
      .mockResolvedValueOnce([])

    await orderRoutes.qrcode(ctx)

    expect(ctx.result.saleOrderId).toBe('FY-COMPAT-001')
  })
})

// ============================================================
// order.createRefund
// ============================================================
describe('order.createRefund', () => {
  beforeEach(() => { vi.clearAllMocks() })

  test('创建退款单成功', async () => {
    const ctx = createManagerCtx({
      refSaleOrderId: 'FY-ORIG-001',
      items: [{ saleItemId: 'item-001', refundQuantity: 1 }],
      refundReason: '质量问题',
      handlingFee: 50,
    })

    // 查原单
    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-ORIG-001', status: '已支付', store_id: 'store-001',
        client_user_id: 'cu-001', client_phone: '138', customer_name: '张三',
        payment_method: 'offline',
      }])
      // 查原单明细
      .mockResolvedValueOnce([{
        sale_item_id: 'item-001', sku_id: 'sku-001', product_name: '面部护理',
        sku_spec_name: '基础款', product_type: '疗程卡', session_count: 10,
        unit_price: '1000', unit_real_price: '1000', quantity: 1,
        sales_category: '自采自销',
      }])
      // generateOrderNo
      .mockResolvedValueOnce([])

    pg.transaction.mockImplementation(async (cb) => {
      const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) }
      return await cb(client)
    })

    await orderRoutes.createRefund(ctx)

    expect(ctx.result.status).toBe('待审批')
    expect(ctx.result.totalAmount).toBe(-950) // -(1000 - 50)
    expect(ctx.result.message).toContain('退款单已创建')
  })

  test('非店长拒绝', async () => {
    const ctx = createBeauticianCtx({ refSaleOrderId: 'FY-001', items: [{}], refundReason: 'x' })
    await expect(orderRoutes.createRefund(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('缺少原单号拒绝', async () => {
    const ctx = createManagerCtx({ items: [{}], refundReason: 'x' })
    await expect(orderRoutes.createRefund(ctx)).rejects.toThrow(/INVALID_PARAMS.*原销售单号/)
  })

  test('退款明细为空拒绝', async () => {
    const ctx = createManagerCtx({ refSaleOrderId: 'FY-001', items: [], refundReason: 'x' })
    await expect(orderRoutes.createRefund(ctx)).rejects.toThrow(/INVALID_PARAMS.*退款明细/)
  })

  test('原单不存在拒绝', async () => {
    const ctx = createManagerCtx({
      refSaleOrderId: 'FY-NOEXIST', items: [{ saleItemId: 'i1' }], refundReason: 'x',
    })
    pg.query.mockResolvedValueOnce([])
    await expect(orderRoutes.createRefund(ctx)).rejects.toThrow(/INVALID_PARAMS.*原订单/)
  })

  test('明细不存在拒绝', async () => {
    const ctx = createManagerCtx({
      refSaleOrderId: 'FY-001', items: [{ saleItemId: 'item-wrong' }], refundReason: 'x',
    })
    pg.query
      .mockResolvedValueOnce([{ sale_order_id: 'FY-001', status: '已支付', store_id: 'store-001', client_user_id: null, client_phone: '138', customer_name: 'C', payment_method: 'offline' }])
      .mockResolvedValueOnce([{ sale_item_id: 'item-001' }]) // 原单明细中无 item-wrong

    await expect(orderRoutes.createRefund(ctx)).rejects.toThrow(/INVALID_PARAMS.*item-wrong.*不存在/)
  })
})

// ============================================================
// order.approveRefund
// ============================================================
describe('order.approveRefund', () => {
  beforeEach(() => { vi.clearAllMocks() })

  test('审批退款单成功', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-TKD-001' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-TKD-001', status: '待审批', sale_order_type: '退款', store_id: 'store-001',
      }])
      .mockResolvedValueOnce([{
        sale_item_id: 'ref-item-1', item_direction: 'refund_out',
        ref_sale_item_id: 'orig-item-1', session_count: 10, quantity: 1,
      }])

    pg.transaction.mockImplementation(async (cb) => {
      const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) }
      return await cb(client)
    })

    await orderRoutes.approveRefund(ctx)

    expect(ctx.result.status).toBe('已支付')
    expect(ctx.result.message).toContain('审批通过')
  })

  test('退款单不存在拒绝', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-NOEXIST' })
    pg.query.mockResolvedValueOnce([])
    await expect(orderRoutes.approveRefund(ctx)).rejects.toThrow(/INVALID_PARAMS.*退款单不存在/)
  })

  test('次数不足时回滚', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-TKD-002' })

    pg.query
      .mockResolvedValueOnce([{ sale_order_id: 'FY-TKD-002', status: '待审批', sale_order_type: '退款', store_id: 'store-001' }])
      .mockResolvedValueOnce([{ sale_item_id: 'ref-item-1', item_direction: 'refund_out', ref_sale_item_id: 'orig-item-1', session_count: 10, quantity: 5 }])

    pg.transaction.mockImplementation(async (cb) => {
      const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }
      return await cb(client)
    })

    await expect(orderRoutes.approveRefund(ctx)).rejects.toThrow(/剩余次数不足/)
  })

  test('非店长拒绝', async () => {
    const ctx = createBeauticianCtx({ saleOrderId: 'FY-TKD-001' })
    await expect(orderRoutes.approveRefund(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })
})

// ============================================================
// order.rejectRefund
// ============================================================
describe('order.rejectRefund', () => {
  beforeEach(() => { vi.clearAllMocks() })

  test('驳回退款单成功', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-TKD-003', rejectedReason: '不符合条件' })
    pg.query.mockResolvedValueOnce({ rowCount: 1 })

    await orderRoutes.rejectRefund(ctx)

    expect(ctx.result.status).toBe('已关闭')
    expect(ctx.result.message).toContain('已驳回')
  })

  test('退款单不存在拒绝', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-NOEXIST' })
    pg.query.mockResolvedValueOnce({ rowCount: 0 })
    await expect(orderRoutes.rejectRefund(ctx)).rejects.toThrow(/INVALID_PARAMS.*退款单/)
  })

  test('非店长拒绝', async () => {
    const ctx = createBeauticianCtx({ saleOrderId: 'FY-TKD-003' })
    await expect(orderRoutes.rejectRefund(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })
})

// ============================================================
// order.createRepayment
// ============================================================
describe('order.createRepayment', () => {
  beforeEach(() => { vi.clearAllMocks() })

  test('创建回款单成功', async () => {
    const ctx = createManagerCtx({
      refSaleOrderId: 'FY-ORIG-001',
      items: [{ saleItemId: 'item-001', repayAmount: 200 }],
      paymentMethod: 'offline',
    })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-ORIG-001', store_id: 'store-001',
        client_user_id: 'cu-001', client_phone: '138', customer_name: '张三',
      }])
      .mockResolvedValueOnce([{
        sale_item_id: 'item-001', sku_id: 'sku-001', product_name: 'P1',
        sku_spec_name: 'S1', product_type: '疗程卡', sales_category: '自采自销',
      }])
      .mockResolvedValueOnce([]) // generateOrderNo

    pg.transaction.mockImplementation(async (cb) => {
      const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) }
      return await cb(client)
    })

    await orderRoutes.createRepayment(ctx)

    expect(ctx.result.status).toBe('待支付')
    expect(ctx.result.totalAmount).toBe(200)
    expect(ctx.result.message).toContain('回款单已创建')
  })

  test('缺少原单号拒绝', async () => {
    const ctx = createManagerCtx({ items: [{ saleItemId: 'i1', repayAmount: 100 }] })
    await expect(orderRoutes.createRepayment(ctx)).rejects.toThrow(/INVALID_PARAMS.*原销售单号/)
  })

  test('回款金额 <= 0 拒绝', async () => {
    const ctx = createManagerCtx({
      refSaleOrderId: 'FY-001', items: [{ saleItemId: 'item-001', repayAmount: 0 }],
    })
    pg.query
      .mockResolvedValueOnce([{ sale_order_id: 'FY-001', store_id: 'store-001', client_user_id: null, client_phone: '138', customer_name: 'C' }])
      .mockResolvedValueOnce([{ sale_item_id: 'item-001', sku_id: 'sku-001', product_name: 'P1', sku_spec_name: 'S1', product_type: '单品', sales_category: null }])

    await expect(orderRoutes.createRepayment(ctx)).rejects.toThrow(/INVALID_PARAMS.*回款金额/)
  })

  test('非店长拒绝', async () => {
    const ctx = createBeauticianCtx({ refSaleOrderId: 'FY-001', items: [{ saleItemId: 'i1', repayAmount: 100 }] })
    await expect(orderRoutes.createRepayment(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })
})

// ============================================================
// order.createConversion
// ============================================================
describe('order.createConversion', () => {
  beforeEach(() => { vi.clearAllMocks() })

  test('创建转换单成功', async () => {
    const ctx = createManagerCtx({
      refSaleOrderId: 'FY-ORIG-001',
      convertOutItems: [{ saleItemId: 'item-001', convertQuantity: 1 }],
      convertInItems: [{ skuId: 'sku-new', quantity: 1 }],
    })

    pg.query
      // 查原单
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-ORIG-001', status: '已支付', store_id: 'store-001',
        client_user_id: 'cu-001', client_phone: '138', customer_name: '张三',
      }])
      // 查原明细行
      .mockResolvedValueOnce([{
        sale_item_id: 'item-001', sale_order_id: 'FY-ORIG-001', item_direction: 'purchase',
        sku_id: 'sku-old', product_name: '旧项目', sku_spec_name: '标准',
        product_type: '疗程卡', session_count: 10, unit_price: '1000',
        unit_real_price: '1000', quantity: 1, sales_category: '自采自销',
      }])
      // 查新 SKU
      .mockResolvedValueOnce([{
        sku_id: 'sku-new', product_id: 'p-new', spec_name: '高级款',
        product_type: '疗程卡', session_count: 10, price: '1500',
        product_name: '新项目', sales_category: '自采自销',
      }])
      // generateOrderNo
      .mockResolvedValueOnce([])

    pg.transaction.mockImplementation(async (cb) => {
      const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) }
      return await cb(client)
    })

    await orderRoutes.createConversion(ctx)

    expect(ctx.result.status).toBe('已支付')
    expect(ctx.result.priceDiff).toBe(500) // 1500 - 1000
    expect(ctx.result.message).toContain('转换单已创建')
  })

  test('缺少转出项目拒绝', async () => {
    const ctx = createManagerCtx({
      refSaleOrderId: 'FY-001', convertOutItems: [], convertInItems: [{ skuId: 'sku-1' }],
    })
    await expect(orderRoutes.createConversion(ctx)).rejects.toThrow(/INVALID_PARAMS.*转出/)
  })

  test('缺少转入项目拒绝', async () => {
    const ctx = createManagerCtx({
      refSaleOrderId: 'FY-001', convertOutItems: [{ saleItemId: 'i1' }], convertInItems: [],
    })
    await expect(orderRoutes.createConversion(ctx)).rejects.toThrow(/INVALID_PARAMS.*转入/)
  })

  test('非店长拒绝', async () => {
    const ctx = createBeauticianCtx({
      refSaleOrderId: 'FY-001',
      convertOutItems: [{ saleItemId: 'i1' }],
      convertInItems: [{ skuId: 'sku-1' }],
    })
    await expect(orderRoutes.createConversion(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })
})

// ============================================================
// order.createPickup
// ============================================================
describe('order.createPickup', () => {
  beforeEach(() => { vi.clearAllMocks() })

  test('取货成功', async () => {
    const ctx = createManagerCtx({ saleItemId: 'item-001', pickupQuantity: 2 })

    pg.query
      .mockResolvedValueOnce({ rows: [{ sale_item_id: 'item-001', quantity: 5, picked_up_quantity: 2 }], rowCount: 1 })
      .mockResolvedValueOnce([{ sale_order_id: 'FY-001', client_user_id: 'cu-001' }])
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })

    await orderRoutes.createPickup(ctx)

    expect(ctx.result.saleItemId).toBe('item-001')
    expect(ctx.result.pickedUp).toBe(2)
    expect(ctx.result.remaining).toBe(3) // 5 - 2
    expect(ctx.result.message).toContain('取货成功')
  })

  test('超出可提货数量拒绝', async () => {
    const ctx = createManagerCtx({ saleItemId: 'item-001', pickupQuantity: 10 })
    pg.query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    await expect(orderRoutes.createPickup(ctx)).rejects.toThrow(/INVALID_PARAMS.*超出/)
  })

  test('缺少 saleItemId 拒绝', async () => {
    const ctx = createManagerCtx({ pickupQuantity: 1 })
    await expect(orderRoutes.createPickup(ctx)).rejects.toThrow(/INVALID_PARAMS.*saleItemId/)
  })

  test('取货数量 <= 0 拒绝', async () => {
    const ctx = createManagerCtx({ saleItemId: 'item-001', pickupQuantity: 0 })
    await expect(orderRoutes.createPickup(ctx)).rejects.toThrow(/INVALID_PARAMS.*取货数量/)
  })
})
