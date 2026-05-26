/**
 * 预约路由测试
 * 覆盖：list / detail / confirm / checkin
 * 核心约束：
 *   - 状态机：待确认 → 已确认
 *   - checkin 仅记录时间不改状态
 *   - 美容师只看/操作指定自己的预约
 */



const pg = globalThis.__mocks__.pg
const { createManagerCtx, createBeauticianCtx } = require('../helpers')
const appointmentRoutes = require('../../routes/appointment')

describe('appointment.confirm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('确认待确认预约（C4: UPDATE WHERE 含 status 条件）', async () => {
    const ctx = createManagerCtx({ appointmentId: 'appt-001' })

    pg.query.mockResolvedValueOnce([{
      appointment_id: 'appt-001',
      status: '待确认',
      employee_id: 'emp-001',
      store_id: 'store-001',
    }])
    // UPDATE + 审计日志走事务 client
    const clientQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    pg.transaction.mockImplementationOnce(async (cb) => await cb({ query: clientQuery }))

    await appointmentRoutes.confirm(ctx)

    expect(ctx.result.status).toBe('已确认')
    // 验证 UPDATE WHERE 包含状态条件（C4 合规）
    const updateSql = clientQuery.mock.calls[0][0]
    expect(updateSql).toContain("status = '已确认'")
    expect(updateSql).toContain("AND status = '待确认'")
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

    pg.query.mockResolvedValueOnce([{
      appointment_id: 'appt-001',
      status: '待确认',
      employee_id: 'emp-beautician-001',
      store_id: 'store-001',
    }])
    pg.transaction.mockImplementationOnce(async (cb) => await cb({ query: vi.fn(async () => ({ rows: [], rowCount: 1 })) }))

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

  test('并发竞态：UPDATE rowCount=0 时报错', async () => {
    const ctx = createManagerCtx({ appointmentId: 'appt-001' })

    pg.query
      .mockResolvedValueOnce([{
        appointment_id: 'appt-001',
        status: '待确认',
        employee_id: 'emp-001',
        store_id: 'store-001',
      }])
      // 模拟并发：SELECT 通过但 UPDATE 匹配 0 行（另一个请求先到）
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })

    await expect(appointmentRoutes.confirm(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*状态已变更/)
  })
})

describe('appointment.checkin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('签到成功 — 仅记录时间不改状态', async () => {
    const ctx = createManagerCtx({ appointmentId: 'appt-001' })

    pg.query.mockResolvedValueOnce([{
      appointment_id: 'appt-001',
      status: '已确认',
      employee_id: 'emp-001',
      store_id: 'store-001',
    }])
    // UPDATE checkin_at + 审计日志走事务 client
    const clientQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    pg.transaction.mockImplementationOnce(async (cb) => await cb({ query: clientQuery }))

    await appointmentRoutes.checkin(ctx)

    expect(ctx.result.checkinAt).toBeDefined()
    expect(ctx.result.message).toContain('已到店')
    // 验证只更新 checkin_at，不改 status（事务 client 首个调用 = UPDATE）
    const sql = clientQuery.mock.calls[0][0]
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

  test('美容师签到自己的预约（权限 happy path）', async () => {
    const ctx = createBeauticianCtx({ appointmentId: 'appt-own' })

    pg.query
      .mockResolvedValueOnce([{
        appointment_id: 'appt-own',
        status: '已确认',
        employee_id: 'emp-beautician-001',  // 匹配自己
        store_id: 'store-001',
        checkin_at: null,
      }])
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })

    await appointmentRoutes.checkin(ctx)

    expect(ctx.result.checkinAt).toBeDefined()
    expect(ctx.result.message).toContain('已到店')
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

  test('幂等 — 已签到过的预约不覆盖原始时间', async () => {
    const ctx = createManagerCtx({ appointmentId: 'appt-001' })
    const existingCheckinAt = '2024-01-15T09:55:00Z'

    pg.query.mockResolvedValueOnce([{
      appointment_id: 'appt-001',
      status: '已确认',
      employee_id: 'emp-001',
      store_id: 'store-001',
      checkin_at: existingCheckinAt,
    }])

    await appointmentRoutes.checkin(ctx)

    expect(ctx.result.checkinAt).toBe(existingCheckinAt)
    expect(ctx.result.message).toContain('幂等')
    // 不应执行 UPDATE
    expect(pg.query).toHaveBeenCalledTimes(1) // 仅 SELECT
  })

  test('缺少 appointmentId 时拒绝', async () => {
    const ctx = createManagerCtx({})

    await expect(appointmentRoutes.checkin(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*appointmentId/)
  })

  test('预约不存在时拒绝', async () => {
    const ctx = createManagerCtx({ appointmentId: 'appt-nonexist' })

    pg.query.mockResolvedValueOnce([])

    await expect(appointmentRoutes.checkin(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*不存在/)
  })
})

describe('appointment.list', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
    vi.clearAllMocks()
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

  test('预约不存在时拒绝', async () => {
    const ctx = createManagerCtx({ id: 'appt-nonexist' })

    pg.query.mockResolvedValueOnce([])

    await expect(appointmentRoutes.detail(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*不存在/)
  })

  test('美容师不能查看非分配给自己的预约', async () => {
    const ctx = createBeauticianCtx({ id: 'appt-001' })

    pg.query.mockResolvedValueOnce([{
      appointment_id: 'appt-001',
      status: '已确认',
      client_user_id: 'c1',
      client_name: '顾客A',
      employee_id: 'emp-other',
      employee_name: '他人',
      appointment_time: '2024-01-15T10:00:00Z',
      notes: '',
      sale_item_id: null,
      checkin_at: null,
      service_name: '到店预约',
      sku_spec_name: null,
      customer_phone: '',
      service_order_id: null,
    }])

    await expect(appointmentRoutes.detail(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('美容师查看自己的预约详情（权限 happy path）', async () => {
    const ctx = createBeauticianCtx({ id: 'appt-own' })

    pg.query.mockResolvedValueOnce([{
      appointment_id: 'appt-own',
      status: '已确认',
      client_user_id: 'c1',
      client_name: '顾客A',
      employee_id: 'emp-beautician-001',  // 匹配美容师自己
      employee_name: '当前美容师',
      appointment_time: '2024-01-15T10:00:00Z',
      notes: '需注意过敏',
      sale_item_id: 'si-001',
      checkin_at: null,
      service_name: '面部护理',
      sku_spec_name: '10次卡',
      customer_phone: '138****1111',
      service_order_id: null,
    }])

    await appointmentRoutes.detail(ctx)

    expect(ctx.result.id).toBe('appt-own')
    expect(ctx.result.customerName).toBe('顾客A')
    expect(ctx.result.remark).toBe('需注意过敏')
  })

  test('已有服务单时返回 serviceOrderId', async () => {
    const ctx = createManagerCtx({ id: 'appt-001' })

    pg.query.mockResolvedValueOnce([{
      appointment_id: 'appt-001',
      status: '已完成',
      client_user_id: 'c1',
      client_name: '顾客A',
      employee_id: 'emp-001',
      employee_name: '员工A',
      appointment_time: '2024-01-15T10:00:00Z',
      notes: '',
      sale_item_id: null,
      checkin_at: '2024-01-15T09:55:00Z',
      service_name: '面部护理',
      sku_spec_name: '10次卡',
      customer_phone: '138',
      service_order_id: 'HLD-WX-001',
    }])

    await appointmentRoutes.detail(ctx)

    expect(ctx.result.serviceOrderId).toBe('HLD-WX-001')
    expect(ctx.result.status).toBe('completed')
  })
})

// ============================================================
// list 补充覆盖
// ============================================================
describe('appointment.list 补充', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('中文状态直接传入也能过滤', async () => {
    const ctx = createManagerCtx({ status: '待确认', page: 1 })

    pg.query.mockResolvedValueOnce([])

    await appointmentRoutes.list(ctx)

    const params = pg.query.mock.calls[0][1]
    expect(params).toContain('待确认')
  })

  test('无状态过滤和无 todayOnly 时只按 store_id 查询', async () => {
    const ctx = createManagerCtx({ page: 1 })

    pg.query.mockResolvedValueOnce([])

    await appointmentRoutes.list(ctx)

    const sql = pg.query.mock.calls[0][0]
    expect(sql).not.toContain('a.status =')
    expect(sql).not.toContain('DATE(a.appointment_time)')
  })

  test('appointment_time 为 null 时 formatDateTime 返回空字符串（line 16 TRUE 分支）', async () => {
    const ctx = createManagerCtx({ page: 1 })

    pg.query.mockResolvedValueOnce([{
      appointment_id: 'appt-null',
      status: '待确认',
      client_user_id: 'c1',
      client_name: '顾客A',
      employee_id: 'emp-001',
      employee_name: '员工A',
      appointment_time: null,
      notes: '',
      sale_item_id: null,
      checkin_at: null,
      created_at: '2024-01-15',
      sale_order_id: null,
      service_name: '到店预约',
      sku_spec_name: null,
      customer_phone: '138',
    }])

    await appointmentRoutes.list(ctx)

    expect(ctx.result[0].appointmentTime).toBe('')
  })

  test('status + todayOnly 组合过滤', async () => {
    const ctx = createManagerCtx({ status: 'pending', todayOnly: true, page: 1 })

    pg.query.mockResolvedValueOnce([])

    await appointmentRoutes.list(ctx)

    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).toContain('a.status =')
    expect(sql).toContain('DATE(a.appointment_time)')
    expect(params).toContain('待确认')
  })

  test('service_name 为 null 时回退到 sku_spec_name', async () => {
    const ctx = createManagerCtx({ page: 1 })

    pg.query.mockResolvedValueOnce([{
      appointment_id: 'appt-sku',
      status: '待确认',
      client_user_id: 'c1',
      client_name: '顾客A',
      employee_id: 'emp-001',
      employee_name: '员工A',
      appointment_time: '2024-06-01T10:00:00Z',
      notes: '',
      sale_item_id: 'si-001',
      checkin_at: null,
      created_at: '2024-06-01',
      sale_order_id: 'SO-001',
      service_name: null,
      sku_spec_name: '10次卡',
      customer_phone: '138',
    }])

    await appointmentRoutes.list(ctx)

    // service_name null → 回退到 sku_spec_name
    expect(ctx.result[0].serviceItemName).toBe('10次卡')
  })

  test('service_name 和 sku_spec_name 都为 null 时返回空字符串', async () => {
    const ctx = createManagerCtx({ page: 1 })

    pg.query.mockResolvedValueOnce([{
      appointment_id: 'appt-empty',
      status: '待确认',
      client_user_id: 'c1',
      client_name: '顾客A',
      employee_id: 'emp-001',
      employee_name: '员工A',
      appointment_time: '2024-06-01T10:00:00Z',
      notes: '',
      sale_item_id: null,
      checkin_at: null,
      created_at: '2024-06-01',
      sale_order_id: null,
      service_name: null,
      sku_spec_name: null,
      customer_phone: '138',
    }])

    await appointmentRoutes.list(ctx)

    expect(ctx.result[0].serviceItemName).toBe('')
  })

  test('美容师 + 状态过滤组合', async () => {
    const ctx = createBeauticianCtx({ status: 'confirmed', page: 1 })

    pg.query.mockResolvedValueOnce([])

    await appointmentRoutes.list(ctx)

    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).toContain('a.status =')
    expect(sql).toContain('a.employee_id =')
    expect(params).toContain('已确认')
    expect(params).toContain('emp-beautician-001')
  })

  test('appointment_time 为无效日期字符串时 formatDateTime 返回原始值（line 18 TRUE 分支）', async () => {
    const ctx = createManagerCtx({ page: 1 })

    pg.query.mockResolvedValueOnce([{
      appointment_id: 'appt-bad',
      status: '待确认',
      client_user_id: 'c1',
      client_name: '顾客A',
      employee_id: 'emp-001',
      employee_name: '员工A',
      appointment_time: 'not-a-date',
      notes: '',
      sale_item_id: null,
      checkin_at: null,
      created_at: '2024-01-15',
      sale_order_id: null,
      service_name: '到店预约',
      sku_spec_name: null,
      customer_phone: '138',
    }])

    await appointmentRoutes.list(ctx)

    expect(ctx.result[0].appointmentTime).toBe('not-a-date')
  })
})
