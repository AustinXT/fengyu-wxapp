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
  const mssql = globalThis.__mocks__.mssql

  beforeEach(() => {
    vi.clearAllMocks()
    // 重置 mssql mock 链
    mssql._mockRequest.input.mockReturnThis()
  })

  test('返回提成比例矩阵', async () => {
    const ctx = createManagerCtx({ marketName: '华东市场' })

    // master 查询
    mssql._mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ RID: 100 }] })
      // detail 查询
      .mockResolvedValueOnce({
        recordset: [
          {
            department: '美容部',
            amount_min: 0, amount_max: 5000,
            order_self_sell: 0.3, order_other_sell_self_use: 0.2,
            order_other_sell_other_use: 0.1, order_eco_coop: 0.05,
            service_self_sell: 0.25, service_other_sell_self_use: 0.15,
            service_other_sell_other_use: 0.1, service_eco_coop: 0.05,
          },
        ],
      })

    await allocationRoutes.getCommissionRates(ctx)

    expect(ctx.result.rates).toHaveLength(1)
    expect(ctx.result.rates[0].department).toBe('美容部')
    expect(ctx.result.rates[0].orderRates['自采自销']).toBe(0.3)
    expect(ctx.result.rates[0].serviceRates['自采自销']).toBe(0.25)
    expect(ctx.result.rates[0].amountMin).toBe(0)
    expect(ctx.result.rates[0].amountMax).toBe(5000)
  })

  test('市场不存在时抛出错误', async () => {
    const ctx = createManagerCtx({ marketName: '不存在市场' })

    mssql._mockRequest.query.mockResolvedValueOnce({ recordset: [] })

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

  test('null 值字段使用默认值', async () => {
    const ctx = createManagerCtx({ marketName: '华东市场' })

    mssql._mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ RID: 100 }] })
      .mockResolvedValueOnce({
        recordset: [{
          department: '  养生部  ',
          amount_min: null, amount_max: null,
          order_self_sell: null, order_other_sell_self_use: null,
          order_other_sell_other_use: null, order_eco_coop: null,
          service_self_sell: null, service_other_sell_self_use: null,
          service_other_sell_other_use: null, service_eco_coop: null,
        }],
      })

    await allocationRoutes.getCommissionRates(ctx)

    expect(ctx.result.rates[0].department).toBe('养生部')
    expect(ctx.result.rates[0].amountMin).toBe(-9999.9)
    expect(ctx.result.rates[0].amountMax).toBe(10000000)
    expect(ctx.result.rates[0].orderRates['自采自销']).toBe(0)
  })
})

// ============================================================
// allocation.suggest
// ============================================================
describe('allocation.suggest', () => {
  const mssql = globalThis.__mocks__.mssql

  beforeEach(() => {
    vi.clearAllMocks()
    mssql._mockRequest.input.mockReturnThis()
  })

  test('返回分配建议（含指定美容师）', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-001' })

    // 1. 加载订单
    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-001', status: '已支付', allocation_status: 'pending',
        store_id: 'store-001', market_name: '华东市场',
        sale_order_source: 'staff', preferred_employee_id: 'emp-b1',
        client_phone: '13800001111', customer_name: '张三',
      }])
      // 2. resolveStaffDepartment
      .mockResolvedValueOnce([{
        employee_id: 'emp-b1', name: '李四', department: '美容部',
      }])
      // 3. checkNewCustomer
      .mockResolvedValueOnce([{ cnt: 0 }])
      // 5. 加载订单项
      .mockResolvedValueOnce([
        { sale_item_id: 'item-001', received: '1000', sales_category: '自采自销', product_name: '面部护理', sku_spec_name: '基础款', product_type: '疗程卡' },
      ])

    // 6. WorkFine 提成比例
    mssql._mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ RID: 100 }] })
      .mockResolvedValueOnce({
        recordset: [{
          department: '美容部', amount_min: 0, amount_max: 99999,
          order_self_sell: 0.3, order_other_sell_self_use: 0.2,
          order_other_sell_other_use: 0.1, order_eco_coop: 0.05,
        }],
      })

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
      // checkNewCustomer
      .mockResolvedValueOnce([{ cnt: 3 }])
      // 订单项
      .mockResolvedValueOnce([
        { sale_item_id: 'item-001', received: '500', sales_category: '自采自销', product_name: 'P1', sku_spec_name: 'S1', product_type: '单品' },
      ])

    mssql._mockRequest.query.mockResolvedValueOnce({ recordset: [] })

    await allocationRoutes.suggest(ctx)

    expect(ctx.result.beauticianInfo).toBeNull()
    expect(ctx.result.allocLines).toEqual([])
    expect(ctx.result.isNewCustomer).toBe(false)
  })

  test('部门异常（非美容部/养生部）标记 deptAnomalous', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-003' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-003', status: '已支付', allocation_status: 'pending',
        store_id: 'store-001', market_name: '华东市场',
        sale_order_source: 'staff', preferred_employee_id: 'emp-b2',
        client_phone: '13800001111', customer_name: '张三',
      }])
      // resolveStaffDepartment — 部门为"咨询部"
      .mockResolvedValueOnce([{
        employee_id: 'emp-b2', name: '王五', department: '咨询部',
      }])
      .mockResolvedValueOnce([{ cnt: 0 }])
      .mockResolvedValueOnce([
        { sale_item_id: 'item-001', received: '500', sales_category: '自采自销', product_name: 'P1', sku_spec_name: 'S1', product_type: '单品' },
      ])

    mssql._mockRequest.query.mockResolvedValueOnce({ recordset: [] })

    await allocationRoutes.suggest(ctx)

    expect(ctx.result.deptAnomalous).toBe(true)
    expect(ctx.result.allocLines).toEqual([]) // 无匹配部门，不生成分配行
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

  test('WorkFine 连接失败时降级返回空 rates', async () => {
    const ctx = createManagerCtx({ saleOrderId: 'FY-004' })

    pg.query
      .mockResolvedValueOnce([{
        sale_order_id: 'FY-004', status: '已支付', allocation_status: 'pending',
        store_id: 'store-001', market_name: '华东市场',
        sale_order_source: 'staff', preferred_employee_id: null,
        client_phone: '13800001111', customer_name: '张三',
      }])
      .mockResolvedValueOnce([{ cnt: 0 }])
      .mockResolvedValueOnce([
        { sale_item_id: 'item-001', received: '500', sales_category: '自采自销', product_name: 'P1', sku_spec_name: 'S1', product_type: '单品' },
      ])

    // WorkFine 抛异常
    mssql.getPool.mockRejectedValueOnce(new Error('MSSQL connection failed'))

    await allocationRoutes.suggest(ctx)

    // 不应抛出，而是降级
    expect(ctx.result.rates).toEqual([])
    expect(ctx.result.allocLines).toEqual([])
  })
})
