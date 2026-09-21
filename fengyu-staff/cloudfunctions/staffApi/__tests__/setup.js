// 与 CloudBase 入口一致：pg 会把 date 解析为当前时区的本地零点 Date。
process.env.TZ = 'Asia/Shanghai'

// 进销存开关现由 env 驱动且默认关闭（见 utils/feature-flags.js）。createPickup 等用例
// 断言的是「联动开启」下的行为（inventoryMode='composition'、扣批次、写库存单据），
// 故在此显式开启。必须在任何 require 之前设置：feature-flags 在模块加载期求值一次。
// 关闭态的 fail-closed 守护在 fengyu-admin/src/lib/inventory-feature-flags.test.ts。
process.env.INVENTORY_LINKAGE_ENABLED = 'true'

const path = require('path')
const { vi } = await import('vitest')
const pgPath = require.resolve('../db/pg')
const mockPg = { query: vi.fn(async () => []), transaction: vi.fn(async (cb) => { const client = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }; return await cb(client) }), getPool: vi.fn(() => ({})) }
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: mockPg }
const wxPath = require.resolve('wx-server-sdk')
const mockCloud = { init: vi.fn(), getWXContext: vi.fn(() => ({ OPENID: 'test-openid-001', APPID: 'wxe3f5d9ee6a94d22d', UNIONID: undefined })), DYNAMIC_CURRENT_ENV: 'test-env' }
require.cache[wxPath] = { id: wxPath, filename: wxPath, loaded: true, exports: mockCloud }
const mssqlPath = require.resolve('../db/mssql')
const mockRequest = { input: vi.fn().mockReturnThis(), query: vi.fn(async () => ({ recordset: [] })) }
const mockPool = { request: vi.fn(() => mockRequest) }
const mockMssql = { query: vi.fn(async () => []), getPool: vi.fn(async () => mockPool), _mockRequest: mockRequest, _mockPool: mockPool }
require.cache[mssqlPath] = { id: mssqlPath, filename: mssqlPath, loaded: true, exports: mockMssql }
const wxacodePath = require.resolve('../utils/wxacode')
// effectiveEnvVersion / versionPathSuffix 是纯函数，mock 里保留真实语义（按正式函数身份 self=release），
// 否则路由层算出的云存储路径就测不出真行为。影子函数分支由 __tests__/utils/wxacode.test.js 单独覆盖。
const mockWxacode = {
  generateWxacode: vi.fn(async () => Buffer.from('fake-qrcode-png')),
  uploadToCloudStorage: vi.fn(async () => 'cloud://mock-file-id/wxacode.png'),
  effectiveEnvVersion: vi.fn((v) => (['develop', 'trial', 'release'].includes(v) ? v : 'release')),
  versionPathSuffix: vi.fn((v) => (v === 'release' ? '' : `-${v}`)),
  getSelfEnvVersion: vi.fn(() => 'release'),
}
require.cache[wxacodePath] = { id: wxacodePath, filename: wxacodePath, loaded: true, exports: mockWxacode }
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
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: mockConfig }
// staffApi → clientApi 跨 env 桥（#214 关闭订单前请 clientApi 向渠道关单）。
// isConfigured 默认 false = 未配通道，等价于改动前的行为；需要覆盖真实分支的用例自行改 mock。
const clientApiBridgePath = require.resolve('../utils/client-api-bridge')
const mockClientApiBridge = {
  isConfigured: vi.fn(() => false),
  callClientApi: vi.fn(async () => ({})),
}
require.cache[clientApiBridgePath] = {
  id: clientApiBridgePath, filename: clientApiBridgePath, loaded: true, exports: mockClientApiBridge,
}
globalThis.__mocks__ = { pg: mockPg, cloud: mockCloud, mssql: mockMssql, wxacode: mockWxacode, config: mockConfig, clientApiBridge: mockClientApiBridge }
beforeEach(() => {
  mockPg.query.mockReset().mockResolvedValue([])
  mockPg.transaction.mockReset().mockImplementation(async (cb) => { const client = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }; return await cb(client) })
  mockPg.getPool.mockReset().mockReturnValue({})
  mockClientApiBridge.isConfigured.mockReset().mockReturnValue(false)
  mockClientApiBridge.callClientApi.mockReset().mockResolvedValue({})
  mockCloud.init.mockReset()
  mockCloud.getWXContext.mockReset().mockReturnValue({ OPENID: 'test-openid-001', APPID: 'wxe3f5d9ee6a94d22d', UNIONID: undefined })
  mockMssql.query.mockReset().mockResolvedValue([])
  mockConfig.getMemberThreshold.mockReset().mockResolvedValue(1980)
  mockConfig.getPointsToYuanRate.mockReset().mockResolvedValue(0.01)
  mockConfig.getPointsDeductionMaxRate.mockReset().mockResolvedValue(0.03)
  mockConfig.invalidateCache.mockReset()
})
