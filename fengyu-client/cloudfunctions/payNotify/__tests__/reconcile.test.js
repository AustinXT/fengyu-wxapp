/**
 * 支付回调丢失定时补偿单测（runPaymentReconcile，issue #37）
 *
 * 锁定：
 *   - 未启用（PAYNOTIFY_ENABLED 缺失 / lakalaConfig 未就绪）→ 不扫描
 *   - 扫到候选单 + 拉卡拉 SUCCESS → cloud.callFunction 自调 payNotify 入账，ok++
 *   - 拉卡拉非 SUCCESS / 商户未配 / 金额无效 → skip
 *   - callFunction 异常 → failed，单笔隔离不影响其他单
 */

// ====== Mock: wx-server-sdk（index.js 顶层 cloud.init + 自调 callFunction）======
const wxPath = require.resolve('wx-server-sdk')
const mockCallFunction = vi.fn(async () => ({ result: { code: 'SUCCESS', message: '已处理' } }))
require.cache[wxPath] = {
  id: wxPath, filename: wxPath, loaded: true,
  exports: {
    init: () => {},
    DYNAMIC_CURRENT_ENV: 'test-env',
    callFunction: (...a) => mockCallFunction(...a),
  },
}

// ====== Mock: pg（getPg() 内 require('pg')，让 Pool.query 走 mockQuery）======
const pgPath = require.resolve('pg')
const mockQuery = vi.fn(async () => ({ rows: [] }))
require.cache[pgPath] = {
  id: pgPath, filename: pgPath, loaded: true,
  exports: {
    types: { setTypeParser: () => {} },
    Pool: class { query(...a) { return mockQuery(...a) } },
  },
}

// ====== Mock: ./utils/lakala-config（控制 isPayNotifyEnabled 的 isReady）======
const lakalaConfigPath = require.resolve('../utils/lakala-config')
const mockIsReady = vi.fn(() => true)
require.cache[lakalaConfigPath] = {
  id: lakalaConfigPath, filename: lakalaConfigPath, loaded: true,
  exports: { isReady: () => mockIsReady(), readConfig: () => ({ apiBase: 'https://x' }) },
}

// ====== Mock: ./utils/lakala-client（queryTrade）======
const lakalaClientPath = require.resolve('../utils/lakala-client')
const mockQueryTrade = vi.fn(async () => ({ tradeState: 'SUCCESS', tradeNo: 'LAK-T', totalAmountFen: 1, raw: {} }))
require.cache[lakalaClientPath] = {
  id: lakalaClientPath, filename: lakalaClientPath, loaded: true,
  exports: { queryTrade: (...a) => mockQueryTrade(...a) },
}

const { runPaymentReconcile } = require('../index')

// 假 pg query：按 SQL 关键字分流（reconcile 扫描 / 商户解析）
function setupPg({ candidates = [], merchant = { merchant_no: 'M1', term_no: 'T1', enabled: true } } = {}) {
  mockQuery.mockImplementation(async (sql) => {
    if (/FROM sale_orders/.test(sql) && /lakala_out_order_no IS NOT NULL/.test(sql)) return { rows: candidates }
    if (/lakala_merchants/.test(sql)) return { rows: merchant ? [merchant] : [] }
    return { rows: [] }
  })
}

beforeEach(() => {
  process.env.PAYNOTIFY_ENABLED = 'true'
  mockIsReady.mockReset().mockReturnValue(true)
  mockCallFunction.mockReset().mockResolvedValue({ result: { code: 'SUCCESS', message: '已处理' } })
  mockQueryTrade.mockReset().mockResolvedValue({ tradeState: 'SUCCESS', tradeNo: 'LAK-T', totalAmountFen: 1, raw: {} })
  setupPg()
})
afterEach(() => { delete process.env.PAYNOTIFY_ENABLED })

test('未启用（PAYNOTIFY_ENABLED 缺失）→ 不扫描', async () => {
  delete process.env.PAYNOTIFY_ENABLED
  const r = await runPaymentReconcile()
  expect(r.code).toBe('SUCCESS')
  expect(r.message).toBe('reconcile disabled')
  expect(mockQuery).not.toHaveBeenCalled()
})

test('lakalaConfig 未就绪 → 不扫描', async () => {
  mockIsReady.mockReturnValue(false)
  const r = await runPaymentReconcile()
  expect(r.message).toBe('reconcile disabled')
  expect(mockQuery).not.toHaveBeenCalled()
})

test('扫到候选单 + 拉卡拉 SUCCESS → 自调 payNotify 入账，ok=1', async () => {
  setupPg({
    candidates: [{
      sale_order_id: 'FY-001', store_id: 's1',
      lakala_out_order_no: 'FY-001_1700000000', payment_method: '微信',
    }],
  })
  const r = await runPaymentReconcile()
  expect(r.message).toContain('ok=1')
  expect(mockQueryTrade).toHaveBeenCalledWith(expect.objectContaining({ outTradeNo: 'FY-001_1700000000' }))
  expect(mockCallFunction).toHaveBeenCalledWith(expect.objectContaining({
    name: 'payNotify',
    data: expect.objectContaining({ orderNo: 'FY-001_1700000000', transactionId: 'LAK-T', payAmount: 0.01, paymentMethod: '微信' }),
  }))
})

test('支付宝单 paymentMethod 透传「支付宝」', async () => {
  setupPg({
    candidates: [{
      sale_order_id: 'FY-002', store_id: 's1',
      lakala_out_order_no: 'FY-002_1700000001', payment_method: '支付宝',
    }],
  })
  await runPaymentReconcile()
  expect(mockCallFunction).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ paymentMethod: '支付宝' }),
  }))
})

test('拉卡拉非 SUCCESS → skip，不自调入账', async () => {
  setupPg({
    candidates: [{
      sale_order_id: 'FY-001', store_id: 's1',
      lakala_out_order_no: 'FY-001_1700000000', payment_method: '微信',
    }],
  })
  mockQueryTrade.mockResolvedValue({ tradeState: 'INIT', tradeNo: 'LAK-T', totalAmountFen: 1, raw: {} })
  const r = await runPaymentReconcile()
  expect(r.message).toContain('skip=1')
  expect(mockCallFunction).not.toHaveBeenCalled()
})

test('商户未配（store 无关联拉卡拉商户）→ skip，不查 trade', async () => {
  setupPg({
    candidates: [{
      sale_order_id: 'FY-001', store_id: 's1',
      lakala_out_order_no: 'FY-001_1700000000', payment_method: '微信',
    }],
    merchant: null,
  })
  const r = await runPaymentReconcile()
  expect(r.message).toContain('skip=1')
  expect(mockQueryTrade).not.toHaveBeenCalled()
})

test('callFunction 异常 → failed，单笔隔离不抛错', async () => {
  setupPg({
    candidates: [{
      sale_order_id: 'FY-001', store_id: 's1',
      lakala_out_order_no: 'FY-001_1700000000', payment_method: '微信',
    }],
  })
  mockCallFunction.mockRejectedValueOnce(new Error('timeout'))
  const r = await runPaymentReconcile()
  expect(r.message).toContain('fail=1')
})

test('无候选单 → scanned=0', async () => {
  setupPg({ candidates: [] })
  const r = await runPaymentReconcile()
  expect(r.message).toContain('scanned=0')
  expect(mockCallFunction).not.toHaveBeenCalled()
})
