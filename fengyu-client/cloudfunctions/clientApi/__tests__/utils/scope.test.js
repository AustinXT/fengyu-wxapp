/**
 * utils/scope 单元测试
 *
 * 覆盖 SUMMARY v3 §2 #13 client 端两个 helper：
 *   - assertUserStoreBound
 *   - assertUserOwnsOrder
 *
 * 不依赖 setup.js 中的全局 pg mock；直接传 client 入参 mock，
 * 与 fengyu-staff scope.test.js 同款 makePgMock 模式（跨端测试风格对齐）。
 */

const { assertUserStoreBound, assertUserOwnsOrder } = require('../../utils/scope')

/**
 * 构造最小可用 pg client mock；rowQueue 提供按调用次序返回的 row 数组。
 */
function makePgMock(rowQueue) {
  const queries = []
  return {
    queries,
    query: vi.fn(async (sql, params) => {
      queries.push({ sql, params })
      const next = rowQueue.shift()
      return next === undefined ? [] : next
    }),
  }
}

describe('assertUserStoreBound', () => {
  test('缺 userId → INVALID_PARAMS', async () => {
    const client = makePgMock([])
    await expect(assertUserStoreBound(client)).rejects.toThrow(/INVALID_PARAMS:\s*缺少\s*userId/)
    expect(client.queries.length).toBe(0)
  })

  test('用户不存在 → PERMISSION_DENIED', async () => {
    const client = makePgMock([[]])
    await expect(assertUserStoreBound(client, 'U_NOT_EXIST')).rejects.toThrow(/PERMISSION_DENIED:\s*用户不存在/)
  })

  test('用户未绑店（bound_store_id IS NULL）→ PERMISSION_DENIED', async () => {
    const client = makePgMock([[{ bound_store_id: null }]])
    await expect(assertUserStoreBound(client, 'U1')).rejects.toThrow(/PERMISSION_DENIED:\s*用户未绑定门店/)
  })

  test('用户已绑店 → 返回 boundStoreId', async () => {
    const client = makePgMock([[{ bound_store_id: 'S1' }]])
    const result = await assertUserStoreBound(client, 'U1')
    expect(result).toEqual({ boundStoreId: 'S1' })
  })

  test('SQL 必须查 client_wechat_users.bound_store_id', async () => {
    const client = makePgMock([[{ bound_store_id: 'S1' }]])
    await assertUserStoreBound(client, 'U1')
    expect(client.queries[0].sql).toMatch(/bound_store_id\s+FROM\s+client_wechat_users/i)
    expect(client.queries[0].params).toEqual(['U1'])
  })
})

describe('assertUserOwnsOrder', () => {
  test('缺 userId → INVALID_PARAMS', async () => {
    const client = makePgMock([])
    await expect(assertUserOwnsOrder(client, undefined, 'FY-XSD-WX-001')).rejects.toThrow(
      /INVALID_PARAMS:\s*缺少\s*userId/,
    )
  })

  test('缺 saleOrderId → INVALID_PARAMS', async () => {
    const client = makePgMock([])
    await expect(assertUserOwnsOrder(client, 'U1')).rejects.toThrow(/INVALID_PARAMS:\s*缺少\s*saleOrderId/)
  })

  test('订单不存在 → PERMISSION_DENIED', async () => {
    const client = makePgMock([[]])
    await expect(assertUserOwnsOrder(client, 'U1', 'FY-XSD-WX-NOT')).rejects.toThrow(
      /PERMISSION_DENIED:\s*订单不存在/,
    )
  })

  test('订单归属他人 → PERMISSION_DENIED', async () => {
    const client = makePgMock([[{ client_user_id: 'U_OTHER', store_id: 'S1' }]])
    await expect(assertUserOwnsOrder(client, 'U1', 'FY-XSD-WX-001')).rejects.toThrow(
      /PERMISSION_DENIED:\s*订单不归属当前用户/,
    )
  })

  test('订单归属当前用户 → 返回 storeId', async () => {
    const client = makePgMock([[{ client_user_id: 'U1', store_id: 'S1' }]])
    const result = await assertUserOwnsOrder(client, 'U1', 'FY-XSD-WX-001')
    expect(result).toEqual({ storeId: 'S1' })
  })

  test('SQL 必须查 sale_orders.client_user_id', async () => {
    const client = makePgMock([[{ client_user_id: 'U1', store_id: 'S1' }]])
    await assertUserOwnsOrder(client, 'U1', 'FY-XSD-WX-001')
    expect(client.queries[0].sql).toMatch(/client_user_id,?\s*store_id\s+FROM\s+sale_orders/i)
    expect(client.queries[0].params).toEqual(['FY-XSD-WX-001'])
  })
})
