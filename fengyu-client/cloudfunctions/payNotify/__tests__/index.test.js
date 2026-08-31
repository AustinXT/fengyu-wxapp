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
const crypto = require('crypto')
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
    types: {
      setTypeParser: vi.fn(),
    },
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

// ====== Mock: ./utils/lakala-config（让 isPayNotifyEnabled() 走 ENABLED 分支）======
const lakalaConfigPath = require.resolve('../utils/lakala-config')
require.cache[lakalaConfigPath] = {
  id: lakalaConfigPath,
  filename: lakalaConfigPath,
  loaded: true,
  exports: {
    REQUIRED_VARS: [],
    readConfig: () => ({
      apiBase: 'https://test.wsmsd.cn/sit/api',
      appid: 'OP00000003',
      serialNo: 'test-serial',
      privateKeyPem: '',
      platformCertPem: '',
      notifyUrl: '',
      ipWhitelist: [],
      ipWhitelistOpen: true,
      env: 'trial',
      subAppid: 'wx811eb4ded3dfba3f',
      alipayShareSource: '',
    }),
    isReady: () => true,
    missingVars: () => [],
    assertReady: () => {},
  },
}

// ====== Mock: ./utils/lakala-sign（验签默认通过；HTTP 入口测试单独覆盖）======
const lakalaSignPath = require.resolve('../utils/lakala-sign')
require.cache[lakalaSignPath] = {
  id: lakalaSignPath,
  filename: lakalaSignPath,
  loaded: true,
  exports: {
    verifyAsyncNotification: vi.fn(() => ({ ok: true })),
    verifyResponseSignature: vi.fn(() => true),
    buildRequestAuthorization: vi.fn(() => ({ authorization: 'mock' })),
    parseAuthorizationHeader: vi.fn(() => ({ timestamp: '0', nonceStr: '0', signature: '0' })),
  },
}

// 全局启用 payNotify（测试需要业务逻辑生效）
process.env.PAYNOTIFY_ENABLED = 'true'

function loadFreshIndex() {
  const p = require.resolve('../index')
  delete require.cache[p]
  return require('../index')
}

function healthPayload(service) {
  const timestamp = String(Date.now())
  const nonce = '12345678-1234-1234-1234-123456789abc'
  return {
    service,
    timestamp,
    nonce,
    signature: crypto.createHmac('sha256', process.env.CLIENT_SECRET)
      .update(`${service}\n${timestamp}\n${nonce}`)
      .digest('hex'),
  }
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
    pending_prepaid_card_amount: '0',
    paid_amount: '300.00',
    ...overrides,
  }
}

/**
 * PR-4: 默认 payments 层 mock —— 自动补齐 payNotify payments 查询
 *   1. SUM(amount) FROM sale_order_payments → 已到账金额，默认 0
 *   2. SELECT 1 FROM sale_order_payments WHERE change_type='首次支付' → 默认空（触发首次支付）
 *   3. INSERT INTO sale_order_payments ... RETURNING id → 默认返回 1 行（非重复回调）
 *   4. UPDATE sale_orders ... SET status = $1::order_status（CAS 守卫）→ 默认 rowCount=1（放行状态翻转，
 *      避免 index.js L760-L764 因 rowCount=0 短路到「订单状态已变更（幂等）」早退）
 * 外层若传入自定义 routes，仍可在这些之前注册更具体 matcher 覆盖。
 */
function defaultPaymentsRoutes({ cashPaidSum = '300', receivedSum = cashPaidSum } = {}) {
  return [
    {
      match: /SELECT COALESCE\(SUM\(amount\), 0\) AS paid_sum/,
      result: { rows: [{ paid_sum: '0' }], rowCount: 1 },
    },
    {
      match: /FROM sale_order_payments[\s\S]*change_type = '首次支付'/,
      result: { rows: [], rowCount: 0 },
    },
    {
      match: /AS cash_paid_sum[\s\S]*AS received_sum/,
      result: { rows: [{ cash_paid_sum: cashPaidSum, received_sum: receivedSum }], rowCount: 1 },
    },
    {
      match: /INSERT INTO sale_order_payments/,
      result: { rows: [{ id: 1 }], rowCount: 1 },
    },
    {
      match: /UPDATE sale_order_payments SET allocation_status = '待分配'/,
      result: { rows: [], rowCount: 1 },
    },
    {
      match: /UPDATE sale_orders[\s\S]*SET status = \$1::order_status/,
      result: { rows: [], rowCount: 1 },
    },
  ]
}

/**
 * 将一组 SQL 片段匹配→返回值的映射应用到 mockClientQuery
 * 对于每次调用：按数组顺序第一个命中的 matcher 返回其 result
 * 未命中返回 { rows: [], rowCount: 0 }
 */
function setupClientQueryRouter(routes) {
  mockClientQuery.mockImplementation(async (sql /* , params */) => {
    if (/FROM sale_orders WHERE sale_order_id = \$1 FOR UPDATE/.test(sql)) {
      const outerResult = mockPoolQuery.mock.results[0] && await mockPoolQuery.mock.results[0].value
      const outerCall = mockPoolQuery.mock.calls.find(([outerSql]) => /FROM sale_orders WHERE sale_order_id = \$1/.test(outerSql))
      const callbackOutTradeNo = outerCall && outerCall[1] && outerCall[1][0]
      return {
        rows: outerResult && outerResult.rows
          ? outerResult.rows.map((row) => ({
              ...row,
              lakala_out_order_no: row.lakala_out_order_no === undefined
                ? callbackOutTradeNo
                : row.lakala_out_order_no,
            }))
          : [],
        rowCount: outerResult && outerResult.rows ? outerResult.rows.length : 0,
      }
    }
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
    process.env.CLIENT_SECRET = 'health-test-secret'
    vi.clearAllMocks()
    mockPoolQuery.mockReset()
    mockClientQuery.mockReset()
    mockClientRelease.mockReset()
    mockConnect.mockReset().mockImplementation(async () => ({
      query: mockClientQuery,
      release: mockClientRelease,
    }))
  })

  test('system.health 先于支付开关分流，仅执行 HMAC + SELECT 1', async () => {
    const { main } = loadFreshIndex()
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ ok: 1 }], rowCount: 1 })
    const result = await main({ action: 'system.health', payload: healthPayload('payNotify') })
    expect(result.code).toBe(0)
    expect(result.data.ok).toBe(true)
    expect(mockPoolQuery).toHaveBeenCalledWith('SELECT 1 AS ok')
  })

  test('system.health 拒绝无效签名', async () => {
    const { main } = loadFreshIndex()
    const result = await main({
      action: 'system.health',
      payload: { ...healthPayload('payNotify'), signature: '0'.repeat(64) },
    })
    expect(result.code).toBe(-401)
    expect(result.errorType).toBe('UNAUTHORIZED')
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  test('1. 无 prepaid 的普通订单 → 充值分支无记录 + 业绩分配正常 + 状态翻 已支付', async () => {
    const { main } = loadFreshIndex()
    mockPoolQuery.mockResolvedValueOnce({
      rows: [makeOrder({
        preferred_employee_id: 'emp-001',
        total_amount: '300.00',
        lakala_out_order_no: 'FY-XSD-WX-2604240001',
      })],
    })

    setupClientQueryRouter([
      ...defaultPaymentsRoutes(),
      // 充值 SELECT：无充值行（死路由：2026-05-20 起充值改判 sale_order_type，此 match 不再命中，留作无害占位）
      { match: "si.is_recharge_card = true", result: { rows: [], rowCount: 0 } },
      // capturePaymentAllocatables 守卫：仅销售单/转换单参与营业额分配
      {
        match: /SELECT sale_order_type, legacy_source FROM sale_orders/,
        result: { rows: [{ sale_order_type: '销售单', legacy_source: null }], rowCount: 1 },
      },
      // 全额到账路径先读取退款感知的逐项可分配额。
      {
        match: /SELECT sale_item_id, sale_amount::numeric AS sale_amount, received::numeric AS received\s+FROM sale_items/,
        result: {
          rows: [{ sale_item_id: 'item-001', sale_amount: '300.00', received: '300.00' }],
          rowCount: 1,
        },
      },
      // sale_items 查询（业绩分配）——补齐 capturePaymentAllocatables 所需字段，走正常比例分摊而非兜底
      {
        match: /SELECT sale_item_id, sale_amount::numeric AS sale_amount, pending_received::numeric AS pending_received, sales_category[\s\S]*FROM sale_items/,
        result: {
          rows: [
            {
              sale_item_id: 'item-001',
              sale_amount: '300.00',
              pending_received: '0',
              sales_category: '自销自耗',
              received: '300.00',
            },
          ],
          rowCount: 1,
        },
      },
      {
        match: /INSERT INTO sale_payment_item_receipts/,
        result: { rows: [{ id: 11 }], rowCount: 1 },
      },
      {
        match: /UPDATE sale_order_payments SET allocation_status = '待分配'/,
        result: { rows: [], rowCount: 1 },
      },
      {
        match: /AS receipt_positive_total/,
        result: { rows: [{ receipt_positive_total: '300.00', order_received: '300.00' }], rowCount: 1 },
      },
      {
        match: /UPDATE sale_order_payments SET allocation_status = '已分配'/,
        result: { rows: [], rowCount: 1 },
      },
      // customer_type 查询
      { match: 'SELECT customer_type', result: { rows: [{ customer_type: '流量客' }], rowCount: 1 } },
      // computed_type
      { match: 'AS computed_type', result: { rows: [{ computed_type: '体验客' }], rowCount: 1 } },
    ])

    const res = await main({ orderNo: 'FY-XSD-WX-2604240001', transactionId: 'wx-txn-001' })
    expect(res.code).toBe('SUCCESS')

    // 不应触发消费扣款
    const qs = mockClientQuery.mock.calls.map((c) => c[0])
    const hasDeductInsert = qs.some((s) => s.includes("'扣款'") && s.includes('INSERT INTO card_transactions'))
    expect(hasDeductInsert).toBe(false)

    // 业绩子分配应插入
    const hasAllocation = qs.some((s) => s.includes('INSERT INTO sale_payment_item_allocations'))
    expect(hasAllocation).toBe(true)
    expect(qs.some((s) => s.includes('INSERT INTO sale_allocations'))).toBe(false)

    // 事务闭环
    expect(qs[0]).toBe('BEGIN')
    expect(qs).toContain('COMMIT')
  })

  test('1b. 拉卡拉 out_order_no 带 _<ts> 后缀 → 剥离后按 sale_order_id 匹配订单', async () => {
    const { main } = loadFreshIndex()
    mockPoolQuery.mockResolvedValueOnce({
      rows: [makeOrder({
        preferred_employee_id: 'emp-001',
        total_amount: '300.00',
        lakala_out_order_no: 'FY-XSD-WX-2604240001_1779725000',
      })],
    })
    setupClientQueryRouter([
      ...defaultPaymentsRoutes(),
      { match: "si.is_recharge_card = true", result: { rows: [], rowCount: 0 } },
      {
        match: 'FROM sale_items WHERE sale_order_id',
        result: { rows: [{ sale_item_id: 'item-001', received: '300.00' }], rowCount: 1 },
      },
      { match: 'SELECT customer_type', result: { rows: [{ customer_type: '流量客' }], rowCount: 1 } },
      { match: 'AS computed_type', result: { rows: [{ computed_type: '体验客' }], rowCount: 1 } },
    ])

    // 模拟真实拉卡拉回调：out_order_no = sale_order_id + '_' + unixSeconds
    const res = await main({ orderNo: 'FY-XSD-WX-2604240001_1779725000', transactionId: 'wx-txn-001b' })
    expect(res.code).toBe('SUCCESS')
    // 订单 SELECT 必须用剥离后的 sale_order_id（不含 _<ts> 后缀），否则永远匹配不到订单
    const orderSelectCall = mockPoolQuery.mock.calls.find(([sql]) => /FROM sale_orders WHERE sale_order_id/.test(sql))
    expect(orderSelectCall[1][0]).toBe('FY-XSD-WX-2604240001')
  })

  test('2. 部分抵扣订单（pending_prepaid_card_amount=100）微信支付成功 → 扣 balance + INSERT 扣款 + 已支付', async () => {
    const { main } = loadFreshIndex()
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        makeOrder({
          total_amount: '300.00',
          prepaid_card_amount: '0.00',
          pending_prepaid_card_amount: '100.00',
          payable_amount: '200.00',
          paid_amount: '200.00', // payable = 300 - 100 = 200
        }),
      ],
    })

    setupClientQueryRouter([
      ...defaultPaymentsRoutes({ cashPaidSum: '200', receivedSum: '300' }),
      { match: "si.is_recharge_card = true", result: { rows: [], rowCount: 0 } },
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

    const res = await main({ orderNo: 'FY-XSD-WX-2604240002', transactionId: 'wx-txn-002' })
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

    // Bug A 修复断言：在线首次混合支付的卡兑现分支必须复用同事务主流水的 `now`，
    // 让 0038 trigger Branch A 用 `paid_at IS NOT DISTINCT FROM` 能配对两条流水。
    const sopInserts = calls.filter(([sql]) => /INSERT INTO sale_order_payments/.test(sql))
    const mainstreamInsert = sopInserts.find(([sql]) => /ON CONFLICT \(sale_order_id, payment_method, external_txn_id\)/.test(sql))
    const cardDeductInsert = sopInserts.find(([sql]) => /'储值卡抵扣'/.test(sql))
    expect(mainstreamInsert).toBeDefined()
    expect(cardDeductInsert).toBeDefined()
    // 主流水 line 988：params = [orderNo, changeType, amount, paymentMethod, txnId, $8_external_trade_info, note, now]
    // paid_at = $7 → params[7]
    // 卡兑现 line 604：params = [orderNo, amount, note, now]
    // paid_at = $4 → params[3]
    expect(mainstreamInsert[1][7]).toBe(cardDeductInsert[1][3])
  })

  test('部分现金到账也先兑现本场次 pending 储值卡，再以现金+卡重算 received/部分支付状态', async () => {
    const { main } = loadFreshIndex()
    mockPoolQuery.mockResolvedValueOnce({
      rows: [makeOrder({
        status: '待支付',
        sale_order_type: '转换单',
        total_amount: '2000.00',
        payable_amount: '1500.00',
        pending_prepaid_card_amount: '500.00',
      })],
    })
    setupClientQueryRouter([
      ...defaultPaymentsRoutes({ cashPaidSum: '500', receivedSum: '1000' }),
      { match: /external_ref = \$1[\s\S]*type = '扣款'/, result: { rows: [], rowCount: 0 } },
      {
        match: 'FROM prepaid_cards WHERE user_id',
        result: { rows: [{ card_id: 'FY-CARD-PARTIAL', balance: '1000.00' }], rowCount: 1 },
      },
    ])

    const res = await main({
      orderNo: 'FY-XSD-WX-PARTIAL-CARD',
      transactionId: 'wx-txn-partial-card',
      payAmount: 500,
    })
    expect(res.code).toBe('SUCCESS')
    expect(res.message).toMatch(/部分支付/)

    const calls = mockClientQuery.mock.calls
    const statusUpdate = calls.find(([sql]) => /UPDATE sale_orders[\s\S]*SET status = \$1::order_status/.test(sql))
    expect(statusUpdate[1][0]).toBe('部分支付')
    expect(Number(statusUpdate[1][1])).toBe(1000)
    expect(calls.some(([sql]) => /UPDATE prepaid_cards SET balance = balance - \$1/.test(sql))).toBe(true)
    expect(calls.some(([sql]) => /INSERT INTO card_transactions/.test(sql))).toBe(true)
    const cardDeductAt = calls.findIndex(([sql]) => /UPDATE prepaid_cards SET balance = balance - \$1/.test(sql))
    const commitAt = calls.findIndex(([sql]) => sql === 'COMMIT')
    expect(cardDeductAt).toBeGreaterThan(-1)
    expect(commitAt).toBeGreaterThan(cardDeductAt)
  })

  test('连续两场现金回调：第二场权威聚合保留首场已结算卡款，received 从 1000 增至 1500', async () => {
    const { main } = loadFreshIndex()
    const order = makeOrder({
      status: '待支付',
      sale_order_type: '转换单',
      total_amount: '2000.00',
      payable_amount: '1500.00',
      pending_prepaid_card_amount: '500.00',
      lakala_out_order_no: 'FY-XSD-WX-TWO-CALLBACKS_1000000000',
    })
    let cashPaid = 0
    let cardPaid = 0
    let paymentId = 10
    const receivedUpdates = []

    mockPoolQuery.mockImplementation(async (sql) => {
      if (/FROM sale_orders WHERE sale_order_id = \$1/.test(sql)) {
        return { rows: [{ ...order }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    mockClientQuery.mockImplementation(async (sql, params = []) => {
      if (/FROM sale_orders WHERE sale_order_id = \$1 FOR UPDATE/.test(sql)) {
        return { rows: [{ ...order }], rowCount: 1 }
      }
      if (/SELECT COALESCE\(SUM\(amount\), 0\) AS paid_sum/.test(sql)) {
        return { rows: [{ paid_sum: String(cashPaid) }], rowCount: 1 }
      }
      if (/change_type = '首次支付'/.test(sql)) {
        return { rows: cashPaid > 0 ? [{ exists: 1 }] : [], rowCount: cashPaid > 0 ? 1 : 0 }
      }
      if (/INSERT INTO sale_order_payments[\s\S]*ON CONFLICT \(sale_order_id, payment_method, external_txn_id\)/.test(sql)) {
        cashPaid += Number(params[2])
        return { rows: [{ id: paymentId++ }], rowCount: 1 }
      }
      if (/change_type = '储值卡抵扣' AND status = '待支付'/.test(sql)) {
        return { rows: [], rowCount: 0 }
      }
      if (/external_ref = \$1 AND type = '扣款'/.test(sql)) {
        return { rows: [], rowCount: 0 }
      }
      if (/FROM prepaid_cards WHERE user_id = \$1 FOR UPDATE/.test(sql)) {
        return { rows: [{ card_id: 'FY-CARD-TWO-CALLBACKS', balance: '1000.00' }], rowCount: 1 }
      }
      if (/INSERT INTO sale_order_payments[\s\S]*'储值卡抵扣'/.test(sql)) {
        cardPaid += Number(params[1])
        return { rows: [], rowCount: 1 }
      }
      if (/AS cash_paid_sum[\s\S]*AS received_sum/.test(sql)) {
        return {
          rows: [{ cash_paid_sum: String(cashPaid), received_sum: String(cashPaid + cardPaid) }],
          rowCount: 1,
        }
      }
      if (/UPDATE sale_orders[\s\S]*SET status = \$1::order_status/.test(sql)) {
        order.status = params[0]
        order.received = String(params[1])
        order.first_payment_amount = null
        receivedUpdates.push(Number(params[1]))
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })

    const first = await main({
      orderNo: 'FY-XSD-WX-TWO-CALLBACKS_1000000000', transactionId: 'wx-txn-session-1', payAmount: 500,
    })
    order.pending_prepaid_card_amount = '0'
    order.lakala_out_order_no = 'FY-XSD-WX-TWO-CALLBACKS_2000000000'
    const second = await main({
      orderNo: 'FY-XSD-WX-TWO-CALLBACKS_2000000000', transactionId: 'wx-txn-session-2', payAmount: 500,
    })

    expect(first.message).toMatch(/部分支付/)
    expect(second.message).toMatch(/部分支付/)
    expect(receivedUpdates).toEqual([1000, 1500])
    expect(cardPaid).toBe(500)
    expect(cashPaid).toBe(1000)
  })

  test('3. 全额抵扣终态订单收到未知 txn → 不伪装成重复回调', async () => {
    // 全额抵扣订单在 clientApi.order.create 已置 '已支付'；若收到回调，走幂等路径
    const { main } = loadFreshIndex()
    mockPoolQuery.mockResolvedValueOnce({
      rows: [makeOrder({ status: '已支付', prepaid_card_amount: '300.00', total_amount: '300.00' })],
    })

    const res = await main({ orderNo: 'FY-XSD-WX-2604240003', transactionId: 'wx-txn-003' })
    expect(res.code).toBe('FAIL')
    expect(res.message).toMatch(/终态.*未入账/)

    // 不应 connect（事务未开启）
    expect(mockConnect).not.toHaveBeenCalled()
  })

  test('4. 重复回调（payments 唯一索引 DO NOTHING）→ 幂等：sale_orders 不修改', async () => {
    const { main } = loadFreshIndex()
    mockPoolQuery.mockResolvedValueOnce({
      rows: [makeOrder({ prepaid_card_amount: '100.00', paid_amount: '200.00' })],
    })

    setupClientQueryRouter([
      // payments SUM / first-pay check
      {
        match: /SELECT COALESCE\(SUM\(amount\), 0\) AS paid_sum/,
        result: { rows: [{ paid_sum: '0' }], rowCount: 1 },
      },
      {
        match: /FROM sale_order_payments[\s\S]*change_type = '首次支付'/,
        result: { rows: [], rowCount: 0 },
      },
      // INSERT ... ON CONFLICT DO NOTHING → RETURNING 空（命中唯一索引）
      {
        match: /INSERT INTO sale_order_payments/,
        result: { rows: [], rowCount: 0 },
      },
    ])

    const res = await main({ orderNo: 'FY-XSD-WX-2604240004', transactionId: 'wx-txn-004' })
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
    // 构造：total=600 prepaid=500 → payable=100（fullyPaid 触发扣款分支）
    mockPoolQuery.mockResolvedValueOnce({
      rows: [makeOrder({
        total_amount: '600.00', prepaid_card_amount: '0.00',
        pending_prepaid_card_amount: '500.00', payable_amount: '100.00', paid_amount: '100.00',
      })],
    })

    setupClientQueryRouter([
      ...defaultPaymentsRoutes({ cashPaidSum: '500', receivedSum: '500' }),
      { match: "si.is_recharge_card = true", result: { rows: [], rowCount: 0 } },
      { match: "type = '扣款'", result: { rows: [], rowCount: 0 } },
      // balance 不足
      {
        match: 'FROM prepaid_cards WHERE user_id',
        result: { rows: [{ card_id: 'FY-CARD-X', balance: '100.00' }], rowCount: 1 },
      },
    ])

    const res = await main({ orderNo: 'FY-XSD-WX-2604240005', transactionId: 'wx-txn-005' })
    expect(res.code).toBe('FAIL')
    // index.js L1178-L1184 用 parseErrorPrefix 剥前缀后只回传 displayMessage（不暴露 errorType 给回调方），
    // 故 message 不含 'INSUFFICIENT_BALANCE:' 字样，匹配剥前缀后的中文文案
    expect(res.message).toMatch(/储值卡余额不足以完成扣款/)

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
      // 2026-05-20 充值卡剥离 SKU 化：充值识别改为 sale_order_type='充值单'，面值取 total_amount
      rows: [makeOrder({ prepaid_card_amount: '0', sale_order_type: '充值单', total_amount: '500.00' })],
    })

    const upsertSpy = vi.fn(async () => ({ rows: [{ card_id: 'FY-CARD-NEW' }], rowCount: 1 }))

    setupClientQueryRouter([
      ...defaultPaymentsRoutes({ cashPaidSum: '500', receivedSum: '500' }),
      // 充值幂等检查：ref_order_id + type='充值'
      {
        match: /SELECT 1 FROM card_transactions WHERE ref_order_id = \$1 AND type = '充值' LIMIT 1/,
        result: { rows: [], rowCount: 0 },
      },
      {
        match: 'INSERT INTO prepaid_cards',
        result: upsertSpy,
      },
      { match: 'SELECT customer_type', result: { rows: [{ customer_type: '流量客' }], rowCount: 1 } },
      { match: 'AS computed_type', result: { rows: [{ computed_type: '体验客' }], rowCount: 1 } },
    ])

    const res = await main({ orderNo: 'FY-XSD-WX-2604240006', transactionId: 'wx-txn-006' })
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
      // 2026-05-20 充值卡剥离 SKU 化：充值识别改为 sale_order_type='充值单'
      rows: [makeOrder({ prepaid_card_amount: '0', sale_order_type: '充值单' })],
    })

    setupClientQueryRouter([
      ...defaultPaymentsRoutes(),
      // 充值幂等检查：ref_order_id + type='充值'
      {
        match: /SELECT 1 FROM card_transactions WHERE ref_order_id = \$1 AND type = '充值' LIMIT 1/,
        result: { rows: [], rowCount: 0 },
      },
      { match: 'INSERT INTO prepaid_cards', result: { rows: [{ card_id: 'FY-CARD-VAL' }], rowCount: 1 } },
      { match: 'SELECT customer_type', result: { rows: [{ customer_type: '流量客' }], rowCount: 1 } },
      { match: 'AS computed_type', result: { rows: [{ computed_type: '体验客' }], rowCount: 1 } },
    ])

    const res = await main({ orderNo: 'FY-XSD-WX-2604240007', transactionId: 'wx-txn-007' })
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

  test('8. 已完成订单收到数据库中不存在的 txn → 返回失败等待人工对账', async () => {
    const { main } = loadFreshIndex()
    mockPoolQuery.mockResolvedValueOnce({
      rows: [makeOrder({ status: '已完成', prepaid_card_amount: '100.00' })],
    })

    const res = await main({ orderNo: 'FY-XSD-WX-2604240008', transactionId: 'wx-txn-008' })
    expect(res.code).toBe('FAIL')
    expect(res.message).toMatch(/终态.*未入账/)
    expect(mockConnect).not.toHaveBeenCalled()
    expect(mockClientQuery).not.toHaveBeenCalled()
  })

  // ========== PR-4: payments 流水写入相关 ==========

  test('PR-4.1: 首次全额到账 → payments 新行 + sale_orders 转 已支付', async () => {
    const { main } = loadFreshIndex()
    mockPoolQuery.mockResolvedValueOnce({
      rows: [makeOrder({ total_amount: '300.00', prepaid_card_amount: '0', paid_amount: '300.00' })],
    })

    const insertSpy = vi.fn(async () => ({ rows: [{ id: 42 }], rowCount: 1 }))

    setupClientQueryRouter([
      {
        match: /SELECT COALESCE\(SUM\(amount\), 0\) AS paid_sum/,
        result: { rows: [{ paid_sum: '0' }], rowCount: 1 },
      },
      // 首次支付检查：无
      {
        match: /FROM sale_order_payments[\s\S]*change_type = '首次支付'/,
        result: { rows: [], rowCount: 0 },
      },
      {
        match: /AS cash_paid_sum[\s\S]*AS received_sum/,
        result: { rows: [{ cash_paid_sum: '300', received_sum: '300' }], rowCount: 1 },
      },
      { match: /INSERT INTO sale_order_payments/, result: insertSpy },
      // CAS 守卫放行（rowCount=1），避免短路到「订单状态已变更（幂等）」早退
      {
        match: /UPDATE sale_orders[\s\S]*SET status = \$1::order_status/,
        result: { rows: [], rowCount: 1 },
      },
      { match: "si.is_recharge_card = true", result: { rows: [], rowCount: 0 } },
      { match: 'SELECT customer_type', result: { rows: [{ customer_type: '流量客' }], rowCount: 1 } },
      { match: 'AS computed_type', result: { rows: [{ computed_type: '体验客' }], rowCount: 1 } },
    ])

    const res = await main({ orderNo: 'FY-XSD-WX-PR4-001', transactionId: 'wx-txn-aaa' })
    expect(res.code).toBe('SUCCESS')

    // payments 插入：change_type='首次支付', amount=300
    expect(insertSpy).toHaveBeenCalled()
    const insertArgs = insertSpy.mock.calls[0]
    // 在 setupClientQueryRouter 中，我们 route.result 是函数时调用无参；用 mockClientQuery.mock.calls 取 params
    const insertParamsCall = mockClientQuery.mock.calls.find((c) =>
      /INSERT INTO sale_order_payments/.test(c[0])
    )
    expect(insertParamsCall[1][1]).toBe('首次支付')
    expect(Number(insertParamsCall[1][2])).toBe(300) // amount

    // sale_orders UPDATE 转 '已支付'
    const statusUpd = mockClientQuery.mock.calls.find(
      (c) => /UPDATE sale_orders[\s\S]*SET status/.test(c[0])
    )
    expect(statusUpd).toBeDefined()
    expect(statusUpd[1][0]).toBe('已支付') // newStatus
    expect(Number(statusUpd[1][1])).toBe(300) // newPaidSum

    // COMMIT
    expect(mockClientQuery.mock.calls.map((c) => c[0])).toContain('COMMIT')
  })

  test('PR-4.2: 部分到账 → payments 新行 + sale_orders 保持 "部分支付"', async () => {
    const { main } = loadFreshIndex()
    mockPoolQuery.mockResolvedValueOnce({
      rows: [makeOrder({ total_amount: '300.00', prepaid_card_amount: '0', paid_amount: '300.00' })],
    })

    setupClientQueryRouter([
      {
        match: /SELECT COALESCE\(SUM\(amount\), 0\) AS paid_sum/,
        result: { rows: [{ paid_sum: '0' }], rowCount: 1 },
      },
      {
        match: /FROM sale_order_payments[\s\S]*change_type = '首次支付'/,
        result: { rows: [], rowCount: 0 },
      },
      {
        match: /AS cash_paid_sum[\s\S]*AS received_sum/,
        result: { rows: [{ cash_paid_sum: '100', received_sum: '100' }], rowCount: 1 },
      },
      { match: /INSERT INTO sale_order_payments/, result: { rows: [{ id: 10 }], rowCount: 1 } },
      // CAS 守卫放行（rowCount=1），避免短路到「订单状态已变更（幂等）」早退
      {
        match: /UPDATE sale_orders[\s\S]*SET status = \$1::order_status/,
        result: { rows: [], rowCount: 1 },
      },
    ])

    // 显式传 payAmount=100（小于应付 300）→ 部分支付
    const res = await main({
      orderNo: 'FY-XSD-WX-PR4-002',
      transactionId: 'wx-txn-part',
      payAmount: 100,
    })
    expect(res.code).toBe('SUCCESS')
    expect(res.message).toMatch(/部分支付/)

    // status 应为 '部分支付'，paid_amount=100
    const statusUpd = mockClientQuery.mock.calls.find(
      (c) => /UPDATE sale_orders[\s\S]*SET status/.test(c[0])
    )
    expect(statusUpd[1][0]).toBe('部分支付')
    expect(Number(statusUpd[1][1])).toBe(100)
    expect(statusUpd[0]).toContain('first_payment_amount = NULL')

    // 不应走到到期日；部分到账也会进入 receipt 捕获/自动分配链路，但不得再写旧表
    // 注：2026-05-21 单品合并后 expire_date 自动赋值整体移除，此守卫恒成立
    const expireUpd = mockClientQuery.mock.calls.find(
      (c) => /UPDATE sale_items[\s\S]*SET expire_date/.test(c[0])
    )
    expect(expireUpd).toBeUndefined()
    const oldAllocIns = mockClientQuery.mock.calls.find(
      (c) => /INSERT INTO sale_allocations/.test(c[0])
    )
    expect(oldAllocIns).toBeUndefined()
  })

  test('PR-4.3: 重复回调（uq_sop_txn 命中）→ payments 不重复，sale_orders 不修改', async () => {
    const { main } = loadFreshIndex()
    mockPoolQuery.mockResolvedValueOnce({
      rows: [makeOrder({ total_amount: '300.00', prepaid_card_amount: '0', paid_amount: '300.00' })],
    })

    setupClientQueryRouter([
      {
        match: /SELECT COALESCE\(SUM\(amount\), 0\) AS paid_sum/,
        result: { rows: [{ paid_sum: '0' }], rowCount: 1 },
      },
      {
        match: /FROM sale_order_payments[\s\S]*change_type = '首次支付'/,
        result: { rows: [], rowCount: 0 },
      },
      // INSERT ON CONFLICT DO NOTHING → RETURNING 空
      { match: /INSERT INTO sale_order_payments/, result: { rows: [], rowCount: 0 } },
    ])

    const res = await main({ orderNo: 'FY-XSD-WX-PR4-003', transactionId: 'wx-txn-dup' })
    expect(res.code).toBe('SUCCESS')
    expect(res.message).toMatch(/幂等/)

    // sale_orders 的 UPDATE 不应执行
    const statusUpd = mockClientQuery.mock.calls.find(
      (c) => /UPDATE sale_orders[\s\S]*SET status/.test(c[0])
    )
    expect(statusUpd).toBeUndefined()
    // 应 ROLLBACK（实际实现里重复回调是 ROLLBACK 提前返回）
    expect(mockClientQuery.mock.calls.map((c) => c[0])).toContain('ROLLBACK')
  })

  test('PR-4.4: 补款回调（订单已有首次支付行）→ change_type=回款', async () => {
    const { main } = loadFreshIndex()
    mockPoolQuery.mockResolvedValueOnce({
      rows: [makeOrder({
        status: '部分支付',
        total_amount: '300.00', prepaid_card_amount: '0', paid_amount: '100.00',
      })],
    })

    setupClientQueryRouter([
      // 已到账 100
      {
        match: /SELECT COALESCE\(SUM\(amount\), 0\) AS paid_sum/,
        result: { rows: [{ paid_sum: '100' }], rowCount: 1 },
      },
      // 已有首次支付行
      {
        match: /FROM sale_order_payments[\s\S]*change_type = '首次支付'/,
        result: { rows: [{ '?column?': 1 }], rowCount: 1 },
      },
      {
        match: /AS cash_paid_sum[\s\S]*AS received_sum/,
        result: { rows: [{ cash_paid_sum: '300', received_sum: '300' }], rowCount: 1 },
      },
      { match: /INSERT INTO sale_order_payments/, result: { rows: [{ id: 99 }], rowCount: 1 } },
      { match: "si.is_recharge_card = true", result: { rows: [], rowCount: 0 } },
      { match: 'SELECT customer_type', result: { rows: [{ customer_type: '流量客' }], rowCount: 1 } },
      { match: 'AS computed_type', result: { rows: [{ computed_type: '体验客' }], rowCount: 1 } },
    ])

    const res = await main({
      orderNo: 'FY-XSD-WX-PR4-004',
      transactionId: 'wx-txn-repay',
    })
    expect(res.code).toBe('SUCCESS')

    // INSERT 参数 change_type='回款'
    const insertCall = mockClientQuery.mock.calls.find((c) =>
      /INSERT INTO sale_order_payments/.test(c[0])
    )
    expect(insertCall).toBeDefined()
    expect(insertCall[1][1]).toBe('回款')
    expect(Number(insertCall[1][2])).toBe(200) // remaining = 300 - 100

    // sale_orders 转 '已支付'（100 + 200 = 300）
    const statusUpd = mockClientQuery.mock.calls.find(
      (c) => /UPDATE sale_orders[\s\S]*SET status/.test(c[0])
    )
    expect(statusUpd[1][0]).toBe('已支付')
  })

  test('旧意图成功回调与当前 out_trade_no 不一致 → 拒绝入账且不清新意图', async () => {
    const { main } = loadFreshIndex()
    const currentOutTradeNo = 'FY-XSD-WX-INTENT_2000000000'
    const order = makeOrder({
      status: '部分支付',
      total_amount: '2000.00',
      payable_amount: '1500.00',
      lakala_out_order_no: currentOutTradeNo,
      first_payment_amount: '500.00',
    })
    mockPoolQuery.mockResolvedValueOnce({ rows: [order] })
    setupClientQueryRouter(defaultPaymentsRoutes())

    const res = await main({
      orderNo: 'FY-XSD-WX-INTENT_1000000000',
      transactionId: 'lakala-old-txn',
      payAmount: 1000,
    })

    expect(res).toEqual({ code: 'FAIL', message: '非当前支付意图' })
    expect(mockClientQuery.mock.calls.some(([sql]) => /INSERT INTO sale_order_payments/.test(sql))).toBe(false)
    expect(mockClientQuery.mock.calls.some(([sql]) => /lakala_out_order_no = NULL/.test(sql))).toBe(false)
  })

  test('当前受限意图回调金额必须等于 first_payment_amount', async () => {
    const { main } = loadFreshIndex()
    const outTradeNo = 'FY-XSD-WX-CAP_2000000000'
    const order = makeOrder({
      status: '部分支付',
      total_amount: '2000.00',
      payable_amount: '1500.00',
      lakala_out_order_no: outTradeNo,
      first_payment_amount: '500.00',
    })
    mockPoolQuery.mockResolvedValueOnce({ rows: [order] })
    setupClientQueryRouter(defaultPaymentsRoutes())

    const res = await main({ orderNo: outTradeNo, transactionId: 'lakala-wrong-amount', payAmount: 600 })

    expect(res.code).toBe('FAIL')
    expect(res.message).toMatch(/回调金额与冻结金额不一致/)
    expect(mockClientQuery.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK')
    expect(mockClientQuery.mock.calls.some(([sql]) => /INSERT INTO sale_order_payments/.test(sql))).toBe(false)
  })

  test('冻结金额高于锁内剩余应付时，回调金额按 min(remaining, cap) 校验', async () => {
    const { main } = loadFreshIndex()
    const outTradeNo = 'FY-XSD-WX-CAP-MIN_2000000000'
    const order = makeOrder({
      status: '部分支付',
      total_amount: '2000.00',
      payable_amount: '300.00',
      lakala_out_order_no: outTradeNo,
      first_payment_amount: '500.00',
      client_user_id: null,
    })
    mockPoolQuery.mockResolvedValueOnce({ rows: [order] })
    setupClientQueryRouter(defaultPaymentsRoutes({ cashPaidSum: '300', receivedSum: '300' }))

    const res = await main({ orderNo: outTradeNo, transactionId: 'lakala-cap-min', payAmount: 300 })

    expect(res.code).toBe('SUCCESS')
    expect(mockClientQuery.mock.calls.some(([sql]) => /INSERT INTO sale_order_payments/.test(sql))).toBe(true)
  })

  test('当前意图成功入账 → 订单更新按 out_trade_no CAS 并原子清两个意图字段', async () => {
    const { main } = loadFreshIndex()
    const outTradeNo = 'FY-XSD-WX-CURRENT_2000000000'
    const order = makeOrder({
      total_amount: '500.00',
      payable_amount: '500.00',
      lakala_out_order_no: outTradeNo,
      first_payment_amount: '500.00',
      client_user_id: null,
    })
    mockPoolQuery.mockResolvedValueOnce({ rows: [order] })
    setupClientQueryRouter(defaultPaymentsRoutes({ cashPaidSum: '500', receivedSum: '500' }))

    const res = await main({ orderNo: outTradeNo, transactionId: 'lakala-current-txn', payAmount: 500 })

    expect(res.code).toBe('SUCCESS')
    const update = mockClientQuery.mock.calls.find(([sql]) => /UPDATE sale_orders[\s\S]*SET status = \$1::order_status/.test(sql))
    expect(update).toBeDefined()
    expect(update[0]).toContain('first_payment_amount = NULL')
    expect(update[0]).toContain('lakala_out_order_no = NULL')
    expect(update[0]).toContain('AND lakala_out_order_no = $5')
    expect(update[1][4]).toBe(outTradeNo)
  })

  test('同一 txn 已入账时优先幂等 ACK，即使成功处理已清空当前意图', async () => {
    const { main } = loadFreshIndex()
    mockPoolQuery.mockResolvedValueOnce({
      rows: [makeOrder({
        status: '已支付',
        lakala_out_order_no: null,
        transaction_already_paid: true,
      })],
    })

    const res = await main({
      orderNo: 'FY-XSD-WX-DUP_2000000000',
      transactionId: 'lakala-duplicate-txn',
      payAmount: 500,
    })

    expect(res.code).toBe('SUCCESS')
    expect(res.message).toMatch(/幂等/)
    expect(mockConnect).not.toHaveBeenCalled()
  })

  test('已有正向储值卡抵扣时，后续现金归类为回款而非第二笔首次支付', async () => {
    const { main } = loadFreshIndex()
    const outTradeNo = 'FY-XSD-WX-CARD-FIRST_2000000000'
    const order = makeOrder({
      status: '部分支付',
      total_amount: '300.00',
      payable_amount: '200.00',
      lakala_out_order_no: outTradeNo,
      first_payment_amount: null,
      client_user_id: null,
    })
    mockPoolQuery.mockResolvedValueOnce({ rows: [order] })
    setupClientQueryRouter([
      {
        match: /amount > 0[\s\S]*change_type = '首次支付'[\s\S]*储值卡抵扣/,
        result: { rows: [{ '?column?': 1 }], rowCount: 1 },
      },
      ...defaultPaymentsRoutes({ cashPaidSum: '200', receivedSum: '300' }),
    ])

    await main({ orderNo: outTradeNo, transactionId: 'lakala-after-card', payAmount: 200 })

    const insert = mockClientQuery.mock.calls.find(([sql]) => /INSERT INTO sale_order_payments \(/.test(sql))
    expect(insert[1][1]).toBe('回款')
  })
})
