/**
 * 云函数入口测试
 * 覆盖：路由分发、错误码映射、缺少 action 处理
 */


const path = require('path')
const cloud = globalThis.__mocks__.cloud
const pg = globalThis.__mocks__.pg
const staffApiDir = path.resolve(__dirname, '..')

function clearStaffApiCache() {
  Object.keys(require.cache).forEach(key => {
    if (key.startsWith(staffApiDir) && !key.includes('node_modules') && !key.includes('__tests__') && !key.includes('/db/')) {
      delete require.cache[key]
    }
  })
}

describe('staffApi 入口', () => {
  let main

  beforeEach(() => {
    vi.clearAllMocks()
    clearStaffApiCache()
    main = require('../index').main

    // 默认：auth 中间件需要 staff 行，设置为已绑定员工
    cloud.getWXContext.mockReturnValue({ OPENID: 'test-openid-001' })
    pg.query
      .mockResolvedValueOnce([{
        employee_id: 'emp-001',
        phone: '13800001111',
        name: '张三',
        position_name: '门店经理',
        store_id: 'store-001',
        is_resigned: false,
        store_name: '测试店',
        market_name: '测试市场',
        department: '美容部',
      }])
      .mockResolvedValueOnce([{ role: 'manager' }]) // permission_roles
  })

  test('缺少 action 返回 code: -1', async () => {
    const result = await main({}, {})
    expect(result.code).toBe(-1)
    expect(result.message).toContain('action')
  })

  test('未知 action 返回 code: -1', async () => {
    const result = await main({ action: 'unknown.method' }, {})
    expect(result.code).toBe(-1)
    expect(result.message).toContain('未知')
  })

  test('成功路由返回 code: 0 + data', async () => {
    pg.query.mockResolvedValueOnce([
      { store_id: 's1', store_name: '店A', market_name: '市场A' },
    ])
    const result = await main({ action: 'store.list', payload: {} }, {})
    expect(result.code).toBe(0)
    expect(result.message).toBe('success')
    expect(result.data).toBeDefined()
  })

  test('UNAUTHORIZED 错误映射为 code: -401', async () => {
    cloud.getWXContext.mockReturnValue({ OPENID: '' })
    clearStaffApiCache()
    const mainFresh = require('../index').main
    const result = await mainFresh({ action: 'store.list', payload: {} }, {})
    expect(result.code).toBe(-401)
    expect(result.message).toContain('UNAUTHORIZED')
  })

  test('INVALID_PARAMS 错误映射为 code: -400', async () => {
    const result = await main({
      action: 'order.create',
      payload: {},
    }, {})
    expect(result.code).toBe(-400)
    expect(result.message).toContain('INVALID_PARAMS')
  })

  test('PERMISSION_DENIED 错误映射为 code: -403', async () => {
    // 使用 allocation.pendingList（仅店长）测试权限拒绝映射
    // 先用美容师身份 mock auth
    pg.query
      .mockReset()
      .mockResolvedValueOnce([{
        employee_id: 'emp-b',
        phone: '139',
        name: '美容师A',
        position_name: '美容师',
        store_id: 'store-001',
        is_resigned: false,
        store_name: '测试店',
        market_name: '测试市场',
        department: '美容部',
      }])
      .mockResolvedValueOnce([]) // 无 manager 角色
      .mockResolvedValue([])

    clearStaffApiCache()
    const mainFresh = require('../index').main
    const result = await mainFresh({
      action: 'allocation.pendingList',
      payload: { page: 1 },
    }, {})
    expect(result.code).toBe(-403)
    expect(result.message).toContain('PERMISSION_DENIED')
  })
})
