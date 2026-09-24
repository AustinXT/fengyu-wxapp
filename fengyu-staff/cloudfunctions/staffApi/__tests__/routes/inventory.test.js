/**
 * 员工端库存 v3 路由回归测试。
 */

const pg = globalThis.__mocks__.pg
const { createCtx: createBaseCtx } = require('../helpers')
const inventoryRoutes = require('../../routes/inventory')

// 旧用例角色名改写为当前数据库角色定义下发的动作，测试重点仍是 action 与 scope 必须来自同一绑定。
function createCtx(input = {}) {
  const ctx = createBaseCtx(input)
  const roleBindings = (ctx.auth.roleBindings || []).map((binding) => ({
    ...binding,
    isSuperAdmin: binding.role === 'admin',
    actions: binding.role === 'manager'
      ? ['inventory:store_operate']
      : binding.role === 'finance' && ['总部', '市场'].includes(binding.scopeType)
        ? ['inventory:market_approve']
        : [],
  }))
  ctx.auth.roleBindings = roleBindings
  ctx.auth.inventoryStoreIds = ctx.auth.inventoryStoreIds ?? ctx.auth.scopeStoreIds ?? []
  return ctx
}

function cutoverQueryResult(sql, status = '已初始化') {
  if (!String(sql).includes('FROM inventory_cutover_states')) return null
  return status == null
    ? { rows: [], rowCount: 0 }
    : { rows: [{ status }], rowCount: 1 }
}

function mockTransactionClient(
  responses,
  { cutoverStatus = '已初始化', locationRow = null, locationRows = null } = {},
) {
  const client = {
    query: vi.fn(async (sql, params = []) => {
      const text = String(sql)
      // F5 修复后 sync UPSERT 与库存主体查询走事务连接（tx client）：
      // 这两类不消耗 responses 队列；主体行默认按入参回显门店行，可传 locationRow 覆盖。
      // sync 漂移探测（AS drifted）同样不消耗队列；无结果 → 保守执行 UPSERT 旧路径。
      if (text.includes('AS drifted')) return { rows: [], rowCount: 0 }
      if (text.includes('INSERT INTO inventory_locations')) return { rows: [], rowCount: 0 }
      if (text.includes('SELECT location_id, location_type, parent_location_id')) {
        // locationRows：#251 用于构造「一个入参命中多行」的撞值场景。
        // 默认分支恒返 1 行，事务内路径原本永远碰不到多行判定。
        if (locationRows) return { rows: locationRows(params[0]) }
        return { rows: [locationRow ?? {
          location_id: params[0], org_node_id: params[0], location_type: '门店',
          parent_location_id: 'market-A', is_active: true,
        }] }
      }
      return cutoverQueryResult(sql, cutoverStatus)
        || responses.shift()
        || { rows: [], rowCount: 0 }
    }),
  }
  pg.transaction.mockImplementationOnce(async (cb) => cb(client))
  return client
}

function mockCutoverTransaction(status) {
  const client = {
    query: vi.fn(async (sql) => cutoverQueryResult(sql, status)),
  }
  pg.transaction.mockImplementationOnce(async (cb) => cb(client))
  return client
}

function inventoryLotRow({ id, locationId, quantityOnHand }) {
  return {
    id,
    location_id: locationId,
    sku_id: 'sku-1',
    sku_name: '测试商品',
    spec_name: '100ml',
    supplier: '供应商A',
    product_series: '护理',
    batch_no: 'B001',
    expiry_date: null,
    is_gift: false,
    quantity_on_hand: String(quantityOnHand),
    supply_chain_unit_cost: '30.00',
    market_standard_unit_price: '50.00',
    market_unit_discount: '5.00',
    market_actual_unit_price: '45.00',
    store_standard_unit_price: '60.00',
    store_unit_discount: '10.00',
    store_actual_unit_price: '50.00',
  }
}

describe('inventory.createDoc 权限与状态', () => {
  test('manager@A + customer_mgr@B 不能用全角色 scope 在 B 创建库存单', async () => {
    const ctx = createCtx({
      payload: {
        docType: '分院调货出库',
        sourceOrgNodeId: 'store-B',
        targetOrgNodeId: 'store-A',
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
    pg.query.mockImplementation(async (query, params) => {
      const sql = String(query)
      if (sql.includes('WITH RECURSIVE descendants')) return [{ store_id: 'store-A' }]
      if (sql.includes('SELECT location_id, location_type, parent_location_id')) {
        return [{
          location_id: params[0], org_node_id: params[0], location_type: '门店',
          parent_location_id: 'market-A', is_active: true,
        }]
      }
      return []
    })

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
    pg.query.mockImplementation(async (query, params) => (
      String(query).includes('SELECT location_id, location_type, parent_location_id')
        ? [{
            location_id: params[0], org_node_id: params[0], location_type: '门店',
            parent_location_id: 'market-A', is_active: true,
          }]
        : []
    ))

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
        sourceOrgNodeId: 'node-store-A',
        targetOrgNodeId: 'node-store-B',
        items: [{ lotId: 10, skuId: 'sku-1', quantity: 2 }],
      },
      auth: {
        roles: ['admin'],
        roleBindings: [{ role: 'admin', scopeId: 'node-hq', scopeType: '总部' }],
        scopeStoreIds: ['store-A', 'store-B'],
        effectiveStoreId: null,
      },
    })
    pg.query.mockImplementation(async (query, params) => {
      const sql = String(query)
      if (sql.includes('SELECT store_id FROM stores')) {
        return [{ store_id: 'store-A' }, { store_id: 'store-B' }]
      }
      if (sql.includes('SELECT location_id, location_type, parent_location_id')) {
        const storeId = params[0] === 'node-store-A' ? 'store-A' : 'store-B'
        return [{
          location_id: storeId, org_node_id: params[0], location_type: '门店',
          parent_location_id: 'market-A', is_active: true,
        }]
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
    expect(insertDocCall[1][3]).toBe('node-store-A')
    expect(insertDocCall[1][4]).toBe('node-store-B')
    expect(insertDocCall[1][17]).toBe('emp-001')
    expect(insertDocCall[1][19]).toBe(true)

    const movementCall = client.query.mock.calls.find(([sql]) => (
      /INSERT INTO inventory_movements/.test(sql)
    ))
    expect(movementCall[1][6]).toBe('出库')
    expect(movementCall[1][7]).toBe(-2)
    expect(client.query.mock.calls[0][0]).toMatch(/FROM inventory_cutover_states/)
    expect(client.query.mock.calls[0][1]).toEqual(['workfine_inventory'])
  })

  test('已预留的退货库存不能再次用于分院调货出库', async () => {
    const ctx = createCtx({
      payload: {
        docType: '分院调货出库',
        sourceOrgNodeId: 'store-A',
        targetOrgNodeId: 'store-B',
        items: [{ lotId: 10, skuId: 'sku-1', quantity: 2 }],
      },
      auth: {
        roles: ['admin'],
        roleBindings: [{ role: 'admin', scopeId: 'node-hq', scopeType: '总部' }],
        scopeStoreIds: ['store-A', 'store-B'],
        effectiveStoreId: null,
      },
    })
    pg.query.mockImplementation(async (query, params) => {
      const sql = String(query)
      if (sql.includes('SELECT store_id FROM stores')) {
        return [{ store_id: 'store-A' }, { store_id: 'store-B' }]
      }
      if (sql.includes('SELECT location_id, location_type, parent_location_id')) {
        return [{
          location_id: params[0], org_node_id: params[0], location_type: '门店',
          parent_location_id: 'market-A', is_active: true,
        }]
      }
      if (sql.includes('WHERE s.location_id = ANY')) {
        return [
          { location_id: 'store-A', location_type: '门店', parent_location_id: 'market-A' },
          { location_id: 'store-B', location_type: '门店', parent_location_id: 'market-A' },
        ]
      }
      return []
    })
    let client
    pg.transaction.mockImplementationOnce(async (cb) => {
      client = {
        query: vi.fn(async (sql) => {
          const cutover = cutoverQueryResult(sql)
          if (cutover) return cutover
          if (String(sql).includes('FROM inventory_stock_lots')) {
            return {
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
            }
          }
          if (String(sql).includes('INSERT INTO inventory_doc_items')) {
            return { rows: [{ id: 101 }], rowCount: 1 }
          }
          if (String(sql).includes('FROM inventory_stock_reservations')) {
            return { rows: [{ quantity: '4' }], rowCount: 1 }
          }
          return { rows: [], rowCount: 1 }
        }),
      }
      return cb(client)
    })

    await expect(inventoryRoutes.createDoc(ctx)).rejects.toThrow(
      'INVALID_STATE: 库存不足：测试商品 可用 1',
    )
    const reservationCall = client.query.mock.calls.find(([sql]) => (
      String(sql).includes('FROM inventory_stock_reservations')
    ))
    expect(reservationCall[0]).toMatch(/quantity - fulfilled_quantity - released_quantity/)
    expect(reservationCall[1]).toEqual([10])
    expect(client.query.mock.calls.some(([sql]) => (
      /UPDATE inventory_stock_lots/.test(sql)
    ))).toBe(false)
  })

  test('院退货固定回库所属市场并预留来源批次', async () => {
    const ctx = createCtx({
      payload: {
        docType: '院退货',
        sourceOrgNodeId: 'store-A',
        targetOrgNodeId: 'market-spoofed',
        status: '已完成',
        items: [{ lotId: 10, skuId: 'sku-1', quantity: 2 }],
      },
      auth: {
        storeId: 'store-A',
        effectiveStoreId: 'store-A',
        scopeStoreIds: ['store-A'],
        roleBindings: [{ role: 'manager', scopeId: 'node-store-A', scopeType: '门店' }],
      },
    })
    pg.query.mockImplementation(async (query, params) => {
      const sql = String(query)
      if (sql.includes('WITH RECURSIVE descendants')) return [{ store_id: 'store-A' }]
      if (sql.includes('FROM inventory_locations') && sql.includes('WHERE location_id = $1')) {
        if (params[0] === 'store-A') {
          return [{
            location_id: 'store-A', location_type: '门店', parent_location_id: 'market-A', is_active: true,
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
    let client
    pg.transaction.mockImplementationOnce(async (cb) => {
      client = {
        query: vi.fn(async (sql) => {
          const text = String(sql)
          const cutover = cutoverQueryResult(text)
          if (cutover) return cutover
          if (text.includes('FROM inventory_stock_lots')) {
            return { rows: [inventoryLotRow({ id: 10, locationId: 'store-A', quantityOnHand: 5 })] }
          }
          if (text.includes('INSERT INTO inventory_doc_items')) {
            return { rows: [{ id: 101 }], rowCount: 1 }
          }
          if (text.includes('SELECT COALESCE(SUM') && text.includes('inventory_stock_reservations')) {
            return { rows: [{ quantity: '1' }], rowCount: 1 }
          }
          return { rows: [], rowCount: 1 }
        }),
      }
      return cb(client)
    })

    await inventoryRoutes.createDoc(ctx)

    const insertDocCall = client.query.mock.calls.find(([sql]) => /INSERT INTO inventory_docs/.test(sql))
    expect(insertDocCall[1][1]).toBe('院退货')
    expect(insertDocCall[1][2]).toBe('待审批')
    expect(insertDocCall[1][3]).toBe('store-A')
    expect(insertDocCall[1][4]).toBe('market-A')
    expect(insertDocCall[1][20]).toBe('market-A')
    const reservationCall = client.query.mock.calls.find(([sql]) => (
      /INSERT INTO inventory_stock_reservations/.test(sql)
    ))
    expect(reservationCall[1]).toEqual([
      ctx.result.id,
      101,
      10,
      'store-A',
      'sku-1',
      2,
      'emp-001',
    ])
    expect(client.query.mock.calls.some(([sql]) => /UPDATE inventory_stock_lots/.test(sql))).toBe(false)
    expect(client.query.mock.calls.some(([sql]) => /INSERT INTO inventory_movements/.test(sql))).toBe(false)
  })

  test('院顾客退货不能把其他市场的自采 SKU 入库', async () => {
    const ctx = createCtx({
      payload: {
        docType: '院顾客退货',
        targetOrgNodeId: 'store-B',
        items: [{ skuId: 'self-sku-A', quantity: 1 }],
      },
      auth: {
        roles: ['admin'],
        roleBindings: [{ role: 'admin', scopeId: 'node-hq', scopeType: '总部' }],
        scopeStoreIds: ['store-B'],
        effectiveStoreId: 'store-B',
      },
    })
    pg.query.mockImplementation(async (query) => {
      const sql = String(query)
      if (sql.includes('SELECT store_id FROM stores')) return [{ store_id: 'store-B' }]
      if (sql.includes('SELECT location_id, location_type, parent_location_id')) {
        return [{ location_id: 'store-B', location_type: '门店', parent_location_id: 'market-B', is_active: true }]
      }
      return []
    })
    let client
    pg.transaction.mockImplementationOnce(async (cb) => {
      client = {
        query: vi.fn(async (sql) => {
          const text = String(sql)
          const cutover = cutoverQueryResult(text)
          if (cutover) return cutover
          if (text.includes('FROM inventory_skus')) {
            return {
              rows: [{
                sku_id: 'self-sku-A',
                product_name: '跨市场自采商品',
                spec_name: null,
                supplier: null,
                product_series: null,
                source_type: '市场自采',
                owner_market_id: 'market-A',
              }],
            }
          }
          if (text.includes('FROM inventory_locations')) {
            return {
              rows: [{
                location_id: 'store-B',
                location_type: '门店',
                parent_location_id: 'market-B',
              }],
            }
          }
          return { rows: [], rowCount: 1 }
        }),
      }
      return cb(client)
    })

    await expect(inventoryRoutes.createDoc(ctx)).rejects.toThrow(
      'INVALID_STATE: 市场自采 SKU 跨市场自采商品 仅可在归属市场使用',
    )
    const skuQuery = client.query.mock.calls.find(([sql]) => String(sql).includes('FROM inventory_skus'))
    expect(skuQuery[0]).toMatch(/source_type, owner_market_id/)
    expect(client.query.mock.calls.some(([sql]) => (
      /INSERT INTO inventory_stock_lots/.test(sql)
    ))).toBe(false)
  })

  test('门店报货按发起门店父级写入市场主体，供市场汇总和配货关联', async () => {
    const ctx = createCtx({
      payload: {
        docType: '门店报货',
        sourceOrgNodeId: 'store-001',
        // 客户端即使带入错误接收主体，也必须以门店所属市场为准。
        targetOrgNodeId: 'market-spoofed',
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
    expect(insertDocCall[1][20]).toBe('market-A')
  })

  test('待收货类型缺少接收主体时拒绝创建', async () => {
    const ctx = createCtx({
      payload: {
        docType: '分院调货出库',
        sourceOrgNodeId: 'store-001',
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
        sourceOrgNodeId: 'store-001',
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
        sourceOrgNodeId: 'store-001',
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
        sourceOrgNodeId: 'store-001',
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

  // ── 盘点账面数量（issue #131）──────────────────────────────────────────
  // staff 端的 STAFF_CREATE_DOC_TYPES 含「分院库存盘点」，原实现的 stock_snapshot 参数
  // 写死 `lot ? lot.quantityOnHand : null` —— 盘点无批次选择器 ⇒ 恒 NULL，
  // 与 admin 端分叉（同一种单据，admin 建的有账面数、staff 建的没有）。

  /** 建一张 staff 侧分院盘点单，返回事务 client 以便断言发出的 SQL。 */
  function mockStoreStocktake({ bookRows, items }) {
    const ctx = createCtx({
      payload: {
        docType: '分院库存盘点',
        sourceOrgNodeId: 'store-A',
        items,
      },
      auth: {
        storeId: 'store-A',
        effectiveStoreId: 'store-A',
        scopeStoreIds: ['store-A'],
        roleBindings: [{ role: 'manager', scopeId: 'node-store-A', scopeType: '门店' }],
      },
    })
    pg.query.mockImplementation(async (query, params) => {
      const sql = String(query)
      if (sql.includes('WITH RECURSIVE descendants')) return [{ store_id: 'store-A' }]
      if (sql.includes('FROM inventory_locations') && sql.includes('WHERE location_id = $1')) {
        return [{
          location_id: params[0], location_type: '门店', parent_location_id: 'market-A', is_active: true,
        }]
      }
      return []
    })
    let client
    pg.transaction.mockImplementationOnce(async (cb) => {
      client = {
        query: vi.fn(async (sql, params = []) => {
          const text = String(sql)
          const cutover = cutoverQueryResult(text)
          if (cutover) return cutover
          if (text.includes('COALESCE(SUM(quantity_on_hand), 0)')) {
            return { rows: bookRows, rowCount: bookRows.length, _params: params }
          }
          if (text.includes('FROM inventory_skus')) {
            return {
              rows: [{
                sku_id: params[0], product_name: '测试商品',
                spec_name: null, supplier: null, product_series: null,
              }],
              rowCount: 1,
            }
          }
          if (text.includes('INSERT INTO inventory_doc_items')) {
            return { rows: [{ id: 101 }], rowCount: 1 }
          }
          return { rows: [], rowCount: 1 }
        }),
      }
      return cb(client)
    })
    return { ctx, getClient: () => client }
  }

  test('分院库存盘点把主体 + SKU 的在手量写进 stock_snapshot（与 admin 同口径）', async () => {
    const { ctx, getClient } = mockStoreStocktake({
      bookRows: [{ sku_id: 'sku-1', quantity: '12' }],
      items: [{ skuId: 'sku-1', quantity: 9 }],
    })

    await inventoryRoutes.createDoc(ctx)

    const client = getClient()
    const bookCall = client.query.mock.calls.find(([sql]) => (
      String(sql).includes('COALESCE(SUM(quantity_on_hand), 0)')
    ))
    expect(bookCall, '没有发出账面数查询').toBeTruthy()
    // ── 账面数查询的**口径快照**（与 admin 侧 engine.test.ts 同款）───────────────
    // 只断片段（含 GROUP BY / 不含 reserv）挡不住「多加一个过滤条件」：
    // 比如补一句 `AND (expiry_date IS NULL OR expiry_date >= CURRENT_DATE)`，
    // 账面数就会漏掉已过期但仍在手的批次、比实际偏小，而那些片段断言全都照样绿。
    // 口径是甲方拍板的（#131 Q0 在手量不扣预留 / Q1 按主体 + SKU 汇总**全部批次**），
    // 改这条 SQL 就该是有意的 —— 改了来更新快照，顺便重新想一遍口径。
    expect(String(bookCall[0]).replace(/\s+/g, ' ').trim()).toBe(
      'SELECT sku_id, COALESCE(SUM(quantity_on_hand), 0) AS quantity'
      + ' FROM inventory_stock_lots'
      + ' WHERE location_id = $1 AND sku_id = ANY($2::text[])'
      + ' GROUP BY sku_id',
    )
    expect(bookCall[1]).toEqual(['store-A', ['sku-1']])

    const itemCall = client.query.mock.calls.find(([sql]) => (
      String(sql).includes('INSERT INTO inventory_doc_items')
    ))
    // 位置下标对应 INSERT 列表：doc_id(0) lot_id(1) sku_id(2) sale_item_id(3) sku_name(4)
    // spec_name(5) supplier(6) product_series(7) batch_no(8) expiry_date(9) is_gift(10)
    // **quantity(11) stock_snapshot(12)** …（加删列会让这里误红，不会假绿）
    expect(itemCall[1][1]).toBeNull()       // lot_id：盘点无批次
    expect(itemCall[1][11]).toBe(9)         // quantity：实盘
    expect(itemCall[1][12]).toBe(12)        // stock_snapshot：账面
  })

  test('该 SKU 一个批次都没有时账面数落 0，不是 NULL', async () => {
    // GROUP BY 查不到就不出行。落 NULL 的话前端会显示「—」（当成历史单没记账面），
    // 而不是「账上 0、实盘 5 = 盘盈 5」。
    const { ctx, getClient } = mockStoreStocktake({
      bookRows: [],
      items: [{ skuId: 'sku-1', quantity: 5 }],
    })

    await inventoryRoutes.createDoc(ctx)

    const itemCall = getClient().query.mock.calls.find(([sql]) => (
      String(sql).includes('INSERT INTO inventory_doc_items')
    ))
    expect(itemCall[1][12]).toBe(0)
  })

  test('盘点单不产生库存流水，也不直接改在手量', async () => {
    const { ctx, getClient } = mockStoreStocktake({
      bookRows: [{ sku_id: 'sku-1', quantity: '12' }],
      items: [{ skuId: 'sku-1', quantity: 9 }],
    })

    await inventoryRoutes.createDoc(ctx)

    // 验收标准是「不产生任何 inventory_movements **且**不改变 quantity_on_hand」，
    // 改在手量有两条路：写流水让触发器联动、或直接 UPDATE 批次表。后者当前代码里没有，
    // 但「盘点自动校准」这类需求最可能就从那里来，且它不写流水 —— 只断第一条看不见。
    //
    // ⚠️ 按表名 + 归一大小写/引号来判，别退回 `includes('INSERT INTO inventory_movements')`：
    //    `insert into …`（小写）、`INSERT INTO "inventory_movements"`（带引号）都匹配不上。
    // ⚠️ 事务连接与**全局** pg.query 都要扫：绕过事务直接 `pg.query(UPDATE ...)`
    //    照样真改库存，只看 client.query 完全看不见。
    const sqls = [
      ...getClient().query.mock.calls.map(([sql]) => String(sql)),
      ...pg.query.mock.calls.map(([sql]) => String(sql)),
    ]
    // `\\w+\\.` 放行 schema 限定名（`INSERT INTO public.inventory_movements`），
    // 不放行的话这一整类写法静默漏检。
    const writesTable = (text, table) => new RegExp(
      `(insert\\s+into|update(\\s+only)?|delete\\s+from|merge\\s+into)\\s+(\\w+\\.)?${table}\\b`,
    ).test(
      text.toLowerCase()
        .replace(/\/\*[\s\S]*?\*\//g, ' ')   // 块注释：`UPDATE /* x */ tbl` 是合法 SQL
        .replace(/--[^\n]*/g, ' ')
        .replace(/["`]/g, ''),
    )
    for (const table of ['inventory_movements', 'inventory_stock_lots']) {
      expect(sqls.some((s) => writesTable(s, table)), `盘点写了 ${table}`).toBe(false)
    }
    // 账面数**不扣预留**（#131 Q0）：整个建单过程连预留表都不该碰。
    // 只断主查询里没有 reserv 不够 —— 另发一条查预留的 SELECT 再在 JS 里减掉，主查询一字不变。
    expect(
      sqls.some((s) => /inventory_stock_reservations/i.test(s)),
      '盘点期间查了预留表 —— 账面数不该扣预留',
    ).toBe(false)
  })

  test('多行盘点只发一次账面数查询（不逐行查）', async () => {
    // 逐行往返会拉长事务持有时间，且各行账面数取自不同语句快照。
    //（注意 staff 的 cutover 锁是 FOR KEY SHARE、不串行；admin 那边才是 FOR UPDATE。）
    const { ctx, getClient } = mockStoreStocktake({
      bookRows: [{ sku_id: 'sku-1', quantity: '12' }, { sku_id: 'sku-2', quantity: '4' }],
      items: [{ skuId: 'sku-1', quantity: 9 }, { skuId: 'sku-2', quantity: 4 }],
    })

    await inventoryRoutes.createDoc(ctx)

    const client = getClient()
    const bookCalls = client.query.mock.calls.filter(([sql]) => (
      String(sql).includes('COALESCE(SUM(quantity_on_hand), 0)')
    ))
    expect(bookCalls).toHaveLength(1)
    expect(bookCalls[0][1][1]).toEqual(['sku-1', 'sku-2'])
    const itemCalls = client.query.mock.calls.filter(([sql]) => (
      String(sql).includes('INSERT INTO inventory_doc_items')
    ))
    expect(itemCalls.map(([, params]) => params[12])).toEqual([12, 4])
  })

  test('同一 SKU 在一张盘点单里只能出现一次，且拦在开事务前', async () => {
    const { ctx } = mockStoreStocktake({
      bookRows: [{ sku_id: 'sku-1', quantity: '12' }],
      items: [{ skuId: 'sku-1', quantity: 9 }, { skuId: 'sku-1', quantity: 3 }],
    })

    await expect(inventoryRoutes.createDoc(ctx)).rejects.toThrow(
      'INVALID_PARAMS: 同一 SKU 请合并为一条盘点明细',
    )
    expect(pg.transaction).not.toHaveBeenCalled()
  })
})

describe('inventory WorkFine 切流门禁', () => {
  function mockCreateDocPrerequisites() {
    pg.query.mockImplementation(async (query, params) => {
      const sql = String(query)
      if (sql.includes('WITH RECURSIVE descendants')) return [{ store_id: 'store-001' }]
      if (sql.includes('FROM inventory_locations') && sql.includes('WHERE location_id = $1')) {
        if (params[0] === 'store-001') {
          return [{
            location_id: 'store-001', location_type: '门店', parent_location_id: 'market-A', is_active: true,
          }]
        }
        return [{
          location_id: 'market-A', location_type: '市场', parent_location_id: 'HQ', is_active: true,
        }]
      }
      return []
    })
  }

  test.each([
    ['缺少状态记录', null],
    ['待初始化', '待初始化'],
    ['待核验', '待核验'],
  ])('createDoc 在%s时拒绝且不写库存', async (_label, status) => {
    mockCreateDocPrerequisites()
    const client = mockCutoverTransaction(status)
    const ctx = createCtx({
      payload: {
        docType: '门店报货',
        sourceOrgNodeId: 'store-001',
        items: [{ skuId: 'sku-1', quantity: 1 }],
      },
    })

    await expect(inventoryRoutes.createDoc(ctx)).rejects.toThrow(
      'INVALID_STATE: WorkFine 库存期初尚未完成核验',
    )
    expect(client.query.mock.calls).toHaveLength(1)
    expect(client.query.mock.calls[0][0]).toMatch(/FROM inventory_cutover_states/)
    expect(client.query.mock.calls.some(([sql]) => /INSERT INTO inventory_docs/.test(sql))).toBe(false)
    expect(client.query.mock.calls.some(([sql]) => /inventory_stock_lots|inventory_movements/.test(sql))).toBe(false)
  })

  test.each([
    ['approveDoc', () => inventoryRoutes.approveDoc(createCtx({
      payload: { id: 'DOC-APPROVE' },
      auth: {
        roles: ['finance'],
        roleBindings: [{ role: 'finance', scopeId: 'market-A', scopeType: '市场' }],
      },
    }))],
    ['rejectDoc', () => inventoryRoutes.rejectDoc(createCtx({
      payload: { id: 'DOC-REJECT' },
      auth: {
        roles: ['finance'],
        roleBindings: [{ role: 'finance', scopeId: 'market-A', scopeType: '市场' }],
      },
    }))],
    ['confirmReceive', () => inventoryRoutes.confirmReceive(createCtx({
      payload: { id: 'DOC-RECEIVE' },
    }))],
  ])('%s 在待核验时拒绝且不继续办理', async (_name, invoke) => {
    const client = mockCutoverTransaction('待核验')

    await expect(invoke()).rejects.toThrow(
      'INVALID_STATE: WorkFine 库存期初尚未完成核验',
    )
    expect(client.query.mock.calls).toHaveLength(1)
    expect(client.query.mock.calls[0][0]).toMatch(/FROM inventory_cutover_states/)
    expect(client.query.mock.calls.some(([sql]) => /inventory_docs|inventory_stock_lots|inventory_movements/.test(sql))).toBe(false)
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

  test('reportableSkuOptions 主查询与 count 同口径：启用 + 可报货 + 无归属或归属门店所属市场（#339）', async () => {
    // admin 门店报货代建候选与这里同口径（#339 Q1=A），staff 端改候选口径必须回来同步
    const ctx = createCtx({ payload: { locationId: 'store-001', keyword: '凝胶', page: 2, pageSize: 20 } })
    pg.query.mockImplementation(async (query) => {
      const sql = String(query)
      if (sql.includes('WITH RECURSIVE descendants')) return [{ store_id: 'store-001' }]
      if (sql.includes('SELECT location_id, location_type, parent_location_id')) {
        return [{ location_id: 'store-001', location_type: '门店', parent_location_id: 'market-A' }]
      }
      if (sql.includes('SELECT COUNT(*)::int AS cnt')) return [{ cnt: 21 }]
      return []
    })

    await inventoryRoutes.reportableSkuOptions(ctx)

    const listCall = pg.query.mock.calls.find(([sql]) => String(sql).includes('FROM inventory_skus sku') && String(sql).includes('LIMIT'))
    const countCall = pg.query.mock.calls.find(([sql]) => String(sql).includes('SELECT COUNT(*)::int AS cnt') && String(sql).includes('FROM inventory_skus sku'))
    for (const [sql] of [listCall, countCall]) {
      expect(sql).toMatch(/sku\.is_active = true/)
      expect(sql).toMatch(/sku\.is_reportable = true/)
      expect(sql).toMatch(/\(sku\.owner_market_id IS NULL OR sku\.owner_market_id = \$\d\)/)
      expect(sql).toMatch(/sku\.product_name ILIKE/)
    }
    expect(listCall[1]).toEqual(['store-001', 'market-A', '%凝胶%'])
    expect(countCall[1]).toEqual(['market-A', '%凝胶%'])
    // 分页：第 2 页、每页 20
    expect(listCall[0]).toMatch(/LIMIT 20 OFFSET 20/)
    expect(ctx.result).toMatchObject({ total: 21, page: 2, pageSize: 20 })
  })

  test('storeOptions 只允许有发起门店写权限的员工查询同市场接收门店', async () => {
    const ctx = createCtx({ payload: { sourceStoreId: 'store-001' } })
    pg.query.mockImplementation(async (query) => {
      const sql = String(query)
      if (sql.includes('WITH RECURSIVE descendants')) return [{ store_id: 'store-001' }]
      if (sql.includes('SELECT location_id, location_type, parent_location_id')) {
        return [{ location_id: 'store-001', location_type: '门店', parent_location_id: 'market-A' }]
      }
      if (sql.includes('JOIN stores s ON s.store_id = loc.store_id')) {
        return [{ location_id: 'store-002', org_node_id: 'node-store-002', name: '同市场门店' }]
      }
      return []
    })

    await inventoryRoutes.storeOptions(ctx)

    expect(ctx.result).toEqual({
      items: [{ storeId: 'store-002', orgNodeId: 'node-store-002', storeName: '同市场门店' }],
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
          source_org_node_id: 'store-B',
          target_org_node_id: null,
        }],
      },
      { rows: [{ store_id: 'store-A' }] },
    ])
    pg.query.mockImplementation(async (query, params) => (
      String(query).includes('SELECT location_id, location_type, parent_location_id')
        ? [{
            location_id: params[0], org_node_id: params[0], location_type: '门店',
            parent_location_id: 'market-B', is_active: true,
          }]
        : []
    ))

    await expect(inventoryRoutes.approveDoc(ctx)).rejects.toThrow(
      'PERMISSION_DENIED: 无权审批该门店库存单据',
    )
    expect(client.query.mock.calls.some(([sql]) => (
      /FROM inventory_doc_items/.test(sql)
    ))).toBe(false)
  })

  test('院退货审批生成市场退货入库并完成库存预留', async () => {
    const ctx = createCtx({
      payload: { id: 'YTH-001', auditRemark: '同意回库' },
      auth: {
        roles: ['finance'],
        roleBindings: [{ role: 'finance', scopeId: 'market-A', scopeType: '市场' }],
        scopeStoreIds: ['store-A'],
        effectiveStoreId: null,
      },
    })
    pg.query.mockImplementation(async (query, params) => {
      const sql = String(query)
      if (sql.includes('WITH RECURSIVE descendants')) return [{ store_id: 'store-A' }]
      if (sql.includes('SELECT location_id, location_type, parent_location_id')) {
        const isMarket = params[0] === 'market-A'
        return [{
          location_id: params[0], org_node_id: params[0],
          location_type: isMarket ? '市场' : '门店',
          parent_location_id: isMarket ? 'HQ' : 'market-A', is_active: true,
        }]
      }
      return []
    })
    let client
    pg.transaction.mockImplementationOnce(async (cb) => {
      client = {
        query: vi.fn(async (sql, params) => {
          const text = String(sql)
          const cutover = cutoverQueryResult(text)
          if (cutover) return cutover
          // F5 修复后主体查询走事务连接，与上方 pg mock 同款回显。
          if (text.includes('SELECT location_id, location_type, parent_location_id')) {
            const isMarket = params[0] === 'market-A'
            return { rows: [{
              location_id: params[0], org_node_id: params[0],
              location_type: isMarket ? '市场' : '门店',
              parent_location_id: isMarket ? 'HQ' : 'market-A', is_active: true,
            }] }
          }
          if (text.includes('SELECT DISTINCT s.store_id') && text.includes('WITH RECURSIVE descendants')) {
            return { rows: [{ store_id: 'store-A' }] }
          }
          if (text.includes('FROM inventory_docs') && text.includes('FOR UPDATE')) {
            return {
              rows: [{
                id: 'YTH-001',
                doc_type: '院退货',
                status: '待审批',
                source_org_node_id: 'store-A',
                target_org_node_id: 'market-A',
                market_id: 'market-A',
                total_quantity: '2',
              }],
            }
          }
          if (text.includes('FROM inventory_locations source')) {
            return { rows: [{ market_id: 'market-A' }] }
          }
          if (text.includes('FROM inventory_doc_items') && text.includes('FOR UPDATE')) {
            return {
              rows: [{
                id: 101,
                lot_id: 10,
                sku_id: 'sku-1',
                sale_item_id: null,
                sku_name: '测试商品',
                spec_name: '100ml',
                supplier: '供应商A',
                product_series: '护理',
                batch_no: 'B001',
                expiry_date: null,
                is_gift: false,
                quantity: '2',
                standard_unit_price: '60.00',
                unit_discount: '10.00',
                actual_unit_price: '50.00',
                amount: '100.00',
                supply_chain_unit_cost: '30.00',
                market_standard_unit_price: '50.00',
                market_unit_discount: '5.00',
                market_actual_unit_price: '45.00',
                store_standard_unit_price: '60.00',
                store_unit_discount: '10.00',
                store_actual_unit_price: '50.00',
                reason: '退货',
                remark: '批次异常',
              }],
            }
          }
          if (text.includes('FROM inventory_stock_lots')) {
            return {
              rows: [params[1] === 'store-A'
                ? inventoryLotRow({ id: 10, locationId: 'store-A', quantityOnHand: 5 })
                : inventoryLotRow({ id: 20, locationId: 'market-A', quantityOnHand: 3 })],
            }
          }
          if (text.includes('FROM inventory_stock_reservations') && text.includes('request_doc_id')) {
            return {
              rows: [{ id: 77, quantity: '2', fulfilled_quantity: '0', released_quantity: '0' }],
            }
          }
          if (text.includes('FROM inventory_stock_reservations')) {
            return { rows: [{ quantity: '0' }] }
          }
          if (text.includes('FROM inventory_skus')) {
            return {
              rows: [{
                sku_id: 'sku-1',
                product_name: '测试商品',
                spec_name: '100ml',
                supplier: '供应商A',
                product_series: '护理',
                source_type: '供应链',
                owner_market_id: null,
                supply_chain_purchase_price: '30.00',
                market_purchase_price: '50.00',
                store_purchase_price: '60.00',
              }],
            }
          }
          if (text.includes('INSERT INTO inventory_stock_lots')) {
            return { rows: [{ id: 20 }], rowCount: 1 }
          }
          if (text.includes('INSERT INTO inventory_doc_items')) {
            return { rows: [{ id: 201 }], rowCount: 1 }
          }
          return { rows: [], rowCount: 1 }
        }),
      }
      return cb(client)
    })

    await inventoryRoutes.approveDoc(ctx)

    const inboundDocCall = client.query.mock.calls.find(([sql]) => (
      /INSERT INTO inventory_docs/.test(sql)
    ))
    expect(inboundDocCall[0]).toMatch(/'市场退货入库'/)
    expect(inboundDocCall[1][1]).toBe('store-A')
    expect(inboundDocCall[1][2]).toBe('market-A')
    expect(inboundDocCall[1][5]).toBe('同意回库')
    const reservationUpdate = client.query.mock.calls.find(([sql]) => (
      /UPDATE inventory_stock_reservations/.test(sql) && /fulfilled_quantity/.test(sql)
    ))
    expect(reservationUpdate[1]).toEqual([77, 2])
    expect(client.query.mock.calls.some(([sql]) => /UPDATE inventory_stock_lots/.test(sql))).toBe(false)
    const movements = client.query.mock.calls.filter(([sql]) => /INSERT INTO inventory_movements/.test(sql))
    expect(movements).toHaveLength(2)
    expect(movements[0][1].slice(4, 8)).toEqual(['YTH-001', 101, '出库', -2])
    expect(movements[1][1].slice(4, 8)).toEqual([inboundDocCall[1][0], 201, '入库', 2])
    const linkCall = client.query.mock.calls.find(([sql]) => /INSERT INTO inventory_doc_links/.test(sql))
    expect(linkCall[0]).toMatch(/'退货回库'/)
    expect(linkCall[1]).toEqual(['YTH-001', inboundDocCall[1][0], 101, 201, 2])
    const sourceItemUpdate = client.query.mock.calls.find(([sql]) => (
      /UPDATE inventory_doc_items/.test(sql) && /fulfilled_quantity/.test(sql)
    ))
    expect(sourceItemUpdate[1]).toEqual([101, 2])
    const returnDocUpdate = client.query.mock.calls.find(([sql]) => (
      /UPDATE inventory_docs/.test(sql) && /status = '已完成'/.test(sql)
    ))
    expect(returnDocUpdate[1]).toEqual(['YTH-001', 2, 'emp-001', '同意回库'])
    expect(ctx.result).toEqual({ message: '审批通过' })
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
      { rows: [{ doc_type: '院退货', source_org_node_id: 'store-001', target_org_node_id: null, status: '待审批' }] },
      { rows: [{ store_id: 'store-001' }] },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ])
    pg.query.mockImplementation(async (query, params) => (
      String(query).includes('SELECT location_id, location_type, parent_location_id')
        ? [{
            location_id: params[0], org_node_id: params[0], location_type: '门店',
            parent_location_id: 'market-A', is_active: true,
          }]
        : []
    ))

    await inventoryRoutes.rejectDoc(ctx)

    const lockDocCall = client.query.mock.calls.find(([sql]) => /FROM inventory_docs/.test(sql))
    const releaseReservationCall = client.query.mock.calls.find(([sql]) => (
      /UPDATE inventory_stock_reservations/.test(sql)
    ))
    const rejectDocCall = client.query.mock.calls.find(([sql]) => (
      /UPDATE inventory_docs/.test(sql)
    ))
    expect(client.query.mock.calls[0][0]).toMatch(/FROM inventory_cutover_states/)
    expect(lockDocCall[0]).toMatch(/FOR UPDATE/)
    expect(releaseReservationCall[0]).toMatch(/released_quantity = quantity/)
    expect(rejectDocCall[0]).toMatch(/status = '待审批'/)
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
      { rows: [{ doc_type: '院退货', source_org_node_id: 'store-001', target_org_node_id: null, status: '已完成' }] },
      { rows: [{ store_id: 'store-001' }] },
    ])
    pg.query.mockImplementation(async (query, params) => (
      String(query).includes('SELECT location_id, location_type, parent_location_id')
        ? [{
            location_id: params[0], org_node_id: params[0], location_type: '门店',
            parent_location_id: 'market-A', is_active: true,
          }]
        : []
    ))

    await expect(inventoryRoutes.rejectDoc(ctx)).rejects.toThrow(
      'INVALID_STATE: 只有待审批单据可以驳回',
    )
    // cutover 检查 + 锁单据 + F5 后走事务连接的 sync 漂移探测与 sync×2 + 主体查询 + scope 校验，
    // 状态不符即抛出，不产生驳回 UPDATE。
    expect(client.query.mock.calls).toHaveLength(7)
    expect(client.query.mock.calls.some(([sql]) => (
      /UPDATE inventory_docs/.test(sql) && /已驳回/.test(sql)
    ))).toBe(false)
  })
})

/**
 * #235：审批/驳回的鉴权主体必须按单据方向推导，不能用 `source || target` 取代表值。
 *
 * 旧写法 `const acting = source_org_node_id || target_org_node_id` 与 #200 修复前的
 * `createInventoryCoreDoc` 是同一个反模式。它今天不可利用靠的是两个巧合
 * （可达类型只有 {院退货, 院产品报损}，source 恒非空；ensureStoreLocation 强制门店类型），
 * 一旦往 STAFF_VISIBLE_DOC_TYPES / APPROVAL_DOC_TYPES 里加入 source 可空的类型就会
 * **无声**退化成按 target 鉴权。
 *
 * 这条不变量唯一能被测试区分新旧的路径就是「source 为空」：
 * 旧代码会拿 target 去 assertApproverStoreScope（审批人对 target 有权 → 放行 → 越权），
 * 新代码显式抛 INVALID_STATE。下面两条用例刻意把 target 设成审批人**有权**的主体，
 * 使旧代码必然放行 —— 回退修复后它们必红。
 */
/** 读 routes/inventory.js 源码（缓存） */
let __invSrc = null
function readInventorySource() {
  if (__invSrc === null) {
    __invSrc = require('node:fs').readFileSync(
      require('node:path').resolve(__dirname, '../../routes/inventory.js'), 'utf8',
    )
  }
  return __invSrc
}

/**
 * 取某个顶层函数的源码，**注释已剥离**。
 *
 * 剥注释是必须的：本文件的 #235 注释里原样引用了旧的代表值写法用于说明，
 * 不剥的话守护会把注释当活代码而恒红（写完第一版就被自己抓到过）。
 * 按函数切片而不是全文件匹配：inventory.js 两千多行，全文件搜到的命中可能落在别的函数里。
 */
function functionSource(fnName) {
  const src = readInventorySource()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
  const start = src.search(new RegExp(`(async )?function ${fnName}\\(`))
  if (start < 0) return null
  // 从函数起点做花括号配平，取到函数体结束
  let depth = 0
  let i = src.indexOf('{', start)
  const from = i
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(from, i + 1) }
  }
  return null
}

describe('inventory.approveDoc / rejectDoc 鉴权主体（#235）', () => {
  /** 审批人对 market-A 有权；单据 source 为空、target 指向他有权的 store-A */
  function approverCtx(id) {
    return createCtx({
      payload: { id, auditRemark: '越权探测' },
      auth: {
        roles: ['finance'],
        roleBindings: [{ role: 'finance', scopeId: 'market-A', scopeType: '市场' }],
        scopeStoreIds: ['store-A'],
        effectiveStoreId: null,
      },
    })
  }

  function mockScopeExpansion() {
    pg.query.mockImplementation(async (query, params) => {
      const sql = String(query)
      if (sql.includes('WITH RECURSIVE descendants')) return [{ store_id: 'store-A' }]
      if (sql.includes('SELECT location_id, location_type, parent_location_id')) {
        return [{
          location_id: params[0], org_node_id: params[0], location_type: '门店',
          parent_location_id: 'market-A', is_active: true,
        }]
      }
      return []
    })
  }

  test('approveDoc：待审批单缺出库主体 → 抛 INVALID_STATE，不退化成按 target 鉴权', async () => {
    const ctx = approverCtx('DOC-NO-SOURCE')
    mockScopeExpansion()
    const client = mockTransactionClient([
      {
        rows: [{
          id: 'DOC-NO-SOURCE',
          doc_type: '院退货',
          status: '待审批',
          source_org_node_id: null,
          // 审批人对 store-A 有权：旧代码 `source || target` 会取到它并放行
          target_org_node_id: 'store-A',
        }],
      },
    ])

    await expect(inventoryRoutes.approveDoc(ctx)).rejects.toThrow(
      'INVALID_STATE: 待审批单据缺少出库主体',
    )
    // 零副作用：既没读明细、也没改单据状态
    expect(client.query.mock.calls.some(([sql]) => /FROM inventory_doc_items/.test(sql))).toBe(false)
    expect(client.query.mock.calls.some(([sql]) => /UPDATE inventory_docs/.test(sql))).toBe(false)
  })

  test('rejectDoc：待审批单缺出库主体 → 抛 INVALID_STATE，不退化成按 target 鉴权', async () => {
    const ctx = approverCtx('DOC-NO-SOURCE-R')
    mockScopeExpansion()
    const client = mockTransactionClient([
      {
        rows: [{
          doc_type: '院退货',
          status: '待审批',
          source_org_node_id: null,
          target_org_node_id: 'store-A',
        }],
      },
    ])

    await expect(inventoryRoutes.rejectDoc(ctx)).rejects.toThrow(
      'INVALID_STATE: 待审批单据缺少出库主体',
    )
    expect(client.query.mock.calls.some(([sql]) => /UPDATE inventory_docs/.test(sql))).toBe(false)
  })

  /**
   * reviewer 构造的越权 mutant：鉴权打 target、扣库存仍打 source。
   * 它能通过「source 为空」那两条用例（在鉴权前就抛），所以必须单独钉住
   * 「鉴权用的就是被扣库存的那一侧」。
   *
   * 构造：source = 审批人**无权**的 store-B，target = 他**有权**的 store-A，两端都非空。
   * 正确实现按 source 鉴权 → PERMISSION_DENIED；mutant 按 target 鉴权 → 放行。
   */
  test('approveDoc：两端非空且 source 无权 → 必须按 source 拒绝（不得改用 target 鉴权）', async () => {
    const ctx = createCtx({
      payload: { id: 'DOC-BOTH-ENDS', auditRemark: '越权探测' },
      auth: {
        roles: ['finance'],
        roleBindings: [{ role: 'finance', scopeId: 'market-A', scopeType: '市场' }],
        scopeStoreIds: ['store-A'],
        effectiveStoreId: null,
      },
    })
    pg.query.mockImplementation(async (query, params) => {
      const sql = String(query)
      // 审批人的 scope 只覆盖 store-A
      if (sql.includes('WITH RECURSIVE descendants')) return [{ store_id: 'store-A' }]
      if (sql.includes('SELECT location_id, location_type, parent_location_id')) {
        return [{
          location_id: params[0], org_node_id: params[0], location_type: '门店',
          parent_location_id: 'market-A', is_active: true,
        }]
      }
      return []
    })
    const client = mockTransactionClient([
      {
        rows: [{
          id: 'DOC-BOTH-ENDS',
          doc_type: '院退货',
          status: '待审批',
          source_org_node_id: 'store-B',
          target_org_node_id: 'store-A',
        }],
      },
      { rows: [{ store_id: 'store-A' }] },
    ])

    await expect(inventoryRoutes.approveDoc(ctx)).rejects.toThrow(
      'PERMISSION_DENIED: 无权审批该门店库存单据',
    )
    expect(client.query.mock.calls.some(([sql]) => /FROM inventory_doc_items/.test(sql))).toBe(false)
    expect(client.query.mock.calls.some(([sql]) => /UPDATE inventory_docs/.test(sql))).toBe(false)
  })

  /** rejectDoc 是独立实现，同一条不变量必须各自钉住（codex 谱系指出只保护了 approveDoc） */
  test('rejectDoc：两端非空且 source 无权 → 必须按 source 拒绝（不得改用 target 鉴权）', async () => {
    const ctx = createCtx({
      payload: { id: 'DOC-BOTH-ENDS-R', auditRemark: '越权探测' },
      auth: {
        roles: ['finance'],
        roleBindings: [{ role: 'finance', scopeId: 'market-A', scopeType: '市场' }],
        scopeStoreIds: ['store-A'],
        effectiveStoreId: null,
      },
    })
    pg.query.mockImplementation(async (query, params) => {
      const sql = String(query)
      if (sql.includes('WITH RECURSIVE descendants')) return [{ store_id: 'store-A' }]
      if (sql.includes('SELECT location_id, location_type, parent_location_id')) {
        return [{
          location_id: params[0], org_node_id: params[0], location_type: '门店',
          parent_location_id: 'market-A', is_active: true,
        }]
      }
      return []
    })
    const client = mockTransactionClient([
      {
        rows: [{
          doc_type: '院退货',
          status: '待审批',
          source_org_node_id: 'store-B',
          target_org_node_id: 'store-A',
        }],
      },
      { rows: [{ store_id: 'store-A' }] },
    ])

    await expect(inventoryRoutes.rejectDoc(ctx)).rejects.toThrow(
      'PERMISSION_DENIED: 无权审批该门店库存单据',
    )
    expect(client.query.mock.calls.some(([sql]) => /UPDATE inventory_docs/.test(sql))).toBe(false)
  })

  /**
   * source 为空这一位在鉴权之前可见，是权衡后保留的（见 routes/inventory.js 里的注释）。
   * 这里钉住它**不产生任何副作用** —— 即便 target 也在审批人权限之外。
   */
  test('approveDoc：source 为空且 target 也无权 → 仍零副作用', async () => {
    const ctx = createCtx({
      payload: { id: 'DOC-NO-SRC-NO-PERM' },
      auth: {
        roles: ['finance'],
        roleBindings: [{ role: 'finance', scopeId: 'market-A', scopeType: '市场' }],
        scopeStoreIds: ['store-A'],
        effectiveStoreId: null,
      },
    })
    pg.query.mockImplementation(async (query, params) => {
      const sql = String(query)
      if (sql.includes('WITH RECURSIVE descendants')) return [{ store_id: 'store-A' }]
      if (sql.includes('SELECT location_id, location_type, parent_location_id')) {
        return [{
          location_id: params[0], org_node_id: params[0], location_type: '门店',
          parent_location_id: 'market-Z', is_active: true,
        }]
      }
      return []
    })
    const client = mockTransactionClient([
      {
        rows: [{
          id: 'DOC-NO-SRC-NO-PERM',
          doc_type: '院退货',
          status: '待审批',
          source_org_node_id: null,
          target_org_node_id: 'store-OUTSIDE',
        }],
      },
    ])

    await expect(inventoryRoutes.approveDoc(ctx)).rejects.toThrow(
      'INVALID_STATE: 待审批单据缺少出库主体',
    )
    expect(client.query.mock.calls.some(([sql]) => /FROM inventory_doc_items/.test(sql))).toBe(false)
    expect(client.query.mock.calls.some(([sql]) => /UPDATE inventory_docs/.test(sql))).toBe(false)
  })

  /**
   * **语义**不变量（不是文本形状）：可审批的类型必须全部是出库方向。
   *
   * 第一版守卫写成 `APPROVAL_DOC_TYPES.has(t) ? '出库' : null` 再断言「不是出库就抛」——
   * 那是恒真守卫（方向由被守卫的集合自己算出来），往 APPROVAL 加一个入库类型时会静默放行，
   * 正是它声称要挡的场景。改用 OUTBOUND 这个独立分类器后，这条断言才有意义：
   * 往 APPROVAL_DOC_TYPES 加入库类型 → 立刻红，提醒改的人回来补主体推导。
   */
  test('APPROVAL_DOC_TYPES ⊆ OUTBOUND_DOC_TYPES（审批恒为出库方向）', () => {
    const src = readInventorySource()
    const setItems = (name) => {
      const block = src.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`))
      expect(block, `未找到 ${name}`).toBeTruthy()
      return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    }
    const approval = setItems('APPROVAL_DOC_TYPES')
    const outbound = new Set(setItems('OUTBOUND_DOC_TYPES'))
    expect(approval.length).toBeGreaterThan(0)
    expect(approval.filter((t) => !outbound.has(t))).toEqual([])
  })

  /**
   * 钉住**审批可达面**：能走到 approveDoc / rejectDoc 的类型 = STAFF_VISIBLE ∩ APPROVAL。
   *
   * 「只有院退货和院产品报损能走到审批」在代码里只是个流程事实（由 SQL 的
   * `doc_type = ANY(STAFF_VISIBLE_DOC_TYPE_LIST)` + 守卫共同决定），不是显式不变量 ——
   * 往 STAFF_VISIBLE_DOC_TYPES 加一个类型的 PR 会**无声**改变审批可达面（GLM 谱系指出）。
   * 这条让那种 PR 必须回来看一眼：新类型是否也该能被 staff 审批、鉴权主体推导是否仍成立。
   */
  test('STAFF_VISIBLE ∩ APPROVAL 恰为 {院退货, 院产品报损}', () => {
    const src = readInventorySource()
    const setItems = (name) => {
      const block = src.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`))
      expect(block, `未找到 ${name}`).toBeTruthy()
      return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    }
    const visible = new Set(setItems('STAFF_VISIBLE_DOC_TYPES'))
    const approval = setItems('APPROVAL_DOC_TYPES')
    expect(approval.filter((t) => visible.has(t)).sort()).toEqual(['院产品报损', '院退货'])

    /**
     * 这里**不再**加一条 `(STAFF_VISIBLE ∩ APPROVAL) ⊆ OUTBOUND`。
     * 一度按 GLM 的建议加过，但 codex 指出它被上面那条全局的 `APPROVAL ⊆ OUTBOUND`
     * **严格蕴含** —— 不存在只被它抓住的 mutant，纯属重复。
     * 这条等集断言的作用是「改了会醒」的摩擦力（钉住泄漏分析与守卫可达性论证的适用域），
     * 机器验证那一半由全局子集断言承担，两者分工明确。
     */
    // 且 LIST 必须是 Set 的派生，不能是手工维护的第二份（会静默漂移）
    expect(src).toMatch(/const STAFF_VISIBLE_DOC_TYPE_LIST = Array\.from\(STAFF_VISIBLE_DOC_TYPES\)/)
  })

  /**
   * 守卫必须用**独立分类器**判方向。钉住它引用 OUTBOUND_DOC_TYPES ——
   * 只要有人把它改回「从 APPROVAL_DOC_TYPES 自身派生方向」，这条就红。
   */
  /**
   * **行为性**证明守卫真的 fail-closed，而不只是「源码里出现了 OUTBOUND_DOC_TYPES」。
   *
   * codex 谱系指出：只断言「引用了 OUTBOUND + 有 throw」时，下面这种退化实现仍会全绿——
   *   `function f(t) { OUTBOUND_DOC_TYPES.has(t); if (!APPROVAL.has(t)) throw ... }`
   * 所以这里把函数源码抽出来，注入**构造的**集合后真的执行它：
   * 造一个「属于 APPROVAL 但不属于 OUTBOUND」的类型（正是将来放开入库审批时的形态），
   * 断言它必定抛错。恒真守卫在这个注入下会静默放行 → 红。
   */
  test('方向守卫在「属于 APPROVAL 但不属于 OUTBOUND」时必定抛错（注入集合实测）', () => {
    const fnSrc = functionSource('assertApprovalOutboundDirection')
    expect(fnSrc, '缺少 assertApprovalOutboundDirection 守卫').toBeTruthy()
    const makeGuard = new Function(
      'APPROVAL_DOC_TYPES', 'OUTBOUND_DOC_TYPES',
      `function assertApprovalOutboundDirection(docType) ${fnSrc}
       return assertApprovalOutboundDirection`,
    )

    // 入库方向的审批类型：属 APPROVAL、不属 OUTBOUND —— 必须 fail-closed
    const guard = makeGuard(new Set(['某入库审批类型']), new Set(['某出库类型']))
    // ⚠️ 必须锚定**一级前缀**：只匹配子串 'APPROVAL_…' 的话，把实现改成
    // `PERMISSION_DENIED: APPROVAL_…`（甚至去掉一级前缀）测试照样绿，
    // 而 API 的 code / errorType 已经变了（一级前缀走 9 项白名单，子标签只供日志归类）。
    expect(() => guard('某入库审批类型'))
      .toThrow(/^INVALID_STATE: APPROVAL_DIRECTION_UNSUPPORTED: /)
    // 完全不属 APPROVAL 的类型走另一条错误
    expect(() => guard('无关类型')).toThrow(/^INVALID_STATE: APPROVAL_NOT_REQUIRED: /)
    // 同属两者 → 放行
    const ok = makeGuard(new Set(['出库审批类型']), new Set(['出库审批类型']))
    expect(() => ok('出库审批类型')).not.toThrow()
  })

  /**
   * 代表值取法的字面量守护（防复发）。
   *
   * 覆盖两种命名（snake_case 的 DB 列名 / camelCase 的 location 变量）、两个方向
   * （source||target 与 target||source）、`||` 与 `??`。
   * ⚠️ 中间变量（`const s = head.source_…; s || head.target_…`）抓不到 ——
   * 这是词法守护的固有上限，真要防对抗只能上 AST；此处威胁模型是「后来者无意中复制」。
   */
  test('三处鉴权主体推导都不含「两主体二选一」的代表值取法', () => {
    const PAIR_RE = /\b(?:source|target)(?:_org_node_id|OrgNodeId|Location)[^\n]{0,60}(?:\|\||\?\?)[^\n]{0,60}\b(?:target|source)(?:_org_node_id|OrgNodeId|Location)/

    // approveDoc / rejectDoc 全函数体内都不该出现
    for (const fn of ['approveDoc', 'rejectDoc']) {
      const body = functionSource(fn)
      expect(body, `未找到函数 ${fn}`).toBeTruthy()
      expect(body, `${fn} 里出现了「第一个非空主体」式的代表值取法`).not.toMatch(PAIR_RE)
    }

    /**
     * `resolveStaffCreateLocations` 只查**鉴权主体推导那一段**（acting 计算 → scope 校验）。
     * 它末尾另有一处 `const orgNodeId = sourceOrgNodeId || targetOrgNodeId` —— 那是
     * 同主体单据（院产品报损 / 分院库存盘点）把两端**归一**，与 admin 侧 insertDocHeader
     * 里 #236 处理的是同一件事，不做任何安全决策，不能一并禁掉。
     */
    const createBody = functionSource('resolveStaffCreateLocations')
    expect(createBody, '未找到 resolveStaffCreateLocations').toBeTruthy()
    const actingAt = createBody.indexOf('const actingLocationId')
    const scopeAt = createBody.indexOf('assertInventoryWriteStoreScope(')
    expect(actingAt, '未找到 actingLocationId 推导').toBeGreaterThan(-1)
    expect(scopeAt, '未找到建单 scope 校验').toBeGreaterThan(actingAt)
    const authSegment = createBody.slice(actingAt, scopeAt + 80)
    expect(authSegment, '建单鉴权主体仍是「第一个非空主体」式的代表值取法').not.toMatch(PAIR_RE)
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
          source_org_node_id: 'store-A',
          target_org_node_id: 'store-B',
          total_quantity: '2',
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
    expect(insertDocCall[0]).not.toMatch(/related_doc_id|request_doc_id/)
    expect(insertDocCall[1][8]).toBe('确认收货')
    expect(insertDocCall[1][9]).toBe('emp-001')
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
          source_org_node_id: 'store-001', source_location_name: '测试店', source_location_type: '门店',
          target_org_node_id: null, target_location_name: null, target_location_type: null,
          doc_date: '2026-08-09', total_quantity: '2', related_sale_order_id: null, customer_name: null,
          employee_name: null, supplier_name: null, logistics_company: null,
          tracking_no: null, remark: null, created_at: '2026-08-09T00:00:00Z', updated_at: '2026-08-09T00:00:00Z',
        }]
      }
      return []
    })

    await inventoryRoutes.docList(ctx)

    expect(ctx.result.items[0]).toMatchObject({
      docType: '门店报货',
      sourceOrgNodeName: '测试店',
      targetOrgNodeName: null,
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
          source_org_node_id: 'store-001', source_location_name: '测试店', source_location_type: '门店',
          target_org_node_id: null, target_location_name: null, target_location_type: null,
          doc_date: '2026-08-09', related_sale_order_id: 'FY-001', customer_name: '顾客A', employee_name: null,
          supplier_name: null, logistics_company: null, tracking_no: null, total_quantity: '2',
          remark: null, audit_remark: null, confirmed_at: null, approved_at: null,
          rejected_at: null, created_at: '2026-08-09T00:00:00Z', updated_at: '2026-08-09T00:00:00Z',
        }]
      }
      return []
    })

    await inventoryRoutes.docDetail(ctx)

    expect(ctx.result).toMatchObject({ docType: '院顾客产品出库', sourceOrgNodeName: '测试店' })
    expect(ctx.result.items[0]).toMatchObject({ lotId: 11, skuId: 'sku-1', skuName: '测试商品' })
    expect(JSON.stringify(ctx.result)).not.toMatch(/actualUnitPrice|amount|price|cost/i)
  })
})

describe('inventory 库存主体同步短路（migration 0009 触发器兜底）', () => {
  test('漂移探测返回无漂移时跳过全表 UPSERT', async () => {
    const ctx = createCtx({ payload: { page: 1, pageSize: 20 } })
    pg.query.mockImplementation(async (query) => {
      const sql = String(query)
      if (sql.includes('AS drifted')) return [{ drifted: false }]
      if (sql.includes('COUNT(*)::int AS cnt')) return [{ cnt: 0 }]
      return []
    })

    await inventoryRoutes.stockList(ctx)

    const probeCall = pg.query.mock.calls.find(([sql]) => String(sql).includes('AS drifted'))
    expect(String(probeCall[0])).toContain('loc.location_id IS NULL')
    expect(String(probeCall[0])).toContain('loc.is_active IS DISTINCT FROM (COALESCE(o.is_active, false) AND NOT s.is_closed)')
    expect(pg.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO inventory_locations'))).toBe(false)
  })

  test('探测到漂移时照常执行两条全表 UPSERT 自愈', async () => {
    const ctx = createCtx({ payload: { page: 1, pageSize: 20 } })
    pg.query.mockImplementation(async (query) => {
      const sql = String(query)
      if (sql.includes('AS drifted')) return [{ drifted: true }]
      if (sql.includes('COUNT(*)::int AS cnt')) return [{ cnt: 0 }]
      return []
    })

    await inventoryRoutes.stockList(ctx)

    const upserts = pg.query.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.includes('INSERT INTO inventory_locations'))
    expect(upserts).toHaveLength(2)
  })
})

/**
 * #251：`ensureInventoryLocation` 的主体解析必须确定。
 *
 * 查询是 `WHERE location_id = $1 OR org_node_id = $1`（有意的双 id 多态：调用方既可能
 * 传 org_node_id，也可能经 fallback 链传 store_id）。两侧各自唯一，但**可以落在不同的两行**：
 * 门店行是 `location_id = store_id` / `org_node_id = org-门店-*`（只有总部/市场行自指），
 * 于是某个 store_id 恰好等于某个门店 org_nodes.id 时，两侧指向两个**不同门店**的库存主体。
 * 原先无 ORDER BY 的 `LIMIT 1` 取哪行不保证稳定，两次独立调用可能拿到不同门店 —— 即
 * 「按 A 鉴权、扣 B 的批次」。
 *
 * ⚠️ 与 issue #251 正文的归因不同：这与 `stores.org_node_id` 是否 unique 无关
 *（该列早有 `stores_org_node_id_unique`，且 `inventory_locations.org_node_id` 也有
 * `uq_inventory_locations_org`），「一个 org_node 挂两个 store」在库层面写不进去。
 */
describe('inventory 库存主体解析确定性（#251）', () => {
  /**
   * 撞值形态：某门店的 store_id 恰好等于另一个门店 org_nodes.id。
   * 两行都是**门店**行（总部/市场行自指 `location_id = org_node_id`，
   * 与行 Y 同值会违反 `uq_inventory_locations_org`，不可能共存）。
   */
  const collisionRows = (input, { yActive = true } = {}) => [
    // 行 Y：另一个门店（store-B）的 org_node_id 恰好等于入参
    {
      location_id: 'store-B',
      org_node_id: input,
      location_type: '门店',
      parent_location_id: 'market-A',
      is_active: yActive,
    },
    // 行 X：某门店的 store_id 就是入参本身
    {
      location_id: input,
      org_node_id: 'node-store-A',
      location_type: '门店',
      parent_location_id: 'market-A',
      is_active: true,
    },
  ]

  function storeCtx(auth = {}) {
    return createCtx({
      payload: {
        docType: '门店报货',
        storeId: 'store-001',
        items: [{ skuId: 'sku-1', quantity: 1 }],
      },
      auth: {
        roles: ['manager'],
        roleBindings: [{ role: 'manager', scopeId: 'node-store-001', scopeType: '门店' }],
        scopeStoreIds: ['store-001'],
        effectiveStoreId: 'store-001',
        ...auth,
      },
    })
  }

  function mockLocationQuery(rowsFor) {
    pg.query.mockImplementation(async (query, params) => (
      String(query).includes('SELECT location_id, location_type, parent_location_id')
        ? rowsFor(params[0])
        : []
    ))
  }

  test('两侧命中不同的两行时抛 CONFLICT，不静默选一行', async () => {
    const ctx = storeCtx()
    mockLocationQuery((input) => collisionRows(input))

    await expect(inventoryRoutes.createDoc(ctx)).rejects.toThrow(
      'CONFLICT: LOCATION_ID_AMBIGUOUS: 库存主体标识冲突',
    )
    // 必须拦在事务之前：撞值时一个批次都不能动
    expect(pg.transaction).not.toHaveBeenCalled()
  })

  test('事务内路径（approveDoc）撞值同样抛 CONFLICT，且不改单据状态', async () => {
    // 事务分支走的是 `client.query(...).then(res => res.rows)`，与池分支返回形状不同，
    // 必须单独钉住——helper 原本把主体查询硬编码成恒返 1 行，这条路径过去碰不到多行判定。
    const ctx = createCtx({
      payload: { id: 'DOC-COLLIDE', auditRemark: '撞值探测' },
      auth: {
        roles: ['finance'],
        roleBindings: [{ role: 'finance', scopeId: 'market-A', scopeType: '市场' }],
        scopeStoreIds: ['store-A'],
        effectiveStoreId: null,
      },
    })
    pg.query.mockImplementation(async (query) => (
      String(query).includes('WITH RECURSIVE descendants') ? [{ store_id: 'store-A' }] : []
    ))
    const client = mockTransactionClient(
      [{
        rows: [{
          id: 'DOC-COLLIDE',
          doc_type: '院退货',
          status: '待审批',
          source_org_node_id: 'store-A',
          target_org_node_id: null,
        }],
      }],
      { locationRows: (input) => collisionRows(input) },
    )

    await expect(inventoryRoutes.approveDoc(ctx)).rejects.toThrow(
      'CONFLICT: LOCATION_ID_AMBIGUOUS: 库存主体标识冲突',
    )
    // 事务中途抛错，单据状态与明细都不得被动过
    expect(client.query.mock.calls.some(([sql]) => /UPDATE inventory_docs/.test(sql))).toBe(false)
    expect(client.query.mock.calls.some(([sql]) => /FROM inventory_doc_items/.test(sql))).toBe(false)
  })

  test('撞值行中有一行已停用**仍**算歧义（停用不能消除 id 空间的不确定性）', async () => {
    // 曾想把闭店幽灵行过滤掉（`syncInventoryLocations` 只 UPSERT 从不 DELETE，闭店只置
    // is_active=false），理由是「免得它把撞值的在营门店锁死」。那是错的：
    // 设入参 X 既是在营门店 A 的 location_id(=store_id)、又是停用门店 Y 的 org_node_id，
    // 调用方传 head.source_org_node_id = X 时意图明确是 Y（单据里存的就是 org_node_id），
    // 过滤掉 Y 会静默返回 A，随后按 A 鉴权、生成 A 的单据 —— 正是本 issue 的危害本体。
    const ctx = storeCtx()
    mockLocationQuery((input) => collisionRows(input, { yActive: false }))

    await expect(inventoryRoutes.createDoc(ctx)).rejects.toThrow(
      'CONFLICT: LOCATION_ID_AMBIGUOUS: 库存主体标识冲突',
    )
    expect(pg.transaction).not.toHaveBeenCalled()
  })

  test('唯一命中项已停用仍抛 INVALID_STATE（原语义不被撞值守卫吃掉）', async () => {
    const ctx = storeCtx()
    mockLocationQuery((input) => [{
      location_id: input,
      org_node_id: 'node-store-001',
      location_type: '门店',
      parent_location_id: 'market-A',
      is_active: false,
    }])

    await expect(inventoryRoutes.createDoc(ctx)).rejects.toThrow(
      'INVALID_STATE: 库存主体已停用',
    )
  })

  test('【已知缺陷·锁当前行为】org_node_id 为空时会把 store_id 当组织节点兜底', async () => {
    // 这条**不是**在断言正确行为，而是把现状钉住，避免它在别的改动里悄悄漂移。
    //
    // `row.org_node_id || locationId` 把入参（store_id）当组织节点 id 返回，而该值会被
    // 写进 inventory_docs 的端点列 —— 那两列对 inventory_locations.org_node_id 有 FK。
    // 正解是 fail-loud，但现网为空的主体行实测 0 且改动会牵动 13 个既有用例的 mock，
    // 已在 routes/inventory.js 的注释里记录，留作独立 issue。
    const ctx = storeCtx({ roles: ['customer_mgr'], roleBindings: [
      { role: 'customer_mgr', scopeId: 'node-store-001', scopeType: '门店' },
    ] })
    mockLocationQuery((input) => [{
      location_id: input,
      org_node_id: null,
      location_type: '门店',
      parent_location_id: 'market-A',
      is_active: true,
    }])

    // 没有因 org_node_id 为空而抛错，照常走到权限判定
    await expect(inventoryRoutes.createDoc(ctx)).rejects.toThrow(
      'PERMISSION_DENIED: 无库存写入权限',
    )
  })

  test('主体查询带确定性排序与 LIMIT 2（防回退成无序 LIMIT 1）', async () => {
    const ctx = storeCtx({ roles: ['customer_mgr'], roleBindings: [
      { role: 'customer_mgr', scopeId: 'node-store-001', scopeType: '门店' },
    ] })
    mockLocationQuery((input) => [{
      location_id: input,
      org_node_id: 'node-store-001',
      location_type: '门店',
      parent_location_id: 'market-A',
      is_active: true,
    }])

    await expect(inventoryRoutes.createDoc(ctx)).rejects.toThrow('PERMISSION_DENIED')

    const call = pg.query.mock.calls.find(([sql]) => (
      String(sql).includes('SELECT location_id, location_type, parent_location_id')
    ))
    const sql = String(call[0]).replace(/\s+/g, ' ')
    // 按主键排序：只保证「同一入参两次调用必得同一行」，**不**声称语义正确
    //（撞值时不存在正确的那一行——一半调用点传 org_node_id、另一半传 store_id，
    // 固定任何优先级都会对另一半确定性地取错主体）。正确性由上面的 CONFLICT 保障。
    expect(sql).toContain('ORDER BY location_id')
    // 两侧各最多 1 行，2 是精确上界；回到 LIMIT 1 就永远看不见撞值
    expect(sql).toContain('LIMIT 2')
    expect(sql).not.toMatch(/LIMIT 1\b/)
  })
})
