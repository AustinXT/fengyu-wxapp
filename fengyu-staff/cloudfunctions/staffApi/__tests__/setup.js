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
const mockWxacode = { generateWxacode: vi.fn(async () => Buffer.from('fake-qrcode-png')), uploadToCloudStorage: vi.fn(async () => 'cloud://mock-file-id/wxacode.png') }
require.cache[wxacodePath] = { id: wxacodePath, filename: wxacodePath, loaded: true, exports: mockWxacode }
globalThis.__mocks__ = { pg: mockPg, cloud: mockCloud, mssql: mockMssql, wxacode: mockWxacode }
beforeEach(() => {
  mockPg.query.mockReset().mockResolvedValue([])
  mockPg.transaction.mockReset().mockImplementation(async (cb) => { const client = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }; return await cb(client) })
  mockPg.getPool.mockReset().mockReturnValue({})
  mockCloud.init.mockReset()
  mockCloud.getWXContext.mockReset().mockReturnValue({ OPENID: 'test-openid-001', APPID: 'wxe3f5d9ee6a94d22d', UNIONID: undefined })
  mockMssql.query.mockReset().mockResolvedValue([])
})
