/**
 * 服务单路由测试
 * 核心约束：
 *   - complete 原子扣减 + 幂等
 *   - 取消不扣次数
 *   - 状态单向推进
 *   - 剩余次数归零关闭关联预约
 *   - 美容师只能操作分配给自己的服务单
 */

jest.mock('../../db/pg', () => require('../mocks/pg'))
jest.mock('wx-server-sdk', () => require('../mocks/wx-server-sdk'))

const pg = require('../../db/pg')
const { createManagerCtx, createBeauticianCtx } = require('../helpers')
const serviceRoutes = require('../../routes/service')

describe('service.create', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('店长为美容师创建服务单', async () => {
    const ctx = createManagerCtx({
      assignedStaffWfId: 'emp-beautician-001',
      items: [{ saleItemId: 'item-001', sessionUsed: 1 }],
    })

    // 验证订单行
    pg.query
      .mockResolvedValueOnce([{
        sale_item_id: 'item-001',
        remaining_sessions: 10,
        unit_real_price: '100',
        product_type: '疗程卡',
        order_status: '已支付',
        store_id: 'store-001',
        client_user_id: 'client-001',
        client_phone: '138',
      }])
      // 顾客无进行中的护理单
      .mockResolvedValueOnce([])
      // generateServiceOrderId
      .mockResolvedValueOnce([])

    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: jest.fn().mockResolvedValue({ rows: [{ sku_id: 'sku-001', unit_real_price: '100' }], rowCount: 1 }),
      }
      return await cb(client)
    })

    await serviceRoutes.create(ctx)

    expect(ctx.result.serviceOrderId).toMatch(/^HLD-WX-\d{6}\d{4}$/)
    expect(ctx.result.status).toBe('待服务')
    expect(pg.transaction).toHaveBeenCalled()
  })

  test('美容师不能为其他人创建服务单', async () => {
    const ctx = createBeauticianCtx({
      assignedStaffWfId: 'emp-other', // 不是自己
      items: [{ saleItemId: 'item-001', sessionUsed: 1 }],
    })

    await expect(serviceRoutes.create(ctx))
      .rejects.toThrow(/PERMISSION_DENIED.*美容师只能创建分配给自己/)
  })

  test('订单未支付时拒绝创建', async () => {
    const ctx = createManagerCtx({
      items: [{ saleItemId: 'item-001', sessionUsed: 1 }],
    })

    pg.query.mockResolvedValueOnce([{
      sale_item_id: 'item-001',
      remaining_sessions: 10,
      unit_real_price: '100',
      product_type: '疗程卡',
      order_status: '待支付', // 未支付
      store_id: 'store-001',
      client_user_id: null,
      client_phone: null,
    }])

    await expect(serviceRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*未支付/)
  })

  test('院装产品拒绝创建服务单', async () => {
    const ctx = createManagerCtx({
      items: [{ saleItemId: 'item-001', sessionUsed: 1 }],
    })

    pg.query.mockResolvedValueOnce([{
      sale_item_id: 'item-001',
      remaining_sessions: null,
      unit_real_price: '100',
      product_type: '院装产品',
      order_status: '已支付',
      store_id: 'store-001',
      client_user_id: null,
      client_phone: null,
    }])

    await expect(serviceRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*院装产品/)
  })

  test('剩余次数不足时拒绝', async () => {
    const ctx = createManagerCtx({
      items: [{ saleItemId: 'item-001', sessionUsed: 5 }],
    })

    pg.query.mockResolvedValueOnce([{
      sale_item_id: 'item-001',
      remaining_sessions: 3, // 不足 5
      unit_real_price: '100',
      product_type: '疗程卡',
      order_status: '已支付',
      store_id: 'store-001',
      client_user_id: null,
      client_phone: null,
    }])

    await expect(serviceRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*剩余次数不足/)
  })

  test('空服务明细拒绝', async () => {
    const ctx = createManagerCtx({ items: [] })

    await expect(serviceRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*服务明细不能为空/)
  })

  test('预约已关联服务单时拒绝重复创建', async () => {
    const ctx = createManagerCtx({
      appointmentId: 'appt-001',
      items: [{ saleItemId: 'item-001', sessionUsed: 1 }],
    })

    pg.query
      .mockResolvedValueOnce([{
        sale_item_id: 'item-001',
        remaining_sessions: 10,
        unit_real_price: '100',
        product_type: '疗程卡',
        order_status: '已支付',
        store_id: 'store-001',
        client_user_id: null,
        client_phone: null,
      }])

    // 验证预约
    pg.query
      .mockResolvedValueOnce([{ appointment_id: 'appt-001', status: '已确认', store_id: 'store-001' }])
      .mockResolvedValueOnce([{ service_order_id: 'HLD-existing' }]) // 已关联

    await expect(serviceRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*已关联服务单/)
  })

  test('顾客有进行中护理单时拒绝', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'client-001',
      items: [{ saleItemId: 'item-001', sessionUsed: 1 }],
    })

    pg.query
      .mockResolvedValueOnce([{
        sale_item_id: 'item-001',
        remaining_sessions: 10,
        unit_real_price: '100',
        product_type: '疗程卡',
        order_status: '已支付',
        store_id: 'store-001',
        client_user_id: 'client-001',
        client_phone: null,
      }])
      .mockResolvedValueOnce([{ service_order_id: 'HLD-active' }]) // 有进行中的

    await expect(serviceRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*已有进行中的护理单/)
  })
})

describe('service.start', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('开始服务成功', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-001',
        status: '待服务',
        assigned_employee_id: 'emp-001',
        store_id: 'store-001',
      }])
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE

    await serviceRoutes.start(ctx)

    expect(ctx.result.status).toBe('服务中')
  })

  test('非待服务状态拒绝开始', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query.mockResolvedValueOnce([{
      service_order_id: 'HLD-001',
      status: '服务中',
      assigned_employee_id: 'emp-001',
      store_id: 'store-001',
    }])

    await expect(serviceRoutes.start(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*服务中.*不可开始/)
  })

  test('美容师不能操作非分配给自己的服务单', async () => {
    const ctx = createBeauticianCtx({ serviceOrderId: 'HLD-001' })

    pg.query.mockResolvedValueOnce([{
      service_order_id: 'HLD-001',
      status: '待服务',
      assigned_employee_id: 'emp-other',
      store_id: 'store-001',
    }])

    await expect(serviceRoutes.start(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })
})

describe('service.complete', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('完成服务 — 原子扣减次数', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-001',
        status: '服务中',
        assigned_employee_id: 'emp-001',
        store_id: 'store-001',
        appointment_id: null,
      }])
      .mockResolvedValueOnce([
        { service_item_id: 'si-1', sale_item_id: 'item-001', session_used: 1 },
      ])

    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: jest.fn()
          // 原子扣减
          .mockResolvedValueOnce({ rows: [], rowCount: 1 })
          // 查询扣减后剩余次数
          .mockResolvedValueOnce({ rows: [{ remaining_sessions: 5 }] })
          // UPDATE service_orders
          .mockResolvedValueOnce({ rows: [], rowCount: 1 }),
      }
      return await cb(client)
    })

    await serviceRoutes.complete(ctx)

    expect(ctx.result.status).toBe('已完成')
    expect(ctx.result.message).toContain('次数已扣减')
  })

  test('幂等 — 已完成的服务单不重复扣减', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query.mockResolvedValueOnce([{
      service_order_id: 'HLD-001',
      status: '已完成',
      assigned_employee_id: 'emp-001',
      store_id: 'store-001',
    }])

    await serviceRoutes.complete(ctx)

    expect(ctx.result.status).toBe('已完成')
    expect(ctx.result.message).toContain('幂等')
    // 不应调用 transaction
    expect(pg.transaction).not.toHaveBeenCalled()
  })

  test('非服务中状态拒绝完成', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query.mockResolvedValueOnce([{
      service_order_id: 'HLD-001',
      status: '待服务',
      assigned_employee_id: 'emp-001',
      store_id: 'store-001',
    }])

    await expect(serviceRoutes.complete(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*待服务.*不可完成/)
  })

  test('原子扣减失败（次数不足）时回滚', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-001',
        status: '服务中',
        assigned_employee_id: 'emp-001',
        store_id: 'store-001',
        appointment_id: null,
      }])
      .mockResolvedValueOnce([
        { service_item_id: 'si-1', sale_item_id: 'item-001', session_used: 5 },
      ])

    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: jest.fn()
          // rowCount = 0 → 原子扣减失败
          .mockResolvedValueOnce({ rows: [], rowCount: 0 })
          // 检查剩余次数
          .mockResolvedValueOnce({ rows: [{ remaining_sessions: 2 }] }),
      }
      return await cb(client)
    })

    await expect(serviceRoutes.complete(ctx))
      .rejects.toThrow(/次数不足/)
  })

  test('剩余次数归零时关闭关联预约', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-001',
        status: '服务中',
        assigned_employee_id: 'emp-001',
        store_id: 'store-001',
        appointment_id: 'appt-001',
      }])
      .mockResolvedValueOnce([
        { service_item_id: 'si-1', sale_item_id: 'item-001', session_used: 1 },
      ])

    const clientQueryMock = jest.fn()
      // 原子扣减成功
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      // 剩余次数归零
      .mockResolvedValueOnce({ rows: [{ remaining_sessions: 0 }] })
      // 关闭关联预约（sale_item_id 维度）
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      // UPDATE service_orders
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      // UPDATE appointment（appointment_id 维度）
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })

    pg.transaction.mockImplementation(async (cb) => {
      return await cb({ query: clientQueryMock })
    })

    await serviceRoutes.complete(ctx)

    expect(ctx.result.status).toBe('已完成')
    // 验证关闭预约的 SQL
    const closeCalls = clientQueryMock.mock.calls.filter(
      call => typeof call[0] === 'string' && call[0].includes('appointments') && call[0].includes('已关闭')
    )
    expect(closeCalls.length).toBeGreaterThanOrEqual(1)
  })
})

describe('service.cancel', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('取消待服务的服务单（不扣次数）', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-001',
        status: '待服务',
        assigned_employee_id: 'emp-001',
        store_id: 'store-001',
      }])
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE

    await serviceRoutes.cancel(ctx)

    expect(ctx.result.status).toBe('已取消')
    // 确认不调用 transaction（不扣次数）
    expect(pg.transaction).not.toHaveBeenCalled()
  })

  test('取消服务中的服务单', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-001',
        status: '服务中',
        assigned_employee_id: 'emp-001',
        store_id: 'store-001',
      }])
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })

    await serviceRoutes.cancel(ctx)
    expect(ctx.result.status).toBe('已取消')
  })

  test('已完成的服务单不能取消', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query.mockResolvedValueOnce([{
      service_order_id: 'HLD-001',
      status: '已完成',
      assigned_employee_id: 'emp-001',
      store_id: 'store-001',
    }])

    await expect(serviceRoutes.cancel(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*已完成.*不可取消/)
  })

  test('美容师只能取消分配给自己的服务单', async () => {
    const ctx = createBeauticianCtx({ serviceOrderId: 'HLD-001' })

    pg.query.mockResolvedValueOnce([{
      service_order_id: 'HLD-001',
      status: '待服务',
      assigned_employee_id: 'emp-other', // 不是自己
      store_id: 'store-001',
    }])

    await expect(serviceRoutes.cancel(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })
})

describe('service.list', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('美容师只看分配给自己的服务单', async () => {
    const ctx = createBeauticianCtx({ page: 1 })

    pg.query.mockResolvedValueOnce([]) // 无服务单

    await serviceRoutes.list(ctx)

    const sql = pg.query.mock.calls[0][0]
    expect(sql).toContain('assigned_employee_id')
    expect(pg.query.mock.calls[0][1]).toContain('emp-beautician-001')
  })

  test('店长查看全部服务单', async () => {
    const ctx = createManagerCtx({ page: 1 })

    pg.query.mockResolvedValueOnce([]) // 无服务单

    await serviceRoutes.list(ctx)

    const sql = pg.query.mock.calls[0][0]
    expect(sql).not.toContain('assigned_employee_id =')
  })
})

describe('service.detail', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('查看服务单详情', async () => {
    const ctx = createManagerCtx({ id: 'HLD-001' })

    pg.query
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-001',
        status: '服务中',
        service_date: '2024-01-15',
        assigned_employee_id: 'emp-001',
        client_user_id: 'client-001',
        appointment_id: null,
        remark: '备注',
        started_at: '2024-01-15T10:00:00Z',
        completed_at: null,
        created_at: '2024-01-15T09:00:00Z',
        updated_at: '2024-01-15T10:00:00Z',
        client_phone: '13800001111',
      }])
      .mockResolvedValueOnce([{
        sale_item_id: 'item-001',
        session_used: 1,
        service_duration: 60,
        session_count: 10,
        remaining_sessions: 9,
        sku_spec_name: '基础款',
        product_type: '疗程卡',
        product_name: '面部护理',
      }])
      .mockResolvedValueOnce([{ name: '张三' }])    // 员工姓名
      .mockResolvedValueOnce([{ name: '顾客A' }])   // 顾客姓名

    await serviceRoutes.detail(ctx)

    expect(ctx.result.serviceOrderId).toBe('HLD-001')
    expect(ctx.result.staffName).toBe('张三')
    expect(ctx.result.customerName).toBe('顾客A')
    expect(ctx.result.items).toHaveLength(1)
    expect(ctx.result.items[0].itemName).toBe('面部护理')
  })

  test('美容师不能查看非分配给自己的服务单', async () => {
    const ctx = createBeauticianCtx({ id: 'HLD-001' })

    pg.query.mockResolvedValueOnce([{
      service_order_id: 'HLD-001',
      status: '服务中',
      assigned_employee_id: 'emp-other',
      store_id: 'store-001',
    }])

    await expect(serviceRoutes.detail(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })
})
