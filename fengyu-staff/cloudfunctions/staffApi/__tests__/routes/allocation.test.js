/**
 * 营业额分配路由测试
 * 覆盖：save / deleteAllocation / pendingList
 * 核心约束：
 *   - 仅已支付订单可分配
 *   - 仅店长可操作
 *   - 空分配标记为"无需分配"
 *   - saleItemId 必须属于该订单
 */



const pg = globalThis.__mocks__.pg
const { createManagerCtx, createBeauticianCtx } = require('../helpers')
const allocationRoutes = require('../../routes/allocation')

describe('allocation.save', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('保存提成分配成功', async () => {
    const ctx = createManagerCtx({
      saleOrderId: 'FY-001',
      allocations: [
        {
          saleItemId: 'item-001',
          employeeId: 'emp-b1',
          departmentName: '美容部',
          allocationRatio: 0.3,
          totalAmount: 300,
        },
      ],
    })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-001',
        status: '已支付',
        allocation_status: 'pending',
        store_id: 'store-001',
      }])
      .mockResolvedValueOnce([
        { sale_item_id: 'item-001', received: '1000' },
      ])

    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
      }
      return await cb(client)
    })

    await allocationRoutes.save(ctx)

    expect(ctx.result.saleOrderId).toBe('FY-001')
    expect(ctx.result.allocationCount).toBe(1)
    expect(pg.transaction).toHaveBeenCalled()
  })

  test('空分配 — 标记为无需分配', async () => {
    const ctx = createManagerCtx({
      saleOrderId: 'FY-001',
      allocations: [],
    })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-001',
        status: '已支付',
        allocation_status: 'pending',
        store_id: 'store-001',
      }])
      .mockResolvedValueOnce([
        { sale_item_id: 'item-001', received: '1000' },
      ])

    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      }
      return await cb(client)
    })

    await allocationRoutes.save(ctx)

    expect(ctx.result.allocationCount).toBe(0)
    expect(ctx.result.message).toContain('无需分配')
  })

  test('非店长拒绝操作', async () => {
    const ctx = createBeauticianCtx({
      saleOrderId: 'FY-001',
      allocations: [],
    })

    await expect(allocationRoutes.save(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('非已支付订单拒绝分配', async () => {
    const ctx = createManagerCtx({
      saleOrderId: 'FY-001',
      allocations: [{ saleItemId: 'item-001', employeeId: 'emp-b1' }],
    })

    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '待支付',
      allocation_status: null,
      store_id: 'store-001',
    }])

    await expect(allocationRoutes.save(ctx))
      .rejects.toThrow(/仅已支付订单/)
  })

  test('saleItemId 不属于订单时拒绝', async () => {
    const ctx = createManagerCtx({
      saleOrderId: 'FY-001',
      allocations: [
        { saleItemId: 'item-wrong', employeeId: 'emp-b1' },
      ],
    })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-001',
        status: '已支付',
        allocation_status: 'pending',
        store_id: 'store-001',
      }])
      .mockResolvedValueOnce([
        { sale_item_id: 'item-001', received: '1000' },
      ])

    await expect(allocationRoutes.save(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*item-wrong.*不属于/)
  })

  test('allocations 非数组时拒绝', async () => {
    const ctx = createManagerCtx({
      saleOrderId: 'FY-001',
      allocations: 'not-array',
    })

    await expect(allocationRoutes.save(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*allocations/)
  })

  test('分配记录缺少 employeeId 时拒绝', async () => {
    const ctx = createManagerCtx({
      saleOrderId: 'FY-001',
      allocations: [{ saleItemId: 'item-001' }],
    })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-001',
        status: '已支付',
        allocation_status: 'pending',
        store_id: 'store-001',
      }])
      .mockResolvedValueOnce([
        { sale_item_id: 'item-001', received: '1000' },
      ])

    await expect(allocationRoutes.save(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*employeeId/)
  })

  test('缺少 saleOrderId 时拒绝（line 34 TRUE 分支）', async () => {
    const ctx = createManagerCtx({ allocations: [] })
    await expect(allocationRoutes.save(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*saleOrderId/)
  })

  test('订单不存在时拒绝（line 47 TRUE 分支）', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-NONEXIST', allocations: [] })
    pg.query.mockResolvedValueOnce([])
    await expect(allocationRoutes.save(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*不存在/)
  })

  test('订单分配状态异常时拒绝（line 56 TRUE 分支）', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-001', allocations: [] })
    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '已支付',
      allocation_status: 'done', // 非 pending/allocated → 异常
      store_id: 'store-001',
    }])
    await expect(allocationRoutes.save(ctx))
      .rejects.toThrow(/PERMISSION_DENIED.*分配状态异常/)
  })

  test('空分配且订单无明细时直接更新状态（line 73 FALSE 分支）', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-001', allocations: [] })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-001',
        status: '已支付',
        allocation_status: 'pending',
        store_id: 'store-001',
      }])
      .mockResolvedValueOnce([]) // 空 orderItems → itemIds.length === 0 → 跳过 DELETE

    pg.transaction.mockImplementation(async (cb) => {
      const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) }
      return await cb(client)
    })

    await allocationRoutes.save(ctx)

    expect(ctx.result.allocationCount).toBe(0)
    expect(ctx.result.message).toContain('无需分配')
  })

  test('分配记录缺少 saleItemId 时拒绝（line 90 TRUE 分支）', async () => {
    const ctx = createManagerCtx({
      saleOrderId: 'FY-001',
      allocations: [{ employeeId: 'emp-001' }], // 无 saleItemId
    })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-001',
        status: '已支付',
        allocation_status: 'pending',
        store_id: 'store-001',
      }])
      .mockResolvedValueOnce([{ sale_item_id: 'item-001', received: '1000' }])

    await expect(allocationRoutes.save(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*saleItemId/)
  })

  test('分配记录缺省字段使用默认值（lines 122-124）', async () => {
    // alloc 不提供 departmentName / allocationRatio / totalAmount
    const ctx = createManagerCtx({
      saleOrderId: 'FY-001',
      allocations: [{ saleItemId: 'item-001', employeeId: 'emp-001' }],
    })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-001',
        status: '已支付',
        allocation_status: 'pending',
        store_id: 'store-001',
      }])
      .mockResolvedValueOnce([{ sale_item_id: 'item-001', received: '1000' }])

    let capturedInsertParams = null
    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn(async (sql, params) => {
          if (sql && sql.includes('INSERT INTO sale_allocations')) capturedInsertParams = params
          return { rows: [], rowCount: 1 }
        }),
      }
      return await cb(client)
    })

    await allocationRoutes.save(ctx)

    // $3=departmentName(null), $4=allocationRatio(1.0), $5=totalAmount(0)
    expect(capturedInsertParams[2]).toBeNull()
    expect(capturedInsertParams[3]).toBe(1.0)
    expect(capturedInsertParams[4]).toBe(0)
  })
})

describe('allocation.deleteAllocation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('删除分配记录 — 重置为 pending', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-001' })

    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '已支付',
      allocation_status: 'allocated',
    }])

    pg.transaction.mockImplementation(async (cb) => {
      const client = {
        query: vi.fn()
          .mockResolvedValueOnce({ rows: [{ sale_item_id: 'item-1' }] })
          .mockResolvedValueOnce({ rows: [], rowCount: 1 })
          .mockResolvedValueOnce({ rows: [], rowCount: 1 }),
      }
      return await cb(client)
    })

    await allocationRoutes.deleteAllocation(ctx)

    expect(ctx.result.message).toContain('已清除')
  })

  test('非已支付订单拒绝操作', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-001' })

    pg.query.mockResolvedValueOnce([{
      sale_order_id: 'FY-001',
      status: '已关闭',
      allocation_status: null,
    }])

    await expect(allocationRoutes.deleteAllocation(ctx))
      .rejects.toThrow(/仅已支付订单/)
  })

  test('非店长拒绝操作', async () => {
    const ctx = createBeauticianCtx({ saleOrderId: 'FY-001' })

    await expect(allocationRoutes.deleteAllocation(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })
})

describe('allocation.pendingList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('返回待分配订单列表', async () => {
    const ctx = createManagerCtx({ page: 1, pageSize: 10 })

    pg.query.mockResolvedValueOnce([
      { sale_order_id: 'FY-001', status: '已支付', allocation_status: 'pending' },
      { sale_order_id: 'FY-002', status: '已支付', allocation_status: 'pending' },
    ])

    await allocationRoutes.pendingList(ctx)

    expect(ctx.result.orders).toHaveLength(2)
    expect(ctx.result.page).toBe(1)
  })

  test('非店长拒绝查看', async () => {
    const ctx = createBeauticianCtx({ page: 1 })

    await expect(allocationRoutes.pendingList(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })
})

// ============================================================
// allocation.getCommissionRates
// ============================================================
describe('allocation.getCommissionRates', () => {
  beforeEach(() => { vi.clearAllMocks() })

  test('返回提成比例矩阵（PG 扁平行 pivot 为 department 分组）', async () => {
    const ctx = createManagerCtx({ marketName: '华东市场' })

    pg.query.mockResolvedValueOnce([
      { role_type: '美容部', order_type: 'sale', sales_category: '自采自销', amount_tier_min: '0', amount_tier_max: '5000', commission_rate: '0.3000' },
      { role_type: '美容部', order_type: 'sale', sales_category: '他销自耗', amount_tier_min: '0', amount_tier_max: '5000', commission_rate: '0.2000' },
      { role_type: '美容部', order_type: 'service', sales_category: '自采自销', amount_tier_min: '0', amount_tier_max: '5000', commission_rate: '0.2500' },
    ])

    await allocationRoutes.getCommissionRates(ctx)

    expect(ctx.result.rates).toHaveLength(1)
    expect(ctx.result.rates[0].department).toBe('美容部')
    expect(ctx.result.rates[0].orderRates['自采自销']).toBe(0.3)
    expect(ctx.result.rates[0].orderRates['他销自耗']).toBe(0.2)
    expect(ctx.result.rates[0].serviceRates['自采自销']).toBe(0.25)
    expect(ctx.result.rates[0].amountMin).toBe(0)
    expect(ctx.result.rates[0].amountMax).toBe(5000)
  })

  test('市场不存在时抛出错误', async () => {
    const ctx = createManagerCtx({ marketName: '不存在市场' })
    pg.query.mockResolvedValueOnce([])
    await expect(allocationRoutes.getCommissionRates(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*未找到市场/)
  })

  test('缺少 marketName 参数时拒绝', async () => {
    const ctx = createManagerCtx({})
    await expect(allocationRoutes.getCommissionRates(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*marketName/)
  })

  test('非店长拒绝操作', async () => {
    const ctx = createBeauticianCtx({ marketName: '华东市场' })
    await expect(allocationRoutes.getCommissionRates(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('null amount_tier_max 使用默认值', async () => {
    const ctx = createManagerCtx({ marketName: '华东市场' })

    pg.query.mockResolvedValueOnce([
      { role_type: '养生部', order_type: 'sale', sales_category: '自采自销', amount_tier_min: null, amount_tier_max: null, commission_rate: '0' },
    ])

    await allocationRoutes.getCommissionRates(ctx)

    expect(ctx.result.rates[0].department).toBe('养生部')
    expect(ctx.result.rates[0].amountMin).toBe(-9999.9)
    expect(ctx.result.rates[0].amountMax).toBe(10000000)
    expect(ctx.result.rates[0].orderRates['自采自销']).toBe(0)
  })

  test('美容部和养生部分别返回不同比例', async () => {
    const ctx = createManagerCtx({ marketName: '华东市场' })

    pg.query.mockResolvedValueOnce([
      { role_type: '美容部', order_type: 'sale', sales_category: '自采自销', amount_tier_min: '0', amount_tier_max: '99999', commission_rate: '0.3000' },
      { role_type: '养生部', order_type: 'sale', sales_category: '自采自销', amount_tier_min: '0', amount_tier_max: '99999', commission_rate: '0.2000' },
    ])

    await allocationRoutes.getCommissionRates(ctx)

    expect(ctx.result.rates).toHaveLength(2)
    const beauty = ctx.result.rates.find(r => r.department === '美容部')
    const wellness = ctx.result.rates.find(r => r.department === '养生部')
    expect(beauty.orderRates['自采自销']).toBe(0.3)
    expect(wellness.orderRates['自采自销']).toBe(0.2)
  })
})

// ============================================================
// allocation.suggest
// ============================================================
describe('allocation.suggest', () => {
  beforeEach(() => { vi.clearAllMocks() })

  test('返回分配建议（含指定美容师，PG 提成比例）', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-001' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-001', status: '已支付', allocation_status: 'pending',
        store_id: 'store-001', market_name: '华东市场',
        sale_order_source: 'staff', preferred_employee_id: 'emp-b1',
        client_phone: '13800001111', customer_name: '张三',
      }])
      .mockResolvedValueOnce([{ employee_id: 'emp-b1', name: '李四', department: '美容部' }])
      .mockResolvedValueOnce([{ cnt: 0 }])
      .mockResolvedValueOnce([
        { sale_item_id: 'item-001', received: '1000', sales_category: '自采自销', product_name: '面部护理', sku_spec_name: '基础款', product_type: '疗程卡' },
      ])
      // 6. PG 提成比例
      .mockResolvedValueOnce([
        { role_type: '美容部', sales_category: '自采自销', amount_tier_min: '0', amount_tier_max: '99999', commission_rate: '0.3000' },
        { role_type: '美容部', sales_category: '他销自耗', amount_tier_min: '0', amount_tier_max: '99999', commission_rate: '0.2000' },
      ])

    await allocationRoutes.suggest(ctx)

    expect(ctx.result.isNewCustomer).toBe(true)
    expect(ctx.result.beauticianInfo.staffWfId).toBe('emp-b1')
    expect(ctx.result.deptAnomalous).toBe(false)
    expect(ctx.result.allocLines).toHaveLength(1)
    expect(ctx.result.allocLines[0].commissionRate).toBe(0.3)
    expect(ctx.result.allocLines[0].amount).toBe('300.00')
    expect(ctx.result.totalAmount).toBe(1000)
  })

  test('无指定美容师时 allocLines 为空', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-002' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-002', status: '已支付', allocation_status: 'pending',
        store_id: 'store-001', market_name: '华东市场',
        sale_order_source: 'staff', preferred_employee_id: null,
        client_phone: '13800001111', customer_name: '张三',
      }])
      .mockResolvedValueOnce([{ cnt: 3 }])
      .mockResolvedValueOnce([
        { sale_item_id: 'item-001', received: '500', sales_category: '自采自销', product_name: 'P1', sku_spec_name: 'S1', product_type: '单品' },
      ])
      .mockResolvedValueOnce([])  // 无提成配置

    await allocationRoutes.suggest(ctx)

    expect(ctx.result.beauticianInfo).toBeNull()
    expect(ctx.result.allocLines).toEqual([])
    expect(ctx.result.isNewCustomer).toBe(false)
  })

  test('部门异常标记 deptAnomalous', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-003' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-003', status: '已支付', allocation_status: 'pending',
        store_id: 'store-001', market_name: '华东市场',
        sale_order_source: 'staff', preferred_employee_id: 'emp-b2',
        client_phone: '13800001111', customer_name: '张三',
      }])
      .mockResolvedValueOnce([{ employee_id: 'emp-b2', name: '王五', department: '咨询部' }])
      .mockResolvedValueOnce([{ cnt: 0 }])
      .mockResolvedValueOnce([
        { sale_item_id: 'item-001', received: '500', sales_category: '自采自销', product_name: 'P1', sku_spec_name: 'S1', product_type: '单品' },
      ])
      .mockResolvedValueOnce([])

    await allocationRoutes.suggest(ctx)

    expect(ctx.result.deptAnomalous).toBe(true)
    expect(ctx.result.allocLines).toEqual([])
  })

  test('缺少 saleOrderId 时拒绝', async () => {
    const ctx = createManagerCtx({})
    await expect(allocationRoutes.suggest(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*saleOrderId/)
  })

  test('订单不存在时拒绝', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-NONEXIST' })
    pg.query.mockResolvedValueOnce([])
    await expect(allocationRoutes.suggest(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*订单不存在/)
  })

  test('非店长拒绝操作', async () => {
    const ctx = createBeauticianCtx({ saleOrderId: 'FY-001' })
    await expect(allocationRoutes.suggest(ctx))
      .rejects.toThrow(/PERMISSION_DENIED/)
  })

  test('market_name 为空时 rates 为空数组', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-004' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-004', status: '已支付', allocation_status: 'pending',
        store_id: 'store-001', market_name: '',
        sale_order_source: 'staff', preferred_employee_id: null,
        client_phone: '13800001111', customer_name: '张三',
      }])
      .mockResolvedValueOnce([{ cnt: 0 }])
      .mockResolvedValueOnce([
        { sale_item_id: 'item-001', received: '500', sales_category: '自采自销', product_name: 'P1', sku_spec_name: 'S1', product_type: '单品' },
      ])

    await allocationRoutes.suggest(ctx)

    expect(ctx.result.rates).toEqual([])
    expect(ctx.result.allocLines).toEqual([])
  })
})
