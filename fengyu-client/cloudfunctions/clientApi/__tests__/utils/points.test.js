/**
 * utils/points 单元测试 — 链净额差值法 settlePointsForOrder
 * 覆盖 ticket 2026-04-24 points-accrual-on-sale-order §6 测试矩阵
 */

const {
  settlePointsForOrder,
  settlePointsSafe,
  ORDER_TYPES_EARN_POINTS,
} = require('../../utils/points')

/**
 * 构造 mock pg client：query(sql, params) 按 SQL 关键字分发不同结果
 *
 * @param {object} opts
 * @param {string|null} opts.saleOrderType  - 原单 sale_order_type；null 表示原单不存在
 * @param {string|null} opts.clientUserId   - 原单 client_user_id
 * @param {number} opts.netSettled          - 链净到账（received - refunded_amount）汇总
 *                                            （2026-04-26 sale-order-domain-refactor: paid_amount → received - refunded_amount）
 * @param {number} opts.granted             - point_transactions 已发合计
 * @returns {{ client, queries }}
 */
function buildMockClient({
  saleOrderType = '销售单',
  clientUserId = 'user-001',
  netSettled = 0,
  granted = 0,
  orderNotFound = false,
} = {}) {
  const queries = []
  const query = vi.fn(async (sql, params) => {
    queries.push({ sql, params })
    const s = String(sql)

    // 1. 取原单
    if (/FROM\s+sale_orders/i.test(s) && /FOR\s+UPDATE/i.test(s)) {
      if (orderNotFound) return { rows: [] }
      return {
        rows: [
          {
            client_user_id: clientUserId,
            sale_order_type: saleOrderType,
          },
        ],
      }
    }

    // 2. 链净汇总（2026-04-26: SUM(received - refunded_amount)）
    if (/FROM\s+sale_orders/i.test(s) && /received/i.test(s) && /refunded_amount/i.test(s)) {
      return { rows: [{ net_settled: netSettled }] }
    }

    // 3. 已发合计
    if (/FROM\s+point_transactions/i.test(s) && /SUM\(amount\)/i.test(s)) {
      return { rows: [{ granted }] }
    }

    // 4. INSERT point_transactions
    if (/INSERT\s+INTO\s+point_transactions/i.test(s)) {
      return { rows: [{ id: 1001 }], rowCount: 1 }
    }

    if (/INSERT\s+INTO\s+point_batches/i.test(s)) {
      return { rowCount: 1 }
    }

    if (/UPDATE\s+point_batches/i.test(s)) {
      return { rowCount: 1 }
    }

    // 5. UPDATE client_wechat_users
    if (/UPDATE\s+client_wechat_users/i.test(s)) {
      return { rowCount: 1 }
    }

    // 6. INSERT operation_logs（settlePointsSafe 错误日志）
    if (/INSERT\s+INTO\s+operation_logs/i.test(s)) {
      return { rowCount: 1 }
    }

    return { rows: [], rowCount: 0 }
  })
  return { client: { query }, queries }
}

/** 找出第一条 SQL 匹配 pattern 的调用 */
function findQuery(queries, pattern) {
  return queries.find((q) => pattern.test(q.sql))
}

/** 统计 SQL 匹配 pattern 的调用数 */
function countQueries(queries, pattern) {
  return queries.filter((q) => pattern.test(q.sql)).length
}

describe('ORDER_TYPES_EARN_POINTS', () => {
  test('仅包含 销售单', () => {
    expect(ORDER_TYPES_EARN_POINTS.has('销售单')).toBe(true)
    expect(ORDER_TYPES_EARN_POINTS.has('内部单')).toBe(false)
    expect(ORDER_TYPES_EARN_POINTS.has('回款单')).toBe(false)
    expect(ORDER_TYPES_EARN_POINTS.has('退款单')).toBe(false)
    expect(ORDER_TYPES_EARN_POINTS.has('转换单')).toBe(false)
  })
})

describe('settlePointsForOrder — 正向发放', () => {
  test('首次消费 280 元 → delta=+2（消费赠送）', async () => {
    const { client, queries } = buildMockClient({ netSettled: 280, granted: 0 })
    const r = await settlePointsForOrder(client, 'FY-XSD-WX-2604240001')

    expect(r).toEqual({ delta: 2, expected: 2, granted: 0 })

    const ins = findQuery(queries, /INSERT\s+INTO\s+point_transactions/i)
    expect(ins).toBeDefined()
    expect(ins.params[0]).toBe('user-001')
    expect(ins.params[1]).toBe('消费赠送')
    expect(ins.params[2]).toBe(2)
    expect(ins.params[3]).toBe('FY-XSD-WX-2604240001')

    const upd = findQuery(queries, /UPDATE\s+client_wechat_users/i)
    expect(upd).toBeDefined()
    expect(upd.params[0]).toBe('user-001')

    const batch = findQuery(queries, /INSERT\s+INTO\s+point_batches/i)
    expect(batch).toBeDefined()
    expect(batch.params).toEqual([
      'user-001',
      1001,
      '消费赠送',
      'FY-XSD-WX-2604240001',
      2,
    ])
  })

  test('消费 100 元整 → delta=+1', async () => {
    const { client } = buildMockClient({ netSettled: 100, granted: 0 })
    const r = await settlePointsForOrder(client, 'o1')
    expect(r).toEqual({ delta: 1, expected: 1, granted: 0 })
  })

  test('消费 99 元 → delta=0 无写入（floor 截断）', async () => {
    const { client, queries } = buildMockClient({ netSettled: 99, granted: 0 })
    const r = await settlePointsForOrder(client, 'o1')
    expect(r).toEqual({ delta: 0, expected: 0, granted: 0 })
    expect(countQueries(queries, /INSERT\s+INTO\s+point_transactions/i)).toBe(0)
    expect(countQueries(queries, /UPDATE\s+client_wechat_users/i)).toBe(0)
  })
})

describe('settlePointsForOrder — 退款冲销', () => {
  test('退款后冲销：netSettled=190, granted=2 → delta=-1（消费冲销）', async () => {
    const { client, queries } = buildMockClient({ netSettled: 190, granted: 2 })
    const r = await settlePointsForOrder(client, 'o1')

    expect(r).toEqual({ delta: -1, expected: 1, granted: 2 })

    const ins = findQuery(queries, /INSERT\s+INTO\s+point_transactions/i)
    expect(ins.params[1]).toBe('消费冲销')
    expect(ins.params[2]).toBe(-1)

    const upd = findQuery(queries, /UPDATE\s+client_wechat_users/i)
    expect(upd.params[0]).toBe('user-001')

    const batchConsume = findQuery(queries, /UPDATE\s+point_batches/i)
    expect(batchConsume).toBeDefined()
    expect(batchConsume.params).toEqual(['user-001', 1, 'o1'])
  })

  test('二次退款尾差归零：netSettled=140, granted=1 → delta=0 无写入', async () => {
    const { client, queries } = buildMockClient({ netSettled: 140, granted: 1 })
    const r = await settlePointsForOrder(client, 'o1')

    expect(r).toEqual({ delta: 0, expected: 1, granted: 1 })

    // 仅 3 次查询（SELECT 原单 + SELECT 链净 + SELECT 已发），无 INSERT/UPDATE
    expect(client.query).toHaveBeenCalledTimes(3)
    expect(countQueries(queries, /INSERT\s+INTO\s+point_transactions/i)).toBe(0)
    expect(countQueries(queries, /UPDATE\s+client_wechat_users/i)).toBe(0)
  })

  test('全额退款：netSettled=0, granted=2 → delta=-2', async () => {
    const { client, queries } = buildMockClient({ netSettled: 0, granted: 2 })
    const r = await settlePointsForOrder(client, 'o1')

    expect(r).toEqual({ delta: -2, expected: 0, granted: 2 })
    const ins = findQuery(queries, /INSERT\s+INTO\s+point_transactions/i)
    expect(ins.params[1]).toBe('消费冲销')
    expect(ins.params[2]).toBe(-2)
  })
})

describe('settlePointsForOrder — 边界保护', () => {
  test('AC-09 负净额保护：netSettled=-50, granted=2 → expected=0, delta=-2', async () => {
    const { client } = buildMockClient({ netSettled: -50, granted: 2 })
    const r = await settlePointsForOrder(client, 'o1')
    expect(r).toEqual({ delta: -2, expected: 0, granted: 2 })
  })

  test('纯卡抵扣：netSettled=0, granted=0 → delta=0 无写入', async () => {
    const { client, queries } = buildMockClient({ netSettled: 0, granted: 0 })
    const r = await settlePointsForOrder(client, 'o1')

    expect(r).toEqual({ delta: 0, expected: 0, granted: 0 })
    expect(countQueries(queries, /INSERT\s+INTO\s+point_transactions/i)).toBe(0)
    expect(countQueries(queries, /UPDATE\s+client_wechat_users/i)).toBe(0)
  })
})

describe('settlePointsForOrder — 跳过分支', () => {
  test('originalSaleOrderId = null → skipped=no-original-id', async () => {
    const { client, queries } = buildMockClient()
    const r = await settlePointsForOrder(client, null)
    expect(r).toEqual({
      delta: 0,
      expected: 0,
      granted: 0,
      skipped: 'no-original-id',
    })
    expect(queries).toHaveLength(0)
  })

  test('originalSaleOrderId = undefined → skipped=no-original-id', async () => {
    const { client, queries } = buildMockClient()
    const r = await settlePointsForOrder(client, undefined)
    expect(r.skipped).toBe('no-original-id')
    expect(queries).toHaveLength(0)
  })

  test('originalSaleOrderId = "" → skipped=no-original-id', async () => {
    const { client, queries } = buildMockClient()
    const r = await settlePointsForOrder(client, '')
    expect(r.skipped).toBe('no-original-id')
    expect(queries).toHaveLength(0)
  })

  test('原单不存在 → skipped=order-not-found', async () => {
    const { client } = buildMockClient({ orderNotFound: true })
    const r = await settlePointsForOrder(client, 'missing-id')
    expect(r).toEqual({
      delta: 0,
      expected: 0,
      granted: 0,
      skipped: 'order-not-found',
    })
    expect(client.query).toHaveBeenCalledTimes(1)
  })

  test('匿名单 client_user_id = null → skipped=anonymous-order', async () => {
    const { client, queries } = buildMockClient({ clientUserId: null })
    const r = await settlePointsForOrder(client, 'o1')
    expect(r).toEqual({
      delta: 0,
      expected: 0,
      granted: 0,
      skipped: 'anonymous-order',
    })
    expect(countQueries(queries, /INSERT\s+INTO/i)).toBe(0)
    expect(countQueries(queries, /UPDATE\s+client_wechat_users/i)).toBe(0)
  })

  test('内部单 → skipped=order-type-内部单', async () => {
    const { client } = buildMockClient({ saleOrderType: '内部单' })
    const r = await settlePointsForOrder(client, 'o1')
    expect(r).toEqual({
      delta: 0,
      expected: 0,
      granted: 0,
      skipped: 'order-type-内部单',
    })
  })

  test('退款单 → skipped=order-type-退款单（派生单不是原始发放点）', async () => {
    const { client } = buildMockClient({ saleOrderType: '退款单' })
    const r = await settlePointsForOrder(client, 'o1')
    expect(r.skipped).toBe('order-type-退款单')
  })
})

describe('settlePointsForOrder — 幂等重放', () => {
  test('连续调用两次同一订单 ID，第二次 granted=expected 时 delta=0 不写入', async () => {
    const first = buildMockClient({ netSettled: 280, granted: 0 })
    const r1 = await settlePointsForOrder(first.client, 'o1')
    expect(r1.delta).toBe(2)
    expect(countQueries(first.queries, /INSERT\s+INTO\s+point_transactions/i)).toBe(1)

    const second = buildMockClient({ netSettled: 280, granted: 2 })
    const r2 = await settlePointsForOrder(second.client, 'o1')
    expect(r2).toEqual({ delta: 0, expected: 2, granted: 2 })
    expect(countQueries(second.queries, /INSERT\s+INTO\s+point_transactions/i)).toBe(0)
    expect(countQueries(second.queries, /UPDATE\s+client_wechat_users/i)).toBe(0)
    expect(second.client.query).toHaveBeenCalledTimes(3)
  })
})

describe('settlePointsSafe — 外层封装', () => {
  const OLD_ENV = process.env.POINTS_ACCRUAL_ENABLED

  afterEach(() => {
    if (OLD_ENV === undefined) {
      delete process.env.POINTS_ACCRUAL_ENABLED
    } else {
      process.env.POINTS_ACCRUAL_ENABLED = OLD_ENV
    }
  })

  test('feature flag = "false" → 直接返回 skipped=feature-flag-disabled，不查 pg', async () => {
    process.env.POINTS_ACCRUAL_ENABLED = 'false'
    const { client, queries } = buildMockClient()
    const r = await settlePointsSafe(client, 'o1', 'unit-test')
    expect(r).toEqual({ skipped: 'feature-flag-disabled' })
    expect(queries).toHaveLength(0)
  })

  test('feature flag 未设置 → 正常执行', async () => {
    delete process.env.POINTS_ACCRUAL_ENABLED
    const { client } = buildMockClient({ netSettled: 280, granted: 0 })
    const r = await settlePointsSafe(client, 'o1', 'unit-test')
    expect(r.delta).toBe(2)
  })

  test('内部 settle 抛异常 → 捕获并写 operation_logs，返回 skipped=settle-failed', async () => {
    delete process.env.POINTS_ACCRUAL_ENABLED
    const operationLogCalls = []
    const client = {
      query: vi.fn(async (sql, params) => {
        const s = String(sql)
        if (/INSERT\s+INTO\s+operation_logs/i.test(s)) {
          operationLogCalls.push({ sql, params })
          return { rowCount: 1 }
        }
        throw new Error('pg connection lost')
      }),
    }

    const r = await settlePointsSafe(client, 'o1', 'order.pay')
    expect(r.skipped).toBe('settle-failed')
    expect(r.error).toBe('pg connection lost')

    expect(operationLogCalls).toHaveLength(1)
    expect(operationLogCalls[0].params[0]).toBe('o1')
    const detail = JSON.parse(operationLogCalls[0].params[1])
    expect(detail.error).toBe('pg connection lost')
    expect(detail.triggerSource).toBe('order.pay')
    expect(operationLogCalls[0].params[2]).toBe('order.pay')
  })

  test('operation_logs 写入也失败时不再抛出，仍返回 skipped=settle-failed', async () => {
    delete process.env.POINTS_ACCRUAL_ENABLED
    const client = {
      query: vi.fn(async () => {
        throw new Error('catastrophic failure')
      }),
    }
    const r = await settlePointsSafe(client, 'o1', 'test')
    expect(r.skipped).toBe('settle-failed')
    expect(r.error).toBe('catastrophic failure')
  })
})
