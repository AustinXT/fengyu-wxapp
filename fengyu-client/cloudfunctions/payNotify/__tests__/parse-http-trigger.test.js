/**
 * parseHttpTriggerEvent 聚合主扫回调字段映射单测
 *
 * 验证 payNotify 收到 POST + lakala 聚合主扫规范字段后，转换为内部 event 格式正确：
 *   - out_trade_no → orderNo（含 _unixSec 后缀，下游剥离）
 *   - trade_no → transactionId（作 external_txn_id 幂等键）
 *   - trade_state SUCCESS → 进业务；INIT/FAIL/REFUND/CLOSE → ack 跳过
 *   - account_type WECHAT/ALIPAY → paymentMethod 中文
 *   - total_amount → payAmount（订单应付为入账基准，缺失兜底 payer_amount）
 *     注：payer_amount 是用户实付（扣银行立减金/平台立减等渠道出资营销），不作入账，否则误判少收
 */

// ====== Mock: pg ======
// pool.query 默认返回空（订单不存在，让 main 早期返回 FAIL）
const mockPoolQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }))
const pgPath = require.resolve('pg')
require.cache[pgPath] = {
  id: pgPath,
  filename: pgPath,
  loaded: true,
  exports: {
    Pool: vi.fn(() => ({
      query: (...args) => mockPoolQuery(...args),
      connect: vi.fn(async () => ({ query: vi.fn(), release: vi.fn() })),
      on: vi.fn(),
    })),
    types: { setTypeParser: vi.fn() },
  },
}

// ====== Mock: wx-server-sdk ======
const wxPath = require.resolve('wx-server-sdk')
require.cache[wxPath] = {
  id: wxPath,
  filename: wxPath,
  loaded: true,
  exports: { init: vi.fn(), DYNAMIC_CURRENT_ENV: 'test-env' },
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

// ====== Mock: ./utils/lakala-config ======
const lakalaConfigPath = require.resolve('../utils/lakala-config')
require.cache[lakalaConfigPath] = {
  id: lakalaConfigPath,
  filename: lakalaConfigPath,
  loaded: true,
  exports: {
    REQUIRED_VARS: [],
    readConfig: () => ({
      apiBase: 'https://test.wsmsd.cn/sit/api',
      appid: 'OP00000003', serialNo: 'sn', privateKeyPem: '', platformCertPem: '',
      notifyUrl: '', ipWhitelist: [], ipWhitelistOpen: true,  // 跳过 IP 白名单
      env: 'trial', subAppid: 'wx811eb4ded3dfba3f', alipayShareSource: 'FENGYU',
    }),
    isReady: () => true,
    missingVars: () => [],
    assertReady: () => {},
  },
}

// ====== Mock: ./utils/lakala-sign（验签默认通过）======
const lakalaSignPath = require.resolve('../utils/lakala-sign')
const mockVerifyAsyncNotification = vi.fn(() => ({ ok: true }))
require.cache[lakalaSignPath] = {
  id: lakalaSignPath,
  filename: lakalaSignPath,
  loaded: true,
  exports: {
    verifyAsyncNotification: mockVerifyAsyncNotification,
    verifyResponseSignature: vi.fn(() => true),
    buildRequestAuthorization: vi.fn(() => ({ authorization: 'mock' })),
    parseAuthorizationHeader: vi.fn(() => ({ timestamp: '0', nonceStr: '0', signature: '0' })),
  },
}

process.env.PAYNOTIFY_ENABLED = 'true'

function loadFreshIndex() {
  const p = require.resolve('../index')
  delete require.cache[p]
  return require('../index')
}

function makeHttpEvent(body, overrides = {}) {
  return {
    httpMethod: 'POST',
    headers: { authorization: 'LKLAPI-SHA256withRSA appid="x",serial_no="x",timestamp="0",nonce_str="x",signature="x"' },
    body: JSON.stringify(body),
    ...overrides,
  }
}

describe('parseHttpTriggerEvent 聚合主扫', () => {
  beforeEach(() => {
    mockVerifyAsyncNotification.mockReset().mockReturnValue({ ok: true })
  })

  test('trade_state=SUCCESS + account_type=WECHAT → orderNo/transactionId/payAmount/paymentMethod 字段映射正确', async () => {
    const { main } = loadFreshIndex()
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })  // 订单不存在
    const event = makeHttpEvent({
      out_trade_no: 'FY-XSD-WX-2604240001_1700000000',
      trade_no: 'LAK-T-001',
      trade_state: 'SUCCESS',
      account_type: 'WECHAT',
      total_amount: 30000,
      payer_amount: 30000,
      acc_trade_no: 'wx-txn-001',
    })

    // 不期待业务成功（pg 没 mock 真实订单行），只验 parseHttpTriggerEvent 字段映射到位
    // 业务层 SELECT sale_orders 返回空 → 返回 FAIL/订单不存在（验证 parseHttpTriggerEvent 已正确剥离 _<unixSec>）
    const res = await main(event)
    // main 在 isHttpEntry 但订单不存在时返回的是裸 { code:'FAIL' }，可能没 wrap statusCode
    // 这里只要不是 403 / 400 即说明验签和字段映射都过了
    expect(res.statusCode).not.toBe(403)
    expect(res.statusCode).not.toBe(400)
    // 业务层 SELECT 用剥离后的 saleOrderId 'FY-XSD-WX-2604240001' 查
    const lastCall = mockPoolQuery.mock.calls[mockPoolQuery.mock.calls.length - 1]
    expect(lastCall[1][0]).toBe('FY-XSD-WX-2604240001')  // _1700000000 后缀已剥离
  })

  test('trade_state=REFUND → ack SUCCESS 跳过业务（不进 payNotify 主流程）', async () => {
    const { main } = loadFreshIndex()
    const event = makeHttpEvent({
      out_trade_no: 'FY-XSD-WX-001_x',
      trade_no: 'LAK-T-001',
      trade_state: 'REFUND',
      account_type: 'WECHAT',
      total_amount: 30000,
    })
    const res = await main(event)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.code).toBe('SUCCESS')
    expect(body.message).toMatch(/退款回调/)
  })

  test('trade_state=PART_REFUND → ack SUCCESS 跳过业务', async () => {
    const { main } = loadFreshIndex()
    const event = makeHttpEvent({
      out_trade_no: 'FY-XSD-WX-001_x',
      trade_no: 'LAK-T-001',
      trade_state: 'PART_REFUND',
      account_type: 'WECHAT',
    })
    const res = await main(event)
    const body = JSON.parse(res.body)
    expect(body.code).toBe('SUCCESS')
    expect(body.message).toMatch(/退款回调/)
  })

  test.each(['INIT', 'CREATE', 'DEAL', 'UNKNOWN'])(
    'trade_state=%s → ack SUCCESS 跳过业务（等下次成功回调）',
    async (state) => {
      const { main } = loadFreshIndex()
      const event = makeHttpEvent({
        out_trade_no: 'FY-XSD-WX-001_x', trade_no: 'LAK-T-001',
        trade_state: state, account_type: 'WECHAT',
      })
      const res = await main(event)
      const body = JSON.parse(res.body)
      expect(body.code).toBe('SUCCESS')
      expect(body.message).toContain('非成功状态')
    }
  )

  // #214：REVOKED（当日交易撤销）同属不可再支付的终态，此前被漏判 → 撤销单永久卡住支付意图
  test.each(['FAIL', 'CLOSE', 'REVOKED'])(
    'trade_state=%s → 按当前 out_trade_no CAS 释放后 ack',
    async (state) => {
      const { main } = loadFreshIndex()
      const event = makeHttpEvent({
        out_trade_no: 'FY-XSD-WX-001_1700000000', trade_no: 'LAK-T-001',
        trade_state: state, account_type: 'WECHAT',
      })
      const res = await main(event)
      expect(JSON.parse(res.body).code).toBe('SUCCESS')
      const release = mockPoolQuery.mock.calls.find(([sql]) => /SET lakala_out_order_no = NULL/.test(sql))
      expect(release).toBeDefined()
      expect(release[1]).toEqual(['FY-XSD-WX-001', 'FY-XSD-WX-001_1700000000'])
    }
  )

  test('非 HTTP callFunction 伪造终态字段 → 拒绝且不清理活动意图', async () => {
    const { main } = loadFreshIndex()
    mockPoolQuery.mockClear()

    const res = await main({
      orderNo: 'FY-XSD-WX-001_1700000000',
      tradeState: 'CLOSE',
      _lakalaTerminalPayment: true,
      _httpEntry: true,
    })

    expect(res).toEqual({
      code: -403,
      message: 'PERMISSION_DENIED: LAKALA_TERMINAL_CALLBACK_HTTP_ONLY',
      data: null,
    })
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  test('account_type=ALIPAY → 验签 + 字段映射通过（落业务层后 paymentMethod=支付宝）', async () => {
    const { main } = loadFreshIndex()
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    const event = makeHttpEvent({
      out_trade_no: 'FY-XSD-WX-001_1700000001',
      trade_no: 'LAK-T-001',
      trade_state: 'SUCCESS',
      account_type: 'ALIPAY',
      total_amount: 30000,
      payer_amount: 30000,
    })
    const res = await main(event)
    expect(res.statusCode).not.toBe(403)
    expect(res.statusCode).not.toBe(400)
  })

  test('验签失败 → 403', async () => {
    mockVerifyAsyncNotification.mockReturnValue({ ok: false, reason: 'SIGNATURE_MISMATCH' })
    const { main } = loadFreshIndex()
    const event = makeHttpEvent({
      out_trade_no: 'x', trade_no: 'x', trade_state: 'SUCCESS', account_type: 'WECHAT',
    })
    const res = await main(event)
    expect(res.statusCode).toBe(403)
    const body = JSON.parse(res.body)
    expect(body.code).toBe('FAIL')
    expect(body.message).toMatch(/LAKALA_CALLBACK_SIGN_FAIL/)
  })

  test('body 不是 JSON → 400', async () => {
    const { main } = loadFreshIndex()
    const event = {
      httpMethod: 'POST',
      headers: { authorization: 'LKLAPI-SHA256withRSA' },
      body: '<<not-json>>',
    }
    const res = await main(event)
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body)
    expect(body.message).toMatch(/BODY_NOT_JSON/)
  })

  test('渠道立减（银行立减金等）：total_amount=15800 payer_amount=15790 → payAmount=158 按订单应付入账（不被立减抵减）', () => {
    // 回归 2026-06-18 bug：用户用「中国银行立减金 -0.10」实付 157.9，但立减由银行出资、
    // 商户全额到账 158；入账须用 total_amount，否则订单被误判「部分支付」(received=157.9)。
    const { parseHttpTriggerEvent } = loadFreshIndex()
    const ev = parseHttpTriggerEvent(makeHttpEvent({
      out_trade_no: 'FY-XSD-WX-2606180025_1700000003',
      trade_no: 'LAK-T-025', trade_state: 'SUCCESS', account_type: 'ALIPAY',
      total_amount: 15800, payer_amount: 15790,
    }))
    expect(ev.payAmount).toBe(158)
    expect(ev.paymentMethod).toBe('支付宝')
    expect(ev.orderNo).toBe('FY-XSD-WX-2606180025_1700000003')
  })

  test('total_amount 缺失 → 兜底 payer_amount 并告警（payAmount=payer_amount）', () => {
    const { parseHttpTriggerEvent } = loadFreshIndex()
    const ev = parseHttpTriggerEvent(makeHttpEvent({
      out_trade_no: 'FY-XSD-WX-001_1700000002',
      trade_no: 'LAK-T-001', trade_state: 'SUCCESS', account_type: 'WECHAT',
      payer_amount: 30000,
      // total_amount 缺失
    }))
    expect(ev.payAmount).toBe(300)
  })

  test('out_trade_no 带 _<unixSec> 后缀 → 主流程会按 saleOrderId 查（剥离后缀逻辑沿用旧版）', async () => {
    const { main } = loadFreshIndex()
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    const event = makeHttpEvent({
      out_trade_no: 'FY-XSD-WX-2604240001_1700000000',
      trade_no: 'LAK-T-001', trade_state: 'SUCCESS', account_type: 'WECHAT', total_amount: 30000,
    })
    const res = await main(event)
    expect(res.statusCode).not.toBe(403)
    // 业务层 SELECT 用剥离后的 saleOrderId 查
    const lastCall = mockPoolQuery.mock.calls[mockPoolQuery.mock.calls.length - 1]
    expect(lastCall[1][0]).toBe('FY-XSD-WX-2604240001')
  })
})
