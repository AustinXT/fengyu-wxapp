/**
 * 预约路由测试
 * 覆盖：create（正常/重复预约/余次=0 拒绝）、list、cancel（状态校验）
 */

const pg = globalThis.__mocks__.pg
const { createBoundCtx, createCtx } = require('../helpers')

let routes

// 生成未来日期字符串（明天），确保不触发"过去时间"校验
function futureTime() {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day} 上午 10:00-12:00`
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.keys(require.cache).forEach(key => {
    if (key.includes('/routes/appointment') || key.includes('/middleware/auth')) {
      delete require.cache[key]
    }
  })
  routes = require('../../routes/appointment')
})

describe('appointment.create', () => {
  test('正常创建预约（关联疗程卡）', async () => {
    pg.query.mockResolvedValueOnce([{
      phone: '13800001111', name: '张三',
      bound_store_id: 'store-001', bound_store_name: '凤御测试店',
    }])
    pg.query.mockResolvedValueOnce([{
      sale_item_id: 'SI-001', sale_order_id: 'FY-001',
      remaining_sessions: 5, client_user_id: 'user-001', store_id: 'store-001',
    }])
    pg.query.mockResolvedValueOnce([])
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({
      saleItemId: 'SI-001',
      appointmentTime: futureTime(),
    })
    await routes.create(ctx)

    expect(ctx.result.appointmentId).toMatch(/^apt_/)
    expect(ctx.result.status).toBe('待确认')
  })

  test('创建到店预约（无关联疗程卡）', async () => {
    pg.query.mockResolvedValueOnce([{
      phone: '138', name: '张三',
      bound_store_id: 'store-001', bound_store_name: '测试店',
    }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({
      appointmentTime: futureTime(),
    })
    await routes.create(ctx)

    expect(ctx.result.appointmentId).toBeTruthy()
  })

  test('剩余次数为 0 → INVALID_PARAMS', async () => {
    pg.query.mockResolvedValueOnce([{
      phone: '138', name: '张三', bound_store_id: 's1', bound_store_name: 'S1',
    }])
    pg.query.mockResolvedValueOnce([{
      sale_item_id: 'SI-001', remaining_sessions: 0,
      client_user_id: 'user-001', store_id: 's1',
    }])

    const ctx = createBoundCtx({
      saleItemId: 'SI-001',
      appointmentTime: futureTime(),
    })
    await expect(routes.create(ctx)).rejects.toThrow(/INVALID_PARAMS.*剩余次数不足/)
  })

  test('已有未完成预约 → INVALID_PARAMS', async () => {
    pg.query.mockResolvedValueOnce([{
      phone: '138', name: '张三', bound_store_id: 's1', bound_store_name: 'S1',
    }])
    pg.query.mockResolvedValueOnce([{
      sale_item_id: 'SI-001', remaining_sessions: 5,
      client_user_id: 'user-001', store_id: 's1',
    }])
    pg.query.mockResolvedValueOnce([{ appointment_id: 'apt-existing' }])

    const ctx = createBoundCtx({
      saleItemId: 'SI-001',
      appointmentTime: futureTime(),
    })
    await expect(routes.create(ctx)).rejects.toThrow(/INVALID_PARAMS.*已有待确认/)
  })

  test('无手机号 → PHONE_REQUIRED', async () => {
    const ctx = createCtx({
      payload: { appointmentTime: futureTime() },
      auth: { phone: null },
    })
    await expect(routes.create(ctx)).rejects.toThrow(/PHONE_REQUIRED/)
  })

  test('缺少预约时间 → INVALID_PARAMS', async () => {
    const ctx = createBoundCtx({})
    await expect(routes.create(ctx)).rejects.toThrow(/INVALID_PARAMS.*预约时间/)
  })

  test('预约时间格式不正确 → INVALID_PARAMS', async () => {
    pg.query.mockResolvedValueOnce([{
      phone: '138', name: '张三', bound_store_id: 's1', bound_store_name: 'S1',
    }])

    const ctx = createBoundCtx({ appointmentTime: 'invalid-format' })
    await expect(routes.create(ctx)).rejects.toThrow(/INVALID_PARAMS.*格式不正确/)
  })

  test('预约时间为过去 → INVALID_PARAMS', async () => {
    const ctx = createBoundCtx({
      appointmentTime: '2024-01-01 上午 09:00-11:00',
    })
    await expect(routes.create(ctx)).rejects.toThrow(/INVALID_PARAMS.*过去/)
  })

  test('非本人订单 → PERMISSION_DENIED', async () => {
    pg.query.mockResolvedValueOnce([{
      phone: '138', name: '张三', bound_store_id: 's1', bound_store_name: 'S1',
    }])
    pg.query.mockResolvedValueOnce([{
      sale_item_id: 'SI-001', remaining_sessions: 5,
      client_user_id: 'other-user', store_id: 's1',
    }])

    const ctx = createBoundCtx({
      saleItemId: 'SI-001',
      appointmentTime: futureTime(),
    })
    await expect(routes.create(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })
})

describe('appointment.list', () => {
  test('返回用户预约列表（含分页）', async () => {
    pg.query.mockResolvedValueOnce([{
      appointment_id: 'apt-1', status: '待确认',
      store_id: 's1', store_name: '测试店',
      appointment_time: '2025-03-20T10:00:00Z',
      service_name: '护理A',
      session_count: 10,
      remaining_sessions: 8,
      paid_sessions: 10,
    }])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    expect(ctx.result.appointments).toHaveLength(1)
    expect(ctx.result.hasMore).toBe(false)
    expect(ctx.result.appointments[0]).toMatchObject({
      service_name: '护理A',
      session_count: 10,
      remaining_sessions: 8,
      paid_sessions: 10,
    })

    // 验证 SQL 包含 LIMIT/OFFSET
    const sql = pg.query.mock.calls[0][0]
    expect(sql).toContain('LIMIT')
    expect(sql).toContain('OFFSET')
    expect(sql).toContain('si.session_count')
    expect(sql).toContain('si.remaining_sessions')
    expect(sql).toContain('si.paid_sessions')
  })

  test('hasMore=true 当结果超过 pageSize', async () => {
    const items = Array.from({ length: 21 }, (_, i) => ({
      appointment_id: `apt-${i}`, status: '待确认',
    }))
    pg.query.mockResolvedValueOnce(items)

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    expect(ctx.result.appointments).toHaveLength(20)
    expect(ctx.result.hasMore).toBe(true)
  })

  test('page=2 使用正确的 OFFSET', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({ page: 2, pageSize: 10 })
    await routes.list(ctx)

    const params = pg.query.mock.calls[0][1]
    expect(params).toContain(10)  // offset = (2-1) * 10
  })

  test('按状态筛选', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({ status: '已确认' })
    await routes.list(ctx)

    expect(pg.query.mock.calls[0][0]).toContain('a.status = $')
    expect(pg.query.mock.calls[0][1]).toContain('已确认')
  })
})

describe('appointment.cancel', () => {
  test('正常取消待确认预约', async () => {
    pg.query
      .mockResolvedValueOnce([{
        appointment_id: 'apt-1', status: '待确认', client_user_id: 'user-001',
      }])
      .mockResolvedValueOnce([]) // 无关联服务单
      .mockResolvedValueOnce([])

    const ctx = createBoundCtx({ appointmentId: 'apt-1' })
    await routes.cancel(ctx)

    expect(ctx.result.status).toBe('已取消')
  })

  test('已确认预约不可取消 → INVALID_PARAMS', async () => {
    pg.query.mockResolvedValueOnce([{
      appointment_id: 'apt-1', status: '已确认', client_user_id: 'user-001',
    }])

    const ctx = createBoundCtx({ appointmentId: 'apt-1' })
    await expect(routes.cancel(ctx)).rejects.toThrow(/INVALID_PARAMS.*仅待确认/)
  })

  test('已关联进行中服务单的预约不可取消 → INVALID_STATE', async () => {
    pg.query
      .mockResolvedValueOnce([{
        appointment_id: 'apt-1', status: '待确认', client_user_id: 'user-001',
      }])
      .mockResolvedValueOnce([{ '?column?': 1 }]) // 存在 服务中 服务单

    const ctx = createBoundCtx({ appointmentId: 'apt-1' })
    await expect(routes.cancel(ctx)).rejects.toThrow(/INVALID_STATE.*已开始服务/)

    // 守卫 SQL：关联服务单只要不是「已取消」就拦截
    const guardSql = pg.query.mock.calls[1][0]
    expect(guardSql).toContain('service_orders')
    expect(guardSql).toContain("NOT IN ('已取消')")
  })

  test('服务单已取消时仍可取消预约', async () => {
    pg.query
      .mockResolvedValueOnce([{
        appointment_id: 'apt-1', status: '待确认', client_user_id: 'user-001',
      }])
      .mockResolvedValueOnce([]) // 服务单为 已取消，守卫查询不命中
      .mockResolvedValueOnce([])

    const ctx = createBoundCtx({ appointmentId: 'apt-1' })
    await routes.cancel(ctx)

    expect(ctx.result.status).toBe('已取消')
  })

  test('已完成预约不允许取消', async () => {
    pg.query.mockResolvedValueOnce([{
      appointment_id: 'apt-1', status: '已完成', client_user_id: 'user-001',
    }])

    const ctx = createBoundCtx({ appointmentId: 'apt-1' })
    await expect(routes.cancel(ctx)).rejects.toThrow(/INVALID_PARAMS.*仅待确认/)
  })

  test('缺少 appointmentId → INVALID_PARAMS', async () => {
    const ctx = createBoundCtx({})
    await expect(routes.cancel(ctx)).rejects.toThrow(/INVALID_PARAMS.*appointmentId/)
  })

  test('预约不存在 → INVALID_PARAMS', async () => {
    pg.query.mockResolvedValueOnce([])
    const ctx = createBoundCtx({ appointmentId: 'nonexistent' })
    await expect(routes.cancel(ctx)).rejects.toThrow(/INVALID_PARAMS.*预约不存在/)
  })
})
