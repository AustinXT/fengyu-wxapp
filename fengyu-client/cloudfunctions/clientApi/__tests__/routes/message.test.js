/**
 * 消息路由测试
 * 覆盖：list（分页）、read（标记已读+参数校验）、unreadCount（未读数）
 */

const pg = globalThis.__mocks__.pg
const { createBoundCtx } = require('../helpers')

let routes
beforeEach(() => {
  vi.clearAllMocks()
  Object.keys(require.cache).forEach(key => {
    if (key.includes('/routes/message')) delete require.cache[key]
  })
  routes = require('../../routes/message')
})

describe('message.list', () => {
  test('返回消息列表', async () => {
    pg.query.mockResolvedValueOnce([
      {
        id: 'msg-1', title: '服务完成', body: '您的护理服务已完成',
        message_type: 'service', is_read: false,
        ref_entity_type: 'service_order', ref_entity_id: 'svc-001',
        created_at: '2025-06-01',
      },
    ])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    expect(ctx.result.records).toHaveLength(1)
    expect(ctx.result.records[0].title).toBe('服务完成')
  })

  test('分页参数正确', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({ page: 2, pageSize: 10 })
    await routes.list(ctx)

    const [sql, params] = pg.query.mock.calls[0]
    expect(params).toEqual(['user-001', 10, 10]) // userId, pageSize, offset=(2-1)*10
    expect(sql).toContain('LIMIT $2 OFFSET $3')
  })

  test('默认分页', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    const params = pg.query.mock.calls[0][1]
    expect(params).toEqual(['user-001', 20, 0])
  })

  test('按 recipient_type=client 过滤', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    const sql = pg.query.mock.calls[0][0]
    expect(sql).toContain("recipient_type = 'client'")
  })

  test('无消息返回空数组', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    expect(ctx.result.records).toEqual([])
  })
})

describe('message.read', () => {
  test('标记消息已读', async () => {
    pg.query.mockResolvedValueOnce({ rowCount: 1 })

    const ctx = createBoundCtx({ messageId: 'msg-001' })
    await routes.read(ctx)

    expect(ctx.result.success).toBe(true)
    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).toContain('SET is_read = true')
    expect(params).toEqual(['msg-001', 'client', 'user-001'])
  })

  test('缺少 messageId → INVALID_PARAMS', async () => {
    const ctx = createBoundCtx({})
    await expect(routes.read(ctx)).rejects.toThrow(/INVALID_PARAMS.*messageId/)
  })

  test('messageId 为空字符串 → INVALID_PARAMS', async () => {
    const ctx = createBoundCtx({ messageId: '' })
    await expect(routes.read(ctx)).rejects.toThrow(/INVALID_PARAMS/)
  })

  test('限定 recipient_type=client 防越权', async () => {
    pg.query.mockResolvedValueOnce({ rowCount: 1 })

    const ctx = createBoundCtx({ messageId: 'msg-001' })
    await routes.read(ctx)

    const params = pg.query.mock.calls[0][1]
    expect(params[1]).toBe('client')
  })
})

describe('message.unreadCount', () => {
  test('返回未读消息数', async () => {
    pg.query.mockResolvedValueOnce([{ count: 5 }])

    const ctx = createBoundCtx({})
    await routes.unreadCount(ctx)

    expect(ctx.result.count).toBe(5)
  })

  test('无未读消息返回 0', async () => {
    pg.query.mockResolvedValueOnce([{ count: 0 }])

    const ctx = createBoundCtx({})
    await routes.unreadCount(ctx)

    expect(ctx.result.count).toBe(0)
  })

  test('查询结果为空时返回 0', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({})
    await routes.unreadCount(ctx)

    expect(ctx.result.count).toBe(0)
  })

  test('仅统计 recipient_type=client 的未读', async () => {
    pg.query.mockResolvedValueOnce([{ count: 3 }])

    const ctx = createBoundCtx({})
    await routes.unreadCount(ctx)

    const sql = pg.query.mock.calls[0][0]
    expect(sql).toContain("recipient_type = 'client'")
    expect(sql).toContain('is_read = false')
  })
})
