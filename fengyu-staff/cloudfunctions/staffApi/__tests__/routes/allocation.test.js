/**
 * 营业额分配路由测试
 * 覆盖：save / deleteAllocation / pendingList
 * 核心约束：
 *   - 仅已支付订单可分配
 *   - 仅店长可操作
 *   - 空分配标记为"无需分配"
 *   - saleItemId 必须属于该订单
 */

jest.mock('../../db/pg', () => require('../mocks/pg'))
jest.mock('../../db/mssql', () => require('../mocks/mssql'))
jest.mock('wx-server-sdk', () => require('../mocks/wx-server-sdk'))

const pg = require('../../db/pg')
const { createManagerCtx, createBeauticianCtx } = require('../helpers')
const allocationRoutes = require('../../routes/allocation')

describe('allocation.save', () => {
  beforeEach(() => {
    jest.clearAllMocks()
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
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
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
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
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
    jest.clearAllMocks()
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
        query: jest.fn()
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
    jest.clearAllMocks()
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
