/**
 * 服务提成路由测试（营业额分配 - 服务提成 Tab）
 * 覆盖：pendingList / detail / save
 * 核心约束：
 *   - 仅店长可操作
 *   - 仅已完成服务单可分配
 *   - serviceItemId 必须属于该服务单
 *   - 分池 (serviceItemId, roleType)：≤3 人 / 合计 ≤100% / 不重复
 *   - 服务端按 ratio 拆分重算：consumeBase=unit_real_price×session_used,
 *     consumeAmount=consumeBase×ratio×rate, fixedFee=service_fee×session_used×ratio
 *   - rate 缺失抛 COMMISSION_RATE_MISSING
 */

const pg = globalThis.__mocks__.pg
const { createManagerCtx, createBeauticianCtx } = require('../helpers')
const routes = require('../../routes/serviceCommission')

// INSERT service_commissions 参数顺序：
// [0]=serviceItemId [1]=employeeId [2]=roleType [3]=ratio
// [4]=rate [5]=fixedFee [6]=consumeAmount [7]=commissionAmount [8]=now
function mockTxnCapture(rate = '0.3000') {
  const captured = []
  pg.transaction.mockImplementation(async (cb) => {
    const client = {
      query: vi.fn(async (sql) => {
        if (sql.includes('commission_rate_matrix')) {
          return { rows: rate === null ? [] : [{ commission_rate: rate }], rowCount: rate === null ? 0 : 1 }
        }
        if (sql.includes('INSERT INTO service_commissions')) {
          // 捕获 params（第二个实参）
          return { rows: [], rowCount: 1 }
        }
        return { rows: [], rowCount: 1 }
      }),
    }
    // 包一层以捕获 INSERT params
    const origQuery = client.query
    client.query = vi.fn(async (sql, params) => {
      if (sql.includes('INSERT INTO service_commissions')) captured.push(params)
      return origQuery(sql, params)
    })
    return await cb(client)
  })
  return captured
}

function mockOrderAndItems(order, items) {
  pg.query
    .mockResolvedValueOnce([order])
    .mockResolvedValueOnce(items)
}

const COMPLETED_ORDER = { service_order_id: 'SO-1', status: '已完成', commission_status: '待分配' }

describe('serviceCommission.pendingList', () => {
  beforeEach(() => { vi.clearAllMocks() })

  test('返回待分配服务单列表', async () => {
    const ctx = createManagerCtx({ page: 1, pageSize: 10 })
    pg.query.mockResolvedValueOnce([
      { service_order_id: 'SO-1', commission_status: '待分配', employee_name: '万琪' },
      { service_order_id: 'SO-2', commission_status: '待分配', employee_name: '李四' },
    ])
    await routes.pendingList(ctx)
    expect(ctx.result.orders).toHaveLength(2)
    expect(ctx.result.page).toBe(1)
  })

  test('支持 commissionStatus=已分配', async () => {
    const ctx = createManagerCtx({ commissionStatus: '已分配' })
    pg.query.mockResolvedValueOnce([{ service_order_id: 'SO-9', commission_status: '已分配' }])
    await routes.pendingList(ctx)
    expect(ctx.result.orders[0].commission_status).toBe('已分配')
    // store + status 进入 SQL 参数
    const params = pg.query.mock.calls[0][1]
    expect(params).toContain('已分配')
    expect(params).toContain('store-001')
  })

  test('非法 commissionStatus 拒绝', async () => {
    const ctx = createManagerCtx({ commissionStatus: '乱填' })
    await expect(routes.pendingList(ctx)).rejects.toThrow(/INVALID_PARAMS.*commissionStatus/)
  })

  test('非店长拒绝', async () => {
    const ctx = createBeauticianCtx({})
    await expect(routes.pendingList(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })
})

describe('serviceCommission.detail', () => {
  beforeEach(() => { vi.clearAllMocks() })

  test('返回 order/items/commissions/rates 结构', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'SO-1' })
    pg.query
      .mockResolvedValueOnce([{ service_order_id: 'SO-1', status: '已完成', market_name: '测试市场', commission_status: '待分配' }])
      .mockResolvedValueOnce([{ service_item_id: 'si-1', unit_real_price: '700', session_used: 1, sales_category: '护理项目', service_fee: '0', session_count: 5, quantity: 1, product_name: 'P1', sku_spec_name: 'S1' }])
      .mockResolvedValueOnce([]) // 无已有提成
      .mockResolvedValueOnce([
        { role_type: '美容师', sales_category: '护理项目', amount_tier_min: '0', amount_tier_max: '99999', commission_rate: '0.3000' },
      ])
    await routes.detail(ctx)
    expect(ctx.result.order.service_order_id).toBe('SO-1')
    expect(ctx.result.items).toHaveLength(1)
    expect(ctx.result.commissions).toEqual([])
    expect(ctx.result.rates).toHaveLength(1)
    expect(ctx.result.rates[0].department).toBe('美容师')
    expect(ctx.result.rates[0].serviceRates['护理项目']).toBe(0.3)
  })

  test('服务单不存在/不属本店 → NOT_FOUND', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'SO-X' })
    pg.query.mockResolvedValueOnce([])
    await expect(routes.detail(ctx)).rejects.toThrow(/NOT_FOUND/)
  })

  test('缺少 serviceOrderId 拒绝', async () => {
    const ctx = createManagerCtx({})
    await expect(routes.detail(ctx)).rejects.toThrow(/INVALID_PARAMS.*serviceOrderId/)
  })

  test('非店长拒绝', async () => {
    const ctx = createBeauticianCtx({ serviceOrderId: 'SO-1' })
    await expect(routes.detail(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })
})

describe('serviceCommission.save', () => {
  beforeEach(() => { vi.clearAllMocks() })

  test('保存成功 — recompute consumeBase=unit_real_price×session_used', async () => {
    const ctx = createManagerCtx({
      serviceOrderId: 'SO-1',
      commissions: [{ serviceItemId: 'si-1', employeeId: 'emp-1', roleType: '美容师', allocationRatio: 1.0 }],
    })
    mockOrderAndItems(COMPLETED_ORDER, [
      { service_item_id: 'si-1', session_used: 1, unit_real_price: '700', sales_category: '护理项目', service_fee: '0', session_count: 5, quantity: 1 },
    ])
    const captured = mockTxnCapture('0.3000')

    await routes.save(ctx)

    expect(ctx.result.commissionCount).toBe(1)
    expect(captured).toHaveLength(1)
    // consumeBase=700, ratio=1, rate=0.3 → consumeAmount=210, commissionAmount=210
    expect(captured[0][3]).toBe(1) // ratio
    expect(Number(captured[0][4])).toBeCloseTo(0.3, 4) // rate
    expect(Number(captured[0][6])).toBeCloseTo(210, 2) // consumeAmount
    expect(Number(captured[0][7])).toBeCloseTo(210, 2) // commissionAmount
  })

  test('按 ratio 拆分：888 单 30% × 12% → 31.97', async () => {
    const ctx = createManagerCtx({
      serviceOrderId: 'SO-1',
      commissions: [{ serviceItemId: 'si-1', employeeId: 'emp-1', roleType: '美容师', allocationRatio: 0.3 }],
    })
    mockOrderAndItems(COMPLETED_ORDER, [
      { service_item_id: 'si-1', session_used: 1, unit_real_price: '888', sales_category: '护理项目', service_fee: '0', session_count: 1, quantity: 1 },
    ])
    const captured = mockTxnCapture('0.1200')

    await routes.save(ctx)

    expect(captured[0][3]).toBe(0.3)
    expect(Number(captured[0][6])).toBeCloseTo(31.97, 2) // 888 × 0.30 × 0.12
    expect(Number(captured[0][7])).toBeCloseTo(31.97, 2)
  })

  test('fixed_fee 也按 ratio 拆分', async () => {
    const ctx = createManagerCtx({
      serviceOrderId: 'SO-1',
      commissions: [{ serviceItemId: 'si-1', employeeId: 'emp-1', roleType: '美容师', allocationRatio: 0.5 }],
    })
    mockOrderAndItems(COMPLETED_ORDER, [
      { service_item_id: 'si-1', session_used: 2, unit_real_price: '100', sales_category: '护理项目', service_fee: '20', session_count: 1, quantity: 1 },
    ])
    const captured = mockTxnCapture('0.3000')

    await routes.save(ctx)

    // consumeBase=200; consumeAmount=200×0.5×0.3=30; fixedFee=20×2×0.5=20; commission=50
    expect(Number(captured[0][5])).toBeCloseTo(20, 2) // fixedFee
    expect(Number(captured[0][6])).toBeCloseTo(30, 2) // consumeAmount
    expect(Number(captured[0][7])).toBeCloseTo(50, 2) // commissionAmount
  })

  test('空数组 → 清空并置待分配', async () => {
    const ctx = createManagerCtx({ serviceOrderId: 'SO-1', commissions: [] })
    mockOrderAndItems(COMPLETED_ORDER, [
      { service_item_id: 'si-1', session_used: 1, unit_real_price: '700', sales_category: '护理项目', service_fee: '0', session_count: 5, quantity: 1 },
    ])
    pg.transaction.mockImplementation(async (cb) => {
      const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) }
      return await cb(client)
    })
    await routes.save(ctx)
    expect(ctx.result.commissionCount).toBe(0)
    expect(ctx.result.message).toContain('清空')
  })

  test('非已完成服务单拒绝', async () => {
    const ctx = createManagerCtx({
      serviceOrderId: 'SO-1',
      commissions: [{ serviceItemId: 'si-1', employeeId: 'emp-1', roleType: '美容师', allocationRatio: 1.0 }],
    })
    pg.query.mockResolvedValueOnce([{ service_order_id: 'SO-1', status: '服务中', commission_status: null }])
    await expect(routes.save(ctx)).rejects.toThrow(/INVALID_STATE.*仅已完成/)
  })

  test('serviceItemId 不属于服务单拒绝', async () => {
    const ctx = createManagerCtx({
      serviceOrderId: 'SO-1',
      commissions: [{ serviceItemId: 'si-wrong', employeeId: 'emp-1', roleType: '美容师', allocationRatio: 1.0 }],
    })
    mockOrderAndItems(COMPLETED_ORDER, [
      { service_item_id: 'si-1', session_used: 1, unit_real_price: '700', sales_category: '护理项目', service_fee: '0', session_count: 5, quantity: 1 },
    ])
    await expect(routes.save(ctx)).rejects.toThrow(/INVALID_PARAMS.*不属于该服务单/)
  })

  test('非整十 ratio 拒绝', async () => {
    const ctx = createManagerCtx({
      serviceOrderId: 'SO-1',
      commissions: [{ serviceItemId: 'si-1', employeeId: 'emp-1', roleType: '美容师', allocationRatio: 0.15 }],
    })
    mockOrderAndItems(COMPLETED_ORDER, [
      { service_item_id: 'si-1', session_used: 1, unit_real_price: '700', sales_category: '护理项目', service_fee: '0', session_count: 5, quantity: 1 },
    ])
    await expect(routes.save(ctx)).rejects.toThrow(/INVALID_PARAMS.*整十/)
  })

  test('同池 > 3 人拒绝', async () => {
    const lines = ['a', 'b', 'c', 'd'].map(e => ({ serviceItemId: 'si-1', employeeId: `emp-${e}`, roleType: '美容师', allocationRatio: 0.1 }))
    const ctx = createManagerCtx({ serviceOrderId: 'SO-1', commissions: lines })
    mockOrderAndItems(COMPLETED_ORDER, [
      { service_item_id: 'si-1', session_used: 1, unit_real_price: '700', sales_category: '护理项目', service_fee: '0', session_count: 5, quantity: 1 },
    ])
    await expect(routes.save(ctx)).rejects.toThrow(/INVALID_PARAMS.*最多分配 3 人/)
  })

  test('同池合计 > 100% 拒绝', async () => {
    const ctx = createManagerCtx({
      serviceOrderId: 'SO-1',
      commissions: [
        { serviceItemId: 'si-1', employeeId: 'emp-1', roleType: '美容师', allocationRatio: 0.6 },
        { serviceItemId: 'si-1', employeeId: 'emp-2', roleType: '美容师', allocationRatio: 0.6 },
      ],
    })
    mockOrderAndItems(COMPLETED_ORDER, [
      { service_item_id: 'si-1', session_used: 1, unit_real_price: '700', sales_category: '护理项目', service_fee: '0', session_count: 5, quantity: 1 },
    ])
    await expect(routes.save(ctx)).rejects.toThrow(/INVALID_PARAMS.*合计不能超过 100%/)
  })

  test('同池重复员工拒绝', async () => {
    const ctx = createManagerCtx({
      serviceOrderId: 'SO-1',
      commissions: [
        { serviceItemId: 'si-1', employeeId: 'emp-dup', roleType: '美容师', allocationRatio: 0.3 },
        { serviceItemId: 'si-1', employeeId: 'emp-dup', roleType: '美容师', allocationRatio: 0.4 },
      ],
    })
    mockOrderAndItems(COMPLETED_ORDER, [
      { service_item_id: 'si-1', session_used: 1, unit_real_price: '700', sales_category: '护理项目', service_fee: '0', session_count: 5, quantity: 1 },
    ])
    await expect(routes.save(ctx)).rejects.toThrow(/INVALID_PARAMS.*重复分配同一员工/)
  })

  test('三角色独立池：同 item 三技能各 1 人通过', async () => {
    const ctx = createManagerCtx({
      serviceOrderId: 'SO-1',
      commissions: [
        { serviceItemId: 'si-1', employeeId: 'emp-1', roleType: '美容师', allocationRatio: 1.0 },
        { serviceItemId: 'si-1', employeeId: 'emp-2', roleType: '养生师', allocationRatio: 1.0 },
        { serviceItemId: 'si-1', employeeId: 'emp-3', roleType: '推广师', allocationRatio: 1.0 },
      ],
    })
    mockOrderAndItems(COMPLETED_ORDER, [
      { service_item_id: 'si-1', session_used: 1, unit_real_price: '700', sales_category: '护理项目', service_fee: '0', session_count: 5, quantity: 1 },
    ])
    const captured = mockTxnCapture('0.3000')
    await routes.save(ctx)
    expect(ctx.result.commissionCount).toBe(3)
    expect(captured).toHaveLength(3)
  })

  test('rate 缺失抛 COMMISSION_RATE_MISSING', async () => {
    const ctx = createManagerCtx({
      serviceOrderId: 'SO-1',
      commissions: [{ serviceItemId: 'si-1', employeeId: 'emp-1', roleType: '美容师', allocationRatio: 1.0 }],
    })
    mockOrderAndItems(COMPLETED_ORDER, [
      { service_item_id: 'si-1', session_used: 1, unit_real_price: '700', sales_category: '护理项目', service_fee: '0', session_count: 5, quantity: 1 },
    ])
    mockTxnCapture(null) // rate 查询返回空 → rate=0 且 consumeBase>0
    await expect(routes.save(ctx)).rejects.toThrow(/INVALID_STATE.*COMMISSION_RATE_MISSING/)
  })

  test('缺少 serviceOrderId 拒绝', async () => {
    const ctx = createManagerCtx({ commissions: [] })
    await expect(routes.save(ctx)).rejects.toThrow(/INVALID_PARAMS.*serviceOrderId/)
  })

  test('非店长拒绝', async () => {
    const ctx = createBeauticianCtx({ serviceOrderId: 'SO-1', commissions: [] })
    await expect(routes.save(ctx)).rejects.toThrow(/PERMISSION_DENIED/)
  })
})
