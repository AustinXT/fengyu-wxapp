/**
 * 顾客档案路由测试
 * 覆盖：search / calendar / detail / paidOrders
 * 双源架构：WorkFine (MSSQL) + PG，手机号去重，非店长脱敏
 */

jest.mock('../../db/pg', () => require('../mocks/pg'))
jest.mock('../../db/mssql', () => require('../mocks/mssql'))
jest.mock('wx-server-sdk', () => require('../mocks/wx-server-sdk'))


const pg = require('../../db/pg')
const mssql = require('../../db/mssql')
const { createManagerCtx, createBeauticianCtx, resetPgMock } = require('../helpers')
const customerRoutes = require('../../routes/customer')

beforeEach(() => {
  resetPgMock(pg)
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
