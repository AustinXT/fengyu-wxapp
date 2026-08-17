/**
 * order.repay 路由测试（Ticket 2026-04-24 PR-C，2026-04-26 sale-order-domain-refactor 重写）
 *
 * 重构后变化：
 *   - 不再生成 FY-HKD 凭证 sale_orders 行（"回款单"概念已废）
 *   - 储值卡通道：直接写 sale_order_payments[change_type='回款',payment_method='储值卡',status='已支付'] 到原单
 *   - 线上通道：仅返回 mock 支付参数，payments 行由 payNotify 回调写
 *   - 原单读取使用 received / refunded_amount 列代替 paid_amount
 *
 * 覆盖：
 *  - 储值卡纯回款付清 → 原单 '已支付' + payments('回款') + card_transactions('扣款')
 *  - 微信线上回款 → 不写 payments / card_transactions，返回 paymentParams
 *  - 超额拦截
 *  - 非待支付/部分支付订单拦截 → INVALID_STATE
 *  - 他人订单 → PERMISSION_DENIED
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
function makeClientQueryRouter(routesArr) {
  return vi.fn(async (sql /* , params */) => {
    for (const r of routesArr) {
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
    received: '100.00',         // 2026-04-26: paid_amount → received
    refunded_amount: '0',
    payable_amount: '300.00',
    ...overrides,
  }
}

describe('order.repay', () => {
  test('储值卡纯回款付清 → 原单转 已支付 + payments 回款行 + card_transactions 扣款', async () => {
    // 原单 payable=300, received=100, refunded=0 → 净到账=100，欠款=200，储值卡付 200 付清
    const router = makeClientQueryRouter([
      // 锁原单
      {
        match: /FROM sale_orders WHERE sale_order_id = \$1 FOR UPDATE/,
        result: { rows: [makeOrigOrderRow()], rowCount: 1 },
      },
      // 锁储值卡（balance=500）
      {
        match: 'FROM prepaid_cards WHERE user_id',
        result: { rows: [{ card_id: 'FY-CARD-X', balance: '500.00' }], rowCount: 1 },
      },
      // 扣减余额
      { match: 'UPDATE prepaid_cards SET balance', result: { rows: [], rowCount: 1 } },
      // INSERT card_transactions
      { match: /INSERT INTO card_transactions/, result: { rows: [], rowCount: 1 } },
      // INSERT payments 回款（合并后单条 INSERT，含 note 字段）
      {
        match: /INSERT INTO sale_order_payments/,
        result: { rows: [], rowCount: 1 },
      },
      // 聚合 received/refunded → 已付清
      {
        match: /received_sum/,
        result: { rows: [{ received_sum: '300', refunded_sum: '0' }], rowCount: 1 },
      },
      // UPDATE sale_orders 置 received/status
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

    // 返回结构（不再有 repaymentOrderId，重构后不生成凭证单）
    expect(ctx.result.status).toBe('已支付')
    expect(ctx.result.paymentMethod).toBe('储值卡')
    expect(ctx.result.prepaidCardAmount).toBe(200)
    expect(ctx.result.saleOrderId).toBe('FY-XSD-WX-2604240001')
    expect(ctx.result.repaymentOrderId).toBeUndefined()

    const calls = router.mock.calls.map((c) => c[0])
    // 关键 SQL 命中
    expect(calls.some((s) => /INSERT INTO sale_order_payments/.test(s))).toBe(true)
    expect(calls.some((s) => /INSERT INTO card_transactions/.test(s))).toBe(true)
    expect(calls.some((s) => /UPDATE prepaid_cards SET balance/.test(s))).toBe(true)
    // 重构后不再 INSERT INTO sale_orders（凭证单消除）
    expect(calls.some((s) => /INSERT INTO sale_orders/.test(s))).toBe(false)
    // 修退款现金泄漏：纯卡回款记 '储值卡抵扣'（非 '回款'），并由统一重算从流水累计 actual prepaid，
    // 使退款 splitRefundByOriginalPayment 把该部分回冲储值卡而非退现金
    expect(calls.some((s) => /INSERT INTO sale_order_payments[\s\S]*'储值卡抵扣'/.test(s))).toBe(true)
    expect(calls.some((s) => /prepaid_card_amount = card_totals\.settled_prepaid/.test(s))).toBe(true)
  })

  test('微信线上回款 → 调聚合主扫 preorder，返回 wx.requestPayment 参数（不写 payments 行）', async () => {
    // 线上通道走聚合主扫：需 lakala env 就绪；lakala-client.requestPreorder 已在 setup.js mock
    const lakalaEnv = {
      LAKALA_API_BASE: 'https://x', LAKALA_APPID: 'OP', LAKALA_SERIAL_NO: 'sn',
      LAKALA_PRIVATE_KEY_PEM: 'pk', LAKALA_PLATFORM_CERT_PEM: 'cert',
    }
    const snap = {}
    for (const [k, v] of Object.entries(lakalaEnv)) { snap[k] = process.env[k]; process.env[k] = v }
    try {
      const router = makeClientQueryRouter([
        {
          match: /FROM sale_orders WHERE sale_order_id = \$1 FOR UPDATE/,
          result: { rows: [makeOrigOrderRow()], rowCount: 1 },
        },
        // 仅 UPDATE payment_method（线上通道更新）
        { match: /UPDATE sale_orders SET payment_method/, result: { rows: [], rowCount: 1 } },
      ])
      pg.transaction.mockImplementation(async (cb) => await cb({ query: router }))
      // 事务后（顶层 pg.query）：resolveLakalaMerchant 查 stores JOIN lakala_merchants + createLakalaPreorder 持久化 out_trade_no
      pg.query.mockImplementation(async (sql) => {
        if (/lakala_merchants/.test(sql)) return [{ merchant_no: 'M1', term_no: 'T1', enabled: true }]
        return []
      })

      const ctx = createBoundCtx({
        saleOrderId: 'FY-XSD-WX-2604240001',
        paymentMethod: '微信',
        repayAmount: 200,
        prepaidCardAmount: 0,
      })
      await routes.repay(ctx)

      expect(ctx.result.status).toBe('待支付')
      expect(ctx.result.paymentMethod).toBe('微信')
      expect(ctx.result.paymentParams.paySign).toBe('mock-pay-sign-001')
      expect(ctx.result.paymentParams.package).toBe('prepay_id=wx_mock_001')
      expect(ctx.result.lakala).toBeUndefined()  // 不再有 counterUrl
      expect(ctx.result.saleOrderId).toBe('FY-XSD-WX-2604240001')
      expect(ctx.result.repaymentOrderId).toBeUndefined()
      // 聚合主扫下单金额按本次回款额（分）
      const args = globalThis.__mocks__.lakalaClient.requestPreorder.mock.calls[0][0]
      expect(args.totalAmountFen).toBe(20000) // 200 元 → 20000 分
      expect(args.accountType).toBe('WECHAT')
      expect(args.transType).toBe('71')
      expect(args.subAppid).toBe('wx811eb4ded3dfba3f')

      // 微信通道：事务内不应写 payments / card_transactions / 凭证单 sale_orders
      const calls = router.mock.calls.map((c) => c[0])
      expect(calls.some((s) => /INSERT INTO sale_order_payments/.test(s))).toBe(false)
      expect(calls.some((s) => /INSERT INTO card_transactions/.test(s))).toBe(false)
      expect(calls.some((s) => /INSERT INTO sale_orders/.test(s))).toBe(false)
    } finally {
      for (const k of Object.keys(lakalaEnv)) { if (snap[k] === undefined) delete process.env[k]; else process.env[k] = snap[k] }
    }
  })

  test('微信+储值卡混合回款 → 仅写「待支付储值卡抵扣」意向，不当场扣卡（扣卡推迟到 payNotify 同事务）', async () => {
    // 原单 payable=300, received=100 → 欠款 200；线上 120 + 储值卡 80 = 200 全额
    const lakalaEnv = {
      LAKALA_API_BASE: 'https://x', LAKALA_APPID: 'OP', LAKALA_SERIAL_NO: 'sn',
      LAKALA_PRIVATE_KEY_PEM: 'pk', LAKALA_PLATFORM_CERT_PEM: 'cert',
    }
    const snap = {}
    for (const [k, v] of Object.entries(lakalaEnv)) { snap[k] = process.env[k]; process.env[k] = v }
    try {
      const router = makeClientQueryRouter([
        {
          match: /FROM sale_orders WHERE sale_order_id = \$1 FOR UPDATE/,
          result: { rows: [makeOrigOrderRow()], rowCount: 1 },
        },
        // 作废本单遗留的待支付储值卡抵扣意向
        { match: /UPDATE sale_order_payments SET status = '已作废'/, result: { rows: [], rowCount: 0 } },
        // 余额校验（FOR UPDATE，仅读不扣）
        { match: 'FROM prepaid_cards WHERE user_id', result: { rows: [{ card_id: 'FY-CARD-X', balance: '500.00' }], rowCount: 1 } },
        // 写待支付储值卡抵扣意向
        { match: /INSERT INTO sale_order_payments/, result: { rows: [], rowCount: 1 } },
        // STEP 4 更新 payment_method
        { match: /UPDATE sale_orders SET payment_method/, result: { rows: [], rowCount: 1 } },
      ])
      pg.transaction.mockImplementation(async (cb) => await cb({ query: router }))
      pg.query.mockImplementation(async (sql) => {
        if (/lakala_merchants/.test(sql)) return [{ merchant_no: 'M1', term_no: 'T1', enabled: true }]
        return []
      })

      const ctx = createBoundCtx({
        saleOrderId: 'FY-XSD-WX-2604240001',
        paymentMethod: '微信',
        repayAmount: 120,
        prepaidCardAmount: 80,
      })
      await routes.repay(ctx)

      expect(ctx.result.status).toBe('待支付')
      expect(ctx.result.paymentMethod).toBe('微信')
      expect(ctx.result.paymentParams.paySign).toBe('mock-pay-sign-001')
      expect(ctx.result.prepaidCardAmount).toBe(80)

      const calls = router.mock.calls.map((c) => c[0])
      // 写了「待支付储值卡抵扣」意向（INSERT payments，含 '储值卡抵扣' + '待支付' 字面）
      expect(calls.some((s) => /INSERT INTO sale_order_payments[\s\S]*'储值卡抵扣'[\s\S]*'待支付'/.test(s))).toBe(true)
      // 作废旧意向
      expect(calls.some((s) => /UPDATE sale_order_payments SET status = '已作废'/.test(s))).toBe(true)
      // 关键：未当场扣卡 —— 无余额扣减、无 card_transactions（扣卡推迟到 payNotify 同事务）
      expect(calls.some((s) => /UPDATE prepaid_cards SET balance/.test(s))).toBe(false)
      expect(calls.some((s) => /INSERT INTO card_transactions/.test(s))).toBe(false)
      // 混合通道不在 repay 内推进状态（received_sum 聚合 / UPDATE status 不应发生）
      expect(calls.some((s) => /received_sum/.test(s))).toBe(false)
    } finally {
      for (const k of Object.keys(lakalaEnv)) { if (snap[k] === undefined) delete process.env[k]; else process.env[k] = snap[k] }
    }
  })

  test('遗留 pending 储值卡意向 → 先作废并恢复 payable，再按真实欠款校验重试金额', async () => {
    // total=300、已收=100；旧 pending=80 把 payable 暂降为 220。
    // 真实欠款仍为 200，因此本次线下意向 200 应通过，不应按 220-100=120 误报超额。
    const router = makeClientQueryRouter([
      {
        match: /FROM sale_orders WHERE sale_order_id = \$1 FOR UPDATE/,
        result: {
          rows: [makeOrigOrderRow({
            payable_amount: '220.00',
            pending_prepaid_card_amount: '80.00',
          })],
          rowCount: 1,
        },
      },
      { match: /UPDATE sale_order_payments SET status = '已作废'/, result: { rows: [], rowCount: 1 } },
      { match: /UPDATE sale_orders[\s\S]*pending_prepaid_card_amount = 0/, result: { rows: [], rowCount: 1 } },
      { match: /UPDATE sale_orders SET payment_method/, result: { rows: [], rowCount: 1 } },
    ])
    pg.transaction.mockImplementation(async (cb) => await cb({ query: router }))

    const ctx = createBoundCtx({
      saleOrderId: 'FY-XSD-WX-2604240001',
      paymentMethod: '线下',
      repayAmount: 200,
      prepaidCardAmount: 0,
    })
    await routes.repay(ctx)

    expect(ctx.result.repayAmount).toBe(200)
    const calls = router.mock.calls.map((c) => c[0])
    const invalidateAt = calls.findIndex((s) => /UPDATE sale_order_payments SET status = '已作废'/.test(s))
    const restoreAt = calls.findIndex((s) => /pending_prepaid_card_amount = 0/.test(s))
    const markMethodAt = calls.findIndex((s) => /UPDATE sale_orders SET payment_method/.test(s))
    expect(invalidateAt).toBeGreaterThan(0)
    expect(restoreAt).toBeGreaterThan(invalidateAt)
    expect(markMethodAt).toBeGreaterThan(restoreAt)
  })

  test('超额回款 → INVALID_PARAMS', async () => {
    // payable=300, received=250, refunded=0 → 欠款=50，本次 100 超额
    const router = makeClientQueryRouter([
      {
        match: /FROM sale_orders WHERE sale_order_id = \$1 FOR UPDATE/,
        result: { rows: [makeOrigOrderRow({ received: '250.00' })], rowCount: 1 },
      },
    ])
    pg.transaction.mockImplementation(async (cb) => await cb({ query: router }))

    const ctx = createBoundCtx({
      saleOrderId: 'FY-XSD-WX-2604240001',
      paymentMethod: '微信',
      repayAmount: 100,
      prepaidCardAmount: 0,
    })
    await expect(routes.repay(ctx)).rejects.toThrow(/INVALID_PARAMS.*超过剩余应付/)
  })

  test('转换单冻结场次已有活动第三方意图：任何 mutation 前 fail-fast CONFLICT', async () => {
    const router = makeClientQueryRouter([
      {
        match: /FROM sale_orders WHERE sale_order_id = \$1 FOR UPDATE/,
        result: { rows: [makeOrigOrderRow({
          sale_order_type: '转换单', total_amount: '2000.00', received: '500.00',
          payable_amount: '2000.00', first_payment_amount: '500.00',
          lakala_out_order_no: 'FY-XSD-WX-2604240001_1770000000',
        })], rowCount: 1 },
      },
    ])
    pg.transaction.mockImplementation(async (cb) => await cb({ query: router }))

    const ctx = createBoundCtx({
      saleOrderId: 'FY-XSD-WX-2604240001',
      paymentMethod: '微信',
      repayAmount: 500,
      prepaidCardAmount: 0,
    })
    await expect(routes.repay(ctx)).rejects.toThrow(/CONFLICT: PAYMENT_INTENT_ACTIVE/)
    expect(globalThis.__mocks__.lakalaClient.requestPreorder).not.toHaveBeenCalled()
    expect(router.mock.calls).toHaveLength(1)
    expect(router.mock.calls.some(([sql]) => /^\s*(UPDATE|INSERT|DELETE)\b/.test(sql))).toBe(false)
  })

  test('转换单冻结场次尚未预下单：order.repay 禁止进入，强制使用原子预占的 order.pay', async () => {
    const router = makeClientQueryRouter([
      {
        match: /FROM sale_orders WHERE sale_order_id = \$1 FOR UPDATE/,
        result: { rows: [makeOrigOrderRow({
          sale_order_type: '转换单', total_amount: '2000.00', received: '500.00',
          payable_amount: '2000.00', first_payment_amount: '500.00', lakala_out_order_no: null,
        })], rowCount: 1 },
      },
    ])
    pg.transaction.mockImplementation(async (cb) => await cb({ query: router }))

    const ctx = createBoundCtx({
      saleOrderId: 'FY-XSD-WX-2604240001',
      paymentMethod: '微信',
      repayAmount: 500,
      prepaidCardAmount: 0,
    })
    await expect(routes.repay(ctx)).rejects.toThrow(/INVALID_STATE: CONVERSION_REPAYMENT_USE_ORDER_PAY/)
    expect(router.mock.calls).toHaveLength(1)
    expect(globalThis.__mocks__.lakalaClient.requestPreorder).not.toHaveBeenCalled()
  })

  test('受限纯卡回款成功入账后原子清空 first_payment_amount', async () => {
    const router = makeClientQueryRouter([
      {
        match: /FROM sale_orders WHERE sale_order_id = \$1 FOR UPDATE/,
        result: { rows: [makeOrigOrderRow({
          sale_order_type: '销售单', total_amount: '2000.00', received: '500.00',
          payable_amount: '2000.00', first_payment_amount: '500.00',
        })], rowCount: 1 },
      },
      { match: 'FROM prepaid_cards WHERE user_id', result: { rows: [{ card_id: 'FY-CARD-X', balance: '800.00' }], rowCount: 1 } },
      { match: /INSERT INTO sale_order_payments/, result: { rows: [{ id: 91 }], rowCount: 1 } },
      { match: /received_sum/, result: { rows: [{ received_sum: '1000', refunded_sum: '0' }], rowCount: 1 } },
      { match: /UPDATE sale_orders[\s\S]*SET status/, result: { rows: [], rowCount: 1 } },
    ])
    pg.transaction.mockImplementation(async (cb) => await cb({ query: router }))

    const ctx = createBoundCtx({
      saleOrderId: 'FY-XSD-WX-2604240001',
      paymentMethod: '储值卡',
      repayAmount: 0,
      prepaidCardAmount: 500,
    })
    await routes.repay(ctx)

    const statusUpdate = router.mock.calls.find(([sql]) => /UPDATE sale_orders[\s\S]*SET status/.test(sql))
    expect(statusUpdate[0]).toContain('first_payment_amount = NULL')
    expect(ctx.result.status).toBe('部分支付')
  })

  test('订单已关闭 → INVALID_STATE', async () => {
    const router = makeClientQueryRouter([
      {
        match: /FROM sale_orders WHERE sale_order_id = \$1 FOR UPDATE/,
        result: { rows: [makeOrigOrderRow({ status: '已关闭' })], rowCount: 1 },
      },
    ])
    pg.transaction.mockImplementation(async (cb) => await cb({ query: router }))

    const ctx = createBoundCtx({
      saleOrderId: 'FY-XSD-WX-2604240001',
      paymentMethod: '微信',
      repayAmount: 50,
    })
    await expect(routes.repay(ctx)).rejects.toThrow(/INVALID_STATE.*订单状态不允许回款/)
  })

  test('他人订单 → PERMISSION_DENIED', async () => {
    const router = makeClientQueryRouter([
      {
        match: /FROM sale_orders WHERE sale_order_id = \$1 FOR UPDATE/,
        result: { rows: [makeOrigOrderRow({ client_user_id: 'user-OTHER' })], rowCount: 1 },
      },
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
      {
        match: /FROM sale_orders WHERE sale_order_id = \$1 FOR UPDATE/,
        result: { rows: [makeOrigOrderRow()], rowCount: 1 },
      },
      // balance 50，不足以扣 200
      {
        match: 'FROM prepaid_cards WHERE user_id',
        result: { rows: [{ card_id: 'FY-CARD-X', balance: '50.00' }], rowCount: 1 },
      },
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
    await expect(routes.repay(ctx)).rejects.toThrow(/INVALID_PARAMS.*支付方式/)
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

  test('线下回款 → 仅标记 payment_method=线下，不写流水、不发起拉卡拉，返回原状态', async () => {
    const router = makeClientQueryRouter([
      {
        match: /FROM sale_orders WHERE sale_order_id = \$1 FOR UPDATE/,
        result: { rows: [makeOrigOrderRow()], rowCount: 1 },
      },
      // STEP 4：仅 UPDATE payment_method='线下'
      { match: /UPDATE sale_orders SET payment_method/, result: { rows: [], rowCount: 1 } },
    ])
    pg.transaction.mockImplementation(async (cb) => await cb({ query: router }))
    // 线下应提前 return，不进线上分支（不解析商户/不发起 preorder）
    pg.query.mockImplementation(async () => [])

    const ctx = createBoundCtx({
      saleOrderId: 'FY-XSD-WX-2604240001',
      paymentMethod: '线下',
      repayAmount: 200,
      prepaidCardAmount: 0,
    })
    await routes.repay(ctx)

    expect(ctx.result.paymentMethod).toBe('线下')
    expect(ctx.result.status).toBe('部分支付') // 原状态不变（不推进）
    expect(ctx.result.paymentParams).toBeNull()
    expect(ctx.result.repaymentOrderId).toBeUndefined()

    const calls = router.mock.calls.map((c) => c[0])
    expect(calls.some((s) => /UPDATE sale_orders SET payment_method/.test(s))).toBe(true)
    // 不写 payments / card_transactions（由 staff 确认收款落账）
    expect(calls.some((s) => /INSERT INTO sale_order_payments/.test(s))).toBe(false)
    expect(calls.some((s) => /INSERT INTO card_transactions/.test(s))).toBe(false)
    // 未发起拉卡拉聚合主扫
    expect(globalThis.__mocks__.lakalaClient.requestPreorder).not.toHaveBeenCalled()
  })

  test('线下通道携储值卡抵扣 → INVALID_PARAMS', async () => {
    const ctx = createBoundCtx({
      saleOrderId: 'FY-XSD-WX-xx',
      paymentMethod: '线下',
      repayAmount: 200,
      prepaidCardAmount: 50,
    })
    await expect(routes.repay(ctx)).rejects.toThrow(/INVALID_PARAMS.*线下通道不支持储值卡抵扣/)
  })
})
