/**
 * order.repay 路由测试（Ticket 2026-04-24 PR-C）
 * 覆盖：
 *  - 储值卡纯回款付清 → 原单 '已支付' + payments('回款') + card_transactions('扣款') + 凭证单'已支付'
 *  - 微信线上回款 → 不写 payments 行（由 payNotify 回调补）；凭证单 '待支付'
 *  - 超额拦截
 *  - 非待支付/部分支付订单拦截
 *  - 所有权校验（他人订单）
 *  - 储值卡余额不足
 *  - 缺参数 / paymentMethod 非法
 */

const pg = globalThis.__mocks__.pg
const { createBoundCtx } = require('../helpers')

let routes
beforeEach(() => {
  vi.clearAllMocks()
  Object.keys(require.cache).forEach((key) => {
    if (key.includes('/routes/order') || key.includes('/middleware/auth')) {
      delete require.cache[key]
    }
  })
  routes = require('../../routes/order')
})

/**
 * 构造事务 client 的 query 路由：按 SQL 片段命中顺序返回结果，
 * 未命中的统一返回 { rows: [], rowCount: 0 }。
 */
function makeClientQueryRouter(routes) {
  return vi.fn(async (sql /* , params */) => {
    for (const r of routes) {
      if (typeof r.match === 'string' ? sql.includes(r.match) : r.match.test(sql)) {
        if (typeof r.result === 'function') return await r.result()
        return r.result
      }
    }
    return { rows: [], rowCount: 0 }
  })
}

function makeOrigOrderRow(overrides = {}) {
  return {
    sale_order_id: 'FY-XSD-WX-2604240001',
    status: '部分支付',
    sale_order_type: '销售单',
    client_user_id: 'user-001',
    client_phone: '13800001111',
    customer_name: '张三',
    store_id: 'store-A',
    market_name: '华东',
    document_type: '售后',
    total_amount: '300.00',
    prepaid_card_amount: '0',
    paid_amount: '100.00',
    payable_amount: '300.00',
    ...overrides,
  }
}

describe('order.repay', () => {
  test('储值卡纯回款付清 → 原单转 已支付 + payments 回款行 + card_transactions 扣款', async () => {
    // 原单 payable=300 已到账=100（含首次支付行），储值卡付 200 付清
    const router = makeClientQueryRouter([
      { match: 'SELECT pg_advisory_xact_lock', result: { rows: [], rowCount: 0 } },
      // 锁原单
      {
        match: /FROM sale_orders WHERE sale_order_id = \$1 FOR UPDATE/,
        result: { rows: [makeOrigOrderRow()], rowCount: 1 },
      },
      // 已到账 SUM = 100
      { match: /SELECT COALESCE\(SUM\(amount\), 0\)/, result: { rows: [{ paid_sum: '100' }], rowCount: 1 } },
      // payments 存在（hasPayments）
      { match: /SELECT 1 FROM sale_order_payments WHERE sale_order_id = \$1 LIMIT 1/,
        result: { rows: [{ '?column?': 1 }], rowCount: 1 } },
      // 锁储值卡（balance=500）
      {
        match: 'FROM prepaid_cards WHERE user_id',
        result: { rows: [{ card_id: 'FY-CARD-X', balance: '500.00' }], rowCount: 1 },
      },
      // 扣减余额
      { match: 'UPDATE prepaid_cards SET balance', result: { rows: [], rowCount: 1 } },
      // 凭证单号查最大序号
      {
        match: /FROM sale_orders[\s\S]*sale_order_id LIKE \$1/,
        result: { rows: [], rowCount: 0 },
      },
      // INSERT 凭证单
      { match: /INSERT INTO sale_orders/, result: { rows: [], rowCount: 1 } },
      // INSERT card_transactions
      { match: /INSERT INTO card_transactions/, result: { rows: [], rowCount: 1 } },
      // INSERT payments 回款
      { match: /INSERT INTO sale_order_payments/, result: { rows: [], rowCount: 1 } },
      // 重算 Sum = 300
      { match: /SELECT COALESCE\(SUM\(amount\), 0\)/, result: { rows: [{ paid_sum: '300' }], rowCount: 1 } },
      // UPDATE sale_orders 置状态
      { match: /UPDATE sale_orders[\s\S]*SET status/, result: { rows: [], rowCount: 1 } },
    ])
    pg.transaction.mockImplementation(async (cb) => {
      return await cb({ query: router })
    })

    const ctx = createBoundCtx({
      saleOrderId: 'FY-XSD-WX-2604240001',
      paymentMethod: '储值卡',
      repayAmount: 0,
      prepaidCardAmount: 200,
    })
    await routes.repay(ctx)

    // 返回结构
    expect(ctx.result.status).toBe('已支付')
    expect(ctx.result.paymentMethod).toBe('储值卡')
    expect(ctx.result.prepaidCardAmount).toBe(200)
    expect(ctx.result.repaymentOrderId).toMatch(/^FY-HKD-WX-/)

    const calls = router.mock.calls.map((c) => c[0])
    // 关键 SQL 命中
    expect(calls.some((s) => /INSERT INTO sale_orders/.test(s))).toBe(true)
    expect(calls.some((s) => /INSERT INTO sale_order_payments/.test(s))).toBe(true)
    expect(calls.some((s) => /INSERT INTO card_transactions/.test(s))).toBe(true)
    expect(calls.some((s) => /UPDATE prepaid_cards SET balance/.test(s))).toBe(true)
  })

  test('微信线上回款 → 不写 payments 行，凭证单 待支付 + 返回 paymentParams', async () => {
    const router = makeClientQueryRouter([
      { match: 'SELECT pg_advisory_xact_lock', result: { rows: [], rowCount: 0 } },
      { match: /FROM sale_orders WHERE sale_order_id = \$1 FOR UPDATE/,
        result: { rows: [makeOrigOrderRow()], rowCount: 1 } },
      { match: /SELECT COALESCE\(SUM\(amount\), 0\)/, result: { rows: [{ paid_sum: '100' }], rowCount: 1 } },
      { match: /SELECT 1 FROM sale_order_payments WHERE sale_order_id = \$1 LIMIT 1/,
        result: { rows: [{ '?column?': 1 }], rowCount: 1 } },
      { match: /FROM sale_orders[\s\S]*sale_order_id LIKE \$1/, result: { rows: [], rowCount: 0 } },
      { match: /INSERT INTO sale_orders/, result: { rows: [], rowCount: 1 } },
      { match: /UPDATE sale_orders SET payment_method/, result: { rows: [], rowCount: 1 } },
    ])
    pg.transaction.mockImplementation(async (cb) => await cb({ query: router }))

    const ctx = createBoundCtx({
      saleOrderId: 'FY-XSD-WX-2604240001',
      paymentMethod: '微信',
      repayAmount: 200,
      prepaidCardAmount: 0,
    })
    await routes.repay(ctx)

    expect(ctx.result.status).toBe('待支付')
    expect(ctx.result.paymentMethod).toBe('微信')
    expect(ctx.result.paymentParams).toBeDefined()
    expect(ctx.result.paymentParams.totalFee).toBe(20000) // 200 元 → 20000 分
    expect(ctx.result.repaymentOrderId).toMatch(/^FY-HKD-WX-/)

    // 微信通道：不应写 payments / card_transactions
    const calls = router.mock.calls.map((c) => c[0])
    expect(calls.some((s) => /INSERT INTO sale_order_payments/.test(s))).toBe(false)
    expect(calls.some((s) => /INSERT INTO card_transactions/.test(s))).toBe(false)
  })

  test('超额回款 → INVALID_PARAMS', async () => {
    const router = makeClientQueryRouter([
      { match: 'SELECT pg_advisory_xact_lock', result: { rows: [], rowCount: 0 } },
      { match: /FROM sale_orders WHERE sale_order_id = \$1 FOR UPDATE/,
        result: { rows: [makeOrigOrderRow({ paid_amount: '250.00' })], rowCount: 1 } },
      { match: /SELECT COALESCE\(SUM\(amount\), 0\)/, result: { rows: [{ paid_sum: '250' }], rowCount: 1 } },
      { match: /SELECT 1 FROM sale_order_payments WHERE sale_order_id = \$1 LIMIT 1/,
        result: { rows: [{ '?column?': 1 }], rowCount: 1 } },
    ])
    pg.transaction.mockImplementation(async (cb) => await cb({ query: router }))

    const ctx = createBoundCtx({
      saleOrderId: 'FY-XSD-WX-2604240001',
      paymentMethod: '微信',
      repayAmount: 100, // 欠款 300-250=50，本次 100 超额
      prepaidCardAmount: 0,
    })
    await expect(routes.repay(ctx)).rejects.toThrow(/INVALID_PARAMS.*超过剩余应付/)
  })

  test('订单已关闭 → INVALID_PARAMS', async () => {
    const router = makeClientQueryRouter([
      { match: 'SELECT pg_advisory_xact_lock', result: { rows: [], rowCount: 0 } },
      { match: /FROM sale_orders WHERE sale_order_id = \$1 FOR UPDATE/,
        result: { rows: [makeOrigOrderRow({ status: '已关闭' })], rowCount: 1 } },
    ])
    pg.transaction.mockImplementation(async (cb) => await cb({ query: router }))

    const ctx = createBoundCtx({
      saleOrderId: 'FY-XSD-WX-2604240001',
      paymentMethod: '微信',
      repayAmount: 50,
    })
    await expect(routes.repay(ctx)).rejects.toThrow(/INVALID_PARAMS.*订单状态不允许回款/)
  })

  test('他人订单 → PERMISSION_DENIED', async () => {
    const router = makeClientQueryRouter([
      { match: 'SELECT pg_advisory_xact_lock', result: { rows: [], rowCount: 0 } },
      { match: /FROM sale_orders WHERE sale_order_id = \$1 FOR UPDATE/,
        result: { rows: [makeOrigOrderRow({ client_user_id: 'user-OTHER' })], rowCount: 1 } },
    ])
    pg.transaction.mockImplementation(async (cb) => await cb({ query: router }))

    const ctx = createBoundCtx({
      saleOrderId: 'FY-XSD-WX-2604240001',
      paymentMethod: '微信',
      repayAmount: 50,
    })
    await expect(routes.repay(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('储值卡余额不足 → INSUFFICIENT_BALANCE', async () => {
    const router = makeClientQueryRouter([
      { match: 'SELECT pg_advisory_xact_lock', result: { rows: [], rowCount: 0 } },
      { match: /FROM sale_orders WHERE sale_order_id = \$1 FOR UPDATE/,
        result: { rows: [makeOrigOrderRow()], rowCount: 1 } },
      { match: /SELECT COALESCE\(SUM\(amount\), 0\)/, result: { rows: [{ paid_sum: '100' }], rowCount: 1 } },
      { match: /SELECT 1 FROM sale_order_payments WHERE sale_order_id = \$1 LIMIT 1/,
        result: { rows: [{ '?column?': 1 }], rowCount: 1 } },
      // balance 50，不足以扣 200
      { match: 'FROM prepaid_cards WHERE user_id',
        result: { rows: [{ card_id: 'FY-CARD-X', balance: '50.00' }], rowCount: 1 } },
    ])
    pg.transaction.mockImplementation(async (cb) => await cb({ query: router }))

    const ctx = createBoundCtx({
      saleOrderId: 'FY-XSD-WX-2604240001',
      paymentMethod: '储值卡',
      repayAmount: 0,
      prepaidCardAmount: 200,
    })
    await expect(routes.repay(ctx)).rejects.toThrow(/INSUFFICIENT_BALANCE/)
  })

  test('缺 saleOrderId → INVALID_PARAMS', async () => {
    const ctx = createBoundCtx({ paymentMethod: '微信', repayAmount: 50 })
    await expect(routes.repay(ctx)).rejects.toThrow(/INVALID_PARAMS.*saleOrderId/)
  })

  test('paymentMethod 非法 → INVALID_PARAMS', async () => {
    const ctx = createBoundCtx({ saleOrderId: 'FY-XSD-WX-xx', paymentMethod: '现金', repayAmount: 50 })
    await expect(routes.repay(ctx)).rejects.toThrow(/INVALID_PARAMS.*paymentMethod/)
  })

  test('储值卡通道 repayAmount 非零 → INVALID_PARAMS', async () => {
    const ctx = createBoundCtx({
      saleOrderId: 'FY-XSD-WX-xx',
      paymentMethod: '储值卡',
      repayAmount: 50,
      prepaidCardAmount: 100,
    })
    await expect(routes.repay(ctx)).rejects.toThrow(/INVALID_PARAMS.*储值卡通道 repayAmount 必须为 0/)
  })
})
