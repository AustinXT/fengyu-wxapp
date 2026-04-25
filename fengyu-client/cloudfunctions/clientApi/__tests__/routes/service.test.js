/**
 * 服务单路由测试
 * 覆盖：detail, list
 */

const pg = globalThis.__mocks__.pg
const { createBoundCtx } = require('../helpers')

let routes
beforeEach(() => {
  vi.clearAllMocks()
  routes = require('../../routes/service')
})

describe('service.detail', () => {
  test('返回服务单详情及明细', async () => {
    pg.query.mockResolvedValueOnce([{
      service_order_id: 'SVC-001', status: '进行中',
      service_order_type: '售前', store_id: 's1', store_name: '凤御A店',
    }])
    pg.query.mockResolvedValueOnce([{
      service_item_id: 'SVI-001', sale_item_id: 'SI-001',
      session_used: 1, employee_id: 'emp-1',
      product_name: '美白护理', sku_spec_name: '10次卡',
    }])

    const ctx = createBoundCtx({ serviceOrderId: 'SVC-001' })
    await routes.detail(ctx)

    expect(ctx.result.serviceOrder.service_order_id).toBe('SVC-001')
    expect(ctx.result.items).toHaveLength(1)
    expect(ctx.result.items[0].product_name).toBe('美白护理')
  })

  test('缺少 serviceOrderId → INVALID_PARAMS', async () => {
    const ctx = createBoundCtx({})
    await expect(routes.detail(ctx)).rejects.toThrow(/INVALID_PARAMS.*serviceOrderId/)
  })

  test('服务单不存在 → INVALID_PARAMS', async () => {
    pg.query.mockResolvedValueOnce([])
    const ctx = createBoundCtx({ serviceOrderId: 'nonexistent' })
    await expect(routes.detail(ctx)).rejects.toThrow(/INVALID_PARAMS.*服务单不存在/)
  })

  test('兼容旧参数名 serviceOrderNo', async () => {
    pg.query.mockResolvedValueOnce([{ service_order_id: 'SVC-001', status: '已完成' }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({ serviceOrderNo: 'SVC-001' })
    await routes.detail(ctx)

    expect(ctx.result.serviceOrder.service_order_id).toBe('SVC-001')
  })
})

describe('service.list', () => {
  test('返回服务记录列表并关联明细', async () => {
    // 第一次查询：服务记录主表
    pg.query.mockResolvedValueOnce([
      {
        service_order_id: 'SVC-001', status: '已完成',
        service_date: '2026-03-10', store_name: '凤御A店',
        employee_name: '李梅', started_at: '2026-03-10T10:00:00Z', completed_at: '2026-03-10T11:30:00Z',
      },
    ])
    // 第二次查询：批量 service_items
    pg.query.mockResolvedValueOnce([
      {
        service_order_id: 'SVC-001', service_item_id: 'SVI-001',
        session_used: 1, service_duration: 90,
        product_name: '深层清洁护理', sku_spec_name: '10次卡',
      },
    ])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    expect(ctx.result.records).toHaveLength(1)
    expect(ctx.result.records[0].service_order_id).toBe('SVC-001')
    expect(ctx.result.records[0].store_name).toBe('凤御A店')
    expect(ctx.result.records[0].employee_name).toBe('李梅')
    expect(ctx.result.records[0].items).toHaveLength(1)
    expect(ctx.result.records[0].items[0].product_name).toBe('深层清洁护理')
  })

  test('空列表时不执行第二次查询', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    expect(ctx.result.records).toHaveLength(0)
    // 只调用了一次查询（主表），没有批量子查询
    expect(pg.query).toHaveBeenCalledTimes(1)
  })

  test('多条记录正确分配各自的 items', async () => {
    pg.query.mockResolvedValueOnce([
      { service_order_id: 'SVC-001', status: '已完成', store_name: '凤御A店', employee_name: '李梅' },
      { service_order_id: 'SVC-002', status: '已完成', store_name: '凤御B店', employee_name: '张红' },
    ])
    pg.query.mockResolvedValueOnce([
      { service_order_id: 'SVC-001', service_item_id: 'SVI-001', product_name: '美白护理', session_used: 1, service_duration: 60 },
      { service_order_id: 'SVC-002', service_item_id: 'SVI-002', product_name: '补水护理', session_used: 1, service_duration: 45 },
      { service_order_id: 'SVC-002', service_item_id: 'SVI-003', product_name: '面部按摩', session_used: 1, service_duration: 30 },
    ])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    const records = ctx.result.records
    expect(records).toHaveLength(2)
    expect(records[0].items).toHaveLength(1)
    expect(records[0].items[0].product_name).toBe('美白护理')
    expect(records[1].items).toHaveLength(2)
    expect(records[1].items.map(i => i.product_name)).toEqual(['补水护理', '面部按摩'])
  })

  test('没有明细的记录 items 为空数组', async () => {
    pg.query.mockResolvedValueOnce([
      { service_order_id: 'SVC-003', status: '待服务', store_name: '凤御A店', employee_name: null },
    ])
    // 批量查询返回空（此服务单没有 items）
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    expect(ctx.result.records[0].items).toEqual([])
  })

  test('分页参数：page=2, pageSize=5 → offset=5', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({ page: 2, pageSize: 5 })
    await routes.list(ctx)

    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).toMatch(/LIMIT \$2 OFFSET \$3/)
    expect(params[1]).toBe(5)   // pageSize
    expect(params[2]).toBe(5)   // offset = (2-1)*5
  })

  test('默认分页：page=1, pageSize=20', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    const [, params] = pg.query.mock.calls[0]
    expect(params[1]).toBe(20)
    expect(params[2]).toBe(0)
  })
})
