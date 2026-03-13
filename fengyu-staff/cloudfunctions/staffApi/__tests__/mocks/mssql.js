/**
 * mssql mock — WorkFine SQL Server 连接模拟
 */
const mockRequest = {
  input: jest.fn().mockReturnThis(),
  query: jest.fn(async () => ({ recordset: [] })),
}

const mockPool = {
  request: jest.fn(() => mockRequest),
}

module.exports = {
  query: jest.fn(async () => []),
  getPool: jest.fn(async () => mockPool),
  _mockRequest: mockRequest,
  _mockPool: mockPool,
}
