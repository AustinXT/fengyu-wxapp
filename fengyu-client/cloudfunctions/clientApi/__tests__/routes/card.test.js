/**
 * 充值卡路由测试
 * 覆盖：list（跨店共享，一户一账户）、balance（按 user_id 查余额）、history（交易记录+分页+所有权校验）
 */

const pg = globalThis.__mocks__.pg
const { createBoundCtx, createCtx } = require('../helpers')

let routes
beforeEach(() => {
  vi.clearAllMocks()
  Object.keys(require.cache).forEach(key => {
    if (key.includes('/routes/card') || key.includes('/middleware/auth')) delete require.cache[key]
  })
  routes = require('../../routes/card')
})

describe('card.list', () => {
  test('返回充值卡列表（无 storeId/storeName 字段）', async () => {
    pg.query.mockResolvedValueOnce([
      { card_id: 'card-1', balance: 500, created_at: '2025-01-01' },
    ])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    expect(ctx.result.cards).toHaveLength(1)
    expect(ctx.result.cards[0].cardId).toBe('card-1')
    expect(ctx.result.cards[0].balance).toBe(500)
    expect(ctx.result.cards[0].createdAt).toBe('2025-01-01')
    expect(ctx.result.cards[0].storeId).toBeUndefined()
    expect(ctx.result.cards[0].storeName).toBeUndefined()
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

  test('SQL 不含 LEFT JOIN stores（跨店共享，不取 store_name）', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    expect(pg.query.mock.calls[0][0]).not.toContain('LEFT JOIN stores')
    expect(pg.query.mock.calls[0][0]).not.toContain('store_id')
  })

  test('PG numeric 字符串 balance 转为 number（避免前端 toFixed 报错）', async () => {
    pg.query.mockResolvedValueOnce([
      { card_id: 'card-1', balance: '7378.52', created_at: '2025-01-01' },
    ])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    expect(typeof ctx.result.cards[0].balance).toBe('number')
    expect(ctx.result.cards[0].balance).toBe(7378.52)
  })
})

describe('card.balance', () => {
  test('无卡返回 balance=0, cardId=null', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({})
    await routes.balance(ctx)

    expect(ctx.result).toEqual({ balance: 0, cardId: null })
  })

  test('有卡按 user_id 查出余额', async () => {
    pg.query.mockResolvedValueOnce([
      { card_id: 'card-1', balance: '320.50' },
    ])

    const ctx = createBoundCtx({}, { userId: 'user-xyz' })
    await routes.balance(ctx)

    expect(ctx.result.cardId).toBe('card-1')
    expect(ctx.result.balance).toBe(320.5)
    expect(typeof ctx.result.balance).toBe('number')

    // 参数化查询，SQL 按 user_id
    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).toContain('user_id = $1')
    expect(sql).not.toContain('store_id')
    expect(params).toEqual(['user-xyz'])
  })

  test('未绑定手机号 → PHONE_REQUIRED', async () => {
    const ctx = createCtx({
      payload: {},
      auth: { phone: null },
    })
    await expect(routes.balance(ctx)).rejects.toThrow(/PHONE_REQUIRED/)
  })

  test('不接受 storeId 参数（payload 有 storeId 被忽略）', async () => {
    pg.query.mockResolvedValueOnce([
      { card_id: 'card-1', balance: '100' },
    ])

    const ctx = createBoundCtx({ storeId: 'any-store' }, { userId: 'user-1' })
    await routes.balance(ctx)

    // SQL 只按 user_id 查询，不会把 storeId 作为参数
    const params = pg.query.mock.calls[0][1]
    expect(params).toEqual(['user-1'])
    expect(ctx.result.balance).toBe(100)
  })

  test('返回的 balance 是 number 而非字符串', async () => {
    pg.query.mockResolvedValueOnce([
      { card_id: 'card-1', balance: '0.00' },
    ])

    const ctx = createBoundCtx({})
    await routes.balance(ctx)

    expect(typeof ctx.result.balance).toBe('number')
    expect(ctx.result.balance).toBe(0)
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

  test('PG numeric 字符串 amount 转为 number（避免前端 toFixed 报错）', async () => {
    // node-postgres 将 numeric 类型返回为字符串，必须在云函数端转数字
    pg.query.mockResolvedValueOnce([{ card_id: 'card-1' }])
    pg.query.mockResolvedValueOnce([
      { id: 'ct-1', type: '充值', amount: '500.00', ref_order_id: null, created_at: '2025-06-01' },
      { id: 'ct-2', type: '消费', amount: '-120.50', ref_order_id: 'ord-1', created_at: '2025-06-02' },
    ])

    const ctx = createBoundCtx({ cardId: 'card-1' })
    await routes.history(ctx)

    expect(typeof ctx.result.records[0].amount).toBe('number')
    expect(ctx.result.records[0].amount).toBe(500)
    expect(ctx.result.records[1].amount).toBe(-120.5)
  })
})
