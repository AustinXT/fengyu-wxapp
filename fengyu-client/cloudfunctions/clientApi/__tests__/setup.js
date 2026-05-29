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
  invalidateCache: vi.fn(),
  FALLBACK_THRESHOLD: 1980,
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
  request: vi.fn(async () => ({
    code: '000000',
    msg: '操作成功',
    resp_data: { counter_url: 'https://pay.test/cashier', pay_order_no: 'PO-TEST-1' },
    expectedCode: '000000',
    ok: true,
  })),
  // query/close helper 也 mock，避免单测走真网络
  queryCashierOrder: vi.fn(async () => ({
    code: '000000', msg: '操作成功', ok: true, resp_data: { order_status: '0' },
  })),
  closeCashierOrder: vi.fn(async () => ({
    code: '000000', msg: '操作成功', ok: true, resp_data: { order_status: '7' },
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
  mockConfig.getMemberThreshold.mockReset().mockResolvedValue(1980)
  mockConfig.invalidateCache.mockReset()
  mockLakalaClient.request.mockReset().mockResolvedValue({
    code: '000000',
    msg: '操作成功',
    resp_data: { counter_url: 'https://pay.test/cashier', pay_order_no: 'PO-TEST-1' },
    expectedCode: '000000',
    ok: true,
  })
  mockLakalaClient.queryCashierOrder.mockReset().mockResolvedValue({
    code: '000000', msg: '操作成功', ok: true, resp_data: { order_status: '0' },
  })
  mockLakalaClient.closeCashierOrder.mockReset().mockResolvedValue({
    code: '000000', msg: '操作成功', ok: true, resp_data: { order_status: '7' },
  })
})
