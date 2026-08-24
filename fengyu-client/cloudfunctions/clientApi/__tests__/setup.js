/**
 * Global test setup — patches require.cache to mock CJS modules
 * This runs before all test files, ensuring route modules get mocked deps
 */
const path = require('path')
const { vi } = await import('vitest')

// L1 单测开启 phoneNumber 直传与 _testOpenid 测试通道
// 路由用 testBypassAllowed('ALLOW_DIRECT_PHONE') / ('ALLOW_TEST_OPENID') 守卫
// （prod 由 runtime-guard 硬闸禁用，L1 测试环境 NODE_ENV !== 'production' 必须配 env 才能走 bypass 分支）
process.env.ALLOW_DIRECT_PHONE = process.env.ALLOW_DIRECT_PHONE || 'true'
process.env.ALLOW_TEST_OPENID = process.env.ALLOW_TEST_OPENID || 'true'

// ====== Mock: db/pg ======
const pgPath = require.resolve('../db/pg')
const mockPg = {
  query: vi.fn(async () => []),
  transaction: vi.fn(async (cb) => {
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }
    return await cb(client)
  }),
  getPool: vi.fn(() => ({})),
}
require.cache[pgPath] = {
  id: pgPath,
  filename: pgPath,
  loaded: true,
  exports: mockPg,
}

// ====== Mock: wx-server-sdk ======
const wxPath = require.resolve('wx-server-sdk')
const mockCloud = {
  init: vi.fn(),
  getWXContext: vi.fn(() => ({
    OPENID: 'test-openid-001',
    APPID: 'wx811eb4ded3dfba3f',
    UNIONID: undefined,
  })),
  DYNAMIC_CURRENT_ENV: 'test-env',
  // confirmPayment 跨函数调 payNotify 触发补偿入账（issue #37）；默认模拟 payNotify 成功 ack
  callFunction: vi.fn(async () => ({ result: { code: 'SUCCESS', message: '已处理' } })),
}
require.cache[wxPath] = {
  id: wxPath,
  filename: wxPath,
  loaded: true,
  exports: mockCloud,
}

// ====== Mock: utils/config ======
const configPath = require.resolve('../utils/config')
const mockConfig = {
  getMemberThreshold: vi.fn(async () => 1980),
  getPointsToYuanRate: vi.fn(async () => 0.01),
  getPointsDeductionMaxRate: vi.fn(async () => 0.03),
  invalidateCache: vi.fn(),
  FALLBACK_THRESHOLD: 1980,
  FALLBACK_POINTS_TO_YUAN_RATE: 0.01,
  FALLBACK_POINTS_DEDUCTION_MAX_RATE: 0.03,
}
require.cache[configPath] = {
  id: configPath,
  filename: configPath,
  loaded: true,
  exports: mockConfig,
}

// ====== Mock: utils/lakala-client (HTTP caller) ======
// 只 mock HTTP 调用 request，避免单测真打拉卡拉网络；保留 formatReqTime / expectedSuccessCode 原实现。
// lakala-config 不在此 mock（其自身单测直接 require 真实模块），需要时由测试文件局部设 env。
const lakalaClientPath = require.resolve('../utils/lakala-client')
const realLakalaClient = require('../utils/lakala-client')
const mockLakalaClient = {
  ...realLakalaClient,
  // 底层 request 兜底（旧测试用，新代码走 requestPreorder/requestAlipayShareCode/queryTrade 高级封装）
  request: vi.fn(async () => ({
    code: 'BBS00000', msg: '操作成功', resp_data: {}, expectedCode: 'BBS00000', ok: true,
  })),
  // 聚合主扫 preorder 默认返回微信 wx.requestPayment 5 字段
  requestPreorder: vi.fn(async () => ({
    ok: true, code: 'BBS00000', msg: '操作成功',
    tradeNo: 'LAK-T-001', logNo: 'LAK-L-001',
    paymentParams: {
      timeStamp: '1700000000',
      nonceStr: 'mock-nonce-001',
      package: 'prepay_id=wx_mock_001',
      signType: 'RSA',
      paySign: 'mock-pay-sign-001',
    },
    lakalaAppId: 'wx811eb4ded3dfba3f',
    raw: {},
  })),
  // 支付宝吱口令默认返回 share_token
  requestAlipayShareCode: vi.fn(async () => ({
    tradeNo: 'LAK-T-001-AC', shareToken: '¥mock-share-token¥', expireDate: '',
  })),
  // 聚合主扫 query 默认返回 SUCCESS
  queryTrade: vi.fn(async () => ({
    ok: true, code: 'BBS00000', msg: '操作成功',
    tradeState: 'SUCCESS', tradeNo: 'LAK-T-001', accTradeNo: 'wx-txn-001',
    payMode: 'WECHAT', totalAmountFen: 0, payerAmountFen: 0, raw: {},
  })),
}
require.cache[lakalaClientPath] = {
  id: lakalaClientPath,
  filename: lakalaClientPath,
  loaded: true,
  exports: mockLakalaClient,
}

// Export mocks for test files to reference
globalThis.__mocks__ = { pg: mockPg, cloud: mockCloud, config: mockConfig, lakalaClient: mockLakalaClient }

// Reset mock state before each test (clears "once" queue + call history)
beforeEach(() => {
  mockPg.query.mockReset().mockResolvedValue([])
  mockPg.transaction.mockReset().mockImplementation(async (cb) => {
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }
    return await cb(client)
  })
  mockPg.getPool.mockReset().mockReturnValue({})
  mockCloud.init.mockReset()
  mockCloud.getWXContext.mockReset().mockReturnValue({
    OPENID: 'test-openid-001',
    APPID: 'wx811eb4ded3dfba3f',
    UNIONID: undefined,
  })
  mockCloud.callFunction.mockReset().mockResolvedValue({ result: { code: 'SUCCESS', message: '已处理' } })
  mockConfig.getMemberThreshold.mockReset().mockResolvedValue(1980)
  mockConfig.getPointsToYuanRate.mockReset().mockResolvedValue(0.01)
  mockConfig.getPointsDeductionMaxRate.mockReset().mockResolvedValue(0.03)
  mockConfig.invalidateCache.mockReset()
  mockLakalaClient.request.mockReset().mockResolvedValue({
    code: 'BBS00000', msg: '操作成功', resp_data: {}, expectedCode: 'BBS00000', ok: true,
  })
  mockLakalaClient.requestPreorder.mockReset().mockResolvedValue({
    ok: true, code: 'BBS00000', msg: '操作成功',
    tradeNo: 'LAK-T-001', logNo: 'LAK-L-001',
    paymentParams: {
      timeStamp: '1700000000',
      nonceStr: 'mock-nonce-001',
      package: 'prepay_id=wx_mock_001',
      signType: 'RSA',
      paySign: 'mock-pay-sign-001',
    },
    lakalaAppId: 'wx811eb4ded3dfba3f',
    raw: {},
  })
  mockLakalaClient.requestAlipayShareCode.mockReset().mockResolvedValue({
    tradeNo: 'LAK-T-001-AC', shareToken: '¥mock-share-token¥', expireDate: '',
  })
  mockLakalaClient.queryTrade.mockReset().mockResolvedValue({
    ok: true, code: 'BBS00000', msg: '操作成功',
    tradeState: 'SUCCESS', tradeNo: 'LAK-T-001', accTradeNo: 'wx-txn-001',
    payMode: 'WECHAT', totalAmountFen: 0, payerAmountFen: 0, raw: {},
  })
})
