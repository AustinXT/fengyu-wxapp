/**
 * 测试辅助工具
 */

/**
 * 创建标准 ctx 对象（客户端用户）
 * @param {Object} overrides - 覆盖默认值
 */
function createCtx(overrides = {}) {
  return {
    event: {
      action: overrides.action || 'test.action',
      payload: overrides.payload || {},
      ...(overrides.event || {}),
    },
    context: {},
    auth: {
      isOpenid: true,
      userId: 'user-001',
      phone: '13800001111',
      boundStoreId: 'store-001',
      boundStoreName: '凤御测试店',
      boundMarketName: '华东市场',
      ...(overrides.auth || {}),
    },
    result: null,
  }
}

/**
 * 创建已绑定手机号的用户 ctx
 */
function createBoundCtx(payload = {}, authOverrides = {}) {
  return createCtx({
    payload,
    auth: {
      phone: '13800001111',
      boundStoreId: 'store-001',
      boundStoreName: '凤御测试店',
      boundMarketName: '华东市场',
      ...authOverrides,
    },
  })
}

/**
 * 创建新用户 ctx（未绑定手机号/门店）
 */
function createNewUserCtx(payload = {}) {
  return createCtx({
    payload,
    auth: {
      userId: null,
      phone: null,
      boundStoreId: null,
      boundStoreName: null,
      boundMarketName: null,
    },
  })
}

/**
 * 模拟 pg.transaction 的 client
 * 支持链式 mockResolvedValueOnce
 */
function createMockTransactionClient(queryResults = []) {
  const mockQuery = vi.fn()
  for (const result of queryResults) {
    mockQuery.mockResolvedValueOnce(result)
  }
  // 默认返回空行
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  return { query: mockQuery }
}

module.exports = {
  createCtx,
  createBoundCtx,
  createNewUserCtx,
  createMockTransactionClient,
}
