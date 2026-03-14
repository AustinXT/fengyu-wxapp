/**
 * Global test setup — patches require.cache to mock CJS modules
 * This runs before all test files, ensuring route modules get mocked deps
 */
const path = require('path')
const { vi } = await import('vitest')

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

// Export mocks for test files to reference
globalThis.__mocks__ = { pg: mockPg, cloud: mockCloud }

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
})
