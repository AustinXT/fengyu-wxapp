/**
 * 预约路由测试
 * 覆盖：list / detail / confirm / checkin
 * 核心约束：
 *   - 状态机：待确认 → 已确认
 *   - checkin 仅记录时间不改状态
 *   - 美容师只看/操作指定自己的预约
 */

jest.mock('../../db/pg', () => require('../mocks/pg'))
jest.mock('wx-server-sdk', () => require('../mocks/wx-server-sdk'))

const pg = require('../../db/pg')
const { createManagerCtx, createBeauticianCtx } = require('../helpers')
const appointmentRoutes = require('../../routes/appointment')

describe('appointment.confirm', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('确认待确认预约', async () => {
    const ctx = createManagerCtx({ appointmentId: 'appt-001' })

    pg.query
      .mockResolvedValueOnce([{
        appointment_id: 'appt-001',
        status: '待确认',
        employee_id: 'emp-001',
        store_id: 'store-001',
      }])
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE

    await appointmentRoutes.confirm(ctx)

    expect(ctx.result.status).toBe('已确认')
    expect(pg.query).toHaveBeenCalledWith(
      expect.stringContaining("'已确认'"),
      expect.any(Array)
    )
  })

  test('非待确认状态拒绝确认', async () => {
    const ctx = createManagerCtx({ appointmentId: 'appt-001' })

    pg.query.mockResolvedValueOnce([{
      appointment_id: 'appt-001',
      status: '已确认',
      employee_id: 'emp-001',
      store_id: 'store-001',
    }])

    await expect(appointmentRoutes.confirm(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*已确认.*不可确认/)
  })

  test('美容师确认自己的预约', async () => {
    const ctx = createBeauticianCtx({ appointmentId: 'appt-001' })

    pg.query
      .mockResolvedValueOnce([{
        appointment_id: 'appt-001',
        status: '待确认',
        employee_id: 'emp-beautician-001',
        store_id: 'store-001',
      }])
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })

    await appointmentRoutes.confirm(ctx)
    expect(ctx.result.status).toBe('已确认')
  })

  test('美容师不能确认其他人的预约', async () => {
    const ctx = createBeauticianCtx({ appointmentId: 'appt-001' })

    pg.query.mockResolvedValueOnce([{
      appointment_id: 'appt-001',
      status: '待确认',
      employee_id: 'emp-other',
      store_id: 'store-001',
    }])

    await expect(appointmentRoutes.confirm(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('缺少 appointmentId 拒绝', async () => {
    const ctx = createManagerCtx({})

    await expect(appointmentRoutes.confirm(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*appointmentId/)
  })

  test('预约不存在时拒绝', async () => {
    const ctx = createManagerCtx({ appointmentId: 'appt-nonexist' })

    pg.query.mockResolvedValueOnce([])

    await expect(appointmentRoutes.confirm(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*不存在/)
  })
})

describe('appointment.checkin', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('签到成功 — 仅记录时间不改状态', async () => {
    const ctx = createManagerCtx({ appointmentId: 'appt-001' })

    pg.query
      .mockResolvedValueOnce([{
        appointment_id: 'appt-001',
        status: '已确认',
        employee_id: 'emp-001',
        store_id: 'store-001',
      }])
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE checkin_at

    await appointmentRoutes.checkin(ctx)

    expect(ctx.result.checkinAt).toBeDefined()
    expect(ctx.result.message).toContain('已到店')
    // 验证只更新 checkin_at，不改 status
    const sql = pg.query.mock.calls[1][0]
    expect(sql).toContain('checkin_at')
    expect(sql).not.toContain("status")
  })

  test('待确认状态也可签到', async () => {
    const ctx = createManagerCtx({ appointmentId: 'appt-001' })

    pg.query
      .mockResolvedValueOnce([{
        appointment_id: 'appt-001',
        status: '待确认',
        employee_id: 'emp-001',
        store_id: 'store-001',
      }])
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })

    await appointmentRoutes.checkin(ctx)
    expect(ctx.result.checkinAt).toBeDefined()
  })

  test('已取消的预约不能签到', async () => {
    const ctx = createManagerCtx({ appointmentId: 'appt-001' })

    pg.query.mockResolvedValueOnce([{
      appointment_id: 'appt-001',
      status: '已取消',
      employee_id: 'emp-001',
      store_id: 'store-001',
    }])

    await expect(appointmentRoutes.checkin(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*已取消.*不支持签到/)
  })

  test('美容师不能操作非分配给自己的预约', async () => {
    const ctx = createBeauticianCtx({ appointmentId: 'appt-001' })

    pg.query.mockResolvedValueOnce([{
      appointment_id: 'appt-001',
      status: '已确认',
      employee_id: 'emp-other',
      store_id: 'store-001',
    }])

    await expect(appointmentRoutes.checkin(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })
})

describe('appointment.list', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('店长查看所有预约', async () => {
    const ctx = createManagerCtx({ status: 'all', page: 1 })

    pg.query.mockResolvedValueOnce([{
      appointment_id: 'appt-001',
      status: '待确认',
      client_user_id: 'c1',
      client_name: '顾客A',
      employee_id: 'emp-001',
      employee_name: '员工A',
      appointment_time: '2024-01-15T10:00:00Z',
      notes: '备注',
      sale_item_id: null,
      checkin_at: null,
      created_at: '2024-01-15',
      sale_order_id: null,
      service_name: '到店预约',
      sku_spec_name: null,
      customer_phone: '138',
    }])

    await appointmentRoutes.list(ctx)

    expect(ctx.result).toHaveLength(1)
    expect(ctx.result[0].status).toBe('pending')
    expect(ctx.result[0].statusText).toBe('待确认')
    const sql = pg.query.mock.calls[0][0]
    expect(sql).not.toContain('employee_id =')
  })

  test('美容师只看自己的预约', async () => {
    const ctx = createBeauticianCtx({ status: 'all', page: 1 })

    pg.query.mockResolvedValueOnce([])

    await appointmentRoutes.list(ctx)

    const sql = pg.query.mock.calls[0][0]
    expect(sql).toContain('a.employee_id')
    expect(pg.query.mock.calls[0][1]).toContain('emp-beautician-001')
  })

  test('状态过滤（英文转中文）', async () => {
    const ctx = createManagerCtx({ status: 'confirmed', page: 1 })

    pg.query.mockResolvedValueOnce([])

    await appointmentRoutes.list(ctx)

    const params = pg.query.mock.calls[0][1]
    expect(params).toContain('已确认')
  })

  test('仅今日过滤', async () => {
    const ctx = createManagerCtx({ todayOnly: true, page: 1 })

    pg.query.mockResolvedValueOnce([])

    await appointmentRoutes.list(ctx)

    const sql = pg.query.mock.calls[0][0]
    expect(sql).toContain('DATE(a.appointment_time)')
  })
})

describe('appointment.detail', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('返回完整预约详情', async () => {
    const ctx = createManagerCtx({ id: 'appt-001' })

    pg.query.mockResolvedValueOnce([{
      appointment_id: 'appt-001',
      status: '已确认',
      client_user_id: 'c1',
      client_name: '顾客A',
      employee_id: 'emp-001',
      employee_name: '员工A',
      appointment_time: '2024-01-15T10:00:00Z',
      notes: '备注',
      sale_item_id: null,
      checkin_at: null,
      service_name: '面部护理',
      sku_spec_name: '基础款',
      customer_phone: '13800001111',
      service_order_id: null,
    }])

    await appointmentRoutes.detail(ctx)

    expect(ctx.result.id).toBe('appt-001')
    expect(ctx.result.status).toBe('confirmed')
    expect(ctx.result.statusText).toBe('已确认')
    expect(ctx.result.customerName).toBe('顾客A')
  })

  test('缺少 id 拒绝', async () => {
    const ctx = createManagerCtx({})

    await expect(appointmentRoutes.detail(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*id/)
  })
})
