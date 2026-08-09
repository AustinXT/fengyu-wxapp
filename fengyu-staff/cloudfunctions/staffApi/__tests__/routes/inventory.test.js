/**
 * 员工端库存 v3 路由回归测试。
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
        docType: '分院调货出库',
        sourceLocationId: 'store-B',
        targetLocationId: 'store-A',
        items: [{ lotId: 10, skuId: 'sku-1', quantity: 1 }],
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
    pg.query.mockImplementation(async (query) => (
      String(query).includes('WITH RECURSIVE descendants') ? [{ store_id: 'store-A' }] : []
    ))

    await expect(inventoryRoutes.createDoc(ctx)).rejects.toThrow(
      'PERMISSION_DENIED: 无权操作该门店库存',
    )
    expect(pg.transaction).not.toHaveBeenCalled()
  })

  test('只有只读库存角色时不能创建库存单', async () => {
    const ctx = createCtx({
      payload: {
        docType: '门店报货',
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
    expect(pg.transaction).not.toHaveBeenCalled()
  })

  test('分院调货出库固定生成待收货并扣减 v3 批次库存', async () => {
    const ctx = createCtx({
      payload: {
        docType: '分院调货出库',
        status: '已完成',
        sourceLocationId: 'store-A',
        targetLocationId: 'store-B',
        items: [{ lotId: 10, skuId: 'sku-1', quantity: 2 }],
      },
      auth: {
        roles: ['admin'],
        roleBindings: [{ role: 'admin', scopeId: 'node-hq', scopeType: '总部' }],
        scopeStoreIds: ['store-A', 'store-B'],
        effectiveStoreId: null,
      },
    })
    pg.query.mockImplementation(async (query) => {
      const sql = String(query)
      if (sql.includes('SELECT store_id FROM stores')) {
        return [{ store_id: 'store-A' }, { store_id: 'store-B' }]
      }
      if (sql.includes('SELECT location_id, location_type, parent_location_id')) {
        return [{ location_id: 'store-A', location_type: '门店', parent_location_id: 'market-A' }]
      }
      if (sql.includes('WHERE s.location_id = ANY')) {
        return [
          { location_id: 'store-A', location_type: '门店', parent_location_id: 'market-A' },
          { location_id: 'store-B', location_type: '门店', parent_location_id: 'market-A' },
        ]
      }
      return []
    })
    const client = mockTransactionClient([
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 1 },
      {
        rows: [{
          id: 10,
          location_id: 'store-A',
          sku_id: 'sku-1',
          sku_name: '测试商品',
          spec_name: null,
          supplier: null,
          product_series: null,
          batch_no: 'B001',
          expiry_date: null,
          is_gift: false,
          quantity_on_hand: '5',
        }],
      },
      { rows: [{ id: 101 }], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ])

    await inventoryRoutes.createDoc(ctx)

    const syncCalls = pg.query.mock.calls
      .map(([query]) => String(query))
      .filter((query) => query.includes('INSERT INTO inventory_locations'))
    const orgLocationSync = syncCalls.find((query) => (
      query.includes('SELECT id, type, name, id, parent_id, is_active')
    ))
    const storeLocationSync = syncCalls.find((query) => (
      query.includes('COALESCE(o.is_active, false) AND NOT s.is_closed')
    ))
    expect(orgLocationSync).toMatch(/parent_location_id, is_active/)
    expect(orgLocationSync).toMatch(/is_active = EXCLUDED\.is_active/)
    expect(storeLocationSync).toMatch(/parent_location_id, is_active/)
    expect(storeLocationSync).toMatch(/is_active = EXCLUDED\.is_active/)

    const insertDocCall = client.query.mock.calls.find(([sql]) => (
      /INSERT INTO inventory_docs/.test(sql)
    ))
    expect(insertDocCall[1][1]).toBe('分院调货出库')
    expect(insertDocCall[1][2]).toBe('待收货')
    expect(insertDocCall[1][3]).toBe('store-A')
    expect(insertDocCall[1][4]).toBe('store-B')
    expect(insertDocCall[1][20]).toBe('emp-001')
    expect(insertDocCall[1][21]).toBe(true)

    const movementCall = client.query.mock.calls.find(([sql]) => (
      /INSERT INTO inventory_movements/.test(sql)
    ))
    expect(movementCall[1][6]).toBe('出库')
    expect(movementCall[1][7]).toBe(-2)
  })

  test('门店报货按发起门店父级写入市场主体，供市场汇总和配货关联', async () => {
    const ctx = createCtx({
      payload: {
        docType: '门店报货',
        sourceLocationId: 'store-001',
        // 客户端即使带入错误接收主体，也必须以门店所属市场为准。
        targetLocationId: 'market-spoofed',
        items: [{ skuId: 'sku-1', quantity: 2 }],
      },
    })
    pg.query.mockImplementation(async (query, params) => {
      const sql = String(query)
      if (sql.includes('WITH RECURSIVE descendants')) return [{ store_id: 'store-001' }]
      if (sql.includes('FROM inventory_locations') && sql.includes('WHERE location_id = $1')) {
        if (params[0] === 'store-001') {
          return [{
            location_id: 'store-001', location_type: '门店', parent_location_id: 'market-A', is_active: true,
          }]
        }
        if (params[0] === 'market-A') {
          return [{
            location_id: 'market-A', location_type: '市场', parent_location_id: 'HQ', is_active: true,
          }]
        }
      }
      return []
    })
    const client = mockTransactionClient([
      { rows: [] },
      { rows: [] },
      { rows: [], rowCount: 1 },
      {
        rows: [{
          sku_id: 'sku-1', product_name: '测试商品', spec_name: null,
          supplier: null, product_series: null,
        }],
      },
      { rows: [{ id: 101 }], rowCount: 1 },
    ])

    await inventoryRoutes.createDoc(ctx)

    const insertDocCall = client.query.mock.calls.find(([sql]) => /INSERT INTO inventory_docs/.test(sql))
    expect(insertDocCall[1][1]).toBe('门店报货')
    expect(insertDocCall[1][3]).toBe('store-001')
    expect(insertDocCall[1][4]).toBe('market-A')
    expect(insertDocCall[1][22]).toBe('market-A')
  })

  test('待收货类型缺少接收主体时拒绝创建', async () => {
    const ctx = createCtx({
      payload: {
        docType: '分院调货出库',
        sourceLocationId: 'store-001',
        items: [{ lotId: 10, skuId: 'sku-1', quantity: 1 }],
      },
    })

    await expect(inventoryRoutes.createDoc(ctx)).rejects.toThrow(
      'INVALID_PARAMS: 调货出库缺少接收门店',
    )
  })

  test('产品报损必须填写原因', async () => {
    const ctx = createCtx({
      payload: {
        docType: '院产品报损',
        sourceLocationId: 'store-001',
        items: [{ lotId: 10, skuId: 'sku-1', quantity: 1 }],
      },
    })

    await expect(inventoryRoutes.createDoc(ctx)).rejects.toThrow(
      'INVALID_PARAMS: 报损明细必须填写原因',
    )
    expect(pg.transaction).not.toHaveBeenCalled()
  })

  test('员工端创建库存单拒绝价格和金额入参', async () => {
    const ctx = createCtx({
      payload: {
        docType: '门店报货',
        sourceLocationId: 'store-001',
        items: [{ skuId: 'sku-1', quantity: 1, actualUnitPrice: 99 }],
      },
    })

    await expect(inventoryRoutes.createDoc(ctx)).rejects.toThrow(
      'INVALID_PARAMS: staff 端不允许提交金额字段',
    )
    expect(pg.transaction).not.toHaveBeenCalled()
  })

  test('员工端创建库存单拒绝嵌套对象中的金额字段', async () => {
    const ctx = createCtx({
      payload: {
        docType: '门店报货',
        sourceLocationId: 'store-001',
        items: [{
          skuId: 'sku-1',
          quantity: 1,
          metadata: { source: { accountingCost: 99 } },
        }],
      },
    })

    await expect(inventoryRoutes.createDoc(ctx)).rejects.toThrow(
      'INVALID_PARAMS: staff 端不允许提交金额字段',
    )
    expect(pg.transaction).not.toHaveBeenCalled()
  })
})

describe('inventory 办理选项无金额响应', () => {
  test('reportableSkuOptions 仅返回可报货 SKU 和库存参考', async () => {
    const ctx = createCtx({ payload: { locationId: 'store-001', keyword: '凝胶' } })
    pg.query.mockImplementation(async (query) => {
      const sql = String(query)
      if (sql.includes('WITH RECURSIVE descendants')) return [{ store_id: 'store-001' }]
      if (sql.includes('SELECT location_id, location_type, parent_location_id')) {
        return [{ location_id: 'store-001', location_type: '门店', parent_location_id: 'market-A' }]
      }
      if (sql.includes('SELECT COUNT(*)::int AS cnt') && sql.includes('FROM inventory_skus sku')) {
        return [{ cnt: 1 }]
      }
      if (sql.includes('FROM inventory_skus sku')) {
        return [{
          sku_id: 'sku-1',
          product_code: 'P-001',
          product_name: '测试凝胶',
          spec_name: '100ml',
          supplier: '供应商A',
          product_series: '护理',
          stock_reference: '7',
          retail_price: '999.00',
          amount: '999.00',
        }]
      }
      return []
    })

    await inventoryRoutes.reportableSkuOptions(ctx)

    expect(ctx.result).toEqual({
      items: [{
        skuId: 'sku-1',
        productCode: 'P-001',
        skuName: '测试凝胶',
        specName: '100ml',
        supplier: '供应商A',
        productSeries: '护理',
        stockReference: 7,
      }],
      total: 1,
      page: 1,
      pageSize: 50,
    })
    expect(JSON.stringify(ctx.result)).not.toMatch(/price|amount|cost/i)
    const skuCall = pg.query.mock.calls.find(([sql]) => String(sql).includes('FROM inventory_skus sku'))
    expect(skuCall[0]).not.toMatch(/price|amount|cost/i)
    expect(skuCall[1]).toEqual(['store-001', 'market-A', '%凝胶%'])
  })

  test('storeOptions 只允许有发起门店写权限的员工查询同市场接收门店', async () => {
    const ctx = createCtx({ payload: { sourceLocationId: 'store-001' } })
    pg.query.mockImplementation(async (query) => {
      const sql = String(query)
      if (sql.includes('WITH RECURSIVE descendants')) return [{ store_id: 'store-001' }]
      if (sql.includes('SELECT location_id, location_type, parent_location_id')) {
        return [{ location_id: 'store-001', location_type: '门店', parent_location_id: 'market-A' }]
      }
      if (sql.includes('JOIN stores s ON s.store_id = loc.store_id')) {
        return [{ location_id: 'store-002', name: '同市场门店' }]
      }
      return []
    })

    await inventoryRoutes.storeOptions(ctx)

    expect(ctx.result).toEqual({
      items: [{ storeId: 'store-002', storeName: '同市场门店' }],
    })
    const storeCall = pg.query.mock.calls.find(([sql]) => String(sql).includes('JOIN stores s ON s.store_id = loc.store_id'))
    expect(storeCall[0]).toMatch(/loc\.parent_location_id = \$1/)
    expect(storeCall[1]).toEqual(['market-A', 'store-001'])
  })
})

describe('inventory.approveDoc / rejectDoc 审批一致性', () => {
  test('门店 scope 的 finance 不能审批退货/报损单', async () => {
    const ctx = createCtx({
      payload: { id: 'DOC-STORE-FINANCE' },
      auth: {
        roles: ['finance'],
        roleBindings: [{ role: 'finance', scopeId: 'node-store-001', scopeType: '门店' }],
      },
    })

    await expect(inventoryRoutes.approveDoc(ctx)).rejects.toThrow(
      'PERMISSION_DENIED: 仅市场财务或管理员可审批库存单据',
    )
    expect(pg.transaction).not.toHaveBeenCalled()
  })

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
          source_location_id: 'store-B',
          target_location_id: null,
        }],
      },
      { rows: [{ store_id: 'store-A' }] },
    ])

    await expect(inventoryRoutes.approveDoc(ctx)).rejects.toThrow(
      'PERMISSION_DENIED: 无权审批该门店库存单据',
    )
    expect(client.query.mock.calls.some(([sql]) => (
      /FROM inventory_doc_items/.test(sql)
    ))).toBe(false)
  })

  test('rejectDoc 在事务内锁定 v3 单据并限定待审批状态更新', async () => {
    const ctx = createCtx({
      payload: { id: 'DOC-002', auditRemark: '资料不完整' },
      auth: {
        roles: ['finance'],
        roleBindings: [{ role: 'finance', scopeId: 'node-hq', scopeType: '总部' }],
      },
    })
    const client = mockTransactionClient([
      { rows: [{ doc_type: '院退货', source_location_id: 'store-001', target_location_id: null, status: '待审批' }] },
      { rows: [{ store_id: 'store-001' }] },
      { rows: [], rowCount: 1 },
    ])

    await inventoryRoutes.rejectDoc(ctx)

    expect(client.query.mock.calls[0][0]).toMatch(/FROM inventory_docs/)
    expect(client.query.mock.calls[0][0]).toMatch(/FOR UPDATE/)
    expect(client.query.mock.calls[2][0]).toMatch(/UPDATE inventory_docs/)
    expect(client.query.mock.calls[2][0]).toMatch(/status = '待审批'/)
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
      { rows: [{ doc_type: '院退货', source_location_id: 'store-001', target_location_id: null, status: '已完成' }] },
      { rows: [{ store_id: 'store-001' }] },
    ])

    await expect(inventoryRoutes.rejectDoc(ctx)).rejects.toThrow(
      'INVALID_STATE: 只有待审批单据可以驳回',
    )
    expect(client.query.mock.calls).toHaveLength(2)
  })
})

describe('inventory.confirmReceive v3 收货', () => {
  test('收货生成入库单时保留原报货单关联', async () => {
    const ctx = createCtx({
      payload: { id: 'OUT-001', remark: '确认收货' },
      auth: {
        roles: ['manager'],
        roleBindings: [{ role: 'manager', scopeId: 'node-store-B', scopeType: '门店' }],
        scopeStoreIds: ['store-B'],
        effectiveStoreId: 'store-B',
      },
    })
    pg.query.mockImplementation(async (query) => {
      const text = String(query)
      if (text.includes('SELECT location_id, location_type, parent_location_id')) {
        return [{ location_id: 'store-B', location_type: '门店', parent_location_id: 'market-A' }]
      }
      return []
    })
    const client = mockTransactionClient([
      {
        rows: [{
          id: 'OUT-001',
          doc_type: '分院配货',
          status: '待收货',
          source_location_id: 'store-A',
          target_location_id: 'store-B',
          total_quantity: '2',
          request_doc_id: 'REQ-001',
          related_doc_id: null,
          remark: '原单备注',
        }],
      },
      { rows: [{ store_id: 'store-B' }] },
      { rows: [], rowCount: 1 },
      { rows: [] },
      { rows: [], rowCount: 1 },
      { rows: [] },
      { rows: [], rowCount: 1 },
    ])

    await inventoryRoutes.confirmReceive(ctx)

    const insertDocCall = client.query.mock.calls.find(([sql]) => (
      /INSERT INTO inventory_docs/.test(sql)
    ))
    expect(insertDocCall[1][1]).toBe('院入库')
    expect(insertDocCall[1][7]).toBe('REQ-001')
    expect(insertDocCall[1][8]).toBe('确认收货')
    expect(ctx.result.inboundDocId).toMatch(/^YRK-/)
  })
})

describe('inventory.docList / docDetail v3 契约', () => {
  test('docList 按 v3 单据类型数组筛选并返回主体字段', async () => {
    const ctx = createCtx({
      payload: { docTypes: ['门店报货'], page: 1, pageSize: 20 },
      auth: { scopeStoreIds: ['store-001'] },
    })
    pg.query.mockImplementation(async (query) => {
      const sql = String(query)
      if (sql.includes('SELECT COUNT(*)::int AS cnt FROM inventory_docs')) return [{ cnt: 1 }]
      if (sql.includes('FROM inventory_docs d')) {
        return [{
          id: 'DBH-260809-0001', doc_type: '门店报货', status: '草稿',
          source_location_id: 'store-001', source_location_name: '测试店', source_location_type: '门店',
          target_location_id: null, target_location_name: null, target_location_type: null,
          doc_date: '2026-08-09', total_quantity: '2', related_doc_id: null,
          request_doc_id: null, related_sale_order_id: null, customer_name: null,
          employee_name: null, supplier_name: null, logistics_company: null,
          tracking_no: null, remark: null, created_at: '2026-08-09T00:00:00Z', updated_at: '2026-08-09T00:00:00Z',
        }]
      }
      return []
    })

    await inventoryRoutes.docList(ctx)

    expect(ctx.result.items[0]).toMatchObject({
      docType: '门店报货',
      sourceLocationName: '测试店',
      targetLocationName: null,
    })
    expect(pg.query.mock.calls.some(([sql]) => /FROM inventory_docs d/.test(sql))).toBe(true)
  })

  test('docDetail 从 v3 单据和明细表读取详情', async () => {
    const ctx = createCtx({ payload: { id: 'DOC-004' } })
    pg.query.mockImplementation(async (query) => {
      const sql = String(query)
      if (sql.includes('FROM inventory_doc_items')) {
        return [{
          id: 7, doc_id: 'DOC-004', lot_id: 11, sku_id: 'sku-1', sale_item_id: null,
          sku_name: '测试商品', spec_name: '规格', supplier: null, product_series: null,
          batch_no: 'B001', expiry_date: null, is_gift: false, quantity: '2',
          stock_snapshot: '5', request_quantity: null, fulfilled_quantity: null,
          actual_unit_price: '99.00', amount: '198.00',
          reason: null, remark: null, created_at: '2026-08-09T00:00:00Z',
        }]
      }
      if (sql.includes('FROM inventory_docs d')) {
        return [{
          id: 'DOC-004', doc_type: '院顾客产品出库', status: '已完成',
          source_location_id: 'store-001', source_location_name: '测试店', source_location_type: '门店',
          target_location_id: null, target_location_name: null, target_location_type: null,
          doc_date: '2026-08-09', related_doc_id: null, request_doc_id: null,
          related_sale_order_id: 'FY-001', customer_name: '顾客A', employee_name: null,
          supplier_name: null, logistics_company: null, tracking_no: null, total_quantity: '2',
          remark: null, audit_remark: null, confirmed_at: null, approved_at: null,
          rejected_at: null, created_at: '2026-08-09T00:00:00Z', updated_at: '2026-08-09T00:00:00Z',
        }]
      }
      return []
    })

    await inventoryRoutes.docDetail(ctx)

    expect(ctx.result).toMatchObject({ docType: '院顾客产品出库', sourceLocationName: '测试店' })
    expect(ctx.result.items[0]).toMatchObject({ lotId: 11, skuId: 'sku-1', skuName: '测试商品' })
    expect(JSON.stringify(ctx.result)).not.toMatch(/actualUnitPrice|amount|price|cost/i)
  })
})
