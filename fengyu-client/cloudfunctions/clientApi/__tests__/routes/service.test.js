/**
 * 服务单路由测试
 * 覆盖：detail
 */

vi.mock('../../db/pg', () => require('../mocks/pg'))
vi.mock('wx-server-sdk', () => require('../mocks/wx-server-sdk'))

const pg = require('../../db/pg')
const { createBoundCtx, createCtx } = require('../helpers')

let routes
beforeEach(() => {
  vi.clearAllMocks()
  routes = require('../../routes/service')
})

describe('service.detail', () => {
  test('返回服务单详情及明细', async () => {
    // 查服务单
    pg.query.mockResolvedValueOnce([{
      service_order_id: 'SVC-001',
      status: '进行中',
      service_order_type: '护理',
      store_id: 's1',
      store_name: '凤御A店',
      assigned_employee_id: 'emp-1',
    }])
    // 查服务明细
    pg.query.mockResolvedValueOnce([{
      service_item_id: 'SVI-001',
      sale_item_id: 'SI-001',
      session_used: 1,
      employee_id: 'emp-1',
      product_name: '美白护理',
      sku_spec_name: '10次卡',
    }])

    const ctx = createBoundCtx({ serviceOrderId: 'SVC-001' })
    await routes.detail(ctx)

    expect(ctx.result.serviceOrder.service_order_id).toBe('SVC-001')
    expect(ctx.result.items).toHaveLength(1)
    expect(ctx.result.items[0].product_name).toBe('美白护理')
  })

  test('缺少 serviceOrderId → INVALID_PARAMS', async () => {
    const ctx = createBoundCtx({})
    await expect(routes.detail(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*serviceOrderId/)
  })

  test('服务单不存在 → INVALID_PARAMS', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({ serviceOrderId: 'nonexistent' })
    await expect(routes.detail(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*服务单不存在/)
  })

  test('兼容旧参数名 serviceOrderNo', async () => {
    pg.query.mockResolvedValueOnce([{
      service_order_id: 'SVC-001',
      status: '已完成',
    }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({ serviceOrderNo: 'SVC-001' })
    await routes.detail(ctx)

    expect(ctx.result.serviceOrder.service_order_id).toBe('SVC-001')
  })
})
