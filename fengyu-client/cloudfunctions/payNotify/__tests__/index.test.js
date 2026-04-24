/**
 * payNotify index.js 单元测试
 *
 * 覆盖范围：
 *  - 充值分支（适配 prepaid_cards schema 变更，UPSERT 维度 user_id）
 *  - 消费扣款分支（prepaid_card_amount > 0 → 扣余额 + INSERT card_transactions type='扣款'）
 *  - 幂等（重复回调不重复扣减、已支付订单短路）
 *  - 余额不足（事务回滚、订单保持 '待支付'）
 *
 * Mock 策略：通过 require.cache 替换 pg / wx-server-sdk / ./config 模块
 * （CJS 模式，绕过 vi.mock），与 config.test.js 同风格。
 */

// ====== Mock: pg ======
// pool.query 用于入口幂等检查；pool.connect() 返回事务 client
const mockPoolQuery = vi.fn()
const mockClientQuery = vi.fn()
const mockClientRelease = vi.fn()
const mockConnect = vi.fn(async () => ({
  query: mockClientQuery,
  release: mockClientRelease,
}))

const pgPath = require.resolve('pg')
require.cache[pgPath] = {
  id: pgPath,
  filename: pgPath,
  loaded: true,
  exports: {
    Pool: vi.fn(() => ({
      query: (...args) => mockPoolQuery(...args),
      connect: (...args) => mockConnect(...args),
      on: vi.fn(),
    })),
  },
}

// ====== Mock: wx-server-sdk ======
const wxPath = require.resolve('wx-server-sdk')
require.cache[wxPath] = {
  id: wxPath,
  filename: wxPath,
  loaded: true,
  exports: {
    init: vi.fn(),
    DYNAMIC_CURRENT_ENV: 'test-env',
  },
}

// ====== Mock: ./config ======
const configPath = require.resolve('../config')
require.cache[configPath] = {
  id: configPath,
  filename: configPath,
  loaded: true,
  exports: {
    getMemberThreshold: vi.fn(async () => 1980),
    invalidateCache: vi.fn(),
    FALLBACK_THRESHOLD: 1980,
  },
}

function loadFreshIndex() {
  const p = require.resolve('../index')
  delete require.cache[p]
  return require('../index')
}

/**
 * 构造基础订单快照（pool.query 返回的行）
 */
function makeOrder(overrides = {}) {
  return {
    status: '待支付',
    payment_method: '微信',
    wechat_transaction_id: null,
    preferred_employee_id: null,
    total_amount: '300.00',
    client_user_id: 'user-001',
    store_id: 'store-A',
    prepaid_card_amount: '0',
    ...overrides,
  }
}

/**
 * 将一组 SQL 片段匹配→返回值的映射应用到 mockClientQuery
 * 对于每次调用：按数组顺序第一个命中的 matcher 返回其 result
 * 未命中返回 { rows: [], rowCount: 0 }
 */
function setupClientQueryRouter(routes) {
  mockClientQuery.mockImplementation(async (sql /* , params */) => {
    for (const route of routes) {
      if (typeof route.match === 'string' ? sql.includes(route.match) : route.match.test(sql)) {
        if (typeof route.result === 'function') {
          return await route.result()
        }
        return route.result
      }
    }
    return { rows: [], rowCount: 0 }
  })
}

describe('payNotify index.js', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPoolQuery.mockReset()
    mockClientQuery.mockReset()
    mockClientRelease.mockReset()
    mockConnect.mockReset().mockImplementation(async () => ({
      query: mockClientQuery,
      release: mockClientRelease,
    }))
  })

  test('1. 无 prepaid 的普通订单 → 充值分支无记录 + 业绩分配正常 + 状态翻 已支付', async () => {
    const { main } = loadFreshIndex()
    mockPoolQuery.mockResolvedValueOnce({
      rows: [makeOrder({ preferred_employee_id: 'emp-001', total_amount: '300.00' })],
    })

    setupClientQueryRouter([
      // 充值 SELECT：无充值行
      { match: "pc.product_kind = '充值卡'", result: { rows: [], rowCount: 0 } },
      // sale_items 查询（业绩分配）
      {
        match: 'FROM sale_items WHERE sale_order_id',
        result: { rows: [{ sale_item_id: 'item-001', received: '300.00' }], rowCount: 1 },
      },
      // customer_type 查询
      { match: 'SELECT customer_type', result: { rows: [{ customer_type: '流量客' }], rowCount: 1 } },
      // computed_type
      { match: 'AS computed_type', result: { rows: [{ computed_type: '体验客' }], rowCount: 1 } },
    ])

    const res = await main({ orderNo: 'FY-XSD-WX-2604240001' })
    expect(res.code).toBe('SUCCESS')

    // 不应触发消费扣款
    const qs = mockClientQuery.mock.calls.map((c) => c[0])
    const hasDeductInsert = qs.some((s) => s.includes("'扣款'") && s.includes('INSERT INTO card_transactions'))
    expect(hasDeductInsert).toBe(false)

    // 业绩分配应插入
    const hasAllocation = qs.some((s) => s.includes('INSERT INTO sale_allocations'))
    expect(hasAllocation).toBe(true)

    // 事务闭环
    expect(qs[0]).toBe('BEGIN')
    expect(qs).toContain('COMMIT')
  })

  test('2. 部分抵扣订单（prepaid_card_amount=100）微信支付成功 → 扣 balance + INSERT 扣款 + 已支付', async () => {
    const { main } = loadFreshIndex()
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        makeOrder({
          total_amount: '300.00',
          prepaid_card_amount: '100.00',
        }),
      ],
    })

    setupClientQueryRouter([
      { match: "pc.product_kind = '充值卡'", result: { rows: [], rowCount: 0 } },
      {
        match: "type = '扣款'",
        result: { rows: [], rowCount: 0 }, // 幂等未命中
      },
      {
        match: 'FROM prepaid_cards WHERE user_id',
        result: { rows: [{ card_id: 'FY-CARD-X', balance: '500.00' }], rowCount: 1 },
      },
      // customer_type
      { match: 'SELECT customer_type', result: { rows: [{ customer_type: '流量客' }], rowCount: 1 } },
      { match: 'AS computed_type', result: { rows: [{ computed_type: '体验客' }], rowCount: 1 } },
    ])

    const res = await main({ orderNo: 'FY-XSD-WX-2604240002' })
    expect(res.code).toBe('SUCCESS')

    const calls = mockClientQuery.mock.calls
    // 余额 UPDATE（扣减）
    const updateBalance = calls.find((c) => c[0].includes('UPDATE prepaid_cards SET balance = balance'))
    expect(updateBalance).toBeDefined()
    expect(Number(updateBalance[1][0])).toBe(100)
    expect(updateBalance[1][1]).toBe('FY-CARD-X')

    // 扣款流水 INSERT
    const insertTxn = calls.find(
      (c) => c[0].includes('INSERT INTO card_transactions') && c[0].includes("'扣款'")
    )
    expect(insertTxn).toBeDefined()
    expect(insertTxn[1][0]).toBe('FY-CARD-X')
    expect(Number(insertTxn[1][1])).toBe(-100) // 金额为负
    expect(insertTxn[1][2]).toBe('FY-XSD-WX-2604240002')

    // 事务应 COMMIT
    expect(calls.map((c) => c[0])).toContain('COMMIT')
    expect(calls.map((c) => c[0])).not.toContain('ROLLBACK')
  })

  test('3. 全额抵扣订单（理论不走 payNotify）若收到 → 基于订单状态幂等短路', async () => {
    // 全额抵扣订单在 clientApi.order.create 已置 '已支付'；若收到回调，走幂等路径
    const { main } = loadFreshIndex()
    mockPoolQuery.mockResolvedValueOnce({
      rows: [makeOrder({ status: '已支付', prepaid_card_amount: '300.00', total_amount: '300.00' })],
    })

    const res = await main({ orderNo: 'FY-XSD-WX-2604240003' })
    expect(res.code).toBe('SUCCESS')
    expect(res.message).toBe('已处理')

    // 不应 connect（事务未开启）
    expect(mockConnect).not.toHaveBeenCalled()
  })

  test('4. 重复回调（扣款已存在）→ 幂等：余额不再扣、流水不重复写入', async () => {
    const { main } = loadFreshIndex()
    mockPoolQuery.mockResolvedValueOnce({
      rows: [makeOrder({ prepaid_card_amount: '100.00' })],
    })

    setupClientQueryRouter([
      { match: "pc.product_kind = '充值卡'", result: { rows: [], rowCount: 0 } },
      // 扣款幂等检查命中
      { match: "type = '扣款'", result: { rows: [{ '?column?': 1 }], rowCount: 1 } },
      { match: 'SELECT customer_type', result: { rows: [{ customer_type: '流量客' }], rowCount: 1 } },
      { match: 'AS computed_type', result: { rows: [{ computed_type: '体验客' }], rowCount: 1 } },
    ])

    const res = await main({ orderNo: 'FY-XSD-WX-2604240004' })
    expect(res.code).toBe('SUCCESS')

    const calls = mockClientQuery.mock.calls
    const qs = calls.map((c) => c[0])

    // 不应再 SELECT ... FOR UPDATE
    expect(qs.some((s) => s.includes('FROM prepaid_cards WHERE user_id') && s.includes('FOR UPDATE'))).toBe(false)
    // 不应 UPDATE balance
    expect(qs.some((s) => s.includes('UPDATE prepaid_cards SET balance'))).toBe(false)
    // 不应再 INSERT 扣款
    expect(
      qs.some((s) => s.includes('INSERT INTO card_transactions') && s.includes("'扣款'"))
    ).toBe(false)
  })

  test('5. 余额不足 → 整个事务 ROLLBACK，订单保持待支付（返回 FAIL）', async () => {
    const { main } = loadFreshIndex()
    mockPoolQuery.mockResolvedValueOnce({
      rows: [makeOrder({ prepaid_card_amount: '500.00' })],
    })

    setupClientQueryRouter([
      { match: "pc.product_kind = '充值卡'", result: { rows: [], rowCount: 0 } },
      { match: "type = '扣款'", result: { rows: [], rowCount: 0 } },
      // balance 不足
      {
        match: 'FROM prepaid_cards WHERE user_id',
        result: { rows: [{ card_id: 'FY-CARD-X', balance: '100.00' }], rowCount: 1 },
      },
    ])

    const res = await main({ orderNo: 'FY-XSD-WX-2604240005' })
    expect(res.code).toBe('FAIL')
    expect(res.message).toMatch(/INSUFFICIENT_BALANCE/)

    const qs = mockClientQuery.mock.calls.map((c) => c[0])
    // 应 ROLLBACK
    expect(qs).toContain('ROLLBACK')
    expect(qs).not.toContain('COMMIT')
    // 未扣余额
    expect(qs.some((s) => s.includes('UPDATE prepaid_cards SET balance'))).toBe(false)
    // 未写扣款
    expect(
      qs.some((s) => s.includes('INSERT INTO card_transactions') && s.includes("'扣款'"))
    ).toBe(false)
    // client 仍被释放
    expect(mockClientRelease).toHaveBeenCalled()
  })

  test('6. 充值分支 UPSERT：INSERT 列集不含 store_id；ON CONFLICT (user_id)', async () => {
    const { main } = loadFreshIndex()
    mockPoolQuery.mockResolvedValueOnce({
      rows: [makeOrder({ prepaid_card_amount: '0' })],
    })

    const upsertSpy = vi.fn(async () => ({ rows: [{ card_id: 'FY-CARD-NEW' }], rowCount: 1 }))

    setupClientQueryRouter([
      {
        match: "pc.product_kind = '充值卡'",
        result: {
          rows: [{ sku_id: 'sku-500', product_name: '充值卡 ¥500', sku_price: '500.00' }],
          rowCount: 1,
        },
      },
      // 充值幂等检查（整个 ref_order_id，不限 type）— 注意此 SQL 无 type 过滤
      {
        match: /SELECT 1 FROM card_transactions WHERE ref_order_id = \$1 LIMIT 1/,
        result: { rows: [], rowCount: 0 },
      },
      {
        match: 'INSERT INTO prepaid_cards',
        result: upsertSpy,
      },
      { match: 'SELECT customer_type', result: { rows: [{ customer_type: '流量客' }], rowCount: 1 } },
      { match: 'AS computed_type', result: { rows: [{ computed_type: '体验客' }], rowCount: 1 } },
    ])

    const res = await main({ orderNo: 'FY-XSD-WX-2604240006' })
    expect(res.code).toBe('SUCCESS')

    // 验证 UPSERT SQL 和参数
    const upsertCall = mockClientQuery.mock.calls.find((c) => c[0].includes('INSERT INTO prepaid_cards'))
    expect(upsertCall).toBeDefined()
    const sql = upsertCall[0]
    expect(sql).toMatch(/ON CONFLICT \(user_id\) DO UPDATE/)
    expect(sql).not.toMatch(/store_id/) // 列集移除 store_id
    // 参数：[newCardId, userId, faceValue]（3 个，不再传 store_id）
    expect(upsertCall[1]).toHaveLength(3)
    expect(upsertCall[1][1]).toBe('user-001')
    expect(Number(upsertCall[1][2])).toBe(500)

    // 同订单不应触发消费扣款（prepaid_card_amount=0）
    const deductCall = mockClientQuery.mock.calls.find(
      (c) => c[0].includes('INSERT INTO card_transactions') && c[0].includes("'扣款'")
    )
    expect(deductCall).toBeUndefined()
  })

  test('7. 充值 + 消费扣款互斥：同订单 prepaid_card_amount=0 + 充值行 → 只走充值、不走扣款', async () => {
    // 本质上"充值订单"的 prepaid_card_amount 必为 0（下单时储值卡不可抵扣充值单）
    // 此用例明确：两个分支在同订单场景下的独立幂等守护都成立
    const { main } = loadFreshIndex()
    mockPoolQuery.mockResolvedValueOnce({
      rows: [makeOrder({ prepaid_card_amount: '0' })],
    })

    setupClientQueryRouter([
      {
        match: "pc.product_kind = '充值卡'",
        result: {
          rows: [{ sku_id: 'sku-recharge-virtual', product_name: '自定义充值 ¥288', sku_price: null }],
          rowCount: 1,
        },
      },
      {
        match: /SELECT 1 FROM card_transactions WHERE ref_order_id = \$1 LIMIT 1/,
        result: { rows: [], rowCount: 0 },
      },
      { match: 'INSERT INTO prepaid_cards', result: { rows: [{ card_id: 'FY-CARD-VAL' }], rowCount: 1 } },
      { match: 'SELECT customer_type', result: { rows: [{ customer_type: '流量客' }], rowCount: 1 } },
      { match: 'AS computed_type', result: { rows: [{ computed_type: '体验客' }], rowCount: 1 } },
    ])

    const res = await main({ orderNo: 'FY-XSD-WX-2604240007' })
    expect(res.code).toBe('SUCCESS')

    const qs = mockClientQuery.mock.calls.map((c) => c[0])
    // 充值入账 INSERT 应存在
    expect(
      qs.some((s) => s.includes('INSERT INTO card_transactions') && s.includes("'充值'"))
    ).toBe(true)
    // 消费扣款分支不应触发（prepaid_card_amount=0）
    expect(
      qs.some((s) => s.includes('INSERT INTO card_transactions') && s.includes("'扣款'"))
    ).toBe(false)
    // 且不应执行消费扣款的幂等检查（SELECT 1 ... AND type='扣款'）
    expect(qs.some((s) => s.includes("type = '扣款'"))).toBe(false)
  })

  test('8. 已支付订单重复回调 → 直接短路返回', async () => {
    const { main } = loadFreshIndex()
    mockPoolQuery.mockResolvedValueOnce({
      rows: [makeOrder({ status: '已完成', prepaid_card_amount: '100.00' })],
    })

    const res = await main({ orderNo: 'FY-XSD-WX-2604240008' })
    expect(res.code).toBe('SUCCESS')
    expect(res.message).toBe('已处理')
    expect(mockConnect).not.toHaveBeenCalled()
    expect(mockClientQuery).not.toHaveBeenCalled()
  })
})
