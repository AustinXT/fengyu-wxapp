/**
 * pg mock — 匹配 db/pg.js 的 { query, transaction, getPool } 签名
 */
const mockPg = {
  query: vi.fn(async () => []),

  transaction: vi.fn(async (cb) => {
    const client = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    }
    return await cb(client)
  }),

  getPool: vi.fn(() => ({})),
}

module.exports = mockPg
