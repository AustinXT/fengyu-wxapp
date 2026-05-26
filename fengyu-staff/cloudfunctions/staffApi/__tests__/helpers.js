/**
 * 测试辅助工具
 */

/**
 * 创建标准 ctx 对象
 * @param {Object} overrides - 覆盖默认值
 */
function createCtx(overrides = {}) {
  const authOverrides = overrides.auth || {}
  // 兼容：若调用方传了 storeId 但未显式传 effectiveStoreId，将 effectiveStoreId 对齐到 storeId
  const storeId = Object.prototype.hasOwnProperty.call(authOverrides, 'storeId')
    ? authOverrides.storeId
    : 'store-001'
  const effectiveStoreId = Object.prototype.hasOwnProperty.call(authOverrides, 'effectiveStoreId')
    ? authOverrides.effectiveStoreId
    : storeId
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
      storeId,
      effectiveStoreId,
      currentStoreId: effectiveStoreId,
      scopeStoreIds: effectiveStoreId ? [effectiveStoreId] : [],
      loginLevel: 'store',
      staffLevel: 'store_manager',
      roleBindings: [{ role: 'manager', scopeId: 'org-node-store-001', scopeType: '门店' }],
      roles: ['manager'],
      position: '门店经理',
      storeName: '测试店',
      marketName: '测试市场',
      department: '美容部',
      skills: [],
      ...authOverrides,
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
      roleBindings: [{ role: 'customer_mgr', scopeId: 'org-node-store-001', scopeType: '门店' }],
      staffLevel: 'store_staff',
      position: '美容师',
      staffWfId: 'emp-beautician-001',
      ...authOverrides,
    },
  })
}

/**
 * 创建管理层模式 ctx（多店店长切到 management 视角）
 */
function createManagementCtx(payload = {}, authOverrides = {}) {
  return createCtx({
    payload,
    auth: {
      roles: ['manager'],
      loginLevel: 'management',
      staffLevel: 'market',
      effectiveStoreId: null,
      currentStoreId: null,
      scopeStoreIds: ['store-001', 'store-002'],
      roleBindings: [
        { role: 'manager', scopeId: 'org-node-store-001', scopeType: '门店' },
        { role: 'manager', scopeId: 'org-node-store-002', scopeType: '门店' },
      ],
      position: '市场经理',
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
      effectiveStoreId: null,
      currentStoreId: null,
      scopeStoreIds: [],
      loginLevel: null,
      staffLevel: null,
      roleBindings: [],
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
  const mockQuery = vi.fn()
  for (const result of queryResults) {
    mockQuery.mockResolvedValueOnce(result)
  }
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  return { query: mockQuery }
}

/**
 * 重置 pg mock 到干净状态
 * vi.clearAllMocks 不会清除 mockResolvedValueOnce 队列，
 * 必须用 mockReset + 重建默认实现
 */
function resetPgMock(pg) {
  pg.query.mockReset().mockImplementation(async () => [])
  pg.transaction.mockReset().mockImplementation(async (cb) => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    }
    return await cb(client)
  })
  pg.getPool.mockReset().mockReturnValue({})
}

module.exports = {
  createCtx,
  createManagerCtx,
  createBeauticianCtx,
  createManagementCtx,
  createUnboundCtx,
  createMockTransactionClient,
  resetPgMock,
}
