/**
 * mssql mock — WorkFine SQL Server 连接模拟
 */
const mockRequest = {
  input: vi.fn().mockReturnThis(),
  query: vi.fn(async () => ({ recordset: [] })),
}

const mockPool = {
  request: vi.fn(() => mockRequest),
}

module.exports = {
  query: vi.fn(async () => []),
  getPool: vi.fn(async () => mockPool),
  _mockRequest: mockRequest,
  _mockPool: mockPool,
}
