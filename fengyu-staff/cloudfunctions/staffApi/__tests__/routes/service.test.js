/**
 * 服务单路由测试
 * 核心约束：
 *   - complete 原子扣减 + 幂等
 *   - 取消不扣次数
 *   - 状态单向推进
 *   - 剩余次数归零关闭关联预约
 *   - 美容师只能操作分配给自己的服务单
 */



const pg = globalThis.__mocks__.pg
const { createManagerCtx, createBeauticianCtx, createManagementCtx } = require('../helpers')
const serviceRoutes = require('../../routes/service')

describe('service.create', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pg.query.mockImplementation(async (sql, params) => {
      if (sql.includes('WHERE u.employee_id = ANY($1::text[])')) {
        return (params?.[0] || []).map(employee_id => ({ employee_id }))
      }
      return []
    })
  })

  test('店长为美容师创建服务单', async () => {
    const ctx = createManagerCtx({
      assignedStaffWfId: 'emp-beautician-001',
      items: [{ saleItemId: 'item-001', sessionUsed: 1 }],
    })

    // 验证订单行
    pg.query
      .mockResolvedValueOnce([{
        sale_item_id: 'item-001',
        remaining_sessions: 10,
        unit_real_price: '100',
        product_type: '疗程卡',
        order_status: '已支付',
        store_id: 'store-001',
        client_user_id: 'client-001',
        client_phone: '138',
      }])
      // 顾客无进行中的服务单
      .mockResolvedValueOnce([])

    // 单一 transaction：generateServiceOrderId（advisory lock + SELECT 最大 ID）+ INSERT 服务单 + 服务明细
    pg.transaction.mockImplementationOnce(async (cb) => {
      const client = {
        query: vi.fn(async (sql) => {
          if (typeof sql === 'string' && sql.includes('pg_advisory_xact_lock')) {
            return { rows: [], rowCount: 0 }
          }
          if (typeof sql === 'string' && sql.includes('FROM service_orders') && sql.includes('LIKE $1')) {
            return { rows: [], rowCount: 0 }  // 无已有服务单 → seq=1
          }
          return { rows: [{ unit_real_price: '100' }], rowCount: 1 }
        }),
      }
      return await cb(client)
    })

    await serviceRoutes.create(ctx)

    expect(ctx.result.serviceOrderId).toMatch(/^HLD-WX-\d{6}\d{4}$/)
    expect(ctx.result.status).toBe('待服务')
    expect(pg.transaction).toHaveBeenCalled()
  })

  test('创建服务单时持久化自定义备注并写入备注审计摘要', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'client-001',
      assignedStaffWfId: 'emp-beautician-001',
      remark: '顾客要求手法轻柔',
      items: [{ saleItemId: 'item-001', sessionUsed: 1 }],
    })

    pg.query
      .mockResolvedValueOnce([{
        sale_item_id: 'item-001',
        session_count: 10,
        remaining_sessions: 10,
        paid_sessions: 10,
        unit_real_price: '100',
        product_type: '疗程卡',
        order_status: '已支付',
        store_id: 'store-001',
        client_user_id: 'client-001',
        client_phone: '138',
        has_pending_refund: false,
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ became_member_at: null, bound_store_id: 'store-001' }])

    let txClient
    pg.transaction.mockImplementationOnce(async (cb) => {
      txClient = {
        query: vi.fn(async (sql) => {
          if (typeof sql === 'string' && sql.includes('pg_advisory_xact_lock')) {
            return { rows: [], rowCount: 0 }
          }
          if (typeof sql === 'string' && /FROM service_orders[\s\S]*LIKE \$1/.test(sql)) {
            return { rows: [], rowCount: 0 }
          }
          if (typeof sql === 'string' && sql.includes('SELECT si.unit_real_price')) {
            return { rows: [{ unit_real_price: '100', is_shengmei: false, sales_category: '自销自耗' }], rowCount: 1 }
          }
          if (typeof sql === 'string' && sql.includes('SELECT EXISTS')) {
            return { rows: [{ has_deposit: false }], rowCount: 1 }
          }
          return { rows: [], rowCount: 1 }
        }),
      }
      return await cb(txClient)
    })

    await serviceRoutes.create(ctx)

    const insertServiceOrderCall = txClient.query.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO service_orders'))
    expect(insertServiceOrderCall).toBeDefined()
    expect(insertServiceOrderCall[1][6]).toBe('顾客要求手法轻柔')

    const opLogCall = txClient.query.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO operation_logs'))
    expect(opLogCall).toBeDefined()
    const detail = JSON.parse(opLogCall[1][8])
    expect(detail.remarkPresent).toBe(true)
    expect(detail.remarkLength).toBe(8)
    expect(detail.remark).toBeUndefined()
  })

  test('美容师为自己创建服务单（权限 happy path）', async () => {
    const ctx = createBeauticianCtx({
      items: [{ saleItemId: 'item-001', sessionUsed: 1 }],
      // assignedStaffWfId 未指定 → 默认 ctx.auth.staffWfId = 'emp-beautician-001'
    })

    pg.query
      // 1. sale_item + order JOIN（单次查询含 order_status）
      .mockResolvedValueOnce([{
        sale_item_id: 'item-001', remaining_sessions: 5, unit_real_price: '200',
        product_type: '疗程卡', order_status: '已支付', store_id: 'store-001',
        client_user_id: 'cu-001', client_phone: '138',
      }])
      // 2. resolvedClientUserId 从 order 获取（L130-136）
      .mockResolvedValueOnce([{ client_user_id: 'cu-001' }])
      // 3. 无进行中服务单
      .mockResolvedValueOnce([])
      // 4. became_member + bound_store_id（绑定门店校验：== effectiveStoreId）
      .mockResolvedValueOnce([{ became_member_at: null, bound_store_id: 'store-001' }])

    pg.transaction.mockImplementation(async (cb) => {
      const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) }
      return await cb(client)
    })

    await serviceRoutes.create(ctx)

    expect(ctx.result.status).toBe('待服务')
  })

  test('美容师不能为其他人创建服务单', async () => {
    const ctx = createBeauticianCtx({
      assignedStaffWfId: 'emp-other', // 不是自己
      items: [{ saleItemId: 'item-001', sessionUsed: 1 }],
    })

    await expect(serviceRoutes.create(ctx))
      .rejects.toThrow(/PERMISSION_DENIED.*美容师只能创建分配给自己/)
  })

  test('订单未支付时拒绝创建', async () => {
    const ctx = createManagerCtx({
      items: [{ saleItemId: 'item-001', sessionUsed: 1 }],
    })

    pg.query.mockResolvedValueOnce([{
      sale_item_id: 'item-001',
      remaining_sessions: 10,
      unit_real_price: '100',
      product_type: '疗程卡',
      order_status: '待支付', // 未支付
      store_id: 'store-001',
      client_user_id: null,
      client_phone: null,
    }])

    await expect(serviceRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*不可消费/)  // ticket 2026-05-19：消息改为"订单状态为 X，不可消费"
  })

  test('原订单退款审批中时拒绝开单（在途退款冻结）', async () => {
    const ctx = createManagerCtx({
      items: [{ saleItemId: 'item-001', sessionUsed: 1 }],
    })

    pg.query.mockResolvedValueOnce([{
      sale_item_id: 'item-001',
      remaining_sessions: 10,
      unit_real_price: '100',
      product_type: '疗程卡',
      order_status: '已支付',
      store_id: 'store-001',
      client_user_id: 'cu-001',
      client_phone: '138',
      has_pending_refund: true, // 存在 '待审批' 退款
    }])

    await expect(serviceRoutes.create(ctx))
      .rejects.toThrow(/INVALID_STATE.*REFUND_IN_PROGRESS.*退款审批中/)
  })

  test('家居产品拒绝创建服务单', async () => {
    const ctx = createManagerCtx({
      items: [{ saleItemId: 'item-001', sessionUsed: 1 }],
    })

    pg.query.mockResolvedValueOnce([{
      sale_item_id: 'item-001',
      remaining_sessions: null,
      unit_real_price: '100',
      product_type: '家居产品',
      order_status: '已支付',
      store_id: 'store-001',
      client_user_id: null,
      client_phone: null,
    }])

    await expect(serviceRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*家居产品/)
  })

  test('剩余次数不足时拒绝', async () => {
    const ctx = createManagerCtx({
      items: [{ saleItemId: 'item-001', sessionUsed: 5 }],
    })

    pg.query.mockResolvedValueOnce([{
      sale_item_id: 'item-001',
      remaining_sessions: 3, // 不足 5
      unit_real_price: '100',
      product_type: '疗程卡',
      order_status: '已支付',
      store_id: 'store-001',
      client_user_id: null,
      client_phone: null,
    }])

    await expect(serviceRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*剩余次数不足/)
  })

  test('空服务明细拒绝', async () => {
    const ctx = createManagerCtx({ items: [] })

    await expect(serviceRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*服务明细不能为空/)
  })

  test('关联预约不存在时拒绝创建（line 62 TRUE 分支）', async () => {
    const ctx = createManagerCtx({
      appointmentId: 'appt-nonexist',
      items: [{ saleItemId: 'item-001', sessionUsed: 1 }],
    })

    // appointment query → 空，预约不存在
    pg.query.mockResolvedValueOnce([])

    await expect(serviceRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*预约不存在/)
  })

  test('预约已关联服务单时拒绝重复创建', async () => {
    const ctx = createManagerCtx({
      appointmentId: 'appt-001',
      items: [{ saleItemId: 'item-001', sessionUsed: 1 }],
    })

    pg.query
      .mockResolvedValueOnce([{
        sale_item_id: 'item-001',
        remaining_sessions: 10,
        unit_real_price: '100',
        product_type: '疗程卡',
        order_status: '已支付',
        store_id: 'store-001',
        client_user_id: null,
        client_phone: null,
      }])

    // 验证预约
    pg.query
      .mockResolvedValueOnce([{ appointment_id: 'appt-001', status: '已确认', store_id: 'store-001' }])
      .mockResolvedValueOnce([{ service_order_id: 'HLD-existing' }]) // 已关联

    await expect(serviceRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*已关联服务单/)
  })

  test('顾客有进行中服务单时拒绝', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'client-001',
      items: [{ saleItemId: 'item-001', sessionUsed: 1 }],
    })

    pg.query
      .mockResolvedValueOnce([{
        sale_item_id: 'item-001',
        remaining_sessions: 10,
        unit_real_price: '100',
        product_type: '疗程卡',
        order_status: '已支付',
        store_id: 'store-001',
        client_user_id: 'client-001',
        client_phone: null,
      }])
      .mockResolvedValueOnce([{ service_order_id: 'HLD-active' }]) // 有进行中的

    await expect(serviceRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*已有进行中的服务单/)
  })

  test('SELECT sale_items 取 sales_category，并把快照写入 INSERT service_items', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'client-001',
      assignedStaffWfId: 'emp-beautician-001',
      items: [{ saleItemId: 'item-001', sessionUsed: 1 }],
    })

    pg.query
      .mockResolvedValueOnce([{
        sale_item_id: 'item-001',
        remaining_sessions: 5,
        unit_real_price: '200',
        product_type: '疗程卡',
        order_status: '已支付',
        store_id: 'store-001',
        client_user_id: 'client-001',
        client_phone: '138',
      }])
      .mockResolvedValueOnce([])                                  // 无进行中服务单
      .mockResolvedValueOnce([{ became_member_at: null, bound_store_id: 'store-001' }])        // 售前

    let capturedSiSelectSql = ''
    let capturedInsertSql = ''
    let capturedInsertParams = null
    // 单一 transaction：generateServiceOrderId（advisory lock + SELECT 服务单 ID）
    // + INSERT service_orders + SELECT sale_items + INSERT service_items
    pg.transaction.mockImplementationOnce(async (cb) => {
      const client = {
        query: vi.fn(async (sql, params) => {
          if (typeof sql === 'string' && sql.includes('pg_advisory_xact_lock')) {
            return { rows: [], rowCount: 0 }
          }
          if (typeof sql === 'string' && /FROM service_orders[\s\S]*LIKE \$1/.test(sql)) {
            return { rows: [], rowCount: 0 } // generateServiceOrderId: no existing → seq=1
          }
          if (typeof sql === 'string' && /SELECT[\s\S]+FROM sale_items\b/.test(sql)) {
            capturedSiSelectSql = sql
            return {
              rows: [{
                unit_real_price: '200',
                is_shengmei: true,
                sales_category: '自销自耗',
              }],
              rowCount: 1,
            }
          }
          if (typeof sql === 'string' && /INSERT INTO service_items/.test(sql)) {
            capturedInsertSql = sql
            capturedInsertParams = params
          }
          return { rows: [], rowCount: 1 }
        }),
      }
      return await cb(client)
    })

    await serviceRoutes.create(ctx)

    // SELECT 列表必须含 si.sales_category
    expect(capturedSiSelectSql).toMatch(/si\.sales_category/)
    // INSERT 列表必须把 sales_category 一起写入（含 9 个 $n 占位符）
    expect(capturedInsertSql).toMatch(/INSERT INTO service_items[\s\S]+sales_category/)
    expect(capturedInsertSql).toMatch(/\$9\)/)
    // params 顺序对应 SQL：$8=is_shengmei, $9=sales_category
    expect(capturedInsertParams).toBeTruthy()
    expect(capturedInsertParams[7]).toBe(true)
    expect(capturedInsertParams[8]).toBe('自销自耗')
  })

  test('sale_items.sales_category=NULL 时 service_items 也写入 NULL，不报错', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'client-001',
      assignedStaffWfId: 'emp-beautician-001',
      items: [{ saleItemId: 'item-legacy', sessionUsed: 1 }],
    })

    pg.query
      .mockResolvedValueOnce([{
        sale_item_id: 'item-legacy',
        remaining_sessions: 5,
        unit_real_price: '100',
        product_type: '疗程卡',
        order_status: '已支付',
        store_id: 'store-001',
        client_user_id: 'client-001',
        client_phone: '138',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ became_member_at: null, bound_store_id: 'store-001' }])

    let capturedInsertParams = null
    // 单一 transaction：generateServiceOrderId + INSERT service_orders + SELECT sale_items + INSERT service_items
    pg.transaction.mockImplementationOnce(async (cb) => {
      const client = {
        query: vi.fn(async (sql, params) => {
          if (typeof sql === 'string' && sql.includes('pg_advisory_xact_lock')) {
            return { rows: [], rowCount: 0 }
          }
          if (typeof sql === 'string' && /FROM service_orders[\s\S]*LIKE \$1/.test(sql)) {
            return { rows: [], rowCount: 0 } // generateServiceOrderId: no existing → seq=1
          }
          if (typeof sql === 'string' && /SELECT[\s\S]+FROM sale_items\b/.test(sql)) {
            // 古旧导入：sales_category 整行为 null
            return {
              rows: [{
                unit_real_price: '100',
                is_shengmei: null,
                sales_category: null,
              }],
              rowCount: 1,
            }
          }
          if (typeof sql === 'string' && /INSERT INTO service_items/.test(sql)) {
            capturedInsertParams = params
          }
          return { rows: [], rowCount: 1 }
        }),
      }
      return await cb(client)
    })

    await serviceRoutes.create(ctx)

    expect(ctx.result.status).toBe('待服务')
    expect(capturedInsertParams).toBeTruthy()
    expect(capturedInsertParams[7]).toBeNull()
    expect(capturedInsertParams[8]).toBeNull()
  })

  test('sale_items 上为 NULL 但 product_skus + product_categories fallback 命中时写入回退值', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'client-001',
      assignedStaffWfId: 'emp-beautician-001',
      items: [{ saleItemId: 'item-legacy-with-sku', sessionUsed: 1 }],
    })

    pg.query
      .mockResolvedValueOnce([{
        sale_item_id: 'item-legacy-with-sku',
        remaining_sessions: 5,
        unit_real_price: '100',
        product_type: '疗程卡',
        order_status: '已支付',
        store_id: 'store-001',
        client_user_id: 'client-001',
        client_phone: '138',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ became_member_at: null, bound_store_id: 'store-001' }])

    let capturedSiSelectSql = ''
    let capturedInsertParams = null
    pg.transaction.mockImplementationOnce(async (cb) => {
      const client = {
        query: vi.fn(async (sql, params) => {
          if (typeof sql === 'string' && sql.includes('pg_advisory_xact_lock')) {
            return { rows: [], rowCount: 0 }
          }
          if (typeof sql === 'string' && /FROM service_orders[\s\S]*LIKE \$1/.test(sql)) {
            return { rows: [], rowCount: 0 }
          }
          if (typeof sql === 'string' && /SELECT[\s\S]+FROM sale_items\b/.test(sql)) {
            capturedSiSelectSql = sql
            // 模拟 COALESCE 后回退到 product_skus + product_categories 取到的值
            return {
              rows: [{
                unit_real_price: '100',
                is_shengmei: true,           // 来自 ps.is_shengmei
                sales_category: '自销自耗',  // 来自 pc.sales_category
              }],
              rowCount: 1,
            }
          }
          if (typeof sql === 'string' && /INSERT INTO service_items/.test(sql)) {
            capturedInsertParams = params
          }
          return { rows: [], rowCount: 1 }
        }),
      }
      return await cb(client)
    })

    await serviceRoutes.create(ctx)

    // 守护 fallback SQL 形状：LEFT JOIN product_skus + product_categories + COALESCE
    expect(capturedSiSelectSql).toMatch(/LEFT JOIN product_skus/)
    expect(capturedSiSelectSql).toMatch(/LEFT JOIN product_categories/)
    expect(capturedSiSelectSql).toMatch(/COALESCE\(si\.is_shengmei,\s*ps\.is_shengmei\)/)
    expect(capturedSiSelectSql).toMatch(/COALESCE\(si\.sales_category,\s*pc\.sales_category\)/)
    expect(capturedInsertParams[7]).toBe(true)
    expect(capturedInsertParams[8]).toBe('自销自耗')
  })
})

describe('service.start', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('开始服务成功（C4: UPDATE WHERE 含 status 条件）', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query.mockResolvedValueOnce([{
      service_order_id: 'HLD-001',
      status: '待服务',
      assigned_employee_id: 'emp-001',
      store_id: 'store-001',
    }])
    const clientQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM service_items sit')) {
        return { rows: [{ sale_item_id: 'item-001', session_used: 1 }], rowCount: 1 }
      }
      if (sql.includes('FROM sale_items') && sql.includes('FOR UPDATE')) {
        return { rows: [{ sale_item_id: 'item-001', remaining_sessions: 2, session_count: 2, paid_sessions: 2, product_type: '疗程卡' }], rowCount: 1 }
      }
      if (sql.includes('GROUP BY reserved_item.sale_item_id')) return { rows: [], rowCount: 0 }
      return { rows: [], rowCount: 1 }
    })
    pg.transaction.mockImplementationOnce(async (cb) => await cb({ query: clientQuery }))

    await serviceRoutes.start(ctx)

    expect(ctx.result.status).toBe('服务中')
    const updateSql = clientQuery.mock.calls.find((call) => call[0].includes('UPDATE service_orders'))[0]
    expect(updateSql).toContain("AND status = '待服务'")
    expect(clientQuery.mock.calls.some((call) => call[0].includes('FOR UPDATE'))).toBe(true)
    expect(clientQuery.mock.calls.some((call) => call[0].includes('SET reserved_at = $1'))).toBe(true)
    const reservedSql = clientQuery.mock.calls.find((call) => call[0].includes('FROM service_items reserved_item'))[0]
    expect(reservedSql).toMatch(/JOIN service_orders reserved_order/)
    expect(reservedSql).toMatch(/reserved_order\.status IN \('服务中', '待客户确认'\)/)
  })

  test('并发竞态：start UPDATE rowCount=0 时报错', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query.mockResolvedValueOnce([{
      service_order_id: 'HLD-001',
      status: '待服务',
      assigned_employee_id: 'emp-001',
      store_id: 'store-001',
    }])
    pg.transaction.mockImplementationOnce(async (cb) => await cb({
      query: vi.fn(async (sql) => {
        if (sql.includes('FROM service_items sit')) return { rows: [{ sale_item_id: 'item-001', session_used: 1 }], rowCount: 1 }
        if (sql.includes('FROM sale_items') && sql.includes('FOR UPDATE')) {
          return { rows: [{ sale_item_id: 'item-001', remaining_sessions: 1, session_count: 1, paid_sessions: 1, product_type: '疗程卡' }], rowCount: 1 }
        }
        if (sql.includes('GROUP BY reserved_item.sale_item_id')) return { rows: [], rowCount: 0 }
        if (sql.includes('UPDATE service_orders')) return { rows: [], rowCount: 0 }
        return { rows: [], rowCount: 1 }
      }),
    }))

    await expect(serviceRoutes.start(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*状态已变更/)
  })

  test('预扣同时占用分期已付次数，重复 service_items 按订单行合并校验', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })
    pg.query.mockResolvedValueOnce([{
      service_order_id: 'HLD-001', status: '待服务', assigned_employee_id: 'emp-001', store_id: 'store-001',
    }])
    const clientQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM service_items sit')) {
        return { rows: [
          { sale_item_id: 'item-001', session_used: 1 },
          { sale_item_id: 'item-001', session_used: 1 },
        ], rowCount: 2 }
      }
      if (sql.includes('FROM sale_items') && sql.includes('FOR UPDATE')) {
        return { rows: [{ sale_item_id: 'item-001', remaining_sessions: 5, session_count: 5, paid_sessions: 3, product_type: '疗程卡' }], rowCount: 1 }
      }
      if (sql.includes('GROUP BY reserved_item.sale_item_id')) {
        return { rows: [{ sale_item_id: 'item-001', total_reserved: '2' }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })
    pg.transaction.mockImplementationOnce(async (cb) => cb({ query: clientQuery }))

    await expect(serviceRoutes.start(ctx))
      .rejects.toThrow(/INSUFFICIENT_BALANCE.*已支付可用次数不足/)
    expect(clientQuery.mock.calls.some((call) => call[0].includes('UPDATE service_orders'))).toBe(false)
    expect(clientQuery.mock.calls.some((call) => call[0].includes('SET reserved_at = $1'))).toBe(false)
  })

  test('非待服务状态拒绝开始', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query.mockResolvedValueOnce([{
      service_order_id: 'HLD-001',
      status: '服务中',
      assigned_employee_id: 'emp-001',
      store_id: 'store-001',
    }])

    await expect(serviceRoutes.start(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*服务中.*不可开始/)
  })

  test('美容师不能操作非分配给自己的服务单', async () => {
    const ctx = createBeauticianCtx({ serviceOrderId: 'HLD-001' })

    pg.query.mockResolvedValueOnce([{
      service_order_id: 'HLD-001',
      status: '待服务',
      assigned_employee_id: 'emp-other',
      store_id: 'store-001',
    }])

    await expect(serviceRoutes.start(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })
})

describe('service.complete（服务中 → 待客户确认，轻量翻状态）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('标记完成 — 服务中 → 待客户确认（不扣次数、不开事务）', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query.mockResolvedValueOnce([{
      service_order_id: 'HLD-001',
      status: '服务中',
      assigned_employee_id: 'emp-001',
      store_id: 'store-001',
      appointment_id: null,
    }])
    // 轻量翻状态 + 审计日志走事务 client（无 finalize 业务副作用）
    const clientQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    pg.transaction.mockImplementationOnce(async (cb) => await cb({ query: clientQuery }))

    await serviceRoutes.complete(ctx)

    expect(ctx.result.status).toBe('待客户确认')
    const updateSql = clientQuery.mock.calls[0][0]
    expect(updateSql).toContain("status = '待客户确认'")
    expect(updateSql).toContain('staff_completed_at')
    expect(updateSql).toContain("AND status = '服务中'")
    // 不产生 finalize 副作用：不扣次数 / 不计提成（事务内仅 UPDATE + 审计日志）
    const sideEffectCalls = clientQuery.mock.calls.filter((c) =>
      /remaining_sessions|service_commissions/.test(c[0])
    )
    expect(sideEffectCalls.length).toBe(0)
  })

  test('并发竞态：complete UPDATE rowCount=0 时报错', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-001',
        status: '服务中',
        assigned_employee_id: 'emp-001',
        store_id: 'store-001',
        appointment_id: null,
      }])
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 并发竞态

    await expect(serviceRoutes.complete(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*状态已变更/)
  })

  test('幂等 — 待客户确认的服务单不重复标记', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query.mockResolvedValueOnce([{
      service_order_id: 'HLD-001',
      status: '待客户确认',
      assigned_employee_id: 'emp-001',
      store_id: 'store-001',
    }])

    await serviceRoutes.complete(ctx)

    expect(ctx.result.status).toBe('待客户确认')
    expect(ctx.result.message).toContain('幂等')
    expect(pg.transaction).not.toHaveBeenCalled()
  })

  test('幂等 — 已完成的服务单直接返回', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query.mockResolvedValueOnce([{
      service_order_id: 'HLD-001',
      status: '已完成',
      assigned_employee_id: 'emp-001',
      store_id: 'store-001',
    }])

    await serviceRoutes.complete(ctx)

    expect(ctx.result.status).toBe('已完成')
    expect(ctx.result.message).toContain('幂等')
    expect(pg.transaction).not.toHaveBeenCalled()
  })

  test('非服务中状态拒绝完成', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query.mockResolvedValueOnce([{
      service_order_id: 'HLD-001',
      status: '待服务',
      assigned_employee_id: 'emp-001',
      store_id: 'store-001',
    }])

    await expect(serviceRoutes.complete(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*待服务.*不可完成/)
  })
})

describe('service.confirm（待客户确认 → 已完成，finalize 副作用）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('确认完成 — 原子扣减次数（finalize: UPDATE WHERE status=待客户确认）', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-001',
        status: '待客户确认',
        assigned_employee_id: 'emp-001',
        store_id: 'store-001',
        appointment_id: null,
      }])
      .mockResolvedValueOnce([])   // 冻结闭环（Bug I）：refund guard 无待审批退款
      .mockResolvedValueOnce([
        { service_item_id: 'si-1', sale_item_id: 'item-001', session_used: 1 },
      ])

    let capturedSoUpdateSql = ''
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql) => {
          if (typeof sql === 'string' && sql.includes("status = '已完成'")) capturedSoUpdateSql = sql
          return { rows: [{ remaining_sessions: 5 }], rowCount: 1 }
        }),
      }
      return await cb(client)
    })

    await serviceRoutes.confirm(ctx)

    expect(ctx.result.status).toBe('已完成')
    expect(ctx.result.message).toContain('次数已扣减')
    expect(capturedSoUpdateSql).toContain("AND status = '待客户确认'")
  })

  test('并发竞态：finalize UPDATE service_orders rowCount=0 时幂等返回（已被顾客确认）', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-001',
        status: '待客户确认',
        assigned_employee_id: 'emp-001',
        store_id: 'store-001',
        appointment_id: null,
      }])
      .mockResolvedValueOnce([])   // 冻结闭环（Bug I）：refund guard 无待审批退款
      .mockResolvedValueOnce([
        { service_item_id: 'si-1', sale_item_id: 'item-001', session_used: 1 },
      ])

    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql) => {
          if (sql.includes('FOR UPDATE')) {
            return { rows: [{ sale_item_id: 'item-001' }], rowCount: 1 }
          }
          if (sql.includes("status = '已完成'")) {
            return { rows: [], rowCount: 0 } // 并发确认已抢先完成状态 CAS
          }
          return { rows: [], rowCount: 1 }
        }),
      }
      return await cb(client)
    })

    // finalize 返回 false → confirm 幂等返回已完成，不报错
    await serviceRoutes.confirm(ctx)
    expect(ctx.result.status).toBe('已完成')
  })

  test('确认在扣次完成后才释放预扣', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })
    pg.query
      .mockResolvedValueOnce([{ service_order_id: 'HLD-001', status: '待客户确认', assigned_employee_id: 'emp-001', store_id: 'store-001', appointment_id: null }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ service_item_id: 'si-1', sale_item_id: 'item-001', session_used: 1, unit_real_price: '100', service_fee: '0', sales_category: '自销自耗', employee_id: 'emp-001', skills: [] }])
    const calls = []
    pg.transaction.mockImplementationOnce(async (cb) => cb({
      query: vi.fn(async (sql) => {
        calls.push(sql)
        if (sql.includes('FOR UPDATE')) return { rows: [{ sale_item_id: 'item-001' }], rowCount: 1 }
        if (sql.includes("UPDATE service_orders SET status = '已完成'")) return { rows: [], rowCount: 1 }
        if (sql.includes('UPDATE sale_items')) return { rows: [], rowCount: 1 }
        if (sql.includes('SELECT remaining_sessions')) return { rows: [{ remaining_sessions: 4 }], rowCount: 1 }
        if (sql.includes('commission_rate_matrix')) return { rows: [], rowCount: 0 }
        return { rows: [], rowCount: 1 }
      }),
    }))

    await serviceRoutes.confirm(ctx)

    const lockAt = calls.findIndex((sql) => sql.includes('FOR UPDATE'))
    const statusAt = calls.findIndex((sql) => sql.includes("UPDATE service_orders SET status = '已完成'"))
    const deductAt = calls.findIndex((sql) => sql.includes('UPDATE sale_items'))
    const releaseAt = calls.findIndex((sql) => sql.includes('UPDATE service_items') && sql.includes('reserved_at = NULL'))
    expect(lockAt).toBeLessThan(statusAt)
    expect(statusAt).toBeLessThan(deductAt)
    expect(deductAt).toBeLessThan(releaseAt)
  })

  test('幂等 — 已完成的服务单不重复扣减', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query.mockResolvedValueOnce([{
      service_order_id: 'HLD-001',
      status: '已完成',
      assigned_employee_id: 'emp-001',
      store_id: 'store-001',
    }])

    await serviceRoutes.confirm(ctx)

    expect(ctx.result.status).toBe('已完成')
    expect(ctx.result.message).toContain('幂等')
    // 不应调用 transaction
    expect(pg.transaction).not.toHaveBeenCalled()
  })

  test('非待客户确认状态拒绝确认', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query.mockResolvedValueOnce([{
      service_order_id: 'HLD-001',
      status: '服务中',
      assigned_employee_id: 'emp-001',
      store_id: 'store-001',
    }])

    await expect(serviceRoutes.confirm(ctx))
      .rejects.toThrow(/INVALID_STATE.*服务中.*不可确认/)
  })

  test('原子扣减失败（次数不足）时回滚', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-001',
        status: '待客户确认',
        assigned_employee_id: 'emp-001',
        store_id: 'store-001',
        appointment_id: null,
      }])
      .mockResolvedValueOnce([])   // 冻结闭环（Bug I）：assertNoPendingRefundByServiceOrder 无待审批退款
      .mockResolvedValueOnce([
        { service_item_id: 'si-1', sale_item_id: 'item-001', session_used: 5 },
      ])

    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn()
          // sale_items 行锁 + 服务单状态 CAS
          .mockResolvedValueOnce({ rows: [{ sale_item_id: 'item-001' }], rowCount: 1 })
          .mockResolvedValueOnce({ rows: [], rowCount: 1 })
          // rowCount = 0 → 原子扣减失败
          .mockResolvedValueOnce({ rows: [], rowCount: 0 })
          // probe: 同店（store_id 一致）但次数不足
          .mockResolvedValueOnce({ rows: [{ store_id: 'store-001', remaining_sessions: 2 }] }),
      }
      return await cb(client)
    })

    await expect(serviceRoutes.confirm(ctx))
      .rejects.toThrow(/次数不足/)
  })

  test('跨店核销允许 — 卡跟顾客走：sale_items.store_id 与服务单门店不一致也可扣减', async () => {
    // 可核销门店由 service.create 的「顾客绑定门店」校验把关；finalize 扣次 UPDATE 已去掉
    // AND store_id=$3，他店售出的卡也能命中（rowCount=1）。
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-001',
        status: '待客户确认',
        assigned_employee_id: 'emp-001',
        store_id: 'store-001',
        appointment_id: null,
      }])
      .mockResolvedValueOnce([])  // assertNoPendingRefundByServiceOrder：无在途退款
      .mockResolvedValueOnce([
        { service_item_id: 'si-1', sale_item_id: 'item-other-store', session_used: 1 },
      ])

    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        // 扣次 UPDATE 不再比卡售出门店 → 他店卡命中 rowCount=1
        query: vi.fn().mockResolvedValue({ rows: [{ remaining_sessions: 5 }], rowCount: 1 }),
      }
      return await cb(client)
    })

    await serviceRoutes.confirm(ctx)

    expect(ctx.result.status).toBe('已完成')
    expect(ctx.result.message).toContain('次数已扣减')
  })

  test('剩余次数归零时关闭关联预约', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-001',
        status: '待客户确认',
        assigned_employee_id: 'emp-001',
        store_id: 'store-001',
        appointment_id: 'appt-001',
      }])
      .mockResolvedValueOnce([])   // 冻结闭环（Bug I）：assertNoPendingRefundByServiceOrder 无待审批退款
      .mockResolvedValueOnce([
        {
          service_item_id: 'si-1',
          sale_item_id: 'item-001',
          session_used: 1,
          employee_id: 'emp-001',
          unit_real_price: '500.00',
          service_fee: '80.00',
          sales_category: '自销自耗',
          skills: ['美容师'],
        },
      ])

    // 根据 SQL 动态分派返回值（新实现增加了 commission_rate_matrix 查询 + service_commissions INSERT）
    const clientQueryMock = vi.fn(async (sql) => {
      if (typeof sql !== 'string') return { rows: [], rowCount: 0 }
      if (sql.includes('remaining_sessions')) {
        if (sql.includes('UPDATE')) return { rows: [], rowCount: 1 }
        return { rows: [{ remaining_sessions: 0 }], rowCount: 1 }
      }
      if (sql.includes('commission_rate_matrix')) {
        return { rows: [{ commission_rate: '0.1000' }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })

    pg.transaction.mockImplementation(async (cb) => {
      return await cb({ query: clientQueryMock })
    })

    await serviceRoutes.confirm(ctx)

    expect(ctx.result.status).toBe('已完成')
    // 验证关闭预约的 SQL
    const closeCalls = clientQueryMock.mock.calls.filter(
      call => typeof call[0] === 'string' && call[0].includes('appointments') && call[0].includes('已关闭')
    )
    expect(closeCalls.length).toBeGreaterThanOrEqual(1)
  })

  // ============================================================
  // 修复 Bug：service.complete 需自动写入 service_commissions
  // 双字段模型：fixed_fee + consume_amount = commission_amount
  // ============================================================
  test('服务完成时自动写入 service_commissions（固定手工费 + 消耗提成）', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-001',
        status: '待客户确认',
        assigned_employee_id: 'emp-001',
        store_id: 'store-001',
        appointment_id: null,
      }])
      .mockResolvedValueOnce([])   // 冻结闭环（Bug I）：assertNoPendingRefundByServiceOrder 无待审批退款
      .mockResolvedValueOnce([
        {
          service_item_id: 'si-1',
          sale_item_id: 'item-001',
          session_used: 2,
          employee_id: 'emp-001',
          unit_real_price: '500.00',
          service_fee: '80.00',       // sale_items.service_fee 快照
          sales_category: '自销自耗',
          skills: ['美容师'],          // skills[0] 自动推断 roleType
        },
      ])

    // commission_rate_matrix 返回 10% 消耗提成比例
    let svcCommInsertCall = null
    let soUpdateCall = null
    const clientQueryMock = vi.fn(async (sql, params) => {
      if (typeof sql !== 'string') return { rows: [], rowCount: 0 }
      if (sql.includes('commission_rate_matrix')) {
        return { rows: [{ commission_rate: '0.1000' }], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO service_commissions')) {
        svcCommInsertCall = { sql, params }
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes("UPDATE service_orders SET status = '已完成'")) {
        soUpdateCall = { sql, params }
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('remaining_sessions')) {
        if (sql.includes('UPDATE')) return { rows: [], rowCount: 1 }
        return { rows: [{ remaining_sessions: 5 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })

    pg.transaction.mockImplementation(async (cb) => {
      return await cb({ query: clientQueryMock })
    })

    await serviceRoutes.confirm(ctx)

    // 断言 service_commissions 被 INSERT
    expect(svcCommInsertCall).not.toBeNull()
    // 参数顺序：service_item_id, employee_id, role_type, commission_rate, commission_amount, fixed_fee, consume_amount
    const [svcItemId, empId, roleType, rate, commAmt, fixedFee, consumeAmt] = svcCommInsertCall.params
    expect(svcItemId).toBe('si-1')
    expect(empId).toBe('emp-001')
    expect(roleType).toBe('美容师')
    expect(rate).toBe(0.1)
    expect(fixedFee).toBe(160)          // 80 × 2
    expect(consumeAmt).toBe(100)        // 500 × 2 × 0.10
    expect(commAmt).toBe(260)           // 160 + 100 = 260
    expect(fixedFee + consumeAmt).toBe(commAmt) // 双字段拆分恒等

    // 断言 service_orders 的 commission_status 被设置为 '已分配'
    expect(soUpdateCall).not.toBeNull()
    expect(soUpdateCall.sql).toContain("commission_status = '已分配'")
  })

  test('commission_rate_matrix 查不到规则时 rate=0 + 写 operation_logs，不阻塞 complete', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-001',
        status: '待客户确认',
        assigned_employee_id: 'emp-001',
        store_id: 'store-001',
        appointment_id: null,
      }])
      .mockResolvedValueOnce([])   // 冻结闭环（Bug I）：assertNoPendingRefundByServiceOrder 无待审批退款
      .mockResolvedValueOnce([
        {
          service_item_id: 'si-1',
          sale_item_id: 'item-001',
          session_used: 1,
          employee_id: 'emp-001',
          unit_real_price: '500.00',
          service_fee: '80.00',
          sales_category: '他销他耗',  // 矩阵无对应规则
          skills: ['美容师'],
        },
      ])

    let svcCommInsert = null
    let opLogInsert = null
    const clientQueryMock = vi.fn(async (sql, params) => {
      if (typeof sql !== 'string') return { rows: [], rowCount: 0 }
      if (sql.includes('commission_rate_matrix')) {
        // 返回空：无匹配规则
        return { rows: [], rowCount: 0 }
      }
      if (sql.includes('INSERT INTO operation_logs') && sql.includes('rate_missing')) {
        // finalize 内的缺率告警日志（9 列裸 INSERT，action 为字面量）
        opLogInsert = { sql, params }
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO operation_logs')) {
        // service.confirm 状态流转审计日志（helper 参数化 INSERT）
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO service_commissions')) {
        svcCommInsert = { sql, params }
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('remaining_sessions')) {
        if (sql.includes('UPDATE')) return { rows: [], rowCount: 1 }
        return { rows: [{ remaining_sessions: 5 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })

    pg.transaction.mockImplementation(async (cb) => {
      return await cb({ query: clientQueryMock })
    })

    // 不应 throw
    await serviceRoutes.confirm(ctx)

    // operation_logs 被写入
    expect(opLogInsert).not.toBeNull()
    expect(opLogInsert.sql).toContain('service.complete.rate_missing')

    // service_commissions 依然被写入：rate=0, consume_amount=0, fixed_fee=80 照常
    expect(svcCommInsert).not.toBeNull()
    const [, , , rate, commAmt, fixedFee, consumeAmt] = svcCommInsert.params
    expect(rate).toBe(0)
    expect(fixedFee).toBe(80)   // 80 × 1
    expect(consumeAmt).toBe(0)  // consume_base × 0 = 0
    expect(commAmt).toBe(80)    // 仅固定手工费
  })

  test('skills 为空时 roleType 兜底为"美容师"', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-001',
        status: '待客户确认',
        assigned_employee_id: 'emp-001',
        store_id: 'store-001',
        appointment_id: null,
      }])
      .mockResolvedValueOnce([])   // 冻结闭环（Bug I）：assertNoPendingRefundByServiceOrder 无待审批退款
      .mockResolvedValueOnce([
        {
          service_item_id: 'si-1',
          sale_item_id: 'item-001',
          session_used: 1,
          employee_id: 'emp-001',
          unit_real_price: '500.00',
          service_fee: '80.00',
          sales_category: '自销自耗',
          skills: null,  // 无技能标签
        },
      ])

    let svcCommInsert = null
    const clientQueryMock = vi.fn(async (sql, params) => {
      if (typeof sql !== 'string') return { rows: [], rowCount: 0 }
      if (sql.includes('commission_rate_matrix')) return { rows: [{ commission_rate: '0.1000' }] }
      if (sql.includes('INSERT INTO service_commissions')) {
        svcCommInsert = { sql, params }
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('remaining_sessions')) {
        if (sql.includes('UPDATE')) return { rows: [], rowCount: 1 }
        return { rows: [{ remaining_sessions: 5 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })

    pg.transaction.mockImplementation(async (cb) => {
      return await cb({ query: clientQueryMock })
    })

    await serviceRoutes.confirm(ctx)

    const [, , roleType] = svcCommInsert.params
    expect(roleType).toBe('美容师')  // 兜底值
  })

  // ============================================================
  // 修复 Bug：service_items.unit_real_price 是 per-card 价格快照，
  // 需还原 per-session：unit_real_price × quantity / session_count
  // ============================================================
  test('5次卡 × 2: consume_amount 按 per-session 计算（非 per-card）', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-001',
        status: '待客户确认',
        assigned_employee_id: 'emp-001',
        store_id: 'store-001',
        appointment_id: null,
      }])
      .mockResolvedValueOnce([])   // 冻结闭环（Bug I）：assertNoPendingRefundByServiceOrder 无待审批退款
      .mockResolvedValueOnce([
        {
          service_item_id: 'si-1',
          sale_item_id: 'item-card',
          session_used: 1,
          employee_id: 'emp-001',
          unit_real_price: '700.00',    // per-session 单次价（5次卡 3500/5=700），已是单次基准
          service_fee: '0',
          sales_category: '自销自耗',
          session_count: 10,             // 5次卡 × 2张
          quantity: 2,
          skills: ['美容师'],
        },
      ])

    let svcCommInsert = null
    const clientQueryMock = vi.fn(async (sql, params) => {
      if (typeof sql !== 'string') return { rows: [], rowCount: 0 }
      if (sql.includes('commission_rate_matrix')) {
        return { rows: [{ commission_rate: '0.1000' }], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO service_commissions')) {
        svcCommInsert = { sql, params }
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('remaining_sessions')) {
        if (sql.includes('UPDATE')) return { rows: [], rowCount: 1 }
        return { rows: [{ remaining_sessions: 9 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })

    pg.transaction.mockImplementation(async (cb) => {
      return await cb({ query: clientQueryMock })
    })

    await serviceRoutes.confirm(ctx)

    expect(svcCommInsert).not.toBeNull()
    // 参数顺序：service_item_id, employee_id, role_type, commission_rate, commission_amount, fixed_fee, consume_amount
    const [, , , rate, commAmt, fixedFee, consumeAmt] = svcCommInsert.params
    // per_session = unit_real_price = 700（已是单次价，不再 ÷session_count）
    // consumeBase = 700 × 1 = 700
    // consumeAmt = 700 × 0.10 = 70
    expect(rate).toBe(0.1)
    expect(fixedFee).toBe(0)
    expect(consumeAmt).toBe(70)
    expect(commAmt).toBe(70)
  })

  test('5次卡 × 2 + sessionUsed=2: consume_amount = 1400 × rate', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-001',
        status: '待客户确认',
        assigned_employee_id: 'emp-001',
        store_id: 'store-001',
        appointment_id: null,
      }])
      .mockResolvedValueOnce([])   // 冻结闭环（Bug I）：assertNoPendingRefundByServiceOrder 无待审批退款
      .mockResolvedValueOnce([
        {
          service_item_id: 'si-1',
          sale_item_id: 'item-card',
          session_used: 2,
          employee_id: 'emp-001',
          unit_real_price: '700.00',    // per-session 单次价（5次卡 3500/5=700）
          service_fee: '0',
          sales_category: '自销自耗',
          session_count: 10,
          quantity: 2,
          skills: ['美容师'],
        },
      ])

    let svcCommInsert = null
    const clientQueryMock = vi.fn(async (sql, params) => {
      if (typeof sql !== 'string') return { rows: [], rowCount: 0 }
      if (sql.includes('commission_rate_matrix')) {
        return { rows: [{ commission_rate: '0.1000' }], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO service_commissions')) {
        svcCommInsert = { sql, params }
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('remaining_sessions')) {
        if (sql.includes('UPDATE')) return { rows: [], rowCount: 1 }
        return { rows: [{ remaining_sessions: 8 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })

    pg.transaction.mockImplementation(async (cb) => {
      return await cb({ query: clientQueryMock })
    })

    await serviceRoutes.confirm(ctx)

    const [, , , , , , consumeAmt] = svcCommInsert.params
    // per_session=700, consumeBase=700×2=1400, consumeAmt=1400×0.10=140
    expect(consumeAmt).toBe(140)
  })

  test('非卡 (session_count=quantity=1): per-session 退化为 unit_real_price', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-001',
        status: '待客户确认',
        assigned_employee_id: 'emp-001',
        store_id: 'store-001',
        appointment_id: null,
      }])
      .mockResolvedValueOnce([])   // 冻结闭环（Bug I）：assertNoPendingRefundByServiceOrder 无待审批退款
      .mockResolvedValueOnce([
        {
          service_item_id: 'si-1',
          sale_item_id: 'item-single',
          session_used: 1,
          employee_id: 'emp-001',
          unit_real_price: '49.80',
          service_fee: '0',
          sales_category: '自销自耗',
          session_count: 1,
          quantity: 1,
          skills: ['美容师'],
        },
      ])

    let svcCommInsert = null
    const clientQueryMock = vi.fn(async (sql, params) => {
      if (typeof sql !== 'string') return { rows: [], rowCount: 0 }
      if (sql.includes('commission_rate_matrix')) {
        return { rows: [{ commission_rate: '0.1000' }], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO service_commissions')) {
        svcCommInsert = { sql, params }
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('remaining_sessions')) {
        if (sql.includes('UPDATE')) return { rows: [], rowCount: 1 }
        return { rows: [{ remaining_sessions: 0 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })

    pg.transaction.mockImplementation(async (cb) => {
      return await cb({ query: clientQueryMock })
    })

    await serviceRoutes.confirm(ctx)

    const [, , , , , , consumeAmt] = svcCommInsert.params
    // per_session = 49.80 × 1 / 1 = 49.80; consumeBase = 49.80; consumeAmt = 4.98
    expect(consumeAmt).toBeCloseTo(4.98, 2)
  })
})

describe('service.cancel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('取消待服务的服务单（C4: UPDATE WHERE 含 status 条件，不扣次数）', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query.mockResolvedValueOnce([{
      service_order_id: 'HLD-001',
      status: '待服务',
      assigned_employee_id: 'emp-001',
      store_id: 'store-001',
    }])
    // UPDATE + 审计日志走事务 client（不扣次数）
    const clientQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    pg.transaction.mockImplementationOnce(async (cb) => await cb({ query: clientQuery }))

    await serviceRoutes.cancel(ctx)

    expect(ctx.result.status).toBe('已取消')
    // C4 合规验证（事务 client 首个调用 = UPDATE）
    const updateSql = clientQuery.mock.calls[0][0]
    expect(updateSql).toContain('AND status = $')
    expect(clientQuery.mock.calls[0][1]).toContain('待服务')
    // 不扣次数：事务内无 remaining_sessions 扣减
    expect(clientQuery.mock.calls.filter((c) => /remaining_sessions/.test(c[0])).length).toBe(0)
    const statusAt = clientQuery.mock.calls.findIndex((call) => call[0].includes('UPDATE service_orders'))
    const releaseAt = clientQuery.mock.calls.findIndex((call) => call[0].includes('reserved_at = NULL'))
    expect(statusAt).toBeLessThan(releaseAt)
  })

  test('并发竞态：cancel UPDATE rowCount=0 时报错', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-001',
        status: '待服务',
        assigned_employee_id: 'emp-001',
        store_id: 'store-001',
      }])
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })

    await expect(serviceRoutes.cancel(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*状态已变更/)
  })

  test('取消服务中的服务单', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query.mockResolvedValueOnce([{
      service_order_id: 'HLD-001',
      status: '服务中',
      assigned_employee_id: 'emp-001',
      store_id: 'store-001',
    }])
    pg.transaction.mockImplementationOnce(async (cb) => await cb({ query: vi.fn(async () => ({ rows: [], rowCount: 1 })) }))

    await serviceRoutes.cancel(ctx)
    expect(ctx.result.status).toBe('已取消')
  })

  test('已完成的服务单不能取消', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-001' })

    pg.query.mockResolvedValueOnce([{
      service_order_id: 'HLD-001',
      status: '已完成',
      assigned_employee_id: 'emp-001',
      store_id: 'store-001',
    }])

    await expect(serviceRoutes.cancel(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*已完成.*不可取消/)
  })

  test('美容师只能取消分配给自己的服务单', async () => {
    const ctx = createBeauticianCtx({ serviceOrderId: 'HLD-001' })

    pg.query.mockResolvedValueOnce([{
      service_order_id: 'HLD-001',
      status: '待服务',
      assigned_employee_id: 'emp-other', // 不是自己
      store_id: 'store-001',
    }])

    await expect(serviceRoutes.cancel(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })
})

describe('service.list', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('美容师只看分配给自己的服务单', async () => {
    const ctx = createBeauticianCtx({ page: 1 })

    pg.query.mockResolvedValueOnce([]) // 无服务单

    await serviceRoutes.list(ctx)

    const sql = pg.query.mock.calls[0][0]
    expect(sql).toContain('assigned_employee_id')
    expect(pg.query.mock.calls[0][1]).toContain('emp-beautician-001')
  })

  test('店长查看全部服务单（门店门带支援 OR 分支，但不被 AND 收窄到本人）', async () => {
    const ctx = createManagerCtx({ page: 1 })

    pg.query.mockResolvedValueOnce([]) // 无服务单

    await serviceRoutes.list(ctx)

    const sql = pg.query.mock.calls[0][0]
    // #224：门店门 = 本店 ∪ 指派给本人的跨店支援单
    expect(sql).toContain('(so.store_id = $1 OR so.assigned_employee_id = $2)')
    // 店长不额外 AND 收窄 —— 仍看全店
    expect(sql).not.toContain('AND so.assigned_employee_id = $2')
  })

  test('list 返回完整数据（含 items/staffName/customerName 批量查询）', async () => {
    const ctx = createManagerCtx({ status: '待服务', page: 1 })

    pg.query
      // 1. 服务单列表
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-001', status: '待服务', service_date: '2024-06-01',
        assigned_employee_id: 'emp-001', client_user_id: 'cu-001',
        appointment_id: null, remark: '', started_at: null, completed_at: null,
        created_at: '2024-06-01', client_phone: '138',
      }])
      // 2. 服务明细 (soIds.length > 0)
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-001', product_name: '面部护理',
        remaining_sessions: 8, session_count: 10, service_duration: 60,
      }])
      // 3. 员工姓名 (staffWfIds.length > 0)
      .mockResolvedValueOnce([{ employee_id: 'emp-001', name: '张三' }])
      // 4. 顾客姓名 (clientUserIds.length > 0)
      .mockResolvedValueOnce([{ user_id: 'cu-001', name: '李女士' }])

    await serviceRoutes.list(ctx)

    expect(ctx.result).toHaveLength(1)
    expect(ctx.result[0].staffName).toBe('张三')
    expect(ctx.result[0].customerName).toBe('李女士')
    expect(ctx.result[0].items).toHaveLength(1)
    expect(ctx.result[0].items[0].itemName).toBe('面部护理')
    // status 过滤
    expect(pg.query.mock.calls[0][1]).toContain('待服务')
  })

  test('list 顾客姓名从 sale_orders 兜底', async () => {
    const ctx = createManagerCtx({ page: 1 })

    pg.query
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-002', status: '待服务', service_date: '2024-06-01',
        assigned_employee_id: 'emp-001', client_user_id: 'cu-noname',
        appointment_id: null, remark: '', started_at: null, completed_at: null,
        created_at: '2024-06-01', client_phone: '139',
      }])
      .mockResolvedValueOnce([])  // 无服务明细
      .mockResolvedValueOnce([{ employee_id: 'emp-001', name: '张三' }])
      // client_wechat_users: 无 name
      .mockResolvedValueOnce([{ user_id: 'cu-noname', name: null }])
      // sale_orders 兜底
      .mockResolvedValueOnce([{ client_user_id: 'cu-noname', customer_name: '订单顾客' }])

    await serviceRoutes.list(ctx)

    expect(ctx.result[0].customerName).toBe('订单顾客')
  })

  test('美容师 + 状态过滤组合', async () => {
    const ctx = createBeauticianCtx({ status: '服务中', page: 1 })

    pg.query.mockResolvedValueOnce([])

    await serviceRoutes.list(ctx)

    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).toContain('so.status =')
    expect(sql).toContain('so.assigned_employee_id =')
    expect(params).toContain('服务中')
    expect(params).toContain('emp-beautician-001')
  })
})

describe('service.detail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('查看服务单详情', async () => {
    const ctx = createManagerCtx({ id: 'HLD-001' })

    pg.query
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-001',
        status: '服务中',
        service_date: '2024-01-15',
        assigned_employee_id: 'emp-001',
        client_user_id: 'client-001',
        appointment_id: null,
        remark: '备注',
        started_at: '2024-01-15T10:00:00Z',
        completed_at: null,
        created_at: '2024-01-15T09:00:00Z',
        updated_at: '2024-01-15T10:00:00Z',
        store_id: 'store-001',
        client_phone: '13800001111',
      }])
      .mockResolvedValueOnce([{
        sale_item_id: 'item-001',
        session_used: 1,
        service_duration: 60,
        session_count: 10,
        remaining_sessions: 9,
        product_type: '疗程卡',
        product_name: '面部护理',
      }])
      .mockResolvedValueOnce([{ name: '张三' }])    // 员工姓名
      .mockResolvedValueOnce([{ name: '顾客A' }])   // 顾客姓名

    await serviceRoutes.detail(ctx)

    expect(ctx.result.serviceOrderId).toBe('HLD-001')
    expect(ctx.result.staffName).toBe('张三')
    expect(ctx.result.customerName).toBe('顾客A')
    expect(ctx.result.items).toHaveLength(1)
    expect(ctx.result.items[0].itemName).toBe('面部护理')
  })

  test('美容师查看自己的服务单详情（权限 happy path）', async () => {
    const ctx = createBeauticianCtx({ id: 'HLD-OWN' })

    pg.query
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-OWN', status: '服务中', service_date: '2024-06-01',
        assigned_employee_id: 'emp-beautician-001',  // 匹配自己
        client_user_id: 'cu-001', appointment_id: null, remark: '',
        started_at: '2024-06-01T10:00:00Z', completed_at: null,
        created_at: '2024-06-01', updated_at: '2024-06-01',
        store_id: 'store-001', client_phone: '138',
      }])
      .mockResolvedValueOnce([])  // items
      .mockResolvedValueOnce([{ name: '当前美容师' }])  // staffName
      .mockResolvedValueOnce([{ name: '顾客A' }])  // customerName

    await serviceRoutes.detail(ctx)

    expect(ctx.result.serviceOrderId).toBe('HLD-OWN')
    expect(ctx.result.staffName).toBe('当前美容师')
  })

  test('美容师不能查看非分配给自己的服务单', async () => {
    const ctx = createBeauticianCtx({ id: 'HLD-001' })

    pg.query.mockResolvedValueOnce([{
      service_order_id: 'HLD-001',
      status: '服务中',
      assigned_employee_id: 'emp-other',
      store_id: 'store-001',
    }])

    await expect(serviceRoutes.detail(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('缺少 id 参数时拒绝', async () => {
    const ctx = createManagerCtx({})
    await expect(serviceRoutes.detail(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*id/)
  })

  test('服务单不存在时报错', async () => {
    const ctx = createManagerCtx({ id: 'HLD-NONEXIST' })
    pg.query.mockResolvedValueOnce([])
    await expect(serviceRoutes.detail(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*不存在/)
  })

  test('顾客姓名从 sale_orders 兜底获取', async () => {
    const ctx = createManagerCtx({ id: 'HLD-001' })

    pg.query
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-001',
        status: '待服务',
        service_date: '2024-01-15',
        assigned_employee_id: 'emp-001',
        client_user_id: 'client-001',
        appointment_id: null,
        remark: '',
        started_at: null,
        completed_at: null,
        created_at: '2024-01-15T09:00:00Z',
        updated_at: '2024-01-15T09:00:00Z',
        store_id: 'store-001',
        client_phone: '13800001111',
      }])
      .mockResolvedValueOnce([]) // 服务明细
      .mockResolvedValueOnce([{ name: '员工' }]) // 员工姓名
      .mockResolvedValueOnce([{ name: null }])    // client_wechat_users.name 为空
      .mockResolvedValueOnce([{ customer_name: '订单顾客名' }]) // 从 sale_orders 兜底

    await serviceRoutes.detail(ctx)
    expect(ctx.result.customerName).toBe('订单顾客名')
  })

  test('跨门店只读：服务单在其他门店，但顾客绑定本 scope → 放行', async () => {
    const ctx = createManagerCtx({ id: 'HLD-XSTORE' })

    pg.query
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-XSTORE', status: '已完成', service_date: '2024-06-01',
        assigned_employee_id: 'emp-other', client_user_id: 'cu-xstore',
        appointment_id: null, remark: '', started_at: null, completed_at: null,
        created_at: '2024-06-01', updated_at: '2024-06-01',
        store_id: 'store-OTHER', client_phone: '138',
      }])
      .mockResolvedValueOnce([{ bound_store_id: 'store-001' }]) // 顾客绑定本 scope → branch 3 只读放行
      .mockResolvedValueOnce([]) // items
      .mockResolvedValueOnce([{ name: '员工' }]) // staffName
      .mockResolvedValueOnce([{ name: '顾客A' }]) // customerName

    await serviceRoutes.detail(ctx)
    expect(ctx.result.serviceOrderId).toBe('HLD-XSTORE')
  })

  test('跨门店拒绝：服务单与顾客均不在本 scope → PERMISSION_DENIED', async () => {
    const ctx = createManagerCtx({ id: 'HLD-DENY' })

    pg.query
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-DENY', status: '已完成',
        assigned_employee_id: 'emp-other', client_user_id: 'cu-other',
        store_id: 'store-OTHER', client_phone: '138',
      }])
      .mockResolvedValueOnce([{ bound_store_id: 'store-OTHER' }]) // 顾客也不在本 scope

    await expect(serviceRoutes.detail(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })
})

// ============================================================
// service.counts
// ============================================================
describe('service.counts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('店长查看门店全部待服务/服务中计数', async () => {
    const ctx = createManagerCtx({})

    pg.query.mockResolvedValueOnce([
      { status: '待服务', cnt: 3 },
      { status: '服务中', cnt: 2 },
    ])

    await serviceRoutes.counts(ctx)

    expect(ctx.result.pending).toBe(3)
    expect(ctx.result.processing).toBe(2)
    // #224：门店门与 list 同口径；店长不被 AND 收窄到本人
    const sql = pg.query.mock.calls[0][0]
    expect(sql).toContain('(so.store_id = $1 OR so.assigned_employee_id = $2)')
    expect(sql).not.toContain('AND so.assigned_employee_id = $2')
  })

  test('美容师只看自己的服务单计数', async () => {
    const ctx = createBeauticianCtx({})

    pg.query.mockResolvedValueOnce([
      { status: '待服务', cnt: 1 },
    ])

    await serviceRoutes.counts(ctx)

    expect(ctx.result.pending).toBe(1)
    expect(ctx.result.processing).toBe(0) // 无服务中
    const sql = pg.query.mock.calls[0][0]
    expect(sql).toContain('assigned_employee_id')
    expect(pg.query.mock.calls[0][1]).toContain('emp-beautician-001')
  })

  test('无数据时返回全零', async () => {
    const ctx = createManagerCtx({})
    pg.query.mockResolvedValueOnce([])
    await serviceRoutes.counts(ctx)
    expect(ctx.result.pending).toBe(0)
    expect(ctx.result.processing).toBe(0)
  })
})

// ============================================================
// 参数校验边界
// ============================================================
describe('参数校验边界', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('start 缺少 serviceOrderId 时拒绝', async () => {
    const ctx = createManagerCtx({})
    await expect(serviceRoutes.start(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*serviceOrderId/)
  })

  test('complete 缺少 serviceOrderId 时拒绝', async () => {
    const ctx = createManagerCtx({})
    await expect(serviceRoutes.complete(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*serviceOrderId/)
  })

  test('cancel 缺少 serviceOrderId 时拒绝', async () => {
    const ctx = createManagerCtx({})
    await expect(serviceRoutes.cancel(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*serviceOrderId/)
  })

  test('start 服务单不存在时报错', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-NONEXIST' })
    pg.query.mockResolvedValueOnce([])
    await expect(serviceRoutes.start(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*不存在/)
  })

  test('complete 服务单不存在时报错', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-NONEXIST' })
    pg.query.mockResolvedValueOnce([])
    await expect(serviceRoutes.complete(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*不存在/)
  })

  test('cancel 服务单不存在时报错', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'HLD-NONEXIST' })
    pg.query.mockResolvedValueOnce([])
    await expect(serviceRoutes.cancel(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*不存在/)
  })

  test('complete 美容师不能操作非分配给自己的服务单', async () => {
    const ctx = createBeauticianCtx({ serviceOrderId: 'HLD-001' })
    pg.query.mockResolvedValueOnce([{
      service_order_id: 'HLD-001',
      status: '服务中',
      assigned_employee_id: 'emp-other',
      store_id: 'store-001',
    }])
    await expect(serviceRoutes.complete(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })
})

// ============================================================
// service.list 深层覆盖
// ============================================================
describe('service.list 深层覆盖', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('返回服务单列表含明细和姓名', async () => {
    const ctx = createManagerCtx({ page: 1, status: '待服务' })

    // 服务单主表
    pg.query.mockResolvedValueOnce([{
      service_order_id: 'HLD-001',
      status: '待服务',
      service_date: '2024-01-15',
      assigned_employee_id: 'emp-001',
      client_user_id: 'client-001',
      appointment_id: null,
      remark: '',
      started_at: null,
      completed_at: null,
      created_at: '2024-01-15T09:00:00Z',
      client_phone: '13800001111',
    }])
    // 服务明细
    .mockResolvedValueOnce([{
      service_order_id: 'HLD-001',
      product_name: '面部护理',
      remaining_sessions: 8,
      session_count: 10,
      service_duration: 60,
    }])
    // 员工姓名
    .mockResolvedValueOnce([{ employee_id: 'emp-001', name: '张三' }])
    // 顾客姓名（client_wechat_users）
    .mockResolvedValueOnce([{ user_id: 'client-001', name: '顾客A' }])

    await serviceRoutes.list(ctx)

    expect(ctx.result).toHaveLength(1)
    expect(ctx.result[0].staffName).toBe('张三')
    expect(ctx.result[0].customerName).toBe('顾客A')
    expect(ctx.result[0].items).toHaveLength(1)
    expect(ctx.result[0].items[0].itemName).toBe('面部护理')
    // 验证 status 过滤参数
    const params = pg.query.mock.calls[0][1]
    expect(params).toContain('待服务')
  })

  test('顾客姓名兜底从订单获取', async () => {
    const ctx = createManagerCtx({ page: 1 })

    pg.query
      .mockResolvedValueOnce([{
        service_order_id: 'HLD-001',
        status: '待服务',
        service_date: '2024-01-15',
        assigned_employee_id: null,
        client_user_id: 'client-noname',
        appointment_id: null,
        remark: '',
        started_at: null,
        completed_at: null,
        created_at: '2024-01-15T09:00:00Z',
        client_phone: null,
      }])
      .mockResolvedValueOnce([]) // 无明细
      // 顾客姓名 — name 为 null
      .mockResolvedValueOnce([{ user_id: 'client-noname', name: null }])
      // 兜底从 sale_orders 获取
      .mockResolvedValueOnce([{ client_user_id: 'client-noname', customer_name: '订单顾客' }])

    await serviceRoutes.list(ctx)

    expect(ctx.result[0].customerName).toBe('订单顾客')
  })
})

// ============================================================
// service.create clientUserId 解析分支
// ============================================================
describe('service.create clientUserId 解析', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pg.query.mockImplementation(async (sql, params) => {
      if (sql.includes('WHERE u.employee_id = ANY($1::text[])')) {
        return (params?.[0] || []).map(employee_id => ({ employee_id }))
      }
      return []
    })
  })

  test('通过 clientPhone 从 client_wechat_users 解析 clientUserId', async () => {
    const ctx = createManagerCtx({
      clientPhone: '13800001111',
      items: [{ saleItemId: 'item-001', sessionUsed: 1 }],
    })

    pg.query
      // 验证订单行
      .mockResolvedValueOnce([{
        sale_item_id: 'item-001',
        remaining_sessions: 10,
        unit_real_price: '100',
        product_type: '疗程卡',
        order_status: '已支付',
        store_id: 'store-001',
        client_user_id: null,
        client_phone: '13800001111',
      }])
      // 通过 clientPhone 查 client_wechat_users
      .mockResolvedValueOnce([{ user_id: 'resolved-user' }])
      // 顾客无进行中的服务单
      .mockResolvedValueOnce([])
      // became_member + bound_store_id（绑定门店校验：== effectiveStoreId）
      .mockResolvedValueOnce([{ became_member_at: null, bound_store_id: 'store-001' }])

    // 单一 transaction：generateServiceOrderId + INSERT 服务单 + 服务明细
    pg.transaction.mockImplementationOnce(async (cb) => {
      const client = {
        query: vi.fn(async (sql) => {
          if (typeof sql === 'string' && sql.includes('pg_advisory_xact_lock')) {
            return { rows: [], rowCount: 0 }
          }
          if (typeof sql === 'string' && /FROM service_orders[\s\S]*LIKE \$1/.test(sql)) {
            return { rows: [], rowCount: 0 } // generateServiceOrderId: no existing → seq=1
          }
          return { rows: [{ unit_real_price: '100' }], rowCount: 1 }
        }),
      }
      await cb(client)
      // 验证 INSERT service_orders 的 client_user_id 参数（参数列表第 8 项，索引 [7]）
      const insertCall = client.query.mock.calls.find(c =>
        typeof c[0] === 'string' && c[0].includes('INSERT INTO service_orders'))
      expect(insertCall).toBeDefined()
      expect(insertCall[1][7]).toBe('resolved-user')
    })

    await serviceRoutes.create(ctx)
    expect(ctx.result.status).toBe('待服务')
  })

  test('从 sale_orders 兜底解析 clientUserId', async () => {
    const ctx = createManagerCtx({
      // 不传 clientUserId 也不传 clientPhone
      items: [{ saleItemId: 'item-001', sessionUsed: 1 }],
    })

    pg.query
      // 验证订单行
      .mockResolvedValueOnce([{
        sale_item_id: 'item-001',
        remaining_sessions: 10,
        unit_real_price: '100',
        product_type: '疗程卡',
        order_status: '已支付',
        store_id: 'store-001',
        client_user_id: null,
        client_phone: null,
      }])
      // 从 sale_orders 兜底获取 client_user_id
      .mockResolvedValueOnce([{ client_user_id: 'fallback-user' }])
      // 顾客无进行中的服务单
      .mockResolvedValueOnce([])
      // became_member + bound_store_id（绑定门店校验：== effectiveStoreId）
      .mockResolvedValueOnce([{ became_member_at: null, bound_store_id: 'store-001' }])

    // 单一 transaction：generateServiceOrderId + INSERT 服务单 + 服务明细
    pg.transaction.mockImplementationOnce(async (cb) => {
      const client = {
        query: vi.fn(async (sql) => {
          if (typeof sql === 'string' && sql.includes('pg_advisory_xact_lock')) {
            return { rows: [], rowCount: 0 }
          }
          if (typeof sql === 'string' && /FROM service_orders[\s\S]*LIKE \$1/.test(sql)) {
            return { rows: [], rowCount: 0 } // generateServiceOrderId: no existing → seq=1
          }
          return { rows: [{ unit_real_price: '100' }], rowCount: 1 }
        }),
      }
      await cb(client)
      const insertCall = client.query.mock.calls.find(c =>
        typeof c[0] === 'string' && c[0].includes('INSERT INTO service_orders'))
      expect(insertCall).toBeDefined()
      expect(insertCall[1][7]).toBe('fallback-user')
    })

    await serviceRoutes.create(ctx)
    expect(ctx.result.status).toBe('待服务')
  })

  test('saleItemId 不存在时拒绝', async () => {
    const ctx = createManagerCtx({
      items: [{ saleItemId: 'item-nonexist', sessionUsed: 1 }],
    })

    pg.query.mockResolvedValueOnce([]) // 查不到

    await expect(serviceRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*不存在/)
  })

  test('缺少 saleItemId 字段时拒绝', async () => {
    const ctx = createManagerCtx({
      items: [{ sessionUsed: 1 }], // 无 saleItemId
    })

    await expect(serviceRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*saleItemId/)
  })

  test('sessionUsed 为负数时拒绝', async () => {
    const ctx = createManagerCtx({
      items: [{ saleItemId: 'item-001', sessionUsed: -1 }],
    })

    await expect(serviceRoutes.create(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*本次使用次数必须大于 0/)
  })
})

// ============================================================
// #224 外援跨店支援单：可见 + 可开始/完成，取消仍归开单门店
//
// 场景：外援本人 effectiveStoreId=store-001，被指派到 store-SUPPORT 的服务单。
// 放行判据一律是 assigned_employee_id = 本人，不重算「锚定市场 + is_on_business_trip」。
// ============================================================
describe('#224 跨店支援单可见性与操作权限', () => {
  const SUPPORT_STORE = 'store-SUPPORT'
  const ME = 'emp-beautician-001'

  // 指派给本人、但开在别的门店的服务单
  const supportOrderRow = (overrides = {}) => ({
    service_order_id: 'HLD-SUPPORT',
    status: '待服务',
    service_date: '2026-09-21',
    assigned_employee_id: ME,
    client_user_id: 'cu-support',
    appointment_id: null,
    remark: '',
    started_at: null,
    completed_at: null,
    created_at: '2026-09-21',
    updated_at: '2026-09-21',
    store_id: SUPPORT_STORE,
    store_name: '支援门店',
    client_phone: '13800001111',
    ...overrides,
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('list', () => {
    test('非店长：门店门放宽为 OR，且仍被 AND 收死在指派给自己', async () => {
      const ctx = createBeauticianCtx({ page: 1 })
      pg.query.mockResolvedValueOnce([])

      await serviceRoutes.list(ctx)

      const [sql, params] = pg.query.mock.calls[0]
      expect(sql).toContain('(so.store_id = $1 OR so.assigned_employee_id = $2)')
      expect(sql).toContain('AND so.assigned_employee_id = $2')
      // $1/$2 固定占位，不因 status/keyword 等动态条件而错位
      expect(params[0]).toBe('store-001')
      expect(params[1]).toBe(ME)
    })

    test('非店长 + 状态过滤：动态参数从 $3 起，不与固定占位撞号', async () => {
      const ctx = createBeauticianCtx({ status: '服务中', page: 1 })
      pg.query.mockResolvedValueOnce([])

      await serviceRoutes.list(ctx)

      const [sql, params] = pg.query.mock.calls[0]
      expect(sql).toContain('so.status = $3')
      expect(params[2]).toBe('服务中')
    })

    test('支援单返回 isSupport=true + 开单门店名', async () => {
      const ctx = createBeauticianCtx({ page: 1 })
      pg.query
        .mockResolvedValueOnce([supportOrderRow()])
        .mockResolvedValueOnce([]) // items
        .mockResolvedValueOnce([{ employee_id: ME, name: '外援甲' }])
        .mockResolvedValueOnce([{ user_id: 'cu-support', name: '顾客A' }])

      await serviceRoutes.list(ctx)

      expect(ctx.result[0].isSupport).toBe(true)
      expect(ctx.result[0].storeId).toBe(SUPPORT_STORE)
      expect(ctx.result[0].storeName).toBe('支援门店')
    })

    test('本店单 isSupport=false（不误标）', async () => {
      const ctx = createBeauticianCtx({ page: 1 })
      pg.query
        .mockResolvedValueOnce([supportOrderRow({ store_id: 'store-001', store_name: '测试店' })])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ employee_id: ME, name: '本店美容师' }])
        .mockResolvedValueOnce([{ user_id: 'cu-support', name: '顾客A' }])

      await serviceRoutes.list(ctx)

      expect(ctx.result[0].isSupport).toBe(false)
    })

    test('管理层模式 isSupport 恒 false（监管视角无支援语义）', async () => {
      const ctx = createManagementCtx({ page: 1 })
      pg.query
        .mockResolvedValueOnce([supportOrderRow({ assigned_employee_id: 'emp-001' })])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ employee_id: 'emp-001', name: '员工' }])
        .mockResolvedValueOnce([{ user_id: 'cu-support', name: '顾客A' }])

      await serviceRoutes.list(ctx)

      expect(ctx.result[0].isSupport).toBe(false)
    })
  })

  describe('counts', () => {
    test('非店长与 list 同口径，保证角标数与列表条数一致', async () => {
      const ctx = createBeauticianCtx({})
      pg.query.mockResolvedValueOnce([{ status: '待服务', cnt: 2 }])

      await serviceRoutes.counts(ctx)

      const [sql, params] = pg.query.mock.calls[0]
      expect(sql).toContain('(so.store_id = $1 OR so.assigned_employee_id = $2)')
      expect(sql).toContain('AND so.assigned_employee_id = $2')
      expect(params).toEqual(['store-001', ME])
      expect(ctx.result.pending).toBe(2)
    })
  })

  describe('detail', () => {
    test('外援可查看指派给自己的支援单（不落到顾客 scope 兜底分支）', async () => {
      const ctx = createBeauticianCtx({ id: 'HLD-SUPPORT' })
      pg.query
        .mockResolvedValueOnce([supportOrderRow({ status: '服务中' })])
        .mockResolvedValueOnce([]) // items
        .mockResolvedValueOnce([{ name: '外援甲' }])
        .mockResolvedValueOnce([{ name: '顾客A' }])

      await serviceRoutes.detail(ctx)

      expect(ctx.result.serviceOrderId).toBe('HLD-SUPPORT')
      expect(ctx.result.isSupport).toBe(true)
      expect(ctx.result.storeName).toBe('支援门店')
      // 第 2 次查询应是 service_items，而非 client_wechat_users 可见性兜底
      expect(pg.query.mock.calls[1][0]).toContain('FROM service_items')
    })

    test('支援门店里未指派给本人的单仍拒绝', async () => {
      const ctx = createBeauticianCtx({ id: 'HLD-OTHER' })
      pg.query
        .mockResolvedValueOnce([supportOrderRow({ service_order_id: 'HLD-OTHER', assigned_employee_id: 'emp-other' })])
        .mockResolvedValueOnce([{ bound_store_id: SUPPORT_STORE, bound_employee_id: 'emp-other' }])

      await expect(serviceRoutes.detail(ctx))
        .rejects.toThrow(/PERMISSION_DENIED/)
    })
  })

  describe('start / complete', () => {
    test('start：第一道门放行支援单（SQL 带 OR assigned + 三个参数）', async () => {
      const ctx = createBeauticianCtx({ serviceOrderId: 'HLD-SUPPORT' })
      pg.query.mockResolvedValueOnce([supportOrderRow()])
      const clientQuery = vi.fn(async (sql) => {
        if (sql.includes('FROM service_items sit')) {
          return { rows: [{ sale_item_id: 'item-001', session_used: 1 }], rowCount: 1 }
        }
        if (sql.includes('FROM sale_items') && sql.includes('FOR UPDATE')) {
          return { rows: [{ sale_item_id: 'item-001', remaining_sessions: 2, session_count: 2, paid_sessions: 2, product_type: '疗程卡' }], rowCount: 1 }
        }
        if (sql.includes('GROUP BY reserved_item.sale_item_id')) return { rows: [], rowCount: 0 }
        return { rows: [], rowCount: 1 }
      })
      pg.transaction.mockImplementationOnce(async (cb) => await cb({ query: clientQuery }))

      await serviceRoutes.start(ctx)

      expect(ctx.result.status).toBe('服务中')
      const [sql, params] = pg.query.mock.calls[0]
      expect(sql).toContain('(store_id = $2 OR assigned_employee_id = $3)')
      expect(params).toEqual(['HLD-SUPPORT', 'store-001', ME])
    })

    test('complete：支援单可标记完成，流转到待客户确认', async () => {
      const ctx = createBeauticianCtx({ serviceOrderId: 'HLD-SUPPORT' })
      pg.query.mockResolvedValueOnce([supportOrderRow({ status: '服务中' })])
      pg.transaction.mockImplementationOnce(async (cb) => await cb({
        query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
      }))

      await serviceRoutes.complete(ctx)

      expect(ctx.result.status).toBe('待客户确认')
      expect(pg.query.mock.calls[0][0]).toContain('(store_id = $2 OR assigned_employee_id = $3)')
    })

    test('第二道门仍生效：支援门店里他人的单，非店长不可操作', async () => {
      const ctx = createBeauticianCtx({ serviceOrderId: 'HLD-OTHER' })
      // 第一道门此时只可能因 store_id 命中（他人单不会因 assigned 命中），构造为本店他人单
      pg.query.mockResolvedValueOnce([supportOrderRow({
        service_order_id: 'HLD-OTHER', store_id: 'store-001', assigned_employee_id: 'emp-other',
      })])

      await expect(serviceRoutes.start(ctx))
        .rejects.toThrow(/PERMISSION_DENIED/)
    })
  })

  describe('cancel（口径：仍仅开单门店）', () => {
    test('外援取消支援单被拒，且给出准确原因而非「不存在」', async () => {
      const ctx = createBeauticianCtx({ serviceOrderId: 'HLD-SUPPORT' })
      pg.query
        .mockResolvedValueOnce([])                 // 门店门 0 行
        .mockResolvedValueOnce([{ '?column?': 1 }]) // 探测：确为指派给本人的支援单

      await expect(serviceRoutes.cancel(ctx))
        .rejects.toThrow(/PERMISSION_DENIED.*支援服务单需由开单门店取消/)

      // 探测查询必须同时绑定 serviceOrderId + 本人工号，不得泄露他人单
      expect(pg.query.mock.calls[1][1]).toEqual(['HLD-SUPPORT', ME])
    })

    test('单真不存在时仍是 INVALID_PARAMS（不被支援分支吞掉）', async () => {
      const ctx = createBeauticianCtx({ serviceOrderId: 'HLD-NONE' })
      pg.query
        .mockResolvedValueOnce([]) // 门店门 0 行
        .mockResolvedValueOnce([]) // 探测也 0 行

      await expect(serviceRoutes.cancel(ctx))
        .rejects.toThrow(/INVALID_PARAMS.*不存在/)
    })

    test('本店单取消不受影响（零回归）', async () => {
      const ctx = createBeauticianCtx({ serviceOrderId: 'HLD-LOCAL' })
      pg.query.mockResolvedValueOnce([supportOrderRow({
        service_order_id: 'HLD-LOCAL', store_id: 'store-001', status: '待服务',
      })])
      pg.transaction.mockImplementationOnce(async (cb) => await cb({
        query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
      }))

      await serviceRoutes.cancel(ctx)

      expect(ctx.result.status).toBe('已取消')
      // 未走探测分支
      expect(pg.query.mock.calls).toHaveLength(1)
    })
  })

  describe('confirm（口径：仍由开单门店店长执行）', () => {
    test('外援所属门店店长确认不到支援单（门店门未放宽）', async () => {
      const ctx = createManagerCtx({ serviceOrderId: 'HLD-SUPPORT' })
      pg.query.mockResolvedValueOnce([]) // store_id = effectiveStoreId 不命中

      await expect(serviceRoutes.confirm(ctx))
        .rejects.toThrow(/INVALID_PARAMS.*不属于本门店/)

      expect(pg.query.mock.calls[0][0]).toContain('AND store_id = $2')
      expect(pg.query.mock.calls[0][0]).not.toContain('assigned_employee_id')
    })
  })
})
