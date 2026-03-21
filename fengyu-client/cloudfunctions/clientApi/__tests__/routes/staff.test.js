/**
 * 美容师路由测试
 * 覆盖：list、defaultStaff、detail（详情+服务次数+忙碌状态）
 */

const pg = globalThis.__mocks__.pg
const { createCtx, createBoundCtx } = require('../helpers')

let routes
beforeEach(() => {
  vi.clearAllMocks()
  routes = require('../../routes/staff')
})

describe('staff.list', () => {
  test('返回门店美容师列表', async () => {
    pg.query.mockResolvedValueOnce([
      { staff_id: 'emp-1', name: '张美', position: '美容师', phone: '138' },
      { staff_id: 'emp-2', name: '李美', position: '高级美容师', phone: '139' },
    ])

    const ctx = createCtx({ payload: { storeId: 'store-001' } })
    await routes.list(ctx)

    expect(ctx.result.staffList).toHaveLength(2)
    expect(ctx.result.staffList[0].name).toBe('张美')
  })

  test('缺少 storeId → INVALID_PARAMS', async () => {
    const ctx = createCtx({ payload: {} })
    await expect(routes.list(ctx)).rejects.toThrow(/INVALID_PARAMS.*storeId/)
  })
})

describe('staff.defaultStaff', () => {
  test('有绑定美容师时返回信息', async () => {
    pg.query.mockResolvedValueOnce([{
      main_staff_id: 'emp-1', bound_store_id: 's1', store_name: '凤御A店',
    }])
    pg.query.mockResolvedValueOnce([{
      staff_id: 'emp-1', name: '张美', position: '美容师',
    }])

    const ctx = createBoundCtx({})
    await routes.defaultStaff(ctx)

    expect(ctx.result.mainStaffId).toBe('emp-1')
    expect(ctx.result.mainStaffName).toBe('张美')
    expect(ctx.result.storeName).toBe('凤御A店')
  })

  test('未绑定手机号 → 返回空', async () => {
    const ctx = createCtx({ payload: {}, auth: { phone: null, userId: null } })
    await routes.defaultStaff(ctx)

    expect(ctx.result.mainStaffId).toBeNull()
  })

  test('无绑定美容师 → 返回空', async () => {
    pg.query.mockResolvedValueOnce([{
      main_staff_id: null, bound_store_id: 's1', store_name: '凤御A店',
    }])

    const ctx = createBoundCtx({})
    await routes.defaultStaff(ctx)

    expect(ctx.result.mainStaffId).toBeNull()
    expect(ctx.result.storeName).toBe('凤御A店')
  })
})

describe('staff.detail', () => {
  const staffRow = {
    employee_id: 'emp-1', name: '张美丽', position_name: '高级美容师',
    skills: ['美白护理', '深层清洁'], gender: '女',
    store_id: 'store-001', store_name: '凤御A店',
  }

  test('返回美容师详情（含服务次数和今日预约）', async () => {
    pg.query
      .mockResolvedValueOnce([staffRow])                   // basic info
      .mockResolvedValueOnce([{ count: 42 }])              // service count
      .mockResolvedValueOnce([{ count: 2 }])               // today appointments

    const ctx = createCtx({ payload: { employeeId: 'emp-1' } })
    await routes.detail(ctx)

    expect(ctx.result.employeeId).toBe('emp-1')
    expect(ctx.result.name).toBe('张美丽')
    expect(ctx.result.position).toBe('高级美容师')
    expect(ctx.result.skills).toEqual(['美白护理', '深层清洁'])
    expect(ctx.result.storeId).toBe('store-001')
    expect(ctx.result.storeName).toBe('凤御A店')
    expect(ctx.result.serviceCount).toBe(42)
    expect(ctx.result.todayAppointments).toBe(2)
    expect(ctx.result.isBusy).toBe(true)
  })

  test('isBusy = false 当今日无预约', async () => {
    pg.query
      .mockResolvedValueOnce([staffRow])
      .mockResolvedValueOnce([{ count: 10 }])
      .mockResolvedValueOnce([{ count: 0 }])

    const ctx = createCtx({ payload: { employeeId: 'emp-1' } })
    await routes.detail(ctx)

    expect(ctx.result.isBusy).toBe(false)
    expect(ctx.result.todayAppointments).toBe(0)
  })

  test('skills 为 null 时返回空数组', async () => {
    pg.query
      .mockResolvedValueOnce([{ ...staffRow, skills: null }])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([{ count: 0 }])

    const ctx = createCtx({ payload: { employeeId: 'emp-1' } })
    await routes.detail(ctx)

    expect(ctx.result.skills).toEqual([])
  })

  test('serviceCount 默认 0 当查询结果为空', async () => {
    pg.query
      .mockResolvedValueOnce([staffRow])
      .mockResolvedValueOnce([])           // count 查询返回空数组
      .mockResolvedValueOnce([])

    const ctx = createCtx({ payload: { employeeId: 'emp-1' } })
    await routes.detail(ctx)

    expect(ctx.result.serviceCount).toBe(0)
    expect(ctx.result.isBusy).toBe(false)
  })

  test('缺少 employeeId → INVALID_PARAMS', async () => {
    const ctx = createCtx({ payload: {} })
    await expect(routes.detail(ctx)).rejects.toThrow(/INVALID_PARAMS.*employeeId/)
  })

  test('美容师不存在 → INVALID_PARAMS', async () => {
    pg.query.mockResolvedValueOnce([])  // basic info 返回空

    const ctx = createCtx({ payload: { employeeId: 'nonexistent' } })
    await expect(routes.detail(ctx)).rejects.toThrow(/INVALID_PARAMS.*美容师不存在/)
  })
})
