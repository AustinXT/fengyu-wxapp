/**
 * 积分路由测试
 * 覆盖：balance（余额+等级+下一等级）、history（分页）
 */

const pg = globalThis.__mocks__.pg
const { createBoundCtx, createCtx } = require('../helpers')

let routes
beforeEach(() => {
  vi.clearAllMocks()
  Object.keys(require.cache).forEach(key => {
    if (key.includes('/routes/points')) delete require.cache[key]
  })
  routes = require('../../routes/points')
})

describe('points.balance', () => {
  test('返回积分余额和等级名称（重构后：单表查询，levelBenefits/nextLevel 硬编码 null）', async () => {
    // 重构后 customer_points 表已去掉，仅从 client_wechat_users 读取 balance + member_level
    pg.query.mockResolvedValueOnce([{
      balance: 1200,
      level_name: '银卡会员',
    }])

    const ctx = createBoundCtx({})
    await routes.balance(ctx)

    expect(ctx.result.balance).toBe(1200)
    expect(ctx.result.levelName).toBe('银卡会员')
    expect(ctx.result.levelBenefits).toBeNull()
    expect(ctx.result.nextLevel).toBeNull()
  })

  test('无积分记录返回默认值', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({})
    await routes.balance(ctx)

    expect(ctx.result.balance).toBe(0)
    expect(ctx.result.levelName).toBeNull()
    expect(ctx.result.levelBenefits).toBeNull()
    expect(ctx.result.nextLevel).toBeNull()
  })

  test('已是最高等级时 nextLevel 为 null', async () => {
    pg.query
      .mockResolvedValueOnce([{
        balance: 5000, level_id: 'lv-5', level_name: '钻石会员',
        min_points: 3000, benefits: '7折优惠',
      }])
      .mockResolvedValueOnce([]) // 没有更高等级

    const ctx = createBoundCtx({})
    await routes.balance(ctx)

    expect(ctx.result.balance).toBe(5000)
    expect(ctx.result.levelName).toBe('钻石会员')
    expect(ctx.result.nextLevel).toBeNull()
  })

  test('使用 userId 查询', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({}, { userId: 'user-xyz' })
    await routes.balance(ctx)

    expect(pg.query.mock.calls[0][1]).toEqual(['user-xyz'])
  })
})

describe('points.history', () => {
  test('返回积分变动记录', async () => {
    pg.query.mockResolvedValueOnce([
      { id: 'pt-1', type: '消费', amount: -100, ref_order_id: 'ord-1', created_at: '2025-06-01' },
      { id: 'pt-2', type: '签到', amount: 10, ref_order_id: null, created_at: '2025-06-02' },
    ])

    const ctx = createBoundCtx({ page: 1, pageSize: 20 })
    await routes.history(ctx)

    expect(ctx.result.records).toHaveLength(2)
    expect(ctx.result.records[0].type).toBe('消费')
  })

  test('分页参数正确', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({ page: 3, pageSize: 10 })
    await routes.history(ctx)

    const params = pg.query.mock.calls[0][1]
    expect(params).toContain(10)  // pageSize → LIMIT
    expect(params).toContain(20)  // offset = (3-1)*10 = 20
  })

  test('默认分页参数', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({})
    await routes.history(ctx)

    const params = pg.query.mock.calls[0][1]
    expect(params).toContain(20)  // 默认 pageSize
    expect(params).toContain(0)   // 默认 offset
  })

  test('无记录返回空数组', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({})
    await routes.history(ctx)

    expect(ctx.result.records).toEqual([])
  })
})
