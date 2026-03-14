/**
 * 顾客档案路由测试
 * 覆盖：search / calendar / detail / paidOrders
 * 双源架构：WorkFine (MSSQL) + PG，手机号去重，非店长脱敏
 */



const pg = globalThis.__mocks__.pg
const mssql = globalThis.__mocks__.mssql
const { createManagerCtx, createBeauticianCtx } = require('../helpers')
const customerRoutes = require('../../routes/customer')

beforeEach(() => {
  mssql.query.mockReset().mockResolvedValue([])
})

// ============================================================
// customer.search
// ============================================================
describe('customer.search', () => {
  test('关键词搜索返回 WorkFine + PG 合并结果', async () => {
    const ctx = createManagerCtx({ keyword: '张' })
    mssql.query.mockResolvedValueOnce([
      { customer_id: 'C001', name: '张三', phone: '13800001111', member_level: 'VIP', store_name: '测试店', main_staff_id: null, register_date: '2024-01-01' },
    ])
    pg.query.mockResolvedValueOnce([
      { user_id: 'u1', phone: '13800001111', name: '张三', bound_store_id: 'store-001' },
      { user_id: 'u2', phone: '13900002222', name: '张四', bound_store_id: 'store-001' },
    ])
    await customerRoutes.search(ctx)
    expect(ctx.result).toHaveLength(2)
    const zhangSan = ctx.result.find(r => r.name === '张三')
    expect(zhangSan.source).toBe('both')
    expect(zhangSan.clientUserId).toBe('u1')
    const zhangSi = ctx.result.find(r => r.name === '张四')
    expect(zhangSi.source).toBe('miniprogram')
    expect(zhangSi.clientUserId).toBe('u2')
  })

  test('手机号搜索返回精确匹配', async () => {
    const ctx = createManagerCtx({ phone: '13800001111' })
    mssql.query.mockResolvedValueOnce([
      { customer_id: 'C001', name: '张三', phone: '13800001111', member_level: 'VIP', store_name: '测试店', main_staff_id: null, register_date: '2024-01-01' },
    ])
    pg.query.mockResolvedValueOnce([
      { user_id: 'u1', phone: '13800001111', name: '张三', bound_store_id: 'store-001' },
    ])
    await customerRoutes.search(ctx)
    expect(ctx.result).toHaveLength(1)
    expect(ctx.result[0].phone).toBe('13800001111')
  })

  test('美容师看到脱敏手机号', async () => {
    const ctx = createBeauticianCtx({ phone: '13800001111' })
    mssql.query.mockResolvedValueOnce([
      { customer_id: 'C001', name: '张三', phone: '13800001111', member_level: 'VIP', store_name: '测试店', main_staff_id: null, register_date: '2024-01-01' },
    ])
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.search(ctx)
    expect(ctx.result).toHaveLength(1)
    expect(ctx.result[0].phone).toBe('*******1111')
    expect(ctx.result[0].phoneMasked).toBe('*******1111')
  })

  test('无结果时返回空数组', async () => {
    const ctx = createManagerCtx({ keyword: '不存在的人' })
    mssql.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.search(ctx)
    expect(ctx.result).toEqual([])
  })
})

// ============================================================
// customer.calendar
// ============================================================
describe('customer.calendar', () => {
  test('返回月度消费日历和订单', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1', year: 2024, month: 6 })
    pg.query.mockResolvedValueOnce([
      { pay_date: '2024-06-01', order_count: '2', total_received: '500.00' },
      { pay_date: '2024-06-15', order_count: '1', total_received: '300.00' },
    ])
    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'SO-001', sale_order_type: '正式', store_id: 'store-001', payment_method: '微信支付', paid_at: '2024-06-01T10:00:00Z', client_phone: '138', customer_name: '张三', pay_date: '2024-06-01', total_received: '250.00' },
    ])
    await customerRoutes.calendar(ctx)
    expect(ctx.result.year).toBe(2024)
    expect(ctx.result.month).toBe(6)
    expect(ctx.result.dailySummary).toHaveLength(2)
    expect(ctx.result.dailySummary[0].orderCount).toBe(2)
    expect(ctx.result.dailySummary[0].totalReceived).toBe(500)
    expect(ctx.result.orders).toHaveLength(1)
  })

  test('缺少 clientUserId 和 clientPhone 时拒绝', async () => {
    const ctx = createManagerCtx({ year: 2024, month: 6 })
    await expect(customerRoutes.calendar(ctx)).rejects.toThrow(/INVALID_PARAMS/)
  })

  test('缺少 year 或 month 时拒绝', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1' })
    await expect(customerRoutes.calendar(ctx)).rejects.toThrow(/INVALID_PARAMS/)
  })
})

// ============================================================
// customer.detail
// ============================================================
describe('customer.detail', () => {
  test('WorkFine 中找到顾客返回完整信息', async () => {
    const ctx = createManagerCtx({ id: 'C001' })
    mssql.query.mockResolvedValueOnce([
      { customer_id: 'C001', name: '张三', phone: '13800001111', member_level: 'VIP', store_name: '测试店', main_staff_id: 'emp-002' },
    ])
    pg.query.mockResolvedValueOnce([{ user_id: 'u1' }])
    pg.query.mockResolvedValueOnce([{ name: '李四' }])
    pg.query.mockResolvedValueOnce([{ total: '5000' }])
    pg.query.mockResolvedValueOnce([{ total: '2000' }])
    await customerRoutes.detail(ctx)
    expect(ctx.result.id).toBe('C001')
    expect(ctx.result.name).toBe('张三')
    expect(ctx.result.phone).toBe('13800001111')
    expect(ctx.result.clientUserId).toBe('u1')
    expect(ctx.result.preferredStaffName).toBe('李四')
    expect(ctx.result.totalConsumption).toBe(5000)
    expect(ctx.result.yearConsumption).toBe(2000)
    expect(ctx.result.source).toBe('both')
  })

  test('WorkFine 无记录但 PG 有，返回 miniprogram 源', async () => {
    const ctx = createManagerCtx({ phone: '13900002222' })
    mssql.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([{ user_id: 'u2', phone: '13900002222', name: 'PG顾客', bound_store_id: 'store-001' }])
    pg.query.mockResolvedValueOnce([{ total: '1000' }])
    pg.query.mockResolvedValueOnce([{ total: '500' }])
    await customerRoutes.detail(ctx)
    expect(ctx.result.id).toBeNull()
    expect(ctx.result.clientUserId).toBe('u2')
    expect(ctx.result.name).toBe('PG顾客')
    expect(ctx.result.source).toBe('miniprogram')
  })

  test('两边都找不到时抛出错误', async () => {
    const ctx = createManagerCtx({ phone: '19900009999' })
    mssql.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([])
    await expect(customerRoutes.detail(ctx)).rejects.toThrow(/INVALID_PARAMS/)
  })

  test('缺少所有标识参数时拒绝', async () => {
    const ctx = createManagerCtx({})
    await expect(customerRoutes.detail(ctx)).rejects.toThrow(/INVALID_PARAMS/)
  })
})

// ============================================================
// customer.paidOrders
// ============================================================
describe('customer.paidOrders', () => {
  test('按 clientUserId 返回已支付订单及明细', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1' })
    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'SO-001', status: '已支付', paid_at: '2024-06-01T10:00:00Z' },
      { sale_order_id: 'SO-002', status: '已支付', paid_at: '2024-06-15T14:00:00Z' },
    ])
    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'SO-001', sale_item_id: 'item-001', session_count: 10, remaining_sessions: 8, sku_id: 'sku-1', product_type: '疗程卡', sku_spec_name: '基础款', product_name: '面部护理' },
      { sale_order_id: 'SO-002', sale_item_id: 'item-002', session_count: 5, remaining_sessions: 5, sku_id: 'sku-2', product_type: '疗程卡', sku_spec_name: '高级款', product_name: '身体护理' },
    ])
    await customerRoutes.paidOrders(ctx)
    expect(ctx.result).toHaveLength(2)
    expect(ctx.result[0].saleOrderId).toBe('SO-001')
    expect(ctx.result[0].items).toHaveLength(1)
    expect(ctx.result[0].items[0].itemName).toBe('面部护理')
    expect(ctx.result[0].items[0].remainingSessions).toBe(8)
  })

  test('无已支付订单时返回空数组', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u-empty' })
    pg.query.mockResolvedValueOnce([])
    await customerRoutes.paidOrders(ctx)
    expect(ctx.result).toEqual([])
  })

  test('缺少 clientUserId 和 clientPhone 时拒绝', async () => {
    const ctx = createManagerCtx({})
    await expect(customerRoutes.paidOrders(ctx)).rejects.toThrow(/INVALID_PARAMS/)
  })

  test('按 clientPhone 查询已支付订单', async () => {
    const ctx = createManagerCtx({ clientPhone: '13800001111' })
    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'SO-003', status: '已支付', paid_at: '2024-07-01T10:00:00Z' },
    ])
    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'SO-003', sale_item_id: 'item-003', session_count: 3, remaining_sessions: 3, sku_id: 'sku-3', product_type: '疗程卡', sku_spec_name: '标准', product_name: '头疗' },
    ])
    await customerRoutes.paidOrders(ctx)
    expect(ctx.result).toHaveLength(1)
    expect(ctx.result[0].saleOrderId).toBe('SO-003')
  })
})

// ============================================================
// customer.stats
// ============================================================
describe('customer.stats', () => {
  test('正确分类顾客活跃度和生日', async () => {
    const now = new Date()
    const today = now.toISOString().slice(0, 10)
    const currentMonth = now.getMonth() + 1
    const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1

    const ctx = createManagerCtx({})

    // 构造不同活跃度的顾客
    const daysAgo = (n) => {
      const d = new Date(now)
      d.setDate(d.getDate() - n)
      return d.toISOString().slice(0, 10)
    }

    pg.query
      .mockResolvedValueOnce([
        { user_id: 'u1', birthday: `2000-${String(currentMonth).padStart(2, '0')}-15`, last_service_date: daysAgo(10) },  // active + birthday
        { user_id: 'u2', birthday: `2000-${String(nextMonth).padStart(2, '0')}-20`, last_service_date: daysAgo(40) },    // atRisk + birthdayNext
        { user_id: 'u3', birthday: null, last_service_date: daysAgo(70) },        // lost
        { user_id: 'u4', birthday: null, last_service_date: daysAgo(100) },       // sleeping
        { user_id: 'u5', birthday: null, last_service_date: null },               // sleeping (无服务记录)
      ])
      .mockResolvedValueOnce([{ cnt: '3' }]) // memberCount

    await customerRoutes.stats(ctx)

    expect(ctx.result.active).toBe(1)
    expect(ctx.result.atRisk).toBe(1)
    expect(ctx.result.lost).toBe(1)
    expect(ctx.result.sleeping).toBe(2)
    expect(ctx.result.birthday).toBe(1)
    expect(ctx.result.birthdayNext).toBe(1)
    expect(ctx.result.total).toBe(5)
    expect(ctx.result.memberCount).toBe(3)
    expect(ctx.result.flowCount).toBe(2)
  })

  test('空门店返回全零统计', async () => {
    const ctx = createManagerCtx({})

    pg.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ cnt: '0' }])

    await customerRoutes.stats(ctx)

    expect(ctx.result.active).toBe(0)
    expect(ctx.result.atRisk).toBe(0)
    expect(ctx.result.lost).toBe(0)
    expect(ctx.result.sleeping).toBe(0)
    expect(ctx.result.total).toBe(0)
    expect(ctx.result.memberCount).toBe(0)
    expect(ctx.result.flowCount).toBe(0)
  })
})

// ============================================================
// customer.listByTag
// ============================================================
describe('customer.listByTag', () => {
  test('按 active 标签筛选', async () => {
    const now = new Date()
    const daysAgo = (n) => {
      const d = new Date(now)
      d.setDate(d.getDate() - n)
      return d.toISOString().slice(0, 10)
    }

    const ctx = createManagerCtx({ tag: 'active', page: 1, pageSize: 10 })

    pg.query.mockResolvedValueOnce([
      { user_id: 'u1', name: '活跃客', phone: '13800001111', birthday: null, member_level: 'VIP', last_service_date: daysAgo(5), year_consumption: '25000' },
      { user_id: 'u2', name: '流失客', phone: '13900002222', birthday: null, member_level: null, last_service_date: daysAgo(80), year_consumption: '0' },
    ])

    await customerRoutes.listByTag(ctx)

    expect(ctx.result.total).toBe(1)
    expect(ctx.result.customers).toHaveLength(1)
    expect(ctx.result.customers[0].name).toBe('活跃客')
    expect(ctx.result.customers[0].tier).toBe('diamond') // 25000 >= 20000
  })

  test('按 sleeping 标签筛选（含无服务记录）', async () => {
    const ctx = createManagerCtx({ tag: 'sleeping', page: 1, pageSize: 10 })

    pg.query.mockResolvedValueOnce([
      { user_id: 'u1', name: '沉睡客', phone: '13800001111', birthday: null, member_level: null, last_service_date: null, year_consumption: '0' },
    ])

    await customerRoutes.listByTag(ctx)

    expect(ctx.result.total).toBe(1)
    expect(ctx.result.customers[0].tier).toBeNull() // 0 消费无 tier
  })

  test('按 birthday 标签筛选当月生日', async () => {
    const now = new Date()
    const currentMonth = now.getMonth() + 1
    const ctx = createManagerCtx({ tag: 'birthday', page: 1, pageSize: 10 })

    pg.query.mockResolvedValueOnce([
      { user_id: 'u1', name: '生日客', phone: '13800001111', birthday: `1990-${String(currentMonth).padStart(2, '0')}-15`, member_level: 'VIP', last_service_date: null, year_consumption: '6000' },
      { user_id: 'u2', name: '非生日客', phone: '13900002222', birthday: '1990-01-01', member_level: null, last_service_date: null, year_consumption: '100' },
    ])

    await customerRoutes.listByTag(ctx)

    // 只有当月生日的被筛选出来
    const hasBirthday = ctx.result.customers.some(c => c.name === '生日客')
    expect(hasBirthday).toBe(true)
    // 6000 >= 5000 → iron
    const birthdayCustomer = ctx.result.customers.find(c => c.name === '生日客')
    expect(birthdayCustomer.tier).toBe('iron')
  })

  test('美容师看到脱敏手机号', async () => {
    const ctx = createBeauticianCtx({ tag: 'active', page: 1, pageSize: 10 })
    const now = new Date()
    const d = new Date(now)
    d.setDate(d.getDate() - 5)

    pg.query.mockResolvedValueOnce([
      { user_id: 'u1', name: '客户', phone: '13800001111', birthday: null, member_level: null, last_service_date: d.toISOString().slice(0, 10), year_consumption: '0' },
    ])

    await customerRoutes.listByTag(ctx)

    expect(ctx.result.customers[0].phone).not.toBe('13800001111')
    expect(ctx.result.customers[0].phoneMasked).toBe('*******1111')
  })

  test('分页功能正确', async () => {
    const now = new Date()
    const daysAgo = (n) => {
      const d = new Date(now)
      d.setDate(d.getDate() - n)
      return d.toISOString().slice(0, 10)
    }

    const ctx = createManagerCtx({ tag: 'active', page: 2, pageSize: 1 })

    pg.query.mockResolvedValueOnce([
      { user_id: 'u1', name: '客A', phone: '13800001111', birthday: null, member_level: null, last_service_date: daysAgo(5), year_consumption: '0' },
      { user_id: 'u2', name: '客B', phone: '13900002222', birthday: null, member_level: null, last_service_date: daysAgo(10), year_consumption: '0' },
    ])

    await customerRoutes.listByTag(ctx)

    expect(ctx.result.total).toBe(2)
    expect(ctx.result.customers).toHaveLength(1)
    expect(ctx.result.customers[0].name).toBe('客B')
  })

  test('缺少 tag 参数时拒绝', async () => {
    const ctx = createManagerCtx({ page: 1 })
    await expect(customerRoutes.listByTag(ctx)).rejects.toThrow(/INVALID_PARAMS.*tag/)
  })

  test('tier 分级正确：fan', async () => {
    const now = new Date()
    const d = new Date(now)
    d.setDate(d.getDate() - 5)

    const ctx = createManagerCtx({ tag: 'active', page: 1 })
    pg.query.mockResolvedValueOnce([
      { user_id: 'u1', name: '粉丝客', phone: '138', birthday: null, member_level: null, last_service_date: d.toISOString().slice(0, 10), year_consumption: '100' },
    ])

    await customerRoutes.listByTag(ctx)
    expect(ctx.result.customers[0].tier).toBe('fan') // 0 < 100 < 5000
  })
})

// ============================================================
// customer.refundHistory
// ============================================================
describe('customer.refundHistory', () => {
  test('返回退款和转换订单及明细', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1' })

    // 退换订单
    pg.query.mockResolvedValueOnce([
      {
        sale_order_id: 'REF-001', status: '已完成', sale_order_type: '退款',
        total_amount: '500', refund_reason: '质量问题', handling_fee: '50',
        ref_sale_order_id: 'FY-001', approved_by: 'emp-001', approved_at: '2024-06-20',
        rejected_reason: null, created_at: '2024-06-15', paid_at: null,
      },
      {
        sale_order_id: 'CVT-001', status: '已完成', sale_order_type: '转换',
        total_amount: '300', refund_reason: '更换项目', handling_fee: null,
        ref_sale_order_id: 'FY-002', approved_by: 'emp-001', approved_at: '2024-06-22',
        rejected_reason: null, created_at: '2024-06-18', paid_at: null,
      },
    ])
    // 明细
    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'REF-001', sale_item_id: 'refitem-1', item_direction: 'refund', product_name: '面部护理', sku_spec_name: '基础款', quantity: 1, received: '500' },
      { sale_order_id: 'CVT-001', sale_item_id: 'cvtitem-1', item_direction: 'purchase', product_name: '身体护理', sku_spec_name: '高级款', quantity: 1, received: '300' },
    ])

    await customerRoutes.refundHistory(ctx)

    expect(ctx.result).toHaveLength(2)
    expect(ctx.result[0].saleOrderId).toBe('REF-001')
    expect(ctx.result[0].type).toBe('退款')
    expect(ctx.result[0].handlingFee).toBe(50)
    expect(ctx.result[0].items).toHaveLength(1)
    expect(ctx.result[1].type).toBe('转换')
    expect(ctx.result[1].handlingFee).toBeNull()
  })

  test('按 clientPhone 查询', async () => {
    const ctx = createManagerCtx({ clientPhone: '13800001111' })

    pg.query.mockResolvedValueOnce([])

    await customerRoutes.refundHistory(ctx)

    expect(ctx.result).toEqual([])
    const sql = pg.query.mock.calls[0][0]
    expect(sql).toContain('client_phone')
  })

  test('缺少标识参数时拒绝', async () => {
    const ctx = createManagerCtx({})
    await expect(customerRoutes.refundHistory(ctx)).rejects.toThrow(/INVALID_PARAMS.*clientUserId/)
  })

  test('无退换记录返回空数组', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u-clean' })
    pg.query.mockResolvedValueOnce([])

    await customerRoutes.refundHistory(ctx)
    expect(ctx.result).toEqual([])
  })
})

// ============================================================
// customer.giftHistory
// ============================================================
describe('customer.giftHistory', () => {
  test('返回福利活动订单和赠品明细', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1' })

    // 福利活动订单
    pg.query.mockResolvedValueOnce([
      {
        sale_order_id: 'PROMO-001', status: '已支付', sale_order_type: '福利活动',
        total_amount: '0', created_at: '2024-06-01', paid_at: '2024-06-01',
      },
    ])
    // 赠品明细（received=0 的行）
    pg.query.mockResolvedValueOnce([
      {
        sale_item_id: 'gift-001', sale_order_id: 'FY-001', product_name: '赠送面膜',
        sku_spec_name: '体验装', quantity: 1, session_count: 3, remaining_sessions: 3,
        received: '0', created_at: '2024-06-05', paid_at: '2024-06-05',
      },
    ])
    // 福利活动订单的明细
    pg.query.mockResolvedValueOnce([
      {
        sale_order_id: 'PROMO-001', sale_item_id: 'promo-item-1',
        product_name: '活动面部护理', sku_spec_name: '体验版',
        quantity: 1, session_count: 5, remaining_sessions: 5, received: '0',
      },
    ])

    await customerRoutes.giftHistory(ctx)

    expect(ctx.result.promoOrders).toHaveLength(1)
    expect(ctx.result.promoOrders[0].saleOrderId).toBe('PROMO-001')
    expect(ctx.result.promoOrders[0].items).toHaveLength(1)
    expect(ctx.result.promoOrders[0].items[0].productName).toBe('活动面部护理')
    expect(ctx.result.giftItems).toHaveLength(1)
    expect(ctx.result.giftItems[0].productName).toBe('赠送面膜')
  })

  test('无福利活动时 promoOrders 为空', async () => {
    const ctx = createManagerCtx({ clientUserId: 'u1' })

    pg.query.mockResolvedValueOnce([]) // 无福利活动
    pg.query.mockResolvedValueOnce([]) // 无赠品

    await customerRoutes.giftHistory(ctx)

    expect(ctx.result.promoOrders).toEqual([])
    expect(ctx.result.giftItems).toEqual([])
  })

  test('按 clientPhone 查询', async () => {
    const ctx = createManagerCtx({ clientPhone: '13800001111' })

    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([])

    await customerRoutes.giftHistory(ctx)

    const sql = pg.query.mock.calls[0][0]
    expect(sql).toContain('client_phone')
  })

  test('缺少标识参数时拒绝', async () => {
    const ctx = createManagerCtx({})
    await expect(customerRoutes.giftHistory(ctx)).rejects.toThrow(/INVALID_PARAMS.*clientUserId/)
  })
})
