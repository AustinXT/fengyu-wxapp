/**
 * 充值卡路由测试
 * 覆盖：recharge / inflow 的门店归属校验（临时跨店放行，普通外店拒绝）
 */

const pg = globalThis.__mocks__.pg
const { createManagerCtx } = require('../helpers')
const cardRoutes = require('../../routes/card')

/** loadRechargeConfig 的 system_configs 行（1 档：面值 1000 实付 900） */
function mockRechargeConfigRows() {
  return [
    { key: 'recharge.tiers', value: '[{"faceValue":1000,"payAmount":900}]' },
    { key: 'recharge.minAmount', value: '100' },
    { key: 'recharge.maxAmount', value: '100000' },
  ]
}

describe('card.recharge', () => {
  beforeEach(() => { vi.clearAllMocks() })

  test('非本店顾客（bound_store_id ≠ effectiveStoreId）拒绝充值', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'cu-999',
      faceValue: 1000,
      paymentMethod: '线下',
    })
    pg.query
      .mockResolvedValueOnce(mockRechargeConfigRows()) // loadRechargeConfig
      .mockResolvedValueOnce([{ // 顾客绑定其他门店
        user_id: 'cu-999', phone: '138', name: '外店顾客',
        customer_type: '会员客', bound_store_id: 'store-999', is_cross_store_temp: false,
      }])

    await expect(cardRoutes.recharge(ctx))
      .rejects.toThrow(/PERMISSION_DENIED.*不属于当前门店/)
  })

  test('本店顾客可继续充值流程（越过门店校验，不抛 PERMISSION_DENIED）', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'cu-001',
      faceValue: 1000,
      paymentMethod: '线下',
    })
    pg.query
      .mockResolvedValueOnce(mockRechargeConfigRows()) // loadRechargeConfig
      .mockResolvedValueOnce([{ // 绑定本店
        user_id: 'cu-001', phone: '138', name: '本店顾客',
        customer_type: '会员客', bound_store_id: 'store-001', is_cross_store_temp: false,
      }])
      .mockResolvedValueOnce([]) // 无待支付订单
    pg.transaction.mockImplementation(async (cb) => {
      const client = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) }
      return await cb(client)
    })

    await cardRoutes.recharge(ctx)
    expect(ctx.result).toBeDefined()
    expect(ctx.result.faceValue).toBe(1000)
    expect(ctx.result.payAmount).toBe(900)
  })

  test('临时跨店顾客可在外店充值，订单仍由当前门店创建', async () => {
    const ctx = createManagerCtx({
      clientUserId: 'cu-temp',
      faceValue: 1000,
      paymentMethod: '线下',
    })
    pg.query
      .mockResolvedValueOnce(mockRechargeConfigRows())
      .mockResolvedValueOnce([{
        user_id: 'cu-temp', phone: '139', name: '临时跨店顾客',
        bound_store_id: 'store-999', is_cross_store_temp: true,
      }])
    const clientQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    pg.transaction.mockImplementation(async (cb) => cb({ query: clientQuery }))

    await cardRoutes.recharge(ctx)

    expect(ctx.result.saleOrderId).toMatch(/^FY-XSD-WX-/)
    expect(ctx.result.faceValue).toBe(1000)
    const orderInsert = clientQuery.mock.calls.find(([sql]) => /INSERT INTO sale_orders/.test(sql))
    expect(orderInsert).toBeTruthy()
    expect(orderInsert[1][4]).toBe('store-001')
  })
})

describe('card.inflow — 幂等防重复入账', () => {
  beforeEach(() => { vi.clearAllMocks() })

  // inflow 第 1 次模块级 pg.query 即查顾客（绑定本店 store-001，过 isStoreInScope）
  function mockCustomerInScope() {
    pg.query.mockResolvedValueOnce([{
      user_id: 'cu-001', phone: '138', name: '本店顾客',
      customer_type: '会员客', bound_store_id: 'store-001', is_cross_store_temp: false,
    }])
  }

  test('普通外店顾客拒绝转入', async () => {
    const ctx = createManagerCtx({ clientUserId: 'cu-999', amount: 500, requestId: 'req-reject' })
    pg.query.mockResolvedValueOnce([{
      user_id: 'cu-999', phone: '138', name: '外店顾客',
      bound_store_id: 'store-999', is_cross_store_temp: false,
    }])

    await expect(cardRoutes.inflow(ctx))
      .rejects.toThrow(/PERMISSION_DENIED.*不属于当前门店/)
  })

  test('临时跨店顾客可在外店转入', async () => {
    const ctx = createManagerCtx({ clientUserId: 'cu-temp', amount: 500, requestId: 'req-temp' })
    pg.query.mockResolvedValueOnce([{
      user_id: 'cu-temp', phone: '139', name: '临时跨店顾客',
      bound_store_id: 'store-999', is_cross_store_temp: true,
    }])
    const clientQuery = vi.fn(async (sql) => {
      if (/INSERT INTO prepaid_cards/.test(sql)) {
        return { rows: [{ card_id: 'FY-CARD-cu-temp' }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })
    pg.transaction.mockImplementation(async (cb) => cb({ query: clientQuery }))

    await cardRoutes.inflow(ctx)

    expect(ctx.result.saleOrderId).toMatch(/^FY-XSD-WX-/)
    expect(ctx.result.message).toBe('转入成功')
    const orderInsert = clientQuery.mock.calls.find(([sql]) => /INSERT INTO sale_orders/.test(sql))
    expect(orderInsert).toBeTruthy()
    expect(orderInsert[1][3]).toBe('store-001')
  })

  test('相同 requestId 已转入 → 幂等短路复用既有订单，不重复建单 / 不重复入账', async () => {
    const ctx = createManagerCtx({ clientUserId: 'cu-001', amount: 500, requestId: 'req-xyz' })
    mockCustomerInScope()
    // 事务内 client.query 返回原生 node-pg Result（取 .rows）：① 顾客级锁 → 空；② dup 查 → 命中既有转入单
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ref_order_id: 'FY-XSD-WX-2606240001' }] })
    pg.transaction.mockImplementation(async (cb) => cb({ query: clientQuery }))

    await cardRoutes.inflow(ctx)

    expect(ctx.result.saleOrderId).toBe('FY-XSD-WX-2606240001')
    expect(ctx.result.message).toMatch(/转入已完成/)
    // 早返回：仅 2 次 client.query（锁 + dup 查），未进入建单 / 入账（守护 .rows 取值不退化为死代码）
    expect(clientQuery).toHaveBeenCalledTimes(2)
  })

  test('新 requestId 无重复 → 正常建单 + 入账（message=转入成功）', async () => {
    const ctx = createManagerCtx({ clientUserId: 'cu-001', amount: 500, requestId: 'req-new' })
    mockCustomerInScope()
    // 顾客已有卡，且 card_id 是历史异格式（≠ FY-CARD-cu-001）：UPSERT ON CONFLICT(user_id) 命中旧行，
    // RETURNING 返回旧 card_id。其余 client.query 默认空 rows + rowCount=1（锁 / orderSeq / INSERT / logOperation）。
    const EXISTING_CARD_ID = 'FY-CARD-1779383511931710'
    const clientQuery = vi.fn(async (sql) => {
      if (/INSERT INTO prepaid_cards/.test(sql)) return { rows: [{ card_id: EXISTING_CARD_ID }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    })
    pg.transaction.mockImplementation(async (cb) => cb({ query: clientQuery }))

    await cardRoutes.inflow(ctx)

    expect(ctx.result.saleOrderId).toMatch(/^FY-XSD-WX-/)
    expect(ctx.result.message).toBe('转入成功')
    expect(clientQuery.mock.calls.length).toBeGreaterThan(2)
    // 回归守护（card_id FK 23503）：card_transactions 必须用 UPSERT 返回的实际异格式 card_id，
    // 而非构造的 FY-CARD-cu-001（顾客已有异格式卡时直用构造值会违反 card_transactions→prepaid_cards 外键）
    const ctInsert = clientQuery.mock.calls.find(([s]) => /INSERT INTO card_transactions/.test(s))
    expect(ctInsert).toBeTruthy()
    expect(ctInsert[1][0]).toBe(EXISTING_CARD_ID)
  })
})
