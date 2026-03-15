/**
 * 充值卡路由测试
 * 覆盖：list（卡列表含门店名）、history（交易记录+分页+所有权校验）
 */

const pg = globalThis.__mocks__.pg
const { createBoundCtx } = require('../helpers')

let routes
beforeEach(() => {
  vi.clearAllMocks()
  Object.keys(require.cache).forEach(key => {
    if (key.includes('/routes/card')) delete require.cache[key]
  })
  routes = require('../../routes/card')
})

describe('card.list', () => {
  test('返回充值卡列表含门店名', async () => {
    pg.query.mockResolvedValueOnce([
      {
        card_id: 'card-1', balance: 500, store_id: 's1',
        store_name: '凤御A店', created_at: '2025-01-01',
      },
      {
        card_id: 'card-2', balance: 1000, store_id: 's2',
        store_name: '凤御B店', created_at: '2025-02-01',
      },
    ])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    expect(ctx.result.cards).toHaveLength(2)
    expect(ctx.result.cards[0].cardId).toBe('card-1')
    expect(ctx.result.cards[0].storeName).toBe('凤御A店')
    expect(ctx.result.cards[1].balance).toBe(1000)
  })

  test('无充值卡返回空数组', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    expect(ctx.result.cards).toEqual([])
  })

  test('使用 userId 查询', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({}, { userId: 'user-abc' })
    await routes.list(ctx)

    expect(pg.query.mock.calls[0][1]).toEqual(['user-abc'])
  })

  test('按创建时间倒序排列', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    expect(pg.query.mock.calls[0][0]).toContain('ORDER BY pc.created_at DESC')
  })

  test('LEFT JOIN stores 获取门店名', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    expect(pg.query.mock.calls[0][0]).toContain('LEFT JOIN stores')
  })
})

describe('card.history', () => {
  test('返回交易记录', async () => {
    // 第一次查询：所有权校验
    pg.query.mockResolvedValueOnce([{ card_id: 'card-1' }])
    // 第二次查询：交易记录
    pg.query.mockResolvedValueOnce([
      { id: 'ct-1', type: '充值', amount: 500, ref_order_id: null, created_at: '2025-06-01' },
      { id: 'ct-2', type: '消费', amount: -100, ref_order_id: 'ord-1', created_at: '2025-06-02' },
    ])

    const ctx = createBoundCtx({ cardId: 'card-1' })
    await routes.history(ctx)

    expect(ctx.result.records).toHaveLength(2)
    expect(ctx.result.records[0].type).toBe('充值')
    expect(ctx.result.records[1].amount).toBe(-100)
  })

  test('缺少 cardId → INVALID_PARAMS', async () => {
    const ctx = createBoundCtx({})
    await expect(routes.history(ctx)).rejects.toThrow(/INVALID_PARAMS.*cardId/)
  })

  test('卡不存在 → INVALID_PARAMS', async () => {
    pg.query.mockResolvedValueOnce([]) // 所有权校验返回空

    const ctx = createBoundCtx({ cardId: 'nonexistent' })
    await expect(routes.history(ctx)).rejects.toThrow(/INVALID_PARAMS.*充值卡不存在/)
  })

  test('校验卡的所有权（user_id 匹配）', async () => {
    pg.query.mockResolvedValueOnce([{ card_id: 'card-1' }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({ cardId: 'card-1' }, { userId: 'user-xyz' })
    await routes.history(ctx)

    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).toContain('card_id = $1')
    expect(sql).toContain('user_id = $2')
    expect(params).toEqual(['card-1', 'user-xyz'])
  })

  test('分页参数正确', async () => {
    pg.query.mockResolvedValueOnce([{ card_id: 'card-1' }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({ cardId: 'card-1', page: 2, pageSize: 10 })
    await routes.history(ctx)

    const params = pg.query.mock.calls[1][1]
    expect(params).toEqual(['card-1', 10, 10]) // cardId, pageSize, offset
  })

  test('默认分页', async () => {
    pg.query.mockResolvedValueOnce([{ card_id: 'card-1' }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({ cardId: 'card-1' })
    await routes.history(ctx)

    const params = pg.query.mock.calls[1][1]
    expect(params).toEqual(['card-1', 20, 0])
  })

  test('仅查询最近6个月记录', async () => {
    pg.query.mockResolvedValueOnce([{ card_id: 'card-1' }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({ cardId: 'card-1' })
    await routes.history(ctx)

    const sql = pg.query.mock.calls[1][0]
    expect(sql).toContain("'6 months'")
  })

  test('无交易记录返回空数组', async () => {
    pg.query.mockResolvedValueOnce([{ card_id: 'card-1' }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({ cardId: 'card-1' })
    await routes.history(ctx)

    expect(ctx.result.records).toEqual([])
  })
})
