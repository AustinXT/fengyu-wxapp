/**
 * 员工端库存 v2 路由回归测试
 */

const pg = globalThis.__mocks__.pg
const { createCtx } = require('../helpers')
const inventoryRoutes = require('../../routes/inventory')

function mockTransactionClient(responses) {
  const client = {
    query: vi.fn(async () => responses.shift() || { rows: [], rowCount: 0 }),
  }
  pg.transaction.mockImplementationOnce(async (cb) => cb(client))
  return client
}

describe('inventory.createDoc 权限与状态', () => {
  test('manager@A + customer_mgr@B 不能用全角色 scope 在 B 创建库存单', async () => {
    const ctx = createCtx({
      payload: {
        docType: '院入库',
        storeId: 'store-B',
        items: [{ skuId: 'sku-1', quantity: 1 }],
      },
      auth: {
        roles: ['manager', 'customer_mgr'],
        roleBindings: [
          { role: 'manager', scopeId: 'node-store-A', scopeType: '门店' },
          { role: 'customer_mgr', scopeId: 'node-store-B', scopeType: '门店' },
        ],
        scopeStoreIds: ['store-A', 'store-B'],
        effectiveStoreId: 'store-A',
      },
    })
    pg.query.mockResolvedValueOnce([])

    await expect(inventoryRoutes.createDoc(ctx)).rejects.toThrow(
      'PERMISSION_DENIED: 无权操作该门店库存',
    )
    expect(pg.transaction).not.toHaveBeenCalled()
    const [scopeSql, scopeParams] = pg.query.mock.calls[0]
    expect(scopeSql).toContain('WITH RECURSIVE descendants')
    expect(scopeSql).toContain('child.parent_id = descendants.id')
    expect(scopeSql).toContain('NOT child.id = ANY(descendants.path)')
    expect(scopeParams).toEqual([['node-store-A']])
  })

  test('只有只读库存角色时不能创建库存单', async () => {
    const ctx = createCtx({
      payload: {
        docType: '院入库',
        storeId: 'store-001',
        items: [{ skuId: 'sku-1', quantity: 1 }],
      },
      auth: {
        roles: ['customer_mgr'],
        roleBindings: [{ role: 'customer_mgr', scopeId: 'node-store-001', scopeType: '门店' }],
        scopeStoreIds: ['store-001'],
      },
    })

    await expect(inventoryRoutes.createDoc(ctx)).rejects.toThrow(
      'PERMISSION_DENIED: 无库存写入权限',
    )
    expect(pg.query).not.toHaveBeenCalled()
    expect(pg.transaction).not.toHaveBeenCalled()
  })

  test('忽略调用方 status，分院调货出库固定生成待收货并扣出库库存', async () => {
    const ctx = createCtx({
      payload: {
        docType: '分院调货出库',
        status: '已完成',
        storeId: 'store-A',
        counterpartStoreId: 'store-B',
        items: [{ stockId: 10, quantity: 2 }],
      },
      auth: {
        roles: ['admin'],
        roleBindings: [{ role: 'admin', scopeId: 'node-hq', scopeType: '总部' }],
        scopeStoreIds: ['store-A', 'store-B'],
        effectiveStoreId: null,
      },
    })
    const client = mockTransactionClient([
      { rows: [] },
      { rows: [] },
      { rows: [] },
      {
        rows: [{
          id: 10,
          store_id: 'store-A',
          sku_id: 'sku-1',
          sku_name: '测试商品',
          product_type: '家居产品',
          batch_no: 'B001',
          expiry_date: null,
          quantity_on_hand: '5',
        }],
      },
      { rows: [{ id: 101 }] },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ])
    pg.query.mockResolvedValueOnce([
      { store_id: 'store-A' },
      { store_id: 'store-B' },
    ])

    await inventoryRoutes.createDoc(ctx)

    const insertDocCall = client.query.mock.calls.find(([sql]) => (
      /INSERT INTO store_inventory_docs/.test(sql)
    ))
    expect(insertDocCall[1][2]).toBe('待收货')
    expect(insertDocCall[1][14]).toBe('emp-001')
    expect(insertDocCall[1][15]).toBe(true)

    const movementCall = client.query.mock.calls.find(([sql]) => (
      /INSERT INTO store_inventory_movements/.test(sql)
    ))
    expect(movementCall[1][8]).toBe('出库')
    expect(movementCall[1][9]).toBe(-2)
  })
})

describe('inventory.approveDoc / rejectDoc 审批一致性', () => {
  test('finance@市场A 不能凭其它角色可见 scope 审批市场B库存单', async () => {
    const ctx = createCtx({
      payload: { id: 'DOC-001', auditRemark: '拒绝越权' },
      auth: {
        roles: ['finance', 'customer_mgr'],
        roleBindings: [
          { role: 'finance', scopeId: 'market-A', scopeType: '市场' },
          { role: 'customer_mgr', scopeId: 'market-B', scopeType: '市场' },
        ],
        scopeStoreIds: ['store-A', 'store-B'],
        effectiveStoreId: null,
      },
    })
    const client = mockTransactionClient([
      {
        rows: [{
          id: 'DOC-001',
          doc_type: '院退货',
          status: '待审批',
          store_id: 'store-B',
          related_sale_order_id: null,
        }],
      },
      { rows: [] },
    ])

    await expect(inventoryRoutes.approveDoc(ctx)).rejects.toThrow(
      'PERMISSION_DENIED: 无权审批该门店库存单据',
    )
    expect(client.query.mock.calls.some(([sql]) => (
      /FROM store_inventory_doc_items/.test(sql)
    ))).toBe(false)
  })

  test('rejectDoc 在事务内 SELECT FOR UPDATE 后再驳回', async () => {
    const ctx = createCtx({
      payload: { id: 'DOC-002', auditRemark: '资料不完整' },
      auth: {
        roles: ['finance'],
        roleBindings: [{ role: 'finance', scopeId: 'node-hq', scopeType: '总部' }],
      },
    })
    const client = mockTransactionClient([
      { rows: [{ store_id: 'store-001', status: '待审批' }] },
      { rows: [{ store_id: 'store-001' }] },
      { rows: [], rowCount: 1 },
    ])

    await inventoryRoutes.rejectDoc(ctx)

    expect(client.query.mock.calls[0][0]).toMatch(/FOR UPDATE/)
    expect(client.query.mock.calls[2][0]).toMatch(/UPDATE store_inventory_docs/)
    expect(ctx.result).toEqual({ message: '已驳回' })
  })

  test('rejectDoc 锁定后发现状态已变化时不覆盖为已驳回', async () => {
    const ctx = createCtx({
      payload: { id: 'DOC-003' },
      auth: {
        roles: ['finance'],
        roleBindings: [{ role: 'finance', scopeId: 'node-hq', scopeType: '总部' }],
      },
    })
    const client = mockTransactionClient([
      { rows: [{ store_id: 'store-001', status: '已完成' }] },
      { rows: [{ store_id: 'store-001' }] },
    ])

    await expect(inventoryRoutes.rejectDoc(ctx)).rejects.toThrow(
      'INVALID_STATE: 只有待审批单据可以驳回',
    )
    expect(client.query.mock.calls).toHaveLength(2)
  })
})
