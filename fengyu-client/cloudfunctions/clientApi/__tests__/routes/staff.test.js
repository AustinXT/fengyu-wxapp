/**
 * 美容师路由测试
 * 覆盖：list、defaultStaff
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
