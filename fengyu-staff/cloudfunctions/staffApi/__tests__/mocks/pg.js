/**
 * pg mock — 匹配 db/pg.js 的 { query, transaction, getPool } 签名
 */
const mockPg = {
  query: jest.fn(async () => []),

  transaction: jest.fn(async (cb) => {
    const client = {
      query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
    }
    return await cb(client)
  }),

  getPool: jest.fn(() => ({})),
}

module.exports = mockPg
