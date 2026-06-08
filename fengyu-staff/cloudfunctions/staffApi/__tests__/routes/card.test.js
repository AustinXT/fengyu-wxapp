/**
 * 充值卡路由测试
 * 覆盖：recharge 的门店归属校验（非本店顾客禁止充值）
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
        customer_type: '会员客', bound_store_id: 'store-999',
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
        customer_type: '会员客', bound_store_id: 'store-001',
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
})
