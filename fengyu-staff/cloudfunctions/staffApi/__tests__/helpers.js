/**
 * 测试辅助工具
 */

/**
 * 创建标准 ctx 对象
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
      openid: 'test-openid-001',
      phone: '13800001111',
      staffWfId: 'emp-001',
      storeId: 'store-001',
      roles: ['manager'],
      position: '门店经理',
      storeName: '测试店',
      marketName: '测试市场',
      department: '美容部',
      ...(overrides.auth || {}),
    },
    result: null,
  }
}

/**
 * 创建店长 ctx
 */
function createManagerCtx(payload = {}, authOverrides = {}) {
  return createCtx({
    payload,
    auth: {
      roles: ['manager'],
      position: '门店经理',
      ...authOverrides,
    },
  })
}

/**
 * 创建美容师 ctx
 */
function createBeauticianCtx(payload = {}, authOverrides = {}) {
  return createCtx({
    payload,
    auth: {
      roles: [],
      position: '美容师',
      staffWfId: 'emp-beautician-001',
      ...authOverrides,
    },
  })
}

/**
 * 创建未绑定员工 ctx
 */
function createUnboundCtx(payload = {}) {
  return createCtx({
    payload,
    auth: {
      openid: 'test-openid-new',
      phone: null,
      staffWfId: null,
      storeId: null,
      roles: [],
      position: null,
      storeName: null,
      marketName: null,
      department: null,
    },
  })
}

/**
 * 模拟 pg.transaction 的 client
 * 支持链式 mockResolvedValueOnce
 */
function createMockTransactionClient(queryResults = []) {
  const mockQuery = jest.fn()
  for (const result of queryResults) {
    mockQuery.mockResolvedValueOnce(result)
  }
  // 默认返回空行
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  return { query: mockQuery }
}

module.exports = {
  createCtx,
  createManagerCtx,
  createBeauticianCtx,
  createUnboundCtx,
  createMockTransactionClient,
}
